package dev.zseven.rish.modules

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import dev.zseven.rish.RishUnavailable

/**
 * LocalProjects — phase-1 Android skeleton.
 *
 * Mirrors the iOS registration in modules/rish/ios/Sources/LocalProjectsModule.mm
 * (RCT_EXPORT_MODULE(LocalProjects)) and the JS wrapper in
 * apps/mobile/src/native/LocalProjects.ts. Every method rejects with the JS-
 * recognized "E_PROJECT_NATIVE" unavailable code; no success results are stubbed.
 */
class LocalProjectsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

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
    fun attachWorkspaceProject(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun projectForWorkspaceV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun prepareProjectDetachV1(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun commitProjectDetachV1(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun statusV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun diffV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun stageAllV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun commitV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)

    @ReactMethod
    fun pushV2(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalProjects", "E_PROJECT_NATIVE", promise)
}
