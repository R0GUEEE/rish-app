package tech.zseven.rish.modules

import com.facebook.react.bridge.*
import tech.zseven.rish.RishUnavailable
import tech.zseven.rish.runtime.AndroidRuntimeState
import tech.zseven.rish.runtime.RuntimeJson
import org.json.JSONObject

/** Opaque chat snapshots with atomic CAS. Workspace authority APIs remain unavailable. */
class SessionSnapshotsModule(react: ReactApplicationContext) : ReactContextBaseJavaModule(react) {
    private val runtime = AndroidRuntimeState.get(react)
    override fun getName() = "SessionSnapshots"
    private fun run(promise: Promise, operation: () -> JSONObject) {
        runtime.io.execute {
            try { promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(operation()))) }
            catch (_: Exception) { promise.reject("E_SESSION_NATIVE", "Session snapshot operation failed") }
        }
    }
    private fun capture(request: ReadableMap?): String {
        requireNotNull(request)
        val json = JSONObject(request.toHashMap()).toString()
        require(json.toByteArray(Charsets.UTF_8).size <= 20 * 1024 * 1024)
        return json
    }
    @ReactMethod fun loadSessionSnapshot(promise: Promise) = run(promise) { runtime.loadSnapshot() }
    @ReactMethod fun casPersistSession(request: ReadableMap?, promise: Promise) {
        try { val captured = capture(request); run(promise) { runtime.sessions.persist(JSONObject(captured)) } }
        catch (_: Exception) { promise.reject("E_SESSION_NATIVE", "Invalid session request") }
    }
    @ReactMethod fun querySessionCommit(request: ReadableMap?, promise: Promise) {
        try { val captured = capture(request); run(promise) { runtime.sessions.query(JSONObject(captured)) } }
        catch (_: Exception) { promise.reject("E_SESSION_NATIVE", "Invalid session request") }
    }
    @ReactMethod fun persistSessionWithWorkspaceClearance(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("SessionSnapshots", "E_SESSION_NATIVE", promise)
    @ReactMethod fun queryWorkspaceClearance(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("SessionSnapshots", "E_SESSION_NATIVE", promise)
}
