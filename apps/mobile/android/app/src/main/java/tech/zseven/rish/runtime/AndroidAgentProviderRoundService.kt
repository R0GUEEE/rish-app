package tech.zseven.rish.runtime

import org.json.JSONArray
import org.json.JSONObject

/**
 * `complete_agent_round_v2` on Android.
 *
 * Mirrors modules/rish/ios/Sources/AgentProviderRoundService.mm, whose pure
 * half is already `provider_round` in the shared core. That module names the
 * split: *the host keeps the transport, credentials, the tool registry's
 * native descriptors, the root projection validator, and the two provider
 * digests* -- the digests because they are taken with `NSJSONSerialization`
 * and sorted keys, a different byte protocol from the crate's canonical JSON,
 * so they are passed in as host facts rather than recomputed.
 *
 * The round is the step that asks the model what to do next. What it reads,
 * what the model is shown, how a reply becomes tool calls, and what the
 * journal records are all the core's; calling the provider and writing the
 * row are this file's.
 *
 * **Streaming is not here.** iOS shows a round's text as it arrives; this
 * waits for the whole reply. A round still completes and its calls are still
 * journalled; the only thing missing is watching it happen.
 *
 * Tools do travel, on the chat-completions protocol. What the model is shown
 * is the registry's description of each tool the root carries, and what comes
 * back is read by the core: turning untrusted model output into calls is
 * `completion_response`'s rule, and the transport carries the provider's reply
 * for it rather than reading it here.
 */
internal class AndroidAgentProviderRoundService(
    private val sessions: AndroidSessionStore,
    private val prepared: AndroidPreparedAttemptStore,
    private val rounds: AndroidAgentRoundJournal,
    private val roots: AndroidAgentRootResolver,
    private val tools: AndroidAgentToolRegistry,
    private val transport: AndroidModelTransport,
    private val wal: AndroidAgentWal,
    private val operations: AndroidAgentOperations,
    private val liveTasks: AndroidLiveTasks,
    private val transcripts: AndroidAgentTranscriptStore,
) {
    class Refused(val code: String) : Exception(code)

    private fun decide(envelope: JSONObject): JSONObject {
        if (!RishAgentCoreNative.available) throw Refused(NATIVE)
        val reply = RishAgentCoreNative.providerRoundReduce(envelope.toString())
            ?: throw Refused(NATIVE)
        val parsed = JSONObject(reply)
        if (!parsed.optBoolean("ok")) {
            // A round walks through eight of the core's rules. Which one said
            // no is the whole diagnosis, and the code that reaches JavaScript
            // cannot carry it.
            android.util.Log.w(
                "RishAgent",
                "round reduce refused: op=${envelope.optString("op")} error=${parsed.optInt("error", 2)}",
            )
            throw Refused(codeFor(parsed.optInt("error", 2)))
        }
        return parsed
    }

    private fun codeFor(error: Int): String = when (error) {
        1 -> "E_AGENT_BAD_ARGUMENTS"
        3 -> "E_AGENT_CONFLICT"
        4 -> "E_AGENT_PERSISTENCE"
        else -> NATIVE
    }

    /**
     * The environment the round rules read. It is the model catalogue, not a
     * clock: the core asks it which harness serves the model a request names,
     * and it can only ask a host that shipped the catalogue. Collected from
     * the request's own strings, exactly as `DSHProviderEnvironment` collects
     * it from the request on iOS.
     */
    private fun env(request: JSONObject): JSONObject =
        AndroidSessionEnvironment.facts(request)

    fun completeRound(request: JSONObject): JSONObject {
        val root = request.optJSONObject("root")
        val rootOk = roots.resolveAgentProjection(root) != null
        if (!rootOk) android.util.Log.w("RishAgent", "round root did not resolve: $root")

        // Shape and locator first. A request the rules refuse never reaches
        // the journal, let alone the provider.
        val located = decide(
            JSONObject().put("op", "round_request").put("request", request)
                .put("root_ok", rootOk).put("env", env(request)),
        )
        val locator = located.optJSONObject("locator") ?: throw Refused(BAD_ARGUMENTS)

        val taskId = request.optString("task_id")
        val attemptId = request.optString("attempt_id")
        val authority = prepared.authorityFor(taskId, attemptId)
            ?: throw Refused(CONFLICT)
        // The session the request was built against, not whichever one is
        // stored now. A round decided over a session that has since moved on
        // is a conflict the controller recovers from by re-reading.
        val session = AndroidCommittedSession.load(sessions, request) ?: throw Refused(CONFLICT)
        AndroidCommittedSession.conversation(session, request) ?: throw Refused(CONFLICT)

        // The first time a round is asked for, its row does not exist yet:
        // this operation is what creates it. Only a retry finds one, and a
        // retry claims what is there rather than inserting over it.
        // The owner this process is about to claim has to be alive before the
        // journal will accept it: a row owned by a task nobody is running is
        // exactly what recovery exists to reclaim, and the core refuses to
        // create one. iOS registers the same id for the same reason.
        val nativeTaskId = request.optString("operation_id")
        liveTasks.register(nativeTaskId)
        val owner = ownerFor(request)
        val existing = rowFor(wal.snapshot(), locator)
        if (existing == null) {
            rounds.create(insertCas(request, locator), startedRound(request, locator, owner))
                ?: throw Refused(PERSISTENCE)
        } else {
            // Claimed before the provider is called, so a crash during the
            // call leaves a round that may have happened rather than one that
            // plainly did not.
            val cas = decide(
                JSONObject().put("op", "round_cas").put("row", existing),
            ).optJSONObject("cas") ?: throw Refused(CONFLICT)
            rounds.claim(cas, owner) ?: throw Refused(CONFLICT)
        }
        val claimed = rowFor(wal.snapshot(), locator) ?: throw Refused(PERSISTENCE)
        val dispatchCas = decide(
            JSONObject().put("op", "round_cas").put("row", claimed),
        ).optJSONObject("cas") ?: throw Refused(CONFLICT)
        rounds.markDispatched(dispatchCas) ?: throw Refused(CONFLICT)

        // What the model is shown of the conversation so far. The messages are
        // the transcript's own -- the store reads them out of the WAL under
        // the transcript reference the request names -- and the core turns
        // them into the provider's shape. The transcripts *table* is not that
        // list, and handing it over is how this refused as corrupt.
        val native = transcripts.nativeMessages(
            JSONObject().put("schema_version", 1)
                .put("attempt_id", request.opt("attempt_id"))
                .put("root", request.opt("root"))
                .put("transcript", request.opt("transcript")),
        ) ?: throw Refused(TRANSCRIPT)
        val body = decide(
            JSONObject().put("op", "transcript_body").put("request", JSONObject())
                .put("messages", native),
        ).optJSONArray("messages") ?: JSONArray()

        // What the model is shown. The registry decides which tools a root
        // carries and what each one is; the core turns a descriptor into the
        // description a model sees, so neither this file nor the transport
        // invents anything a tool can be asked to do.
        val registry = tools.registryForRoot(root ?: JSONObject())
        val declared = JSONArray()
        val names = registry.optJSONArray("tools") ?: JSONArray()
        for (index in 0 until names.length()) {
            val name = names.optJSONObject(index)?.optString("name")
                ?: names.optString(index).takeIf { it.isNotEmpty() }
                ?: continue
            // The core describes a tool from its *name*: the description a
            // model is shown is the rule's, not the registry descriptor's.
            val described = decide(
                JSONObject().put("op", "tool_description").put("name", name),
            ).optJSONObject("description")
            if (described != null) declared.put(described)
        }

        var providerError: String? = null
        val reply = try {
            val envelope = JSONObject()
                .put("schema_version", 2)
                .put("harness_id", request.optString("harness_id"))
                .put("model", request.optString("model"))
                .put("round_id", request.optString("round_id"))
                // The transport calls it `turn_id`; an agent request calls the
                // same identity `task_id`, and asking for a key the request
                // does not have yields "" -- which is not a UUID.
                .put("turn_id", request.optString("task_id"))
                .put("attempt_id", request.optString("attempt_id"))
                .put("round_index", request.optInt("round_index"))
                .put("thinking_mode", request.optString("thinking_mode", "off"))
                .put("visible_history", body)
                .put("round_transcript", JSONArray())
                .put("project_context", JSONObject.NULL)
                .put("tools", declared)
            transport.execute(transport.prepare(envelope.toString()))
        } catch (failure: Exception) {
            // What the provider said is what decides the round's failure code,
            // so the transport's own vocabulary is kept rather than discarded.
            providerError = (failure as? RuntimeFailure)?.code
            android.util.Log.w("RishAgent", "round transport failed: $providerError", failure)
            null
        }

        // Untrusted model output becomes calls here, by the core's rule and
        // not by reading fields off a provider's JSON in Kotlin.
        val parsed = if (reply == null) null else RishAgentCoreNative.completionResponseReduce(
            JSONObject().put("op", "parse").put("response", reply)
                .put("requested_model", request.optString("model"))
                .put("model_supported", true)
                .put("thinking_mode", request.optString("thinking_mode", "off"))
                .put("fallback_call_id", request.optString("round_id"))
                .toString(),
        )?.let { JSONObject(it) }?.takeIf { it.optBoolean("ok") }

        val status = if (reply == null || parsed == null) "failed_retryable" else "completed"
        // A completed round carries no failure code. A failed one carries the
        // code the *core* derives from what the provider said -- the mapping
        // from a transport error to an agent failure is a rule, not a lookup
        // this file gets to invent.
        val failure = if (status == "completed") "" else decide(
            JSONObject().put("op", "failure_code")
                .put("provider_error_code", providerError ?: JSONObject.NULL)
                .put("digest_mismatch", false),
        ).optString("code", "")

        val dispatched = rowFor(wal.snapshot(), locator) ?: throw Refused(CONFLICT)
        val completeCas = decide(
            JSONObject().put("op", "round_cas").put("row", dispatched),
        ).optJSONObject("cas") ?: throw Refused(CONFLICT)
        val patch = JSONObject().put("status", status)
            .put("failure_code", if (failure.isEmpty()) JSONObject.NULL else failure)
            .put("reply", parsed?.opt("parsed") ?: JSONObject.NULL)
        rounds.complete(completeCas, patch) ?: throw Refused(PERSISTENCE)

        val settled = rowFor(wal.snapshot(), locator) ?: throw Refused(CONFLICT)
        return decide(
            JSONObject().put("op", "round_result").put("request", request)
                .put("row", settled).put("status", status)
                .put("failure_code", failure),
        ).optJSONObject("result") ?: throw Refused(NATIVE)
    }

    /**
     * The row a first round starts as: in flight, owned by this process, bound
     * to the transcript and the root the request names. Mirrors the literal
     * iOS builds before `createAgentRoundV3WithInsertCAS:`.
     */
    private fun startedRound(request: JSONObject, locator: JSONObject, owner: JSONObject): JSONObject {
        val now = RuntimeJson.now()
        val root = request.optJSONObject("root")
        return JSONObject()
            .put("schema_version", 3)
            .put("locator", locator)
            .put("row_revision", 1)
            .put("root_fingerprint_sha256", root?.opt("root_fingerprint_sha256"))
            .put("binding_revision", root?.opt("workspace_binding_revision"))
            .put("request_sha256", operations.requestSha256("complete_agent_round_v2", request))
            .put("transcript_before", request.optJSONObject("transcript"))
            .put("launch_attempt", request.opt("launch_attempt"))
            .put("state", "in_flight")
            .put("owner", owner)
            .put("failure_code", JSONObject.NULL)
            .put("completion_receipt", JSONObject.NULL)
            .put("transcript_after", JSONObject.NULL)
            .put("calls", JSONArray())
            .put("batch_class", JSONObject.NULL)
            .put("executable_call_count", 0)
            .put("denied_call_count", 0)
            .put("terminal_kind", JSONObject.NULL)
            .put("created_at", now).put("updated_at", now)
    }

    /** What the insert asserts about a world that has no such row yet. */
    private fun insertCas(request: JSONObject, locator: JSONObject): JSONObject {
        val transcript = request.optJSONObject("transcript")
        val root = request.optJSONObject("root")
        return JSONObject()
            .put("schema_version", 1)
            .put("locator", locator)
            .put("expected_absent", true)
            .put("expected_transcript_generation", transcript?.opt("generation"))
            .put("expected_transcript_sha256", transcript?.opt("transcript_sha256"))
            .put("expected_root_fingerprint_sha256", root?.opt("root_fingerprint_sha256"))
            .put("expected_binding_revision", root?.opt("workspace_binding_revision"))
    }

    private fun rowFor(state: JSONObject, locator: JSONObject): JSONObject? {
        val table = state.optJSONArray("rounds") ?: return null
        val key = decide(
            JSONObject().put("op", "locator_key").put("locator", locator),
        ).optString("key")
        for (index in 0 until table.length()) {
            val row = table.optJSONObject(index) ?: continue
            val candidate = decide(
                JSONObject().put("op", "locator_key")
                    .put("locator", row.optJSONObject("locator") ?: JSONObject()),
            ).optString("key")
            if (candidate == key) return row
        }
        return null
    }

    private fun ownerFor(request: JSONObject): JSONObject = JSONObject()
        .put("schema_version", 1)
        .put("task_id", request.optString("task_id"))
        .put("launch_id", AndroidAgentWal.launchId)
        .put("native_task_id", request.optString("operation_id"))
        .put("owner_generation", 1)
        .put("heartbeat_at", RuntimeJson.now())

    private companion object {
        const val NATIVE = "E_AGENT_NATIVE"
        const val CONFLICT = "E_AGENT_CONFLICT"
        const val BAD_ARGUMENTS = "E_AGENT_BAD_ARGUMENTS"
        const val PERSISTENCE = "E_AGENT_PERSISTENCE"
        const val TRANSCRIPT = "E_AGENT_TRANSCRIPT"
    }
}
