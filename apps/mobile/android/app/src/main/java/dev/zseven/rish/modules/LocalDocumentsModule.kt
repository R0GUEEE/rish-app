package dev.zseven.rish.modules

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import dev.zseven.rish.RishUnavailable

/**
 * LocalDocuments — phase-1 Android skeleton.
 *
 * Mirrors the iOS registration in modules/rish/ios/Sources/LocalDocumentsModule.mm
 * (RCT_EXPORT_MODULE(LocalDocuments)) and the JS wrapper in
 * apps/mobile/src/native/LocalDocuments.ts. Every method rejects with the JS-
 * recognized "E_NATIVE_UNAVAILABLE" unavailable code; no success results are stubbed.
 */
class LocalDocumentsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getConstants(): MutableMap<String, Any> = mutableMapOf("implemented" to false)

    override fun getName(): String = "LocalDocuments"

    @ReactMethod
    fun presentImportPicker(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalDocuments", "E_NATIVE_UNAVAILABLE", promise)

    @ReactMethod
    fun presentExportPicker(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalDocuments", "E_NATIVE_UNAVAILABLE", promise)

    @ReactMethod
    fun queryOperation(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalDocuments", "E_NATIVE_UNAVAILABLE", promise)

    @ReactMethod
    fun retryOperation(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalDocuments", "E_NATIVE_UNAVAILABLE", promise)

    @ReactMethod
    fun cleanupOperation(request: ReadableMap?, promise: Promise) = RishUnavailable.reject("LocalDocuments", "E_NATIVE_UNAVAILABLE", promise)
}
