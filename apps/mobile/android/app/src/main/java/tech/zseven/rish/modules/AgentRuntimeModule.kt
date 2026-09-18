package tech.zseven.rish.modules

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import tech.zseven.rish.RishUnavailable
import tech.zseven.rish.runtime.AndroidAgentProviderRoundService
import tech.zseven.rish.runtime.AndroidAgentQueryService
import tech.zseven.rish.runtime.AndroidAgentRecoveryService
import tech.zseven.rish.runtime.AndroidAgentApprovalService
import tech.zseven.rish.runtime.AndroidAgentCancelService
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
 * **`implemented` is true, and that turns the whole surface on.** The JS layer
 * reads it as "this runtime may be used at all": with it false, nothing below
 * is ever called, so it cannot be flipped one operation at a time.
 *
 * All thirteen are now served: the seven above, plus `cancel_agent_attempt`,
 * `recover_agent_attempt`, `interrupt_agent_attempt` and the three queries.
 * What each one has actually been seen to do is in the commits that added it;
 * recovery in particular reconciles correctly but has not been seen to resume
 * a turn, and `retry_failed_round` is refused rather than reconciled.
 *
 * Streaming is absent: a round's text arrives whole rather than as it is
 * written.
 */
class AgentRuntimeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val runtime = AndroidRuntimeState.get(reactContext)

    override fun getConstants(): MutableMap<String, Any> = mutableMapOf("implemented" to true)

    /**
     * `agentRoundPreview`: a round's reply as it arrives.
     *
     * Display only. It is never persisted and never enters a proof, and the
     * round still decides on the reassembled reply, so a dropped event costs
     * nothing but the watching. The sink is installed only while JavaScript is
     * listening -- a stream nobody is watching is not worth asking a provider
     * for.
     */
    private val listeners = java.util.concurrent.atomic.AtomicInteger(0)

    @ReactMethod
    fun addListener(eventName: String?) {
        if (listeners.incrementAndGet() == 1) {
            runtime.roundPreview = { event ->
                try {
                    reactApplicationContext
                        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                        .emit(PREVIEW_EVENT, Arguments.makeNativeMap(RuntimeJson.map(event)))
                } catch (failure: Exception) {
                    // A preview that cannot be delivered is not a failed round.
                    Log.w(TAG, "round preview not delivered", failure)
                }
            }
        }
    }

    @ReactMethod
    fun removeListeners(count: Double) {
        if (listeners.addAndGet(-count.toInt().coerceAtLeast(0)).coerceAtLeast(0) == 0) {
            listeners.set(0)
            runtime.roundPreview = null
        }
    }

    override fun getName(): String = "AgentRuntime"

    private companion object {
        const val TAG = "RishAgent"
        const val PREVIEW_EVENT = "agentRoundPreview"
    }

    @ReactMethod
    fun prepare_agent_attempt(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent attempt request is invalid", failure)
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
                Log.w(TAG, "Agent attempt could not be prepared: ${refused.code}", refused)
                promise.reject(refused.code, "Agent attempt could not be prepared")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent attempt could not be prepared", failure)
                promise.reject("E_AGENT_NATIVE", "Agent attempt could not be prepared")
            }
        }
    }

    @ReactMethod
    fun complete_agent_round_v2(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent round request is invalid", failure)
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent round request is invalid")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.providerRound.completeRound(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentProviderRoundService.Refused) {
                Log.w(TAG, "Agent round could not be completed: ${refused.code}")
                promise.reject(refused.code, "Agent round could not be completed")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent round could not be completed", failure)
                promise.reject("E_AGENT_NATIVE", "Agent round could not be completed")
            }
        }
    }

    @ReactMethod
    fun prepare_agent_tool_batch(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent tool batch request is invalid", failure)
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent tool batch request is invalid")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.toolBatch.prepare(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentToolBatchService.Refused) {
                Log.w(TAG, "Agent tool batch could not be prepared: ${refused.code}")
                promise.reject(refused.code, "Agent tool batch could not be prepared")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent tool batch could not be prepared", failure)
                promise.reject("E_AGENT_NATIVE", "Agent tool batch could not be prepared")
            }
        }
    }

    @ReactMethod
    fun bind_agent_approval(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent approval request is invalid", failure)
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent approval request is invalid")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.approvals.bind(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentApprovalService.Refused) {
                Log.w(TAG, "Agent approval could not be bound: ${refused.code}")
                promise.reject(refused.code, "Agent approval could not be bound")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent approval could not be bound", failure)
                promise.reject("E_AGENT_NATIVE", "Agent approval could not be bound")
            }
        }
    }

    @ReactMethod
    fun execute_agent_tool(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent tool request is invalid", failure)
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
                Log.w(TAG, "Agent tool could not be executed: ${refused.code}")

                promise.reject(refused.code, "Agent tool could not be executed")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent tool could not be executed", failure)
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
     * It is also how the cleanup outbox drains: an entry stays durable until
     * this answers for it.
     */
    @ReactMethod
    fun interrupt_agent_attempt(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent interruption request is invalid", failure)
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent interruption request is invalid")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.lifecycle.interrupt(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentLifecycleService.Refused) {
                Log.w(TAG, "Agent attempt could not be interrupted: ${refused.code}")
                promise.reject(refused.code, "Agent attempt could not be interrupted")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent attempt could not be interrupted", failure)
                promise.reject("E_AGENT_NATIVE", "Agent attempt could not be interrupted")
            }
        }
    }

    @ReactMethod
    fun cancel_agent_attempt(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent cancellation request is invalid", failure)
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent cancellation request is invalid")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.cancellation.cancel(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentCancelService.Refused) {
                Log.w(TAG, "Agent attempt could not be cancelled: ${refused.code}")
                promise.reject(refused.code, "Agent attempt could not be cancelled")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent attempt could not be cancelled", failure)
                promise.reject("E_AGENT_NATIVE", "Agent attempt could not be cancelled")
            }
        }
    }

    @ReactMethod
    fun query_agent_attempt(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent attempt query is invalid", failure)
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent attempt query is invalid")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.queries.query(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentQueryService.Refused) {
                Log.w(TAG, "Agent attempt could not be queried: ${refused.code}")
                promise.reject(refused.code, "Agent attempt could not be queried")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent attempt could not be queried", failure)
                promise.reject("E_AGENT_NATIVE", "Agent attempt could not be queried")
            }
        }
    }

    @ReactMethod
    fun query_agent_tool(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent tool could not be queried: request is invalid", failure)
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent tool could not be queried")
            return
        }
        runtime.io.execute {
            try {
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(runtime.queries.queryTool(captured))))
            } catch (refused: AndroidAgentQueryService.Refused) {
                Log.w(TAG, "Agent tool could not be queried: ${refused.code}")
                promise.reject(refused.code, "Agent tool could not be queried")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent tool could not be queried", failure)
                promise.reject("E_AGENT_NATIVE", "Agent tool could not be queried")
            }
        }
    }

    @ReactMethod
    fun recover_agent_attempt(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent recovery request is invalid", failure)
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent recovery request is invalid")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.recovery.recover(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentRecoveryService.Refused) {
                Log.w(TAG, "Agent attempt could not be recovered: ${refused.code}")
                promise.reject(refused.code, "Agent attempt could not be recovered")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent attempt could not be recovered", failure)
                promise.reject("E_AGENT_NATIVE", "Agent attempt could not be recovered")
            }
        }
    }

    @ReactMethod
    fun finalize_agent_attempt(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent attempt could not be finalized", failure)
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent attempt could not be finalized")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.lifecycle.finalize(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentLifecycleService.Refused) {
                Log.w(TAG, "Agent attempt could not be finalized: ${refused.code}")
                promise.reject(refused.code, "Agent attempt could not be finalized")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent attempt could not be finalized", failure)
                promise.reject("E_AGENT_NATIVE", "Agent attempt could not be finalized")
            }
        }
    }

    @ReactMethod
    fun discard_agent_attempt(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent attempt could not be discarded", failure)
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent attempt could not be discarded")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.lifecycle.discard(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentLifecycleService.Refused) {
                Log.w(TAG, "Agent attempt could not be discarded: ${refused.code}")
                promise.reject(refused.code, "Agent attempt could not be discarded")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent attempt could not be discarded", failure)
                promise.reject("E_AGENT_NATIVE", "Agent attempt could not be discarded")
            }
        }
    }

    @ReactMethod
    fun query_agent_cleanup(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent cleanup could not be queried: request is invalid", failure)
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent cleanup could not be queried")
            return
        }
        runtime.io.execute {
            try {
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(runtime.queries.queryCleanup(captured))))
            } catch (refused: AndroidAgentQueryService.Refused) {
                Log.w(TAG, "Agent cleanup could not be queried: ${refused.code}")
                promise.reject(refused.code, "Agent cleanup could not be queried")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent cleanup could not be queried", failure)
                promise.reject("E_AGENT_NATIVE", "Agent cleanup could not be queried")
            }
        }
    }
}
