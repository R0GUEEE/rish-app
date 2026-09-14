package tech.zseven.rish.modules

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableArray
import tech.zseven.rish.RishUnavailable

/**
 * LocalAttachments — phase-1 Android skeleton.
 *
 * Mirrors the iOS registration in modules/rish/ios/Sources/LocalAttachmentsModule.mm
 * (RCT_EXPORT_MODULE(LocalAttachments)) and the JS wrapper in
 * apps/mobile/src/native/LocalAttachments.ts. Every method rejects with the JS-
 * recognized "E_NATIVE_UNAVAILABLE" unavailable code; no success results are stubbed.
 */
class LocalAttachmentsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getConstants(): MutableMap<String, Any> = mutableMapOf("implemented" to false)

    override fun getName(): String = "LocalAttachments"

    @ReactMethod
    fun present(source: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalAttachments", "E_NATIVE_UNAVAILABLE", promise)

    @ReactMethod
    fun discard(ids: ReadableArray?, promise: Promise) = RishUnavailable.reject("LocalAttachments", "E_NATIVE_UNAVAILABLE", promise)

    @ReactMethod
    fun prune(referencedIds: ReadableArray?, promise: Promise) = RishUnavailable.reject("LocalAttachments", "E_NATIVE_UNAVAILABLE", promise)

    @ReactMethod
    fun preview(id: String?, promise: Promise) = RishUnavailable.reject("LocalAttachments", "E_NATIVE_UNAVAILABLE", promise)

    @ReactMethod
    fun presentPreview(id: String?, promise: Promise) = RishUnavailable.reject("LocalAttachments", "E_NATIVE_UNAVAILABLE", promise)
}
