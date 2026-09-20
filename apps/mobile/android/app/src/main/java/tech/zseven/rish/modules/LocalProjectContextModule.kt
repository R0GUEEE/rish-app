package tech.zseven.rish.modules

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import tech.zseven.rish.RishUnavailable
import tech.zseven.rish.runtime.AndroidProjectContextService
import tech.zseven.rish.runtime.AndroidRuntimeState
import tech.zseven.rish.runtime.RishAgentCoreNative
import tech.zseven.rish.runtime.RishLibgit2Native
import tech.zseven.rish.runtime.RuntimeJson

/**
 * LocalProjectContext on Android.
 *
 * Mirrors the iOS registration in modules/rish/ios/Sources/LocalProjectContextModule.mm
 * (RCT_EXPORT_MODULE(LocalProjectContext)) and the JS wrapper in
 * apps/mobile/src/native/LocalProjectContext.ts.
 *
 * [listCandidatesV2] answers, through [AndroidProjectContextService]. The
 * snapshot operations -- prepare, confirm, inspect, discard, send -- still
 * reject with the JS-recognized "E_CONTEXT_NATIVE"; no success is stubbed.
 */
class LocalProjectContextModule(private val react: ReactApplicationContext) :
    ReactContextBaseJavaModule(react) {

    private val runtime by lazy { AndroidRuntimeState.get(react) }

    override fun getConstants(): MutableMap<String, Any> =
        mutableMapOf("implemented" to (RishAgentCoreNative.available && RishLibgit2Native.available))

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
    fun listCandidatesV2(request: ReadableMap?, promise: Promise) {
        if (!RishAgentCoreNative.available || !RishLibgit2Native.available) {
            RishUnavailable.reject("LocalProjectContext", "E_CONTEXT_NATIVE", promise)
            return
        }
        val captured = try {
            request?.let { RuntimeJson.fromBridgeMap(it.toHashMap()) }
        } catch (_: Exception) {
            promise.reject("E_CONTEXT_REQUEST_INVALID", "E_CONTEXT_REQUEST_INVALID")
            return
        }
        runtime.io.execute {
            try {
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(runtime.projectContext.listCandidates(captured))))
            } catch (refused: AndroidProjectContextService.Refused) {
                // The code and nothing else: a reason could name a path.
                Log.w(TAG, "listCandidatesV2 refused: ${refused.code}")
                promise.reject(refused.code, refused.code)
            } catch (failure: Throwable) {
                Log.w(TAG, "listCandidatesV2 could not be answered", failure)
                promise.reject("E_CONTEXT_NATIVE", "E_CONTEXT_NATIVE")
            }
        }
    }

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

    private companion object {
        const val TAG = "RishProjectContext"
    }
}
