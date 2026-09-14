package dev.zseven.rish.modules

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import dev.zseven.rish.RishUnavailable
import dev.zseven.rish.guest.AndroidGuestAssets
import dev.zseven.rish.guest.GuestSessionController
import dev.zseven.rish.guest.RishGuestNative

/**
 * LocalGuest — the rish Linux guest on Android.
 *
 * Mirrors the iOS registration in modules/rish/ios/Sources/LocalGuestModule.mm
 * (RCT_EXPORT_MODULE(LocalGuest)) and the JS wrapper in
 * apps/mobile/src/native/LocalGuest.ts. The pure-Rust x86_64 interpreter and
 * the guest boot assets are only packaged when scripts/prepare-rish-android.sh
 * staged them; a lite build keeps rejecting every call with E_GUEST_NATIVE and
 * reports `implemented = false`, which is what LocalGuest.isAvailable() reads.
 */
class LocalGuestModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val controller: GuestSessionController? =
        if (RishGuestNative.available) {
            GuestSessionController(AndroidGuestAssets(reactContext), RishGuestNative)
        } else {
            null
        }

    override fun getName(): String = "LocalGuest"

    override fun getConstants(): MutableMap<String, Any> = mutableMapOf("implemented" to (controller != null))

    @ReactMethod
    fun bootGuest(request: ReadableMap?, promise: Promise) {
        val live = controller ?: return RishUnavailable.reject("LocalGuest", "E_GUEST_NATIVE", promise)
        live.bootGuest(request?.toHashMap(), { receipt -> promise.resolve(Arguments.makeNativeMap(receipt)) }, promise::reject)
    }

    @ReactMethod
    fun guestExec(request: ReadableMap?, promise: Promise) {
        val live = controller ?: return RishUnavailable.reject("LocalGuest", "E_GUEST_NATIVE", promise)
        live.guestExec(request?.toHashMap(), { receipt -> promise.resolve(Arguments.makeNativeMap(receipt)) }, promise::reject)
    }

    @ReactMethod
    fun shutdownGuest(promise: Promise) {
        val live = controller ?: return RishUnavailable.reject("LocalGuest", "E_GUEST_NATIVE", promise)
        live.shutdownGuest { receipt -> promise.resolve(Arguments.makeNativeMap(receipt)) }
    }

    override fun invalidate() {
        controller?.close()
        super.invalidate()
    }
}
