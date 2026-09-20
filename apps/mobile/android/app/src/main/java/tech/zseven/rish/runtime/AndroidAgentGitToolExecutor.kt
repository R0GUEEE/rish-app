package tech.zseven.rish.runtime

import org.json.JSONArray
import org.json.JSONObject
import java.util.TimeZone

/**
 * The agent's `git_status` and `git_commit` over a workspace's project.
 *
 * Mirrors `AgentGitToolExecutor.mm` for the two tools this platform can run
 * without a network: what a call asserts before it runs (the precondition
 * the ledger holds and a person approves), what it does, and what recovery
 * can conclude afterwards. The commit's object id is predicted by the core
 * before libgit2 writes anything and the commit is made only if it comes
 * out with that id, so a crash between the object and the ledger row leaves
 * exactly the id recovery looks for. `git_push` stays unserved here.
 *
 * Refusals use [AndroidWorkspaceToolExecutor.Refused] so the batch and
 * execution services map them the way they map every other tool's.
 */
internal class AndroidAgentGitToolExecutor(
    private val projects: AndroidWorkspaceProjects,
    private val workspaces: AndroidWorkspaceRegistry,
    private val roots: AndroidAgentRootResolver,
) {
    val tools: List<String> = listOf("git_status", "git_commit")

    private class Opened(val gitDir: String, val workDir: String)

    fun prepare(name: String, arguments: JSONObject, root: JSONObject): JSONObject {
        val opened = open(name, root)
        return when (name) {
            "git_status" -> {
                if (arguments.length() != 0) throw refused(INVALID)
                val status = status(opened)
                JSONObject().put("schema_version", 1).put("reserved_write_bytes", 0).put(
                    "precondition",
                    JSONObject().put("schema_version", 1).put("kind", "git_status").put("head_oid", status.opt("head_oid")),
                )
            }
            "git_commit" -> {
                val message = commitMessage(arguments)
                val branch = branch(opened)
                val preHead = branch.opt("head_oid").takeIf { it != JSONObject.NULL } as? String
                val staged = stage(opened)
                val tree = staged.getString("tree_oid")
                val indexDigest = indexDigest(staged.getJSONArray("entries"))
                val messageBytes = message.toByteArray(Charsets.UTF_8)
                val messageDigest = RishAgentCoreNative.hashBytes("commit-message", messageBytes) ?: throw refused(PERSISTENCE)
                val identity = JSONObject().put("schema_version", 1).put("name", "Rish Agent").put("email", "agent@rish.local")
                    .put("timestamp_seconds", System.currentTimeMillis() / 1000)
                    .put("timezone_offset", timezoneString(TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000))
                val parents = JSONArray().apply { if (preHead != null) put(preHead) }
                val commit = commitIdentity(tree, parents, identity, message)
                JSONObject().put("schema_version", 1).put("reserved_write_bytes", 0).put(
                    "precondition",
                    JSONObject().put("schema_version", 2).put("kind", "git_commit").put("object_format", "sha1")
                        .put("pre_head_oid", preHead ?: JSONObject.NULL).put("ordered_parent_oids", parents)
                        .put("staged_index_sha256", indexDigest).put("tree_oid", tree)
                        .put("author", identity).put("committer", identity)
                        .put("message_blob_ref", messageDigest).put("message_sha256", messageDigest)
                        .put("message_bytes", messageBytes.size).put("encoding_header", "UTF-8")
                        .put("signature_policy", "unsigned").put("extra_headers", JSONArray()).put("stage_all", true)
                        .put("commit_payload_sha256", commit.getString("commit_payload_sha256"))
                        .put("expected_commit_oid", commit.getString("expected_commit_oid")),
                )
            }
            else -> throw refused(INVALID)
        }
    }

    fun execute(name: String, arguments: JSONObject, root: JSONObject, precondition: JSONObject?): JSONObject {
        if (precondition == null || precondition.opt("kind") != name) throw refused(INVALID)
        val opened = open(name, root)
        return when (name) {
            "git_status" -> {
                val status = status(opened)
                // The model-facing payload is exactly the six keys the core's
                // feedback rule names; the native reply's `ok` is transport,
                // and with it in place the ledger refuses to settle the row.
                val payload = JSONObject().put("schema_version", 1)
                for (key in listOf("branch", "head_oid", "clean", "has_conflicts", "entry_count")) payload.put(key, status.get(key))
                effect(
                    feedback(name, payload),
                    JSONObject().put("schema_version", 1).put("kind", "git_status").put("head_oid", status.opt("head_oid")),
                    mayHaveOccurred = false,
                )
            }
            "git_commit" -> {
                val message = commitMessage(arguments)
                val staged = stage(opened)
                val tree = staged.getString("tree_oid")
                if (tree != precondition.optString("tree_oid") ||
                    indexDigest(staged.getJSONArray("entries")) != precondition.optString("staged_index_sha256")
                ) {
                    return failure(name, "E_AGENT_CONFLICT", ambiguous = false)
                }
                val identity = precondition.getJSONObject("author")
                val minutes = timezoneMinutes(identity.getString("timezone_offset"))
                val expectedHead = precondition.opt("pre_head_oid").takeIf { it != JSONObject.NULL } as? String
                val reply = JSONObject(
                    String(
                        RishLibgit2Native.agentCommit(
                            opened.gitDir, opened.workDir, message, identity.getLong("timestamp_seconds"), minutes,
                            expectedHead, tree, precondition.getString("expected_commit_oid"),
                        ),
                        Charsets.UTF_8,
                    ),
                )
                if (!reply.optBoolean("ok")) {
                    return when (reply.optString("failure")) {
                        "conflict" -> failure(name, "E_AGENT_CONFLICT", ambiguous = false)
                        "ambiguous" -> failure(name, "E_AGENT_EXECUTION_AMBIGUOUS", ambiguous = true)
                        else -> failure(name, "E_AGENT_TOOL_FAILED", ambiguous = false)
                    }
                }
                val commit = reply.getString("commit_oid")
                effect(
                    feedback(name, JSONObject().put("schema_version", 1).put("commit_oid", commit).put("tree_oid", tree)),
                    JSONObject().put("schema_version", 1).put("kind", "git_commit").put("actual_commit_oid", commit),
                    mayHaveOccurred = true,
                )
            }
            else -> throw refused(INVALID)
        }
    }

    /** What recovery can tell about a commit that may or may not have landed. */
    fun recover(name: String, arguments: JSONObject, root: JSONObject, precondition: JSONObject?): JSONObject {
        if (name != "git_commit" || precondition == null) return status("not_dispatched")
        val opened = open(name, root)
        val head = branch(opened).opt("head_oid").takeIf { it != JSONObject.NULL } as? String
        if (head != null && head == precondition.optString("expected_commit_oid")) {
            return status("settled").put("actual_commit_oid", head)
        }
        val prior = precondition.opt("pre_head_oid").takeIf { it != JSONObject.NULL } as? String
        if (prior == head) {
            // HEAD is where the call found it. The commit was never made only
            // if everything it would have been made from is still the same.
            val message = arguments.opt("message") as? String ?: return status("ambiguous")
            val staged = try { stage(opened) } catch (_: AndroidWorkspaceToolExecutor.Refused) { return status("ambiguous") }
            val tree = staged.getString("tree_oid")
            val messageBytes = message.toByteArray(Charsets.UTF_8)
            val messageDigest = RishAgentCoreNative.hashBytes("commit-message", messageBytes)
            val commit = try {
                commitIdentity(tree, precondition.getJSONArray("ordered_parent_oids"), precondition.getJSONObject("author"), message)
            } catch (_: Exception) { null }
            val frozen = commit != null &&
                indexDigest(staged.getJSONArray("entries")) == precondition.optString("staged_index_sha256") &&
                tree == precondition.optString("tree_oid") &&
                messageDigest == precondition.optString("message_sha256") &&
                messageBytes.size == precondition.optInt("message_bytes", -1) &&
                commit.optString("commit_payload_sha256") == precondition.optString("commit_payload_sha256") &&
                commit.optString("expected_commit_oid") == precondition.optString("expected_commit_oid")
            return status(if (frozen) "not_dispatched" else "ambiguous")
        }
        return status("ambiguous")
    }

    // --- the root ------------------------------------------------------------

    /**
     * The project the root names, re-proven: the projection resolves, is a
     * project, and carries the capability this tool needs.
     */
    private fun open(name: String, root: JSONObject): Opened {
        if (!RishLibgit2Native.require()) throw refused(CONFLICT)
        val resolved = roots.resolveAgentProjection(root) ?: throw refused(CONFLICT)
        if (resolved.optString("kind") != "project") throw refused(INVALID)
        val capabilities = resolved.optJSONArray("capabilities") ?: JSONArray()
        if ((0 until capabilities.length()).none { capabilities.optString(it) == name }) throw refused(CONFLICT)
        val workspaceId = resolved.getString("workspace_id")
        val projectId = resolved.getString("project_id")
        val workDir = workspaces.rootFor(workspaceId) ?: throw refused(CONFLICT)
        return Opened(projects.gitDirectory(workspaceId, projectId).absolutePath, workDir.absolutePath)
    }

    // --- git, through libgit2 -------------------------------------------------

    private fun native(bytes: ByteArray): JSONObject {
        val reply = JSONObject(String(bytes, Charsets.UTF_8))
        if (!reply.optBoolean("ok")) throw refused(PERSISTENCE)
        return reply
    }

    private fun branch(opened: Opened) = native(RishLibgit2Native.agentBranch(opened.gitDir, opened.workDir))
    private fun status(opened: Opened) = native(RishLibgit2Native.agentStatus(opened.gitDir, opened.workDir))
    private fun stage(opened: Opened) = native(RishLibgit2Native.agentStage(opened.gitDir, opened.workDir))

    // --- the core's rules -----------------------------------------------------

    private fun gitRule(envelope: JSONObject): JSONObject {
        val reply = RishAgentCoreNative.gitToolReduce(envelope.toString())?.let { JSONObject(it) } ?: throw refused(PERSISTENCE)
        if (!reply.optBoolean("ok")) throw refused(INVALID)
        return reply
    }

    private fun indexDigest(entries: JSONArray): String =
        gitRule(JSONObject().put("op", "index_digest").put("entries", entries)).getString("staged_index_sha256")

    private fun commitIdentity(tree: String, parents: JSONArray, identity: JSONObject, message: String): JSONObject =
        gitRule(
            JSONObject().put("op", "commit_identity").put("tree_oid", tree).put("parents", parents)
                .put("timestamp_seconds", identity.get("timestamp_seconds").toString())
                .put("timezone_offset", identity.optString("timezone_offset")).put("message", message),
        )

    private fun timezoneString(minutes: Int): String =
        gitRule(JSONObject().put("op", "timezone_string").put("minutes", minutes)).optString("timezone_offset", "+0000")

    private fun timezoneMinutes(offset: String): Int =
        gitRule(JSONObject().put("op", "timezone_minutes").put("timezone_offset", offset)).getInt("minutes")

    private fun failure(name: String, code: String, ambiguous: Boolean): JSONObject =
        gitRule(JSONObject().put("op", "failure_result").put("name", name).put("failure_code", code).put("ambiguous", ambiguous))
            .getJSONObject("result")

    /**
     * `DSHAgentGitCanonicalFeedback`: the model-facing object as the core's
     * canonical JSON string. The workspace tools' `feedback` op knows only
     * their three names; the ledger holds every tool's string to the same
     * feedback contract when it settles, which is where iOS's check lands too.
     */
    private fun feedback(name: String, payload: JSONObject): String =
        RishAgentCoreNative.canonical(
            JSONObject().put("schema_version", 1).put("name", name).put("outcome", "ok").put("payload", payload).toString(),
        )?.takeIf { it.isNotEmpty() } ?: throw refused(PERSISTENCE)

    private fun effect(feedback: String, settledFacts: JSONObject, mayHaveOccurred: Boolean): JSONObject =
        JSONObject().put("schema_version", 1).put("status", "ok").put("feedback", feedback)
            .put("settled_facts", settledFacts).put("truncated", false).put("effect_may_have_occurred", mayHaveOccurred)

    private fun status(value: String): JSONObject = JSONObject().put("schema_version", 1).put("status", value)

    /** iOS's bound: exactly `message`, at most 500 bytes, not empty. */
    private fun commitMessage(arguments: JSONObject): String {
        val message = arguments.opt("message") as? String
        if (arguments.keys().asSequence().toSet() != setOf("message") || message == null || message.isEmpty() ||
            message.toByteArray(Charsets.UTF_8).size > 500
        ) {
            throw refused(INVALID)
        }
        return message
    }

    private fun refused(code: String) = AndroidWorkspaceToolExecutor.Refused(code)

    private companion object {
        // The workspace executor's vocabulary, which the services map.
        const val INVALID = "E_AGENT_BAD_ARGUMENTS"
        const val CONFLICT = "E_AGENT_CONFLICT"
        const val PERSISTENCE = "E_AGENT_PERSISTENCE"
    }
}
