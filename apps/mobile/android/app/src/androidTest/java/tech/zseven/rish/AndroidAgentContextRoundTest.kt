package tech.zseven.rish

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import tech.zseven.rish.runtime.AndroidAgentOperations
import tech.zseven.rish.runtime.AndroidAgentProviderRoundService
import tech.zseven.rish.runtime.AndroidAgentRootResolver
import tech.zseven.rish.runtime.AndroidAgentRoundJournal
import tech.zseven.rish.runtime.AndroidAgentToolRegistry
import tech.zseven.rish.runtime.AndroidAgentTranscriptStore
import tech.zseven.rish.runtime.AndroidAgentWal
import tech.zseven.rish.runtime.AndroidCredentialStore
import tech.zseven.rish.runtime.AndroidLiveTasks
import tech.zseven.rish.runtime.AndroidModelTransport
import tech.zseven.rish.runtime.AndroidPreparedAttemptStore
import tech.zseven.rish.runtime.AndroidProjectContextSnapshots
import tech.zseven.rish.runtime.AndroidProjectContextStore
import tech.zseven.rish.runtime.AndroidProviderConfiguration
import tech.zseven.rish.runtime.AndroidSessionStore
import tech.zseven.rish.runtime.AndroidWorkspaceProjects
import tech.zseven.rish.runtime.AndroidWorkspaceRegistry
import tech.zseven.rish.runtime.RishAgentCoreNative
import tech.zseven.rish.runtime.RishLibgit2Native
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A complete agent round with a project context attached, on a device: the
 * snapshot is prepared and confirmed, the attempt records it, the round is
 * prepared against the project root, and `complete_agent_round_v2` at
 * transport schema 3 sends the verified envelope to the provider ahead of
 * the conversation and journals the receipt for it.
 *
 * Until this existed nothing had shown a round completing on this platform
 * at all; the round test says so. The provider is a socket on this device,
 * so what went out is read back byte for byte.
 */
@RunWith(AndroidJUnit4::class)
class AndroidAgentContextRoundTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    /** A provider that records one request and answers a fixed chat-completions stream. */
    private class Provider(private val reply: String) {
        val socket: ServerSocket = ServerSocket().apply {
            reuseAddress = true
            bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
        }
        val served = CountDownLatch(1)
        @Volatile var request: String = ""

        fun start() {
            Thread {
                socket.use { server ->
                    server.accept().use { client ->
                        val input = client.getInputStream()
                        val head = StringBuilder()
                        while (!head.endsWith("\r\n\r\n")) {
                            val next = input.read()
                            if (next < 0) return@use
                            head.append(next.toChar())
                        }
                        val length = Regex("(?i)content-length: *(\\d+)").find(head)?.groupValues?.get(1)?.toInt() ?: 0
                        val body = ByteArray(length)
                        var read = 0
                        while (read < length) {
                            val count = input.read(body, read, length - read)
                            if (count < 0) break
                            read += count
                        }
                        request = head.toString() + String(body, Charsets.UTF_8)
                        val out = client.getOutputStream()
                        out.write(
                            ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n" +
                                "Content-Length: ${reply.toByteArray().size}\r\n\r\n").toByteArray(),
                        )
                        out.write(reply.toByteArray(Charsets.UTF_8))
                        out.flush()
                        served.countDown()
                    }
                }
            }.apply { isDaemon = true }.start()
        }
    }

    @Test
    fun aRoundWithAProjectContextSendsTheVerifiedEnvelopeFirstAndJournalsItsReceipt() {
        assumeTrue("rish agent core is not staged in this build", RishAgentCoreNative.available)
        assumeTrue("libgit2 is not staged in this build", RishLibgit2Native.available)
        val scratch = File(context.noBackupFilesDir, "context-round-${UUID.randomUUID()}").apply { mkdirs() }
        val databaseName = "context-round-${UUID.randomUUID()}.db"
        val sessions = AndroidSessionStore(context, databaseName)
        try {
            val wal = AndroidAgentWal(File(scratch, "wal").apply { mkdirs() })
            val workspaces = AndroidWorkspaceRegistry(File(scratch, "registry").apply { mkdirs() })
            val projects = AndroidWorkspaceProjects(workspaces)
            val roots = AndroidAgentRootResolver(workspaces, projects)
            val snapshots = AndroidProjectContextSnapshots(projects, roots, AndroidProjectContextStore(File(scratch, "project-context")))

            // A workspace with a project and one file, snapshotted and confirmed.
            val workspaceId = workspaces.create("Scratch").getString("workspace_id")
            val projectId = projects.attach(
                JSONObject().put("schema_version", 1).put("operation_id", UUID.randomUUID().toString()).put("mode", "init")
                    .put("root", rootRef(workspaceId, null)),
            ).getJSONObject("project").getString("project_id")
            val workDir = workspaces.rootFor(workspaceId)!!
            File(workDir, "README.md").writeText("# the project\n")
            assertEquals("ok", RishLibgit2Native.stagePath(projects.gitDirectory(workspaceId, projectId).absolutePath, workDir.absolutePath, "README.md"))
            val runtimeContextId = UUID.randomUUID().toString()
            val manifest = snapshots.prepare(
                JSONObject().put("schema_version", 2).put("root", rootRef(workspaceId, projectId))
                    .put("conversation_id", runtimeContextId).put("model_id", MODEL).put("policy", "chat-read-v1")
                    .put("selected_paths", JSONArray().put("README.md")),
            )
            val snapshotId = manifest.getString("snapshot_id")
            val consent = snapshots.confirm(JSONObject().put("schema_version", 2).put("snapshot_id", snapshotId).put("root", rootRef(workspaceId, projectId)))

            // The attempt records that snapshot, as JavaScript records it.
            val ids = AgentSessionFixture.Ids()
            val attemptContext = JSONObject().put("schema_version", 1).put("runtime_context_id", runtimeContextId)
                .put("project_id", projectId).put("snapshot_id", snapshotId)
                .put("snapshot_sha256", manifest.getString("snapshot_sha256"))
                .put("source_fingerprint", manifest.getString("source_fingerprint"))
                .put("context_bytes", manifest.getInt("context_bytes"))
                .put("consent_receipt_id", consent.getString("consent_receipt_id"))
                .put("provider", "openai").put("policy", "chat-read-v1").put("policy_version", "chat-read-v1.0.0")
            val first = AgentSessionFixture.commit(sessions, ids, workspace = workspaceId, model = MODEL, attemptContext = attemptContext)

            // Prepared against the project root, at transport schema 3.
            val prepared = AndroidPreparedAttemptStore(sessions, wal, roots)
            val preparation = prepared.prepareAgentAttempt(
                JSONObject().put("schema_version", 2).put("operation_id", ids.operation)
                    .put("controller_cas", controllerCas(ids, first, 0, 0))
                    .put("committed_checkpoint", AgentSessionFixture.checkpoint(first, 0))
                    .put("task_id", ids.task).put("conversation_id", ids.conversation).put("attempt_id", ids.attempt)
                    .put("workspace_id", workspaceId).put("project_id", projectId).put("workspace_binding_revision", 1)
                    .put("transport_schema_version", 3).put("model", MODEL).put("thinking_mode", THINKING)
                    .put("visible_message_ids", JSONArray().put(ids.message))
                    .put("visible_history_sha256", visibleDigest()).put("visible_message_count", 1)
                    .put("project_context_sha256", manifest.getString("snapshot_sha256"))
                    .put("registry_version", 2).put("expected_policy_version", JSONObject.NULL)
                    .put("expected_transcript", JSONObject.NULL),
            )
            assertEquals(preparation.toString(), "prepared", preparation.optString("status"))
            val authority = prepared.authorityFor(ids.task, ids.attempt)!!
            assertEquals("project", authority.getJSONObject("root").getString("kind"))

            // The controller writes the agent journal into the session before
            // asking for a round; the round is checked against that session.
            val journal = AgentSessionFixture.agentJournal(workspaceId)
                .put("root", authority.getJSONObject("root"))
                .put("transcript", authority.getJSONObject("transcript"))
                .put("toolset_sha256", authority.getJSONObject("registry").getString("toolset_sha256"))
                .put("policy", authority.getJSONObject("policy"))
            val second = AgentSessionFixture.commit(
                sessions, ids, expected = AgentSessionFixture.expecting(first), workspace = workspaceId,
                agent = journal, model = MODEL, attemptContext = attemptContext,
            )

            // A provider on this device.
            val provider = Provider(
                """{"id":"resp-context","model":"$MODEL","choices":[{"message":{"role":"assistant","content":"I read it."},"finish_reason":"stop"}]}""",
            )
            provider.start()
            val namespace = "context-round-${UUID.randomUUID()}"
            val configurations = AndroidProviderConfiguration(context, "$namespace.providers")
            val transport = AndroidModelTransport(AndroidCredentialStore(context, namespace), configurations)
            configurations.save(
                JSONObject().put("schema_version", 1).put("harness_id", "codex").put("name", "Local")
                    .put("endpoint_url", "http://127.0.0.1:${provider.socket.localPort}/v1/chat/completions")
                    .put("protocol", "chat-completions").put("auth_type", "bearer")
                    .put("model_mappings", JSONObject().put(MODEL, MODEL))
                    .put("send_reasoning", false).put("full_url", true),
            )
            transport.put("OPENAI_API_KEY", transport.account("OPENAI_API_KEY"), "local-test-key")

            val liveTasks = AndroidLiveTasks()
            val service = AndroidAgentProviderRoundService(
                sessions, prepared, AndroidAgentRoundJournal(wal, liveTasks), roots, AndroidAgentToolRegistry, transport, wal,
                AndroidAgentOperations(wal), liveTasks, AndroidAgentTranscriptStore(wal), snapshots,
            )
            val roundId = UUID.randomUUID().toString()
            // The request in the shape the bridge delivers it: every number a
            // Double, because `ReadableMap.toHashMap()` knows no integers.
            val result = service.completeRound(bridged(
                JSONObject().put("schema_version", 2).put("operation_id", UUID.randomUUID().toString())
                    .put("controller_cas", controllerCas(ids, second, 1, 1))
                    .put("committed_checkpoint", AgentSessionFixture.checkpoint(second, 1))
                    .put("task_id", ids.task).put("conversation_id", ids.conversation).put("attempt_id", ids.attempt)
                    .put("round_id", roundId).put("round_index", 0).put("launch_attempt", 1).put("expected_round_revision", 0)
                    .put("transport_schema_version", 3).put("harness_id", "codex").put("model", MODEL).put("thinking_mode", THINKING)
                    .put("visible_history_sha256", visibleDigest()).put("visible_message_count", 1)
                    .put("project_context_sha256", manifest.getString("snapshot_sha256"))
                    .put("transcript", authority.getJSONObject("transcript"))
                    // The round names the root as the journal projects it,
                    // which is what JavaScript carries from the authority.
                    .put("root", authority.getJSONObject("root"))
                    .put("registry_version", 2).put("toolset_sha256", AndroidAgentToolRegistry.toolsetSha256()),
            ))

            // What went out: the envelope first, then the conversation.
            assertTrue(provider.served.await(20, TimeUnit.SECONDS))
            val body = JSONObject(provider.request.substringAfter("\r\n\r\n"))
            val messages = body.getJSONArray("messages")
            assertEquals(body.toString(), "system", messages.getJSONObject(0).getString("role"))
            val envelope = messages.getJSONObject(0).getString("content")
            assertTrue(envelope.take(60), envelope.startsWith("RISH-PROJECT-CONTEXT/2\nMETA "))
            assertTrue(envelope.contains("# the project"))
            assertEquals(manifest.getInt("context_bytes"), envelope.toByteArray(Charsets.UTF_8).size)
            assertEquals("user", messages.getJSONObject(1).getString("role"))
            assertEquals("hello", messages.getJSONObject(1).getString("content"))

            // What came back: a final round, whose public receipt carries the
            // receipt for exactly that snapshot.
            assertEquals(result.toString(), "completed", result.getString("status"))
            val outcome = result.getJSONObject("outcome")
            assertEquals("final", outcome.getString("kind"))
            assertEquals("I read it.", outcome.getString("text"))
            val receipt = outcome.getJSONObject("completion_receipt")
            val contextReceipt = receipt.getJSONObject("project_context_receipt")
            assertEquals(snapshotId, contextReceipt.getString("snapshot_id"))
            assertEquals(manifest.getString("snapshot_sha256"), contextReceipt.getString("snapshot_sha256"))
            assertEquals(manifest.getInt("context_bytes"), contextReceipt.getInt("context_bytes"))
            assertEquals(3, receipt.getInt("transport_schema_version"))
        } finally {
            sessions.close()
            context.deleteDatabase(databaseName)
            scratch.deleteRecursively()
        }
    }

    private fun rootRef(workspaceId: String, projectId: String?): JSONObject = JSONObject()
        .put("schema_version", 1).put("workspace_id", workspaceId).put("binding_revision", 1)
        .put("project_id", projectId ?: JSONObject.NULL)

    private fun controllerCas(ids: AgentSessionFixture.Ids, snapshot: JSONObject, generation: Int, journal: Int): JSONObject =
        JSONObject().put("schema_version", 1).put("conversation_id", ids.conversation).put("task_id", ids.task)
            .put("attempt_id", ids.attempt).put("expected_controller_generation", generation)
            .put("expected_journal_revision", journal)
            .put("expected_session_generation", snapshot.getLong("generation"))
            .put("expected_session_sha256", snapshot.getString("session_sha256"))

    private fun visibleDigest(): String = RishAgentCoreNative.hash(
        "visible-history",
        JSONObject().put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", "hello").put("attachments", JSONArray()))),
    )

    /** Numbers as the React Native bridge delivers them: all Double. */
    private fun bridged(value: Any?): Any? = when (value) {
        is JSONObject -> JSONObject().also { out -> for (key in value.keys()) out.put(key, bridged(value.get(key))) }
        is JSONArray -> JSONArray().also { out -> for (index in 0 until value.length()) out.put(bridged(value.get(index))) }
        is Int -> value.toDouble()
        is Long -> value.toDouble()
        else -> value
    }
    private fun bridged(value: JSONObject): JSONObject = bridged(value as Any?) as JSONObject

    private companion object {
        const val MODEL = "gpt-5.6"
        const val THINKING = AgentSessionFixture.THINKING
    }
}
