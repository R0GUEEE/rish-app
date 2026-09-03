package dev.zseven.rish.modules

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableArray
import dev.zseven.rish.RishUnavailable

/**
 * LocalRuntime — phase-1 Android skeleton.
 *
 * Mirrors the iOS registration in modules/rish/ios/Sources/LocalRuntimeModule.mm
 * (RCT_EXPORT_MODULE(LocalRuntime)) and the JS wrapper in
 * apps/mobile/src/native/LocalRuntime.ts. Every method rejects with the JS-
 * recognized "E_COMPLETION_NATIVE" unavailable code; no success results are stubbed.
 */
class LocalRuntimeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "LocalRuntime"

    @ReactMethod
    fun bootstrap(promise: Promise) = RishUnavailable.reject("LocalRuntime", "E_COMPLETION_NATIVE", promise)

    @ReactMethod
    fun credentialStatus(promise: Promise) = RishUnavailable.reject("LocalRuntime", "E_COMPLETION_NATIVE", promise)

    @ReactMethod
    fun presentCredentialPrompt(locale: String?, promise: Promise) = RishUnavailable.reject("LocalRuntime", "E_COMPLETION_NATIVE", promise)

    @ReactMethod
    fun clearCredential(promise: Promise) = RishUnavailable.reject("LocalRuntime", "E_COMPLETION_NATIVE", promise)

    @ReactMethod
    fun complete(model: String?, history: ReadableArray?, requestId: String?, thinkingMode: String?, promise: Promise) = RishUnavailable.reject("LocalRuntime", "E_COMPLETION_NATIVE", promise)

    @ReactMethod
    fun cancelCompletion(requestId: String?, promise: Promise) = RishUnavailable.reject("LocalRuntime", "E_COMPLETION_NATIVE", promise)

    @ReactMethod
    fun completeV2Stream(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalRuntime", "E_COMPLETION_NATIVE", promise)

    @ReactMethod
    fun completeV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalRuntime", "E_COMPLETION_NATIVE", promise)

    @ReactMethod
    fun recordAgentTrace(trace: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalRuntime", "E_COMPLETION_NATIVE", promise)

    @ReactMethod
    fun recordModelTransition(transition: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalRuntime", "E_COMPLETION_NATIVE", promise)

    @ReactMethod
    fun persistSession(json: String?, promise: Promise) = RishUnavailable.reject("LocalRuntime", "E_COMPLETION_NATIVE", promise)

    @ReactMethod
    fun loadSession(promise: Promise) = RishUnavailable.reject("LocalRuntime", "E_COMPLETION_NATIVE", promise)
}
