package tech.zseven.rish.runtime

import org.json.JSONObject

/**
 * `recover_agent_attempt` on Android, for the `reconcile` action.
 *
 * Mirrors the recovering half of modules/rish/ios/Sources/AgentRuntimeCoordinator.mm.
 * This is what a restarted app does with a turn that was in the middle of
 * something when the process died: ask what the durable state says, find out
 * whether the row's writer is still alive, and either take it over or record
 * honestly that nobody can say how it ended.
 *
 * Nothing is re-run. A round that was waiting on a provider has no reply to
 * wait for -- it died with the process that asked -- and a tool call is judged
 * by what the disk says, never by doing it again. `recover_initial_outcome`,
 * `recover_round_outcome`, `recover_tool_outcome` and `recover_result` decide
 * what all of that means; this file supplies the two recoveries and the
 * transaction.
 *
 * **Not here: `retry_failed_round`.** The controller only asks for it after a
 * reconcile reports a retryable round, and re-launching a round needs the
 * retry half of the round service. A request for it is refused rather than
 * silently reconciled.
 */
internal class AndroidAgentRecoveryService(
    private val wal: AndroidAgentWal,
    private val sessions: AndroidSessionStore,
    private val prepared: AndroidPreparedAttemptStore,
    private val queries: AndroidAgentQueryService,
    private val rounds: AndroidAgentProviderRoundService,
    private val executions: AndroidAgentToolExecutionService,
    private val roots: AndroidAgentRootResolver,
    private val operations: AndroidAgentOperations,
) {
    class Refused(val code: String) : Exception(code)

    private fun runtime(envelope: JSONObject): JSONObject {
        if (!RishAgentCoreNative.available) throw Refused(NATIVE)
        val reply = RishAgentCoreNative.runtimeReduce(envelope.toString()) ?: throw Refused(NATIVE)
        val parsed = JSONObject(reply)
        if (!parsed.optBoolean("ok")) {
            android.util.Log.w(
                "RishAgent",
                "recovery reduce refused: op=${envelope.optString("op")} error=${parsed.optInt("error", 2)}",
            )
            throw Refused(codeFor(parsed.optInt("error", 2)))
        }
        return parsed
    }

    private fun codeFor(error: Int): String = when (error) {
        1 -> "E_AGENT_BAD_ARGUMENTS"
        3 -> "E_AGENT_CONFLICT"
        4 -> "E_AGENT_PERSISTENCE"
        5 -> "E_AGENT_NOT_FOUND"
        else -> NATIVE
    }

    fun recover(request: JSONObject): JSONObject {
        runtime(
            JSONObject().put("op", "target_request").put("kind", "recover")
                .put("request", request),
        )
        if (request.optString("action") != "reconcile") throw Refused(NATIVE)
        val target = request.optJSONObject("target") ?: throw Refused(BAD_ARGUMENTS)
        val cas = request.optJSONObject("controller_cas") ?: JSONObject()
        val checkpoint = request.optJSONObject("committed_checkpoint") ?: JSONObject()
        val taskId = target.opt("task_id")
        val attemptId = target.opt("attempt_id")
        val kind = "recover_agent_attempt"
        val sha = operations.requestSha256(kind, request)
        val timestamp = AndroidClock.now()

        var replay: JSONObject? = null
        var found = false
        var recordRevision: Any? = null
        wal.transaction { state ->
            val query = operations.queryInState(state, request.opt("operation_id"), sha, taskId, attemptId)
            found = query.optString("status") == "found"
            val record = query.optJSONObject("record")
            recordRevision = record?.opt("authority_revision")
            if (found && record?.optString("state") != "started") {
                replay = operations.settledResult(
                    operations.startTargetInState(
                        state, kind, request, target, recordRevision, timestamp,
                    ),
                )
            }
            false
        }
        replay?.let { return it }

        // The attempt as the durable state sees it. Everything below is
        // decided over this, and it is read again at the end because the
        // recovery itself moves rows.
        val attemptQuery = queryAttempt(request, target, cas, checkpoint)
        if (attemptQuery.optString("status") == "conflict") {
            return conflict(
                request, attemptQuery.optString("failure_code", "E_AGENT_CONFLICT"),
                attemptQuery.opt("actual_journal_revision"),
            )
        }
        val authority = prepared.authorityFor(
            taskId as? String ?: "", attemptId as? String ?: "",
        ) ?: throw Refused(CONFLICT)

        var started: JSONObject? = null
        var startedReplay: JSONObject? = null
        wal.transaction { state ->
            val outcome = operations.startTargetInState(
                state, kind, request, target,
                if (found) recordRevision else authority.opt("authority_revision"),
                timestamp,
            )
            if (outcome.optString("status") == "replayed") {
                startedReplay = operations.settledResult(outcome)
            }
            started = outcome
            startedReplay == null
        }
        startedReplay?.let { return it }
        val startedOperation = started ?: throw Refused(PERSISTENCE)

        var settled = runtime(
            JSONObject().put("op", "recover_initial_outcome")
                .put("attempt_query", attemptQuery),
        ).opt("settled") ?: throw Refused(NATIVE)

        when (target.optString("kind")) {
            "round" -> {
                val recovery = rounds.recoverRound(
                    JSONObject().put("schema_version", 2)
                        .put("task_id", taskId).put("attempt_id", attemptId)
                        .put("round_id", target.opt("round_id"))
                        .put("round_index", target.opt("round_index"))
                        .put("expected_round_revision", request.opt("expected_round_revision"))
                        .put("transcript", request.opt("expected_transcript"))
                        .put("root", request.opt("root")),
                )
                if (recovery.optString("status") == "conflict") {
                    return commit(
                        request, startedOperation, timestamp,
                        conflictOutput(
                            request, recovery.optString("failure_code", "E_AGENT_CONFLICT"), null,
                        ),
                    )
                }
                val outcome = runtime(
                    JSONObject().put("op", "recover_round_outcome").put("recovery", recovery),
                ).opt("settled")
                if (outcome != null && outcome != JSONObject.NULL) settled = outcome
            }
            "tool" -> {
                val child = runtime(
                    JSONObject().put("op", "child_operation_id")
                        .put("request", request).put("purpose", "recover-tool"),
                ).optString("operation_id").takeIf { it.isNotEmpty() }
                    ?: throw Refused(NATIVE)
                val plan = runtime(
                    JSONObject().put("op", "recover_tool_plan").put("state", wal.snapshot())
                        .put("request", request).put("authority", authority)
                        .put("child_operation_id", child),
                )
                val toolRequest = plan.optJSONObject("tool_request") ?: throw Refused(NATIVE)
                var toolStarted: JSONObject? = null
                wal.transaction { state ->
                    toolStarted = operations.startInState(
                        state, "execute_agent_tool", toolRequest,
                        plan.opt("authority_revision"), timestamp,
                    )
                    true
                }
                var recovery = executions.recover(toolRequest)
                val outcome = runtime(
                    JSONObject().put("op", "recover_tool_outcome").put("recovery", recovery),
                )
                if (outcome.optBoolean("terminal")) {
                    // The child operation carries the answer, so it is
                    // committed before the parent settles on it.
                    val toolCommit = runtime(
                        JSONObject().put("op", "recover_tool_commit").put("request", request)
                            .put("started", toolStarted ?: throw Refused(PERSISTENCE))
                            .put("recovery", recovery).put("child_operation_id", child),
                    ).optJSONObject("commit") ?: throw Refused(NATIVE)
                    var committed: JSONObject? = null
                    wal.transaction { state ->
                        committed = operations.settledResult(
                            operations.commitDecidedInState(state, toolCommit, timestamp),
                        )
                        true
                    }
                    recovery = committed ?: recovery
                }
                if (recovery.optString("status") == "conflict") {
                    return commit(
                        request, startedOperation, timestamp,
                        conflictOutput(
                            request, recovery.optString("failure_code", "E_AGENT_CONFLICT"), null,
                        ),
                    )
                }
                settled = runtime(
                    JSONObject().put("op", "recover_tool_outcome").put("recovery", recovery),
                ).opt("settled") ?: throw Refused(NATIVE)
            }
        }

        // Every branch ends the same way: read the attempt again, and commit
        // what the branch concluded beside what the attempt now looks like.
        val after = queryAttempt(request, target, cas, checkpoint)
        val attempt = after.optJSONObject("attempt") ?: throw Refused(CONFLICT)
        val result = runtime(
            JSONObject().put("op", "recover_result").put("request", request)
                .put("attempt", attempt).put("settled", settled),
        ).optJSONObject("output") ?: throw Refused(NATIVE)
        return commit(request, startedOperation, timestamp, result)
    }

    private fun queryAttempt(
        request: JSONObject,
        target: JSONObject,
        cas: JSONObject,
        checkpoint: JSONObject,
    ): JSONObject = queries.query(
        JSONObject().put("schema_version", 2).put("controller_cas", cas)
            .put("task_id", target.opt("task_id"))
            .put("conversation_id", cas.opt("conversation_id"))
            .put("attempt_id", target.opt("attempt_id"))
            .put("expected_journal_revision", cas.opt("expected_journal_revision"))
            .put("expected_session_generation", checkpoint.opt("session_generation"))
            .put("expected_session_sha256", checkpoint.opt("session_sha256"))
            .put("expected_transcript", request.opt("expected_transcript"))
            .put(
                "expected_root_fingerprint_sha256",
                request.optJSONObject("root")?.opt("root_fingerprint_sha256"),
            )
            .put(
                "expected_workspace_binding_revision",
                request.optJSONObject("root")?.opt("workspace_binding_revision"),
            ),
    )

    /** A refusal decided before the operation started, answered as it is. */
    private fun conflict(
        request: JSONObject,
        failureCode: String,
        journalRevision: Any?,
    ): JSONObject = conflictOutput(request, failureCode, journalRevision)

    private fun conflictOutput(
        request: JSONObject,
        failureCode: String,
        journalRevision: Any?,
    ): JSONObject {
        val envelope = JSONObject().put("op", "target_conflict")
            .put("failure_code", failureCode).put("request", request)
            .put("proof", JSONObject().put("matches", false))
        if (journalRevision != null && journalRevision != JSONObject.NULL) {
            envelope.put("actual_journal_revision", journalRevision)
        }
        return runtime(envelope).optJSONObject("output") ?: throw Refused(NATIVE)
    }

    private fun commit(
        request: JSONObject,
        started: JSONObject,
        timestamp: String,
        result: JSONObject,
    ): JSONObject {
        var settledResult: JSONObject? = null
        wal.transaction { state ->
            val decided = runtime(
                JSONObject().put("op", "recovery_commit").put("state", state)
                    .put("request", request).put("started", started).put("settled", result),
            )
            settledResult = operations.settledResult(
                operations.commitDecidedInState(
                    state, decided.optJSONObject("commit") ?: throw Refused(NATIVE), timestamp,
                ),
            )
            true
        }
        return settledResult ?: result
    }

    private companion object {
        const val NATIVE = "E_AGENT_NATIVE"
        const val CONFLICT = "E_AGENT_CONFLICT"
        const val BAD_ARGUMENTS = "E_AGENT_BAD_ARGUMENTS"
        const val PERSISTENCE = "E_AGENT_PERSISTENCE"
    }
}
