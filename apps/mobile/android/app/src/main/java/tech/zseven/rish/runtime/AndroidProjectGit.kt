package tech.zseven.rish.runtime

import org.json.JSONObject

/**
 * The git panel over a workspace's project: `statusV2`, `diffV2`,
 * `stageAllV2`, `commitV2`.
 *
 * The rules are iOS's, request by request: the same keys, the same bounds on
 * a commit message and its author, the same HEAD expectation, the same error
 * numbers. What git itself reports is [RishLibgit2Native]'s; what this adds
 * is proving the root names a project this device holds before git is asked,
 * and stamping the answer with the root it was asked about.
 *
 * A refusal is [AndroidWorkspaceProjects.Refused], by iOS's number, so the
 * bridge reports both classes of failure through one mapping.
 */
internal class AndroidProjectGit(
    private val projects: AndroidWorkspaceProjects,
    private val workspaces: AndroidWorkspaceRegistry,
) {
    private class Opened(val root: JSONObject, val projectId: String, val gitDir: String, val workDir: String)

    fun status(rawRequest: JSONObject?): JSONObject {
        val request = exact(rawRequest, WORKSPACE_KEYS)
        val opened = open(request, write = false)
        return stamped(answer(RishLibgit2Native.status(opened.gitDir, opened.workDir)), opened)
    }

    fun diff(rawRequest: JSONObject?): JSONObject {
        val request = exact(rawRequest, DIFF_KEYS)
        val maxBytes = request.opt("max_bytes")
        val limit = when (maxBytes) {
            is Int -> maxBytes.toLong()
            is Long -> maxBytes
            else -> throw refused(REQUEST_INVALID, "git diff request is invalid")
        }
        if (limit < 1 || limit > MAX_DIFF_BYTES) throw refused(REQUEST_INVALID, "git diff request is invalid")
        val opened = open(request, write = false)
        val diff = answer(RishLibgit2Native.diff(opened.gitDir, opened.workDir, false, CONTEXT_LINES))
        // The patch is clipped to what the caller will take, on a character
        // boundary, and the clip counts as truncation.
        val clipped = RishAgentCoreNative.projectModuleReduce(
            JSONObject().put("op", "clip_utf8").put("value", diff.getString("patch"))
                .put("maximum_bytes", limit).toString(),
        )?.let { JSONObject(it) } ?: throw refused(NATIVE, "git diff failed")
        diff.put("patch", clipped.getString("value"))
        diff.put("truncated", diff.getBoolean("truncated") || clipped.optBoolean("truncated"))
        return stamped(diff, opened)
    }

    fun stageAll(rawRequest: JSONObject?): JSONObject {
        val request = exact(rawRequest, WORKSPACE_KEYS)
        val opened = open(request, write = true)
        return stamped(answer(RishLibgit2Native.stageAll(opened.gitDir, opened.workDir)), opened)
    }

    fun commit(rawRequest: JSONObject?): JSONObject {
        val request = exact(rawRequest, COMMIT_KEYS)
        val operationId = request.opt("operation_id") as? String
        val message = request.opt("message") as? String
        val name = request.opt("author_name") as? String
        val email = request.opt("author_email") as? String
        val expected = request.opt("expected_head_oid").takeIf { it != JSONObject.NULL }
        if (operationId == null || !projects.canonicalOperationId(operationId) ||
            message == null || !bounded(message, MAX_COMMIT_MESSAGE_BYTES) || message.isBlank() ||
            name == null || !bounded(name, MAX_AUTHOR_NAME_BYTES) || name.any { it.isWhitespace() } ||
            email == null || !bounded(email, MAX_EMAIL_BYTES) || !emailShaped(email) ||
            (expected != null && (expected !is String || !oid(expected)))
        ) {
            throw refused(REQUEST_INVALID, "git commit request is invalid")
        }
        val opened = open(request, write = true)
        val committed = answer(
            RishLibgit2Native.commit(opened.gitDir, opened.workDir, message, name, email, expected as String?),
        )
        return JSONObject().put("schema_version", 2).put("root", opened.root).put("project_id", opened.projectId)
            .put("oid", committed.getString("oid")).put("summary", message.lineSequence().first())
            .put("committed_at", RuntimeJson.now())
    }

    // --- shared ------------------------------------------------------------

    private fun exact(rawRequest: JSONObject?, keys: Set<String>): JSONObject {
        val request = rawRequest ?: throw refused(REQUEST_INVALID, "git request is missing")
        if (request.keys().asSequence().toSet() != keys || request.opt("schema_version") != 1) {
            throw refused(REQUEST_INVALID, "git request is invalid")
        }
        return request
    }

    /**
     * The root, proven: the binding beside the gitdir restates it, and the
     * workspace grants what the operation needs. `v2LeaseForRoot` on iOS.
     */
    private fun open(request: JSONObject, write: Boolean): Opened {
        if (!RishLibgit2Native.require()) throw refused(UNAVAILABLE, "libgit2 is not available")
        val root = projects.canonicalRoot(request.optJSONObject("root"), projectRequired = true)
        val workspaceId = root.getString("workspace_id")
        val projectId = root.getString("project_id")
        projects.verifiedDescriptor(root, projectId)
        val capabilities = workspaces.descriptor(workspaceId)?.optJSONObject("capabilities")
        val needed = if (write) listOf("read", "write", "git") else listOf("read", "git")
        if (capabilities == null || !needed.all { capabilities.optBoolean(it) }) {
            throw refused(UNAVAILABLE, "workspace project is unavailable")
        }
        val workDir = projects.workingTree(workspaceId) ?: throw refused(UNAVAILABLE, "workspace project is unavailable")
        return Opened(root, projectId, projects.gitDirectory(workspaceId, projectId).absolutePath, workDir.absolutePath)
    }

    private fun answer(bytes: ByteArray): JSONObject {
        val reply = JSONObject(String(bytes, Charsets.UTF_8))
        if (!reply.optBoolean("ok")) {
            throw refused(reply.optInt("number", NATIVE), "git ${reply.optString("stage")} failed")
        }
        reply.remove("ok")
        return reply
    }

    private fun stamped(reply: JSONObject, opened: Opened): JSONObject =
        reply.put("schema_version", 2).put("root", opened.root).put("project_id", opened.projectId)

    private fun refused(number: Int, reason: String) = AndroidWorkspaceProjects.Refused(number, reason)

    private fun bounded(value: String, maximumBytes: Int): Boolean =
        value.isNotEmpty() && value.toByteArray(Charsets.UTF_8).size <= maximumBytes

    /** iOS's shape: one `@` with something on both sides, no whitespace, no angle brackets. */
    private fun emailShaped(value: String): Boolean {
        val parts = value.split("@")
        return parts.size == 2 && parts[0].isNotEmpty() && parts[1].isNotEmpty() &&
            value.none { it.isWhitespace() } && '<' !in value && '>' !in value
    }

    private fun oid(value: String): Boolean = value.length == 40 && value.all { it in '0'..'9' || it in 'a'..'f' }

    companion object {
        private const val REQUEST_INVALID = AndroidWorkspaceProjects.REQUEST_INVALID
        private const val UNAVAILABLE = AndroidWorkspaceProjects.UNAVAILABLE
        private const val NATIVE = 3199
        private const val CONTEXT_LINES = 3
        private const val MAX_DIFF_BYTES = 1024L * 1024
        private const val MAX_COMMIT_MESSAGE_BYTES = 500
        private const val MAX_AUTHOR_NAME_BYTES = 120
        private const val MAX_EMAIL_BYTES = 254
        private val WORKSPACE_KEYS = setOf("schema_version", "root")
        private val DIFF_KEYS = setOf("schema_version", "root", "max_bytes")
        private val COMMIT_KEYS = setOf(
            "schema_version", "root", "operation_id", "message", "author_name", "author_email", "expected_head_oid",
        )
    }
}
