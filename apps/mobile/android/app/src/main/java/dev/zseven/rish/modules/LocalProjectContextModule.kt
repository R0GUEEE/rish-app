package dev.zseven.rish.modules

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import dev.zseven.rish.RishUnavailable

/**
 * LocalProjectContext — phase-1 Android skeleton.
 *
 * Mirrors the iOS registration in modules/rish/ios/Sources/LocalProjectContextModule.mm
 * (RCT_EXPORT_MODULE(LocalProjectContext)) and the JS wrapper in
 * apps/mobile/src/native/LocalProjectContext.ts. Every method rejects with the JS-
 * recognized "E_CONTEXT_NATIVE" unavailable code; no success results are stubbed.
 */
class LocalProjectContextModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getConstants(): MutableMap<String, Any> = mutableMapOf("implemented" to false)

    override fun getName(): String = "LocalProjectContext"

    @ReactMethod
    fun listProjectContextCandidates(projectId: String?, query: String?, nextCursor: String?, promise: Promise) = RishUnavailable.reject("LocalProjectContext", "E_CONTEXT_NATIVE", promise)

    @ReactMethod
    fun prepareProjectContext(selection: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjectContext", "E_CONTEXT_NATIVE", promise)

    @ReactMethod
    fun confirmProjectContext(snapshotId: String?, promise: Promise) = RishUnavailable.reject("LocalProjectContext", "E_CONTEXT_NATIVE", promise)

    @ReactMethod
    fun inspectProjectContext(snapshotId: String?, promise: Promise) = RishUnavailable.reject("LocalProjectContext", "E_CONTEXT_NATIVE", promise)

    @ReactMethod
    fun discardProjectContext(snapshotId: String?, promise: Promise) = RishUnavailable.reject("LocalProjectContext", "E_CONTEXT_NATIVE", promise)

    @ReactMethod
    fun listCandidatesV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjectContext", "E_CONTEXT_NATIVE", promise)

    @ReactMethod
    fun prepareCandidateV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjectContext", "E_CONTEXT_NATIVE", promise)

    @ReactMethod
    fun confirmSnapshotV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjectContext", "E_CONTEXT_NATIVE", promise)

    @ReactMethod
    fun inspectSnapshotV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjectContext", "E_CONTEXT_NATIVE", promise)

    @ReactMethod
    fun discardProjectContextV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjectContext", "E_CONTEXT_NATIVE", promise)

    @ReactMethod
    fun verifiedSendProjectContextV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjectContext", "E_CONTEXT_NATIVE", promise)
}
