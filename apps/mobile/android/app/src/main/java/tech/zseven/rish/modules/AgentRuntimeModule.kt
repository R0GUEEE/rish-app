package tech.zseven.rish.modules

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import tech.zseven.rish.RishUnavailable

/**
 * AgentRuntime — phase-1 Android skeleton.
 *
 * Mirrors the iOS registration in modules/rish/ios/Sources/AgentRuntimeModule.mm
 * (RCT_EXPORT_MODULE(AgentRuntime)) and the JS wrapper in
 * apps/mobile/src/native/AgentRuntime.ts. Every method rejects with the JS-
 * recognized "E_AGENT_NATIVE" unavailable code; no success results are stubbed.
 */
class AgentRuntimeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getConstants(): MutableMap<String, Any> = mutableMapOf("implemented" to false)

    override fun getName(): String = "AgentRuntime"

    @ReactMethod
    fun prepare_agent_attempt(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun complete_agent_round_v2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun prepare_agent_tool_batch(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun bind_agent_approval(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun execute_agent_tool(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun cancel_agent_attempt(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun query_agent_attempt(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun query_agent_tool(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun recover_agent_attempt(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun finalize_agent_attempt(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun discard_agent_attempt(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)

    @ReactMethod
    fun query_agent_cleanup(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("AgentRuntime", "E_AGENT_NATIVE", promise)
}
