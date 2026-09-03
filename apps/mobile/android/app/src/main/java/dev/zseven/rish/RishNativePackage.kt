package dev.zseven.rish

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import dev.zseven.rish.modules.AgentRuntimeModule
import dev.zseven.rish.modules.LocalAttachmentsModule
import dev.zseven.rish.modules.LocalDocumentsModule
import dev.zseven.rish.modules.LocalGuestModule
import dev.zseven.rish.modules.LocalMirrorsModule
import dev.zseven.rish.modules.LocalProjectContextModule
import dev.zseven.rish.modules.LocalProjectsModule
import dev.zseven.rish.modules.LocalRuntimeModule
import dev.zseven.rish.modules.LocalWorkspaceModule
import dev.zseven.rish.modules.LocalWorkspacesModule
import dev.zseven.rish.modules.SessionSnapshotsModule

/**
 * Registers the 11 iOS-mirrored native modules for the phase-1 Android
 * skeleton.
 *
 * Bridge decision (documented for the architecture review): the app runs RN
 * 0.87 with newArchEnabled=true (apps/mobile/android/gradle.properties), and
 * the iOS side registers modules with the classic RCT_EXPORT_MODULE macros
 * (the *Module.mm files under modules/rish/ios/Sources). Classic Android bridge modules
 * (ReactContextBaseJavaModule + @ReactMethod) are exposed through RN's new-
 * architecture interop layer exactly like the iOS classic modules, and the JS
 * wrappers already probe both TurboModuleRegistry and NativeModules. We
 * therefore register classic modules now and leave the codegen TurboModule
 * spec migration as the phase-2 port decision (Kotlin vs Rust core).
 */
class RishNativePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(
            AgentRuntimeModule(reactContext),
            LocalAttachmentsModule(reactContext),
            LocalDocumentsModule(reactContext),
            LocalGuestModule(reactContext),
            LocalMirrorsModule(reactContext),
            LocalProjectContextModule(reactContext),
            LocalProjectsModule(reactContext),
            LocalRuntimeModule(reactContext),
            LocalWorkspaceModule(reactContext),
            LocalWorkspacesModule(reactContext),
            SessionSnapshotsModule(reactContext),
        )

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
