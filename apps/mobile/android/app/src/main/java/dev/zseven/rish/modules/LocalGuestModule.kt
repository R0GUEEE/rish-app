package dev.zseven.rish.modules

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import dev.zseven.rish.RishUnavailable

/**
 * LocalGuest — phase-1 Android skeleton.
 *
 * Mirrors the iOS registration in modules/rish/ios/Sources/LocalGuestModule.mm
 * (RCT_EXPORT_MODULE(LocalGuest)) and the JS wrapper in
 * apps/mobile/src/native/LocalGuest.ts. Every method rejects with the JS-
 * recognized "E_GUEST_NATIVE" unavailable code; no success results are stubbed.
 */
class LocalGuestModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getConstants(): MutableMap<String, Any> = mutableMapOf("implemented" to false)

    override fun getName(): String = "LocalGuest"

    @ReactMethod
    fun bootGuest(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalGuest", "E_GUEST_NATIVE", promise)

    @ReactMethod
    fun guestExec(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalGuest", "E_GUEST_NATIVE", promise)

    @ReactMethod
    fun shutdownGuest(promise: Promise) = RishUnavailable.reject("LocalGuest", "E_GUEST_NATIVE", promise)
}
