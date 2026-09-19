package tech.zseven.rish.runtime

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * The Files browser's view of a workspace, on Android.
 *
 * This is `LocalWorkspace` -- what the drawer lists and opens -- and not the
 * agent's tools, which have their own gate in [AndroidWorkspaceToolExecutor].
 * The two share the rules that decide identity rather than duplicating them:
 * a path is decomposed by the core's `path_components`, and which directory a
 * root names is the resolver's answer. What a person browses and what the
 * agent writes are therefore the same bytes, under the same containment
 * rules; only the spelling of a revision differs, because this bridge's
 * reader requires a digest where the agent's tools carry opaque metadata.
 *
 * **What is here.** Listing, reading, writing, creating directories,
 * renaming, and a recoverable trash. Portable tools and the capability
 * record still reject: the record asserts a tool set this platform does not
 * have, and asserting it would be a claim rather than an answer.
 */
internal class AndroidWorkspaceFiles(
    private val workspaces: AndroidWorkspaceRegistry,
    private val roots: AndroidAgentRootResolver,
) {

    class Refused(val code: String, val reason: String) : Exception(reason)

    /** `listV2`: one directory, sorted, capped by the request. */
    fun list(request: JSONObject?): JSONObject {
        val captured = exact(request, "schema_version", "root", "path", "max_entries")
        val root = directory(captured)
        val path = captured.optString("path")
        val max = integer(captured, "max_entries")
        if (max < 1 || max > MAX_LIST_ENTRIES) throw Refused(INVALID, "max_entries is out of range")
        val target = resolve(root, path, allowRoot = true)
        if (!target.isDirectory) throw Refused(NOT_FOUND, "No such directory")
        val children = target.listFiles() ?: throw Refused(PERSISTENCE, "Directory could not be read")
        val entries = JSONArray()
        children.sortedBy { it.name }
            // A symbolic link leads out of the root by definition; the agent's
            // executor refuses one for the same reason.
            .filter { !isLink(it) }
            // The trash and a half-written file are this store's bookkeeping,
            // not the person's files. `.git` stays visible: the reader knows
            // about it and protects it itself.
            .filter { !hidden(path, it.name) }
            .take(max)
            .forEach { entries.put(entry(root, it, join(path, it.name))) }
        return JSONObject()
            .put("schema_version", 1)
            .put("root", captured.getJSONObject("root"))
            .put("path", path)
            .put("entries", entries)
    }

    /** `readV2`: one text file, refused rather than truncated. */
    fun read(request: JSONObject?): JSONObject {
        val captured = exact(request, "schema_version", "root", "path", "max_bytes")
        val root = directory(captured)
        val path = captured.optString("path")
        val max = integer(captured, "max_bytes")
        if (max < 1 || max > MAX_TEXT_BYTES) throw Refused(INVALID, "max_bytes is out of range")
        val target = resolve(root, path, allowRoot = false)
        if (!target.isFile) throw Refused(NOT_FOUND, "No such file")
        if (target.length() > max) {
            throw Refused(UNAVAILABLE, "This file is larger than the reader will show")
        }
        val bytes = try {
            target.readBytes()
        } catch (_: IOException) {
            throw Refused(PERSISTENCE, "File could not be read")
        }
        return JSONObject()
            .put("schema_version", 1)
            .put("root", captured.getJSONObject("root"))
            .put("path", path)
            .put("file", entry(root, target, path))
            .put("content", text(bytes))
    }

    /**
     * `writeV2`: one text file, atomically, against the revision the caller
     * last saw.
     */
    fun write(request: JSONObject?): JSONObject {
        val captured = exact(
            request, "schema_version", "root", "path", "content", "expected_revision", "create_only",
        )
        val root = directory(captured)
        val path = captured.optString("path")
        val content = captured.opt("content") as? String
            ?: throw Refused(INVALID, "Content must be text")
        if (content.toByteArray(Charsets.UTF_8).size > MAX_TEXT_BYTES) {
            throw Refused(INVALID, "Content is larger than a workspace file may be")
        }
        val expected = captured.opt("expected_revision")?.takeIf { it != JSONObject.NULL } as? String
        val createOnly = captured.opt("create_only") as? Boolean
            ?: throw Refused(INVALID, "create_only must be a boolean")
        val target = resolve(root, path, allowRoot = false)
        if (target.isDirectory) throw Refused(CONFLICT, "A directory already exists at that path")
        val existed = target.isFile
        // The two ways of saying "I know what is there": a create that must
        // not overwrite, and a revision that must still be the current one.
        if (createOnly && existed) throw Refused(CONFLICT, "That file already exists")
        if (!createOnly && expected == null && existed) {
            throw Refused(CONFLICT, "That file already exists")
        }
        if (expected != null) {
            if (!existed) throw Refused(NOT_FOUND, "No such file")
            if (revision(target) != expected) {
                throw Refused(CONFLICT, "That file changed since it was read")
            }
        }
        val parent = target.parentFile ?: throw Refused(INVALID, "Path is invalid")
        if (!parent.isDirectory) throw Refused(NOT_FOUND, "No such directory")
        val staging = File(parent, "${target.name}.rish-staging")
        try {
            staging.writeText(content)
            if (!staging.renameTo(target)) {
                target.delete()
                if (!staging.renameTo(target)) {
                    throw Refused(PERSISTENCE, "File could not be written")
                }
            }
        } catch (refused: Refused) {
            staging.delete()
            throw refused
        } catch (_: IOException) {
            staging.delete()
            throw Refused(PERSISTENCE, "File could not be written")
        }
        return JSONObject()
            .put("schema_version", 1)
            .put("root", captured.getJSONObject("root"))
            .put("file", entry(root, target, path))
            .put("created", !existed)
    }

    /** `createDirectoryV2`: one directory, where nothing is yet. */
    fun createDirectory(request: JSONObject?): JSONObject {
        val captured = exact(request, "schema_version", "root", "path")
        val root = directory(captured)
        val path = captured.optString("path")
        val target = resolve(root, path, allowRoot = false)
        if (target.exists()) throw Refused(CONFLICT, "Something already exists at that path")
        val parent = target.parentFile ?: throw Refused(INVALID, "Path is invalid")
        if (!parent.isDirectory) throw Refused(NOT_FOUND, "No such directory")
        if (!target.mkdir()) throw Refused(PERSISTENCE, "Directory could not be created")
        return JSONObject()
            .put("schema_version", 1)
            .put("root", captured.getJSONObject("root"))
            .put("directory", entry(root, target, path))
    }

    /** `renameEntryV2`: a move within the workspace, never over something. */
    fun rename(request: JSONObject?): JSONObject {
        val captured = exact(request, "schema_version", "root", "source_path", "destination_path")
        val root = directory(captured)
        val from = captured.optString("source_path")
        val to = captured.optString("destination_path")
        if (from == to) throw Refused(INVALID, "Source and destination are the same")
        val source = resolve(root, from, allowRoot = false)
        val destination = resolve(root, to, allowRoot = false)
        if (!source.exists()) throw Refused(NOT_FOUND, "No such file or directory")
        if (destination.exists()) throw Refused(CONFLICT, "Something already exists at that path")
        // Moving a directory into itself leaves it unreachable, and the
        // rename would appear to succeed.
        if (source.isDirectory && destination.canonicalPath.startsWith(source.canonicalPath + File.separator)) {
            throw Refused(CONFLICT, "A folder cannot be moved into itself")
        }
        val parent = destination.parentFile ?: throw Refused(INVALID, "Path is invalid")
        if (!parent.isDirectory) throw Refused(NOT_FOUND, "No such directory")
        if (!source.renameTo(destination)) throw Refused(PERSISTENCE, "Entry could not be renamed")
        return JSONObject()
            .put("schema_version", 1)
            .put("root", captured.getJSONObject("root"))
            .put("entry", entry(root, destination, to))
            .put("from", from)
    }

    /**
     * `trashEntryV2`: recoverable deletion.
     *
     * The entry is moved whole into `.trash/<trash_id>/payload/`, beside a
     * receipt that remembers where it came from. Nothing is unlinked, so a
     * restore is a move back rather than a rebuild, and a trash that cannot
     * be read is reported as a count rather than pretended away.
     */
    fun trash(request: JSONObject?): JSONObject {
        val captured = exact(request, "schema_version", "root", "path")
        val root = directory(captured)
        val path = captured.optString("path")
        val target = resolve(root, path, allowRoot = false)
        if (!target.exists()) throw Refused(NOT_FOUND, "No such file or directory")
        if (isLink(target)) throw Refused(CONFLICT, "That entry is a link")
        val kind = if (target.isDirectory) "directory" else "file"
        val trashId = UUID.randomUUID().toString()
        val holder = File(trashRoot(root), trashId)
        val payload = File(holder, PAYLOAD)
        if (!payload.mkdirs()) throw Refused(PERSISTENCE, "Trash could not be written")
        val receipt = JSONObject()
            .put("schema_version", 1)
            .put("trash_id", trashId)
            .put("original_path", path)
            .put("kind", kind)
            .put("deleted_at", AndroidClock.now())
        // The receipt lands first: an entry with a payload and no receipt is
        // unrecoverable, while a receipt with no payload is merely reported
        // as an unreadable record.
        try {
            File(holder, RECEIPT).writeText(receipt.toString())
        } catch (_: IOException) {
            holder.deleteRecursively()
            throw Refused(PERSISTENCE, "Trash could not be written")
        }
        if (!target.renameTo(File(payload, target.name))) {
            holder.deleteRecursively()
            throw Refused(PERSISTENCE, "Entry could not be moved to the trash")
        }
        return JSONObject()
            .put("schema_version", 1)
            .put("root", captured.getJSONObject("root"))
            .put("receipt", receipt)
    }

    /** `listTrashV2`: the receipts, newest first, and how many were unreadable. */
    fun listTrash(request: JSONObject?): JSONObject {
        val captured = exact(request, "schema_version", "root", "max_entries")
        val root = directory(captured)
        val max = integer(captured, "max_entries")
        if (max < 1 || max > MAX_LIST_ENTRIES) throw Refused(INVALID, "max_entries is out of range")
        val holders = trashRoot(root).listFiles()?.filter { it.isDirectory } ?: emptyList()
        var invalid = 0
        val receipts = mutableListOf<JSONObject>()
        for (holder in holders) {
            val receipt = readReceipt(holder)
            if (receipt == null || !File(holder, PAYLOAD).isDirectory) invalid += 1
            else receipts.add(receipt)
        }
        receipts.sortByDescending { it.optString("deleted_at") }
        val entries = JSONArray()
        receipts.take(max).forEach { entries.put(it) }
        return JSONObject()
            .put("schema_version", 1)
            .put("root", captured.getJSONObject("root"))
            .put("entries", entries)
            // Bounded by the same cap the entries are: this is a hint for the
            // reader, not a census.
            .put("invalid_record_count", minOf(invalid, max))
    }

    /** `restoreFromTrashV2`: the move back, refused rather than overwriting. */
    fun restore(request: JSONObject?): JSONObject {
        val captured = exact(request, "schema_version", "root", "trash_id", "destination_path")
        val root = directory(captured)
        val trashId = captured.opt("trash_id") as? String
            ?: throw Refused(INVALID, "trash_id is invalid")
        if (!UUID_PATTERN.matches(trashId)) throw Refused(INVALID, "trash_id is invalid")
        val holder = File(trashRoot(root), trashId)
        val receipt = readReceipt(holder) ?: throw Refused(NOT_FOUND, "No such trashed entry")
        val payload = File(holder, PAYLOAD).listFiles()?.firstOrNull()
            ?: throw Refused(NOT_FOUND, "That trashed entry has no contents")
        val requested = captured.opt("destination_path")?.takeIf { it != JSONObject.NULL } as? String
        val path = requested ?: receipt.optString("original_path")
        val target = resolve(root, path, allowRoot = false)
        if (target.exists()) throw Refused(CONFLICT, "Something already exists at that path")
        val parent = target.parentFile ?: throw Refused(INVALID, "Path is invalid")
        if (!parent.isDirectory) throw Refused(NOT_FOUND, "No such directory")
        if (!payload.renameTo(target)) throw Refused(PERSISTENCE, "Entry could not be restored")
        // The holder is bookkeeping; if it survives the restore it is listed
        // as an unreadable record rather than offered again.
        holder.deleteRecursively()
        return JSONObject()
            .put("schema_version", 1)
            .put("root", captured.getJSONObject("root"))
            .put("entry", entry(root, target, path))
            .put("trash_id", trashId)
            .put("original_path", receipt.optString("original_path"))
    }

    private fun trashRoot(root: File): File {
        val trash = File(root, TRASH)
        if (!trash.isDirectory && !trash.mkdirs()) {
            throw Refused(PERSISTENCE, "Trash could not be opened")
        }
        return trash
    }

    private fun readReceipt(holder: File): JSONObject? {
        val file = File(holder, RECEIPT)
        if (!file.isFile) return null
        return try {
            val receipt = JSONObject(file.readText())
            // A receipt that does not name this holder is not this holder's.
            if (receipt.optString("trash_id") != holder.name) null else receipt
        } catch (_: Exception) {
            null
        }
    }

    private fun hidden(path: String, name: String): Boolean =
        (path.isEmpty() && name == TRASH) || name.endsWith(".rish-staging")

    private fun exact(request: JSONObject?, vararg keys: String): JSONObject {
        val captured = request ?: throw Refused(INVALID, "Workspace request is missing")
        if (captured.keys().asSequence().toSet() != keys.toSet()) {
            throw Refused(INVALID, "Workspace request is invalid")
        }
        if (integer(captured, "schema_version") != 1) {
            throw Refused(INVALID, "Workspace request is invalid")
        }
        return captured
    }

    /**
     * Numbers cross the bridge as `Double`, so every integer is read through
     * `Number` rather than cast -- the same trap that made every agent root
     * fail to resolve in production while the tests stayed green.
     */
    private fun integer(value: JSONObject, key: String): Int =
        when (val raw = value.opt(key)) {
            is Number -> raw.toInt()
            else -> throw Refused(INVALID, "$key must be a number")
        }

    /** Which directory this root names, or why it does not name one. */
    private fun directory(request: JSONObject): File {
        val reference = request.optJSONObject("root")
            ?: throw Refused(INVALID, "Workspace root is invalid")
        val workspaceId = reference.optString("workspace_id")
        if (workspaceId.isEmpty()) throw Refused(INVALID, "Workspace root is invalid")
        val known = workspaces.list().firstOrNull { it.optString("workspace_id") == workspaceId }
            ?: throw Refused(NOT_FOUND, "This device does not hold that workspace")
        // A binding revision this device does not hold is a root that moved,
        // not a malformed request.
        if (roots.resolveWorkspaceRef(reference) == null) {
            val held = known.opt("binding_revision")
            throw Refused(
                if (held == null) NOT_FOUND else ROOT_CHANGED,
                "That workspace binding is not the one this device holds",
            )
        }
        return workspaces.rootFor(workspaceId)
            ?: throw Refused(NOT_FOUND, "This device does not hold that workspace")
    }

    /**
     * The same containment rule, for a transfer that needs a path resolved
     * without going through a request shape. Exposed rather than duplicated:
     * an import must land inside exactly the directories a listing shows.
     */
    fun resolveForTransfer(root: File, path: String): File =
        resolve(root, path, allowRoot = true)

    private fun resolve(root: File, path: String, allowRoot: Boolean): File {
        if (path.toByteArray(Charsets.UTF_8).size > MAX_PATH_BYTES) {
            throw Refused(INVALID, "Path is too long")
        }
        if (!RishAgentCoreNative.available) throw Refused(UNAVAILABLE, "Workspace rules are unavailable")
        val reply = RishAgentCoreNative.workspaceTool(
            JSONObject().put("op", "path_components").put("path", path)
                .put("allow_root", allowRoot),
        ) ?: throw Refused(INVALID, "Path is invalid")
        val components = reply.optJSONArray("components") ?: throw Refused(INVALID, "Path is invalid")
        var target = root
        for (index in 0 until components.length()) target = File(target, components.getString(index))
        val canonicalRoot = try {
            root.canonicalFile
        } catch (_: IOException) {
            throw Refused(PERSISTENCE, "Workspace could not be read")
        }
        // A path that does not exist yet has no canonical form of its own, so
        // it is the parent that has to be inside the root.
        val probe = if (target.exists()) target else target.parentFile
            ?: throw Refused(INVALID, "Path is invalid")
        val canonical = try {
            probe.canonicalFile
        } catch (_: IOException) {
            throw Refused(PERSISTENCE, "Workspace could not be read")
        }
        if (canonical != canonicalRoot &&
            !canonical.path.startsWith(canonicalRoot.path + File.separator)
        ) {
            throw Refused(CONFLICT, "That path leaves the workspace")
        }
        return target
    }

    private fun entry(root: File, file: File, path: String): JSONObject = JSONObject()
        .put("path", path)
        .put("name", if (path.isEmpty()) root.name else path.substringAfterLast('/'))
        .put("kind", if (file.isDirectory) "directory" else "file")
        // A directory's own byte count is not a fact java.io reports, and the
        // reader only needs a number it can trust for a file.
        .put("size", if (file.isDirectory) 0L else file.length())
        .put("modified_at", timestamp(file.lastModified()))
        .put("revision", revision(file))

    /**
     * A file's revision, as the reader requires it: a digest.
     *
     * The agent's tools spell the same fact as an opaque
     * `dev:ino:size:mtime` string, but this bridge's reader validates a
     * sha256 and refuses anything else, so the same numbers are digested
     * here. It still changes exactly when the file does, which is all
     * `expected_revision` asks of it.
     */
    private fun revision(file: File): String {
        val state = buildString {
            append(if (file.isDirectory) "directory" else "file").append(':')
            append(if (file.isDirectory) 0L else file.length()).append(':')
            append(file.lastModified())
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(state.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { byte -> "%02x".format(byte) }
    }

    /** Text or nothing: a file the reader cannot show is not half-shown. */
    private fun text(bytes: ByteArray): String {
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return try {
            decoder.decode(java.nio.ByteBuffer.wrap(bytes)).toString()
        } catch (_: CharacterCodingException) {
            throw Refused(UNAVAILABLE, "This file is not text")
        }
    }

    /**
     * Whether this entry is a symbolic link.
     *
     * Comparing the whole canonical path with the absolute one says yes for
     * every file on this platform, because the app's own data directory is
     * reached through a link. Only the leaf is the question here: the parent
     * has already been proven to be inside the root.
     */
    private fun isLink(file: File): Boolean = try {
        val parent = file.parentFile?.canonicalFile ?: return true
        file.canonicalFile != File(parent, file.name)
    } catch (_: IOException) {
        true
    }

    private fun join(path: String, name: String): String =
        if (path.isEmpty()) name else "$path/$name"

    private fun timestamp(millis: Long): String = synchronized(format) {
        format.format(Date(millis))
    }

    private companion object {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
        val UUID_PATTERN =
            Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        const val TRASH = ".trash"
        const val PAYLOAD = "payload"
        const val RECEIPT = "receipt.json"
        const val MAX_PATH_BYTES = 1024
        const val MAX_TEXT_BYTES = 1024 * 1024
        const val MAX_LIST_ENTRIES = 1000
        const val INVALID = "E_WORKSPACE_INVALID"
        const val NOT_FOUND = "E_WORKSPACE_NOT_FOUND"
        const val CONFLICT = "E_WORKSPACE_CONFLICT"
        const val PERSISTENCE = "E_WORKSPACE_PERSISTENCE"
        const val ROOT_CHANGED = "E_WORKSPACE_ROOT_CHANGED"
        const val UNAVAILABLE = "E_WORKSPACE_UNAVAILABLE"
    }
}
