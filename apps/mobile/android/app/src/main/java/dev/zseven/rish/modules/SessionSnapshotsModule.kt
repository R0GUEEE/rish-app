package dev.zseven.rish.modules

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import dev.zseven.rish.RishUnavailable

/**
 * SessionSnapshots — phase-1 Android skeleton.
 *
 * Mirrors the iOS registration in modules/rish/ios/Sources/SessionSnapshotsModule.mm
 * (RCT_EXPORT_MODULE(SessionSnapshots)) and the JS wrapper in
 * apps/mobile/src/native/SessionSnapshots.ts. Every method rejects with the JS-
 * recognized "E_SESSION_NATIVE" unavailable code; no success results are stubbed.
 */
class SessionSnapshotsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "SessionSnapshots"

    @ReactMethod
    fun loadSessionSnapshot(promise: Promise) = RishUnavailable.reject("SessionSnapshots", "E_SESSION_NATIVE", promise)

    @ReactMethod
    fun casPersistSession(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("SessionSnapshots", "E_SESSION_NATIVE", promise)

    @ReactMethod
    fun querySessionCommit(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("SessionSnapshots", "E_SESSION_NATIVE", promise)

    @ReactMethod
    fun persistSessionWithWorkspaceClearance(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("SessionSnapshots", "E_SESSION_NATIVE", promise)

    @ReactMethod
    fun queryWorkspaceClearance(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("SessionSnapshots", "E_SESSION_NATIVE", promise)
}
