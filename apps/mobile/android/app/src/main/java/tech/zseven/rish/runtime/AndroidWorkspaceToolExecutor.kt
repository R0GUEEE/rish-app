package tech.zseven.rish.runtime

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException

/**
 * The file work an agent does inside a workspace it is bound to.
 *
 * Mirrors modules/rish/ios/Sources/AgentWorkspaceToolExecutor.mm. Every rule is
 * the core's and asked for: which path components a tool argument may name, how
 * many bytes may be read, how a file revision is spelled. What is left here is
 * the mechanism -- opening, reading, writing, listing -- and the containment
 * that keeps all of it under one root.
 *
 * **Containment, and where it is weaker than iOS.** The core's path rule makes
 * an escape by `..` impossible: a component that is `.`, `..`, `.git` or
 * `.trash` is refused, and so is a leading slash, a backslash, a NUL, a
 * non-NFC spelling and any control or format character. That leaves symbolic
 * links, and iOS closes those with `openat` against a frozen root descriptor,
 * so the check and the open cannot disagree. Here the resolved path is compared
 * against the root's canonical path before the file is touched, which is a
 * check and then an open: a link swapped between the two would not be caught.
 *
 * That is sound for a workspace this app owns -- it lives under `filesDir`,
 * where nothing but this app can create anything, and the only writer is this
 * executor, which writes regular files. It stops being sound the day a folder
 * the person granted through the Storage Access Framework becomes a workspace
 * root, and that is the day this needs the descriptor discipline instead.
 */
internal class AndroidWorkspaceToolExecutor(
    private val workspaces: AndroidWorkspaceRegistry,
    private val roots: AndroidAgentRootResolver,
) {

    /** A refusal carrying the agent's vocabulary rather than a message. */
    class Refused(val code: String) : Exception(code)

    /** The three tools a workspace root carries. */
    val tools: List<String> = listOf("read_file", "write_file", "list_dir")

    private fun rule(request: JSONObject): JSONObject =
        RishAgentCoreNative.workspaceTool(request) ?: throw Refused(INVALID)

    private fun bounds(): JSONObject = rule(JSONObject().put("op", "bounds"))

    /**
     * The components of a tool's path argument, decided by the core. `list_dir`
     * may name the root itself; a file tool never can.
     */
    private fun components(path: String, allowRoot: Boolean): List<String> {
        val reply = rule(
            JSONObject().put("op", "path_components").put("path", path)
                .put("allow_root", allowRoot),
        )
        val array = reply.optJSONArray("components") ?: throw Refused(INVALID)
        return (0 until array.length()).map { array.getString(it) }
    }

    /**
     * The file a path names, or a refusal. The canonical path is compared
     * before anything is opened; see the note on containment above.
     */
    private fun resolve(root: File, components: List<String>): File {
        var target = root
        for (component in components) target = File(target, component)
        val canonicalRoot = try {
            root.canonicalFile
        } catch (_: IOException) {
            throw Refused(PERSISTENCE)
        }
        // A file that does not exist yet has no canonical path of its own, so
        // the parent is what has to be inside the root; the leaf is a name.
        val probe = if (target.exists()) target else target.parentFile ?: throw Refused(INVALID)
        val canonical = try {
            probe.canonicalFile
        } catch (_: IOException) {
            throw Refused(PERSISTENCE)
        }
        if (canonical != canonicalRoot && !canonical.path.startsWith(canonicalRoot.path + File.separator)) {
            throw Refused(CONFLICT)
        }
        return target
    }

    /** `dev:ino:size:mtime_sec:mtime_nsec`, spelled by the core. */
    private fun revision(file: File): String {
        // Android exposes no st_dev or st_ino through java.io, and the rule
        // only requires the five numbers to identify a file state, so the
        // fields this platform cannot read are reported as zero rather than
        // invented. A file that changed still changes size or mtime.
        val reply = rule(
            JSONObject().put("op", "revision").put("dev", 0).put("ino", 0)
                .put("size", file.length()).put("mtime_sec", file.lastModified() / 1000)
                .put("mtime_nsec", (file.lastModified() % 1000) * 1_000_000),
        )
        return reply.optString("revision").ifEmpty { throw Refused(INVALID) }
    }

    /**
     * Runs one tool against the root a binding resolves to.
     *
     * `root` is the agent root reference, not a path: which directory it names
     * is the resolver's answer, and a request naming a project or a workspace
     * this device does not hold is refused there rather than here.
     */
    fun execute(name: String, arguments: JSONObject, root: JSONObject): JSONObject {
        if (name !in tools) throw Refused(INVALID)
        val workspaceId = root.optString("workspace_id").takeIf { it.isNotEmpty() }
        // The projection carries the authority -- which grants this root has,
        // and the fingerprint the registry sealed it under. It deliberately
        // carries no path: where the directory is stays with the registry, and
        // a path is not something JavaScript's root reference should imply.
        val resolved = roots.resolve(
            workspaceId = workspaceId,
            projectId = root.opt("project_id")?.takeIf { it != JSONObject.NULL } as? String,
            bindingRevision = root.opt("binding_revision") as? Int,
        ) ?: throw Refused(CONFLICT)
        val directory = workspaces.rootFor(workspaceId ?: throw Refused(CONFLICT))
            ?: throw Refused(CONFLICT)
        if (!directory.isDirectory) throw Refused(CONFLICT)

        // A capability the binding does not carry is a conflict, not an
        // invalid argument: the tool is real and the root simply may not. The
        // names are the projection's -- `file_read` and `file_write`, what a
        // tool may do -- not the registry's `read`/`write` grants, which are
        // about the binding. Checking the wrong list accepted every tool.
        val capabilities = resolved.optJSONArray("capabilities") ?: JSONArray()
        val needed = if (name == "write_file") "file_write" else "file_read"
        if ((0 until capabilities.length()).none { capabilities.optString(it) == needed }) {
            throw Refused(CONFLICT)
        }

        return when (name) {
            "read_file" -> readFile(directory, arguments)
            "write_file" -> writeFile(directory, arguments)
            else -> listDir(directory, arguments)
        }
    }

    private fun path(arguments: JSONObject, key: String = "path"): String {
        val value = arguments.opt(key)
        if (value !is String) throw Refused(INVALID)
        return value
    }

    private fun readFile(root: File, arguments: JSONObject): JSONObject {
        if (arguments.keys().asSequence().toSet() != setOf("path")) throw Refused(INVALID)
        val file = resolve(root, components(path(arguments), allowRoot = false))
        if (!file.isFile) throw Refused(NOT_FOUND)
        val cap = bounds().getInt("max_read_bytes")
        val bytes = try {
            file.inputStream().use { stream ->
                // One byte past the cap, so a file exactly at the cap is not
                // reported as truncated and one over it is.
                val buffer = ByteArray(cap + 1)
                var read = 0
                while (read < buffer.size) {
                    val n = stream.read(buffer, read, buffer.size - read)
                    if (n < 0) break
                    read += n
                }
                buffer.copyOf(read)
            }
        } catch (_: IOException) {
            throw Refused(PERSISTENCE)
        }
        val truncated = bytes.size > cap
        val content = String(if (truncated) bytes.copyOf(cap) else bytes, Charsets.UTF_8)
        return JSONObject().put("schema_version", 1).put("kind", "file_read")
            .put("content", content).put("truncated", truncated)
            .put("revision", revision(file))
    }

    private fun writeFile(root: File, arguments: JSONObject): JSONObject {
        if (arguments.keys().asSequence().toSet() != setOf("path", "content")) throw Refused(INVALID)
        val content = arguments.opt("content")
        if (content !is String) throw Refused(INVALID)
        val file = resolve(root, components(path(arguments), allowRoot = false))
        if (file.exists() && !file.isFile) throw Refused(CONFLICT)
        val parent = file.parentFile ?: throw Refused(INVALID)
        if (!parent.isDirectory && !parent.mkdirs()) throw Refused(PERSISTENCE)
        // Written beside the target and renamed, so a crash leaves the old
        // file rather than half of the new one.
        val staging = File(parent, "${file.name}.rish-staging")
        try {
            staging.outputStream().use { out ->
                out.write(content.toByteArray(Charsets.UTF_8))
                out.fd.sync()
            }
            if (!staging.renameTo(file)) {
                staging.delete()
                throw Refused(PERSISTENCE)
            }
        } catch (_: IOException) {
            staging.delete()
            throw Refused(PERSISTENCE)
        }
        return JSONObject().put("schema_version", 1).put("kind", "file_write")
            .put("revision", revision(file))
    }

    private fun listDir(root: File, arguments: JSONObject): JSONObject {
        val keys = arguments.keys().asSequence().toSet()
        if (keys.isNotEmpty() && keys != setOf("path")) throw Refused(INVALID)
        val requested = if (keys.isEmpty()) "" else path(arguments)
        val directory = resolve(root, components(requested, allowRoot = true))
        if (!directory.isDirectory) throw Refused(NOT_FOUND)
        val children = directory.listFiles() ?: throw Refused(PERSISTENCE)
        val entries = JSONArray()
        // Which entries a listing includes, and when it is full, is the rule's.
        // Sorted first so two devices reading one directory agree on what the
        // cap left out.
        for (child in children.sortedBy { it.name }) {
            val decision = rule(
                JSONObject().put("op", "directory_entry_decision")
                    .put("visible_count", entries.length())
                    .put(
                        "entry",
                        JSONObject().put("name", child.name)
                            .put("kind", if (child.isDirectory) "directory" else "file")
                            .put("revision", revision(child)),
                    ),
            )
            when (decision.optString("decision")) {
                "include" -> entries.put(
                    JSONObject().put("name", child.name)
                        .put("kind", if (child.isDirectory) "directory" else "file"),
                )
                "skip" -> Unit
                else -> break
            }
        }
        return JSONObject().put("schema_version", 1).put("kind", "directory_list")
            .put("entries", entries)
    }

    private companion object {
        const val INVALID = "E_AGENT_BAD_ARGUMENTS"
        const val CONFLICT = "E_AGENT_CONFLICT"
        const val NOT_FOUND = "E_AGENT_NOT_FOUND"
        const val PERSISTENCE = "E_AGENT_PERSISTENCE"
    }
}
