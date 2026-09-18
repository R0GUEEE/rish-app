package tech.zseven.rish.modules

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import org.json.JSONObject
import tech.zseven.rish.runtime.AndroidAgentPolicyService
import tech.zseven.rish.runtime.AndroidRuntimeState
import tech.zseven.rish.runtime.RuntimeJson

/**
 * AgentPolicy on Android: the read behind the permissions sheet.
 *
 * The rules live in `AndroidAgentPolicyService`; this is the bridge, and like
 * the agent runtime's it says why it refused before it refuses.
 */
class AgentPolicyModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val runtime = AndroidRuntimeState.get(reactContext)

    override fun getName(): String = "AgentPolicy"

    override fun getConstants(): MutableMap<String, Any> = mutableMapOf("implemented" to true)

    @ReactMethod
    fun describe(request: ReadableMap?, promise: Promise) {
        val captured = try {
            JSONObject(requireNotNull(request).toHashMap())
        } catch (failure: Exception) {
            Log.w(TAG, "Agent policy request is invalid", failure)
            promise.reject("E_AGENT_BAD_ARGUMENTS", "Agent policy request is invalid")
            return
        }
        runtime.io.execute {
            try {
                val result = runtime.agentPolicy.describe(captured)
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(result)))
            } catch (refused: AndroidAgentPolicyService.Refused) {
                Log.w(TAG, "Agent policy could not be described: ${refused.code}")
                promise.reject(refused.code, "Agent policy could not be described")
            } catch (failure: Exception) {
                Log.w(TAG, "Agent policy could not be described", failure)
                promise.reject("E_AGENT_NATIVE", "Agent policy could not be described")
            }
        }
    }

    private companion object {
        const val TAG = "RishAgent"
    }
}
