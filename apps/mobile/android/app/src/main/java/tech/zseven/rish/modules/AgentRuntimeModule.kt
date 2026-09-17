package tech.zseven.rish.modules

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import org.json.JSONObject
import tech.zseven.rish.RishUnavailable
import tech.zseven.rish.runtime.AndroidAgentProviderRoundService
import tech.zseven.rish.runtime.AndroidAgentApprovalService
import tech.zseven.rish.runtime.AndroidAgentLifecycleService
import tech.zseven.rish.runtime.AndroidAgentToolBatchService
import tech.zseven.rish.runtime.AndroidAgentToolExecutionService
import tech.zseven.rish.runtime.AndroidPreparedAttemptStore
import tech.zseven.rish.runtime.AndroidRuntimeState
import tech.zseven.rish.runtime.RuntimeJson

/**
 * AgentRuntime on Android.
 *
 * Mirrors the iOS registration in modules/rish/ios/Sources/AgentRuntimeModule.mm
 * (RCT_EXPORT_MODULE(AgentRuntime)) and the JS wrapper in
 * apps/mobile/src/native/AgentRuntime.ts.
 *
 * The five operations a turn walks through are served, each through the shared
 * core and the same reducers iOS calls: `prepare_agent_attempt`,
 * `complete_agent_round_v2`, `prepare_agent_tool_batch`, `bind_agent_approval`
 * and `execute_agent_tool`, and the two that end it, `finalize_agent_attempt`
 * and `discard_agent_attempt`. Attempts are no longer rootless -- this platform
 * resolves a workspace root through AndroidWorkspaceRegistry, so an attempt
 * bound to a directory gets real agent authority over it.
 *
 * **`implemented` is now true, and that turns the whole surface on.** The JS
 * layer reads it as "this runtime may be used at all": with it false, nothing
 * below is ever called. So it cannot be flipped one operation at a time, and
 * flipping it is a statement about what still refuses:
 *
 * - `cancel_agent_attempt`, `recover_agent_attempt` and `query_agent_attempt`
 *   still reject. The controller calls them to stop a run and to pick one up
 *   after a kill. Until they are served, stopping a turn and resuming one
 *   across a restart both fail -- loudly, with E_AGENT_NATIVE, rather than
 *   silently doing the wrong thing.
 * - `interrupt_agent_attempt`, `query_agent_tool` and `query_agent_cleanup`
 *   reject too; the controller does not call them.
 *
 * Streaming is also absent: a round's text arrives whole rather than as it is
 * written.
 */
class AgentRuntimeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val runtime = AndroidRuntimeState.get(reactContext)

    override fun getConstants(): MutableMap<String, Any> = mutableMapOf("implemented" to true)

    override fun getName(): String = "AgentRuntime"

    @ReactMethod
    fun prepare_agent_attempt(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (_: Exception) {
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent attempt request is invalid")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.preparedAttempts.prepareAgentAttempt(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidPreparedAttemptStore.Refused) {
                // The store's own vocabulary reaches JS unchanged; a code the
                // controller does not know would be worse than a stable one.
                promise.reject(refused.code, "Agent attempt could not be prepared")
            } catch (_: Exception) {
                promise.reject("E_AGENT_NATIVE", "Agent attempt could not be prepared")
            }
        }
    }

    @ReactMethod
    fun complete_agent_round_v2(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (_: Exception) {
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent round request is invalid")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.providerRound.completeRound(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentProviderRoundService.Refused) {
                promise.reject(refused.code, "Agent round could not be completed")
            } catch (_: Exception) {
                promise.reject("E_AGENT_NATIVE", "Agent round could not be completed")
            }
        }
    }

    @ReactMethod
    fun prepare_agent_tool_batch(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (_: Exception) {
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent tool batch request is invalid")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.toolBatch.prepare(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentToolBatchService.Refused) {
                promise.reject(refused.code, "Agent tool batch could not be prepared")
            } catch (_: Exception) {
                promise.reject("E_AGENT_NATIVE", "Agent tool batch could not be prepared")
            }
        }
    }

    @ReactMethod
    fun bind_agent_approval(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (_: Exception) {
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent approval request is invalid")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.approvals.bind(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentApprovalService.Refused) {
                promise.reject(refused.code, "Agent approval could not be bound")
            } catch (_: Exception) {
                promise.reject("E_AGENT_NATIVE", "Agent approval could not be bound")
            }
        }
    }

    @ReactMethod
    fun execute_agent_tool(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (_: Exception) {
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent tool request is invalid")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.toolExecution.execute(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentToolExecutionService.Refused) {
                // The service's vocabulary is the controller's; a code it does
                // not know would be worse than a stable one.
                promise.reject(refused.code, "Agent tool could not be executed")
            } catch (_: Exception) {
                promise.reject("E_AGENT_NATIVE", "Agent tool could not be executed")
            }
        }
    }

    /**
     * The thirteenth operation the JS surface requires, and the one Android
     * never declared. Its absence alone kept `AgentRuntime.isAvailable()` false
     * however much else was built: the wrapper checks that every operation is a
     * function before it reads anything at all.
     *
     * Interrupting is not implemented, so it refuses. A method that exists and
     * says no is what the shape check needs; a method that is missing makes the
     * whole surface unavailable.
     */
    @ReactMethod
    fun interrupt_agent_attempt(request: ReadableMap?, promise: Promise) =
        RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun cancel_agent_attempt(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun query_agent_attempt(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun query_agent_tool(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun recover_agent_attempt(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun finalize_agent_attempt(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (_: Exception) {
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent attempt could not be finalized")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.lifecycle.finalize(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentLifecycleService.Refused) {
                promise.reject(refused.code, "Agent attempt could not be finalized")
            } catch (_: Exception) {
                promise.reject("E_AGENT_NATIVE", "Agent attempt could not be finalized")
            }
        }
    }

    @ReactMethod
    fun discard_agent_attempt(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (_: Exception) {
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent attempt could not be discarded")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.lifecycle.discard(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentLifecycleService.Refused) {
                promise.reject(refused.code, "Agent attempt could not be discarded")
            } catch (_: Exception) {
                promise.reject("E_AGENT_NATIVE", "Agent attempt could not be discarded")
            }
        }
    }

    @ReactMethod
    fun query_agent_cleanup(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)
}
