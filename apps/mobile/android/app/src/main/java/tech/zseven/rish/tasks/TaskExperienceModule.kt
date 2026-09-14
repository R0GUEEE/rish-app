package tech.zseven.rish.tasks

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import org.json.JSONObject

class TaskExperienceModule(private val react: ReactApplicationContext) : ReactContextBaseJavaModule(react) {
    private var listeners = 0
    private var permission: Promise? = null
    private val emitter: (String) -> Unit = { event ->
        if (listeners > 0 && react.hasActiveReactInstance()) react.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("RishTaskAction", event)
    }
    override fun getName() = "RishTaskExperience"
    override fun initialize() {
        super.initialize()
        UiThreadUtil.runOnUiThread { TaskExperience.emit = emitter }
    }
    @ReactMethod fun addListener(name: String) { UiThreadUtil.runOnUiThread { if (name == "RishTaskAction") listeners++ } }
    @ReactMethod fun removeListeners(count: Double) { UiThreadUtil.runOnUiThread { listeners = (listeners - count.toInt()).coerceAtLeast(0) } }
    @ReactMethod fun handle(input: String, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            try {
                require(input.toByteArray(Charsets.UTF_8).size <= 32768)
                val request = JSONObject(input)
                require(TaskPolicy.validSchema(request.opt("schema_version")))
                when (request.getString("op")) {
                    "permission" -> {
                        if (Build.VERSION.SDK_INT < 33 || TaskExperience.authorization() == "authorized") resolve(promise, TaskExperience.settings())
                        else {
                            check(permission == null)
                            val activity = react.currentActivity as? PermissionAwareActivity ?: error("Activity required")
                            permission = promise
                            TaskExperience.permissionRequested()
                            activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 9041, PermissionListener { code, _, _ ->
                                if (code != 9041) false else {
                                    permission?.let { resolve(it, TaskExperience.settings()) }; permission = null; true
                                }
                            })
                        }
                    }
                    "openSettings" -> {
                        val intent = if (Build.VERSION.SDK_INT >= 26) Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, react.packageName)
                        else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${react.packageName}"))
                        react.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); resolve(promise, true)
                    }
                    else -> resolve(promise, TaskExperience.handle(request))
                }
            } catch (_: Exception) {
                if (permission === promise) permission = null
                promise.reject("E_TASK_EXPERIENCE", "Task service unavailable")
            }
        }
    }
    private fun resolve(promise: Promise, value: Any) {
        promise.resolve(JSONObject().put("schema_version", 1).put("ok", true).put("value", value).toString())
    }
    override fun invalidate() {
        UiThreadUtil.runOnUiThread {
            if (TaskExperience.emit === emitter) TaskExperience.emit = null
            permission?.reject("E_TASK_EXPERIENCE", "Activity unavailable"); permission = null
        }
        super.invalidate()
    }
}
