package tech.zseven.rish

import org.json.JSONArray
import org.json.JSONObject
import tech.zseven.rish.runtime.AndroidSessionStore
import tech.zseven.rish.runtime.RishAgentCoreNative
import java.util.UUID

/**
 * The committed session fixture the agent tests share.
 *
 * A schema-9 session carrying one conversation, one turn, one user message and
 * one prepared attempt -- the smallest shape the core accepts as a session an
 * attempt can be prepared against. It lives here rather than in one test
 * because more than one test now needs the *same* session: a fixture that
 * drifted between them would let a rule pass in one file and fail in another
 * for reasons that had nothing to do with the rule.
 */
internal object AgentSessionFixture {

    const val MODEL = "deepseek-v4-flash"
    const val THINKING = "off"
    const val STAMP = "2026-09-16T00:00:00.000Z"

    data class Ids(
        val operation: String = UUID.randomUUID().toString(),
        val task: String = UUID.randomUUID().toString(),
        val conversation: String = UUID.randomUUID().toString(),
        val attempt: String = UUID.randomUUID().toString(),
        val message: String = UUID.randomUUID().toString(),
    )

    fun session(ids: Ids, epoch: Int = 0, workspace: String? = null): JSONObject {
        val message = JSONObject().put("id", ids.message).put("role", "user")
            .put("text", "hello").put("created_at", STAMP)
            .put("attachments", JSONArray())
        val attempt = JSONObject().put("schema_version", 3)
            .put("attempt_id", ids.attempt).put("turn_id", ids.task)
            .put("status", "prepared")
            .put("visible_message_ids", JSONArray().put(ids.message))
            // A prepared attempt with no rounds carries no history digest:
            // the digest only becomes meaningful once a round was sent, and
            // the session schema refuses one without that provenance.
            .put("visible_history_sha256", JSONObject.NULL)
            .put("attachment_ids", JSONArray())
            .put("model_id", MODEL).put("thinking_mode", THINKING)
            .put("context_disposition", "unbound")
            .put("context_project_id", JSONObject.NULL)
            .put("project_context", JSONObject.NULL)
            .put("active_round", JSONObject.NULL).put("rounds", JSONArray())
            .put("assistant_message_id", JSONObject.NULL)
            .put("failure_code", JSONObject.NULL)
            .put("created_at", STAMP).put("updated_at", STAMP)
            .put("workspace_id", workspace ?: JSONObject.NULL)
            .put("workspace_binding_revision", if (workspace == null) JSONObject.NULL else 1)
            .put("journal_revision", 0).put("agent", JSONObject.NULL)
        val conversation = JSONObject().put("id", ids.conversation)
            .put("project_id", JSONObject.NULL)
            .put("workspace_id", workspace ?: JSONObject.NULL)
            .put("runtime_context_id", JSONObject.NULL)
            .put("project_context", JSONObject.NULL)
            .put("title", "t").put("title_source", "auto")
            .put("model_id", MODEL).put("thinking_mode", THINKING)
            .put("messages", JSONArray().put(message))
            // An attempt must belong to a turn, and the turn's user message
            // is what fixes the visible history the attempt may claim.
            .put("turns", JSONArray().put(JSONObject().put("schema_version", 1)
                .put("turn_id", ids.task).put("user_message_id", ids.message)
                .put("attempt_ids", JSONArray().put(ids.attempt))
                .put("created_at", STAMP)))
            .put("attempts", JSONArray().put(attempt))
            .put("created_at", STAMP).put("updated_at", STAMP)
            .put(
                "workspace_binding",
                if (workspace == null) JSONObject.NULL
                else JSONObject().put("schema_version", 1)
                    .put("workspace_id", workspace).put("binding_revision", 1)
                    .put("project_id", JSONObject.NULL),
            )
            .put("workspace_bootstrap_state", "none")
            .put("agent_grants", JSONArray())
        return JSONObject().put("schema_version", 9)
            .put("workspace_authority_outbox", JSONArray())
            .put("agent_transcript_cleanup_outbox", JSONArray())
            .put("project_context_destructive_epoch", epoch)
            .put("project_context_destructive_transition", JSONObject.NULL)
            .put("active_conversation_id", JSONObject.NULL)
            .put("conversations", JSONArray().put(conversation))
            .put("messages", JSONArray())
            .put("session_events", JSONArray())
            .put("preferences", JSONObject().put("schema_version", 1)
                .put("theme_mode", "system").put("locale", "system")
                .put("default_model", MODEL).put("thinking_mode", THINKING)
                .put("tool_permission", "read-only").put("show_reasoning", false)
                .put("auto_expand_tools", false)
                .put("confirm_destructive_file_actions", true))
    }
    /**
     * Commits the fixture and answers the snapshot reference. The bytes are
     * canonicalised first: the stores read the committed session's *exact*
     * bytes and refuse anything that is not its own canonical form, which is
     * also what the real controller writes.
     */
    fun commit(
        store: AndroidSessionStore,
        ids: Ids,
        epoch: Int = 0,
        expected: JSONObject? = null,
        workspace: String? = null,
    ): JSONObject {
        val candidate = RishAgentCoreNative.canonical(session(ids, epoch, workspace).toString())
            ?: error("the session fixture is not canonicalisable")
        val reply = store.persist(
            JSONObject().put("schema_version", 1)
                .put("operation_id", UUID.randomUUID().toString())
                .put(
                    "expected",
                    expected ?: JSONObject().put("schema_version", 1).put("kind", "missing"),
                )
                .put("candidate_json", candidate),
        )
        check(reply.getString("status") == "committed") {
            "the session fixture was not committed: ${reply}"
        }
        return reply.getJSONObject("snapshot")
    }

    /** The CAS a second commit asserts against an already-stored snapshot. */
    fun expecting(snapshot: JSONObject): JSONObject = JSONObject()
        .put("schema_version", 1).put("kind", "present")
        .put(
            "snapshot",
            JSONObject().put("schema_version", 1)
                .put("generation", snapshot.getLong("generation"))
                .put("session_sha256", snapshot.getString("session_sha256")),
        )

    /** The checkpoint a request carries for a committed snapshot. */
    fun checkpoint(snapshot: JSONObject, journalRevision: Int = 0): JSONObject = JSONObject()
        .put("schema_version", 1)
        .put("journal_revision", journalRevision)
        .put("session_generation", snapshot.getLong("generation"))
        .put("session_sha256", snapshot.getString("session_sha256"))
}
