package tech.zseven.rish.modules

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import org.json.JSONObject
import tech.zseven.rish.runtime.AndroidMirrorStore
import tech.zseven.rish.runtime.AndroidRuntimeState
import tech.zseven.rish.runtime.RuntimeJson

/**
 * LocalMirrors on Android: staging the guest's package mirrors.
 *
 * The rules live in [AndroidMirrorStore], which writes the same three files
 * and the same receipt as `LocalMirrorsModule.mm`. This is the bridge, and
 * like the agent runtime's it says why it refused before it refuses.
 */
class LocalMirrorsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val runtime = AndroidRuntimeState.get(reactContext)

    override fun getConstants(): MutableMap<String, Any> = mutableMapOf("implemented" to true)

    override fun getName(): String = "LocalMirrors"

    @ReactMethod
    fun applyMirrors(mirrors: ReadableMap?, promise: Promise) {
        val requested = try {
            mirrors?.let { JSONObject(it.toHashMap()) }
        } catch (failure: Exception) {
            Log.w(TAG, "Mirror configuration is invalid", failure)
            promise.reject("E_MIRRORS_INVALID", "Mirror configuration is invalid")
            return
        }
        runtime.io.execute {
            try {
                promise.resolve(
                    Arguments.makeNativeMap(RuntimeJson.map(runtime.mirrors.apply(requested))),
                )
            } catch (refused: AndroidMirrorStore.Refused) {
                Log.w(TAG, "Mirrors could not be staged: ${refused.code}")
                promise.reject(refused.code, refused.reason)
            } catch (failure: Exception) {
                Log.w(TAG, "Mirrors could not be staged", failure)
                promise.reject("E_MIRRORS_NATIVE", "Mirrors could not be staged")
            }
        }
    }

    @ReactMethod
    fun mirrorStatus(promise: Promise) {
        runtime.io.execute {
            try {
                val staged = runtime.mirrors.status()
                // Nothing staged is an answer, not a failure.
                if (staged == null) promise.resolve(null)
                else promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(staged)))
            } catch (refused: AndroidMirrorStore.Refused) {
                Log.w(TAG, "Mirror status could not be read: ${refused.code}")
                promise.reject(refused.code, refused.reason)
            } catch (failure: Exception) {
                Log.w(TAG, "Mirror status could not be read", failure)
                promise.reject("E_MIRRORS_NATIVE", "Mirror status could not be read")
            }
        }
    }

    private companion object {
        const val TAG = "RishMirrors"
    }
}
