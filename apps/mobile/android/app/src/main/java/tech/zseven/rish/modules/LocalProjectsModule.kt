package tech.zseven.rish.modules

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableMap
import org.json.JSONObject
import tech.zseven.rish.RishUnavailable
import tech.zseven.rish.runtime.AndroidRuntimeState
import tech.zseven.rish.runtime.AndroidWorkspaceProjects
import tech.zseven.rish.runtime.RishAgentCoreNative
import tech.zseven.rish.runtime.RishLibgit2Native
import tech.zseven.rish.runtime.RuntimeJson

/**
 * LocalProjects on Android.
 *
 * Mirrors the iOS registration in modules/rish/ios/Sources/LocalProjectsModule.mm
 * (RCT_EXPORT_MODULE(LocalProjects)) and the JS wrapper in
 * apps/mobile/src/native/LocalProjects.ts.
 *
 * [projectForWorkspaceV2] and [attachWorkspaceProject] answer, through
 * [AndroidWorkspaceProjects]: whether a git project is attached to a workspace
 * root, and attaching one. That is what turns a bound working directory into
 * something the project context can list. The git panel's local operations
 * -- [statusV2], [diffV2], [stageAllV2], [commitV2] -- answer through
 * [tech.zseven.rish.runtime.AndroidProjectGit].
 *
 * Everything else still rejects with the JS-recognized "E_PROJECT_NATIVE"; no
 * success is stubbed anywhere, and nothing here pretends a repository exists.
 */
class LocalProjectsModule(private val react: ReactApplicationContext) :
    ReactContextBaseJavaModule(react) {

    private val runtime by lazy { AndroidRuntimeState.get(react) }

    override fun getConstants(): MutableMap<String, Any> =
        mutableMapOf("implemented" to (RishAgentCoreNative.available && RishLibgit2Native.available))

    override fun getName(): String = "LocalProjects"

    @ReactMethod
    fun list(promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun create(name: String?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun clone(url: String?, name: String?, options: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun status(projectId: String?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun diff(projectId: String?, options: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun stageAll(projectId: String?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun commit(projectId: String?, input: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun setRemote(projectId: String?, url: String?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun credentialStatus(projectId: String?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun presentCredentialPrompt(projectId: String?, locale: String?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun clearCredential(projectId: String?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun push(projectId: String?, options: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun attachWorkspaceProject(request: ReadableMap?, promise: Promise) =
        answer("attachWorkspaceProject", request, promise) { runtime.workspaceProjects.attach(it) }

    @ReactMethod
    fun projectForWorkspaceV2(request: ReadableMap?, promise: Promise) =
        answer("projectForWorkspaceV2", request, promise) { runtime.workspaceProjects.projectFor(it) }

    /**
     * A refusal carries the stable code the shared rule maps iOS's number to,
     * and no detail: a message could name a directory, and a path is not
     * JavaScript's to see. Anything else is the native failure JS already
     * knows how to sanitize.
     */
    private fun answer(
        operation: String,
        request: ReadableMap?,
        promise: Promise,
        body: (JSONObject?) -> JSONObject,
    ) {
        if (!RishAgentCoreNative.available || !RishLibgit2Native.available) {
            RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)
            return
        }
        val captured = try {
            request?.let { RuntimeJson.fromBridgeMap(it.toHashMap()) }
        } catch (_: Exception) {
            promise.reject("E_PROJECT_REQUEST_INVALID", "E_PROJECT_REQUEST_INVALID")
            return
        }
        runtime.io.execute {
            try {
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(body(captured))))
            } catch (refused: AndroidWorkspaceProjects.Refused) {
                android.util.Log.w(TAG, "$operation refused: ${refused.number}")
                promise.reject(refused.code, refused.code)
            } catch (failure: Throwable) {
                android.util.Log.w(TAG, "$operation could not be answered", failure)
                promise.reject("E_PROJECT_NATIVE", "E_PROJECT_NATIVE")
            }
        }
    }

    @ReactMethod
    fun prepareProjectDetachV1(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun commitProjectDetachV1(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun statusV2(request: ReadableMap?, promise: Promise) =
        answer("statusV2", request, promise) { runtime.projectGit.status(it) }

    @ReactMethod
    fun diffV2(request: ReadableMap?, promise: Promise) =
        answer("diffV2", request, promise) { runtime.projectGit.diff(it) }

    @ReactMethod
    fun stageAllV2(request: ReadableMap?, promise: Promise) =
        answer("stageAllV2", request, promise) { runtime.projectGit.stageAll(it) }

    @ReactMethod
    fun commitV2(request: ReadableMap?, promise: Promise) =
        answer("commitV2", request, promise) { runtime.projectGit.commit(it) }

    @ReactMethod
    fun pushV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    private companion object {
        const val TAG = "RishProjects"
    }
}
