package dev.zseven.dsh.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.PromiseImpl
import com.facebook.react.bridge.ReactApplicationContext
import dev.zseven.rish.tasks.TaskExperienceModule
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class TaskPermissionTest {
    @Test fun explicitPermissionRequestResolvesAfterTheRealSystemPrompt() {
        assumeTrue(Build.VERSION.SDK_INT >= 33)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        // Run this test separately, before granted-permission notification tests.
        assumeTrue(context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
        ActivityScenario.launch(MainActivity::class.java).use {
            val response = AtomicReference<String?>()
            val rejection = AtomicReference<String?>()
            val deadline = System.currentTimeMillis() + 30_000
            var react: ReactApplicationContext? = null
            while (System.currentTimeMillis() < deadline && react == null) {
                instrumentation.runOnMainSync { react = (context.applicationContext as MainApplication).reactHost.currentReactContext?.let { candidate -> (candidate as? ReactApplicationContext)?.takeIf { it.currentActivity?.hasWindowFocus() == true } } }
                if (react == null) Thread.sleep(100)
            }
            assertNotNull("React context unavailable", react)
            val module = TaskExperienceModule(react!!)
            module.handle("{\"schema_version\":1,\"op\":\"permission\"}", PromiseImpl(
                Callback { args -> response.set(args.firstOrNull() as? String) },
                Callback { args -> rejection.set(args.firstOrNull().toString()) },
            ))
            var clicked = false
            val promptDeadline = System.currentTimeMillis() + 10_000
            while (System.currentTimeMillis() < promptDeadline && !clicked) {
                val root = instrumentation.uiAutomation.rootInActiveWindow
                val allow = root?.findAccessibilityNodeInfosByText("Allow")?.firstOrNull { node -> node.text?.toString()?.equals("allow", ignoreCase = true) == true }
                if (allow != null) {
                    val image = instrumentation.uiAutomation.takeScreenshot()
                    context.cacheDir.resolve("task-notification-permission.png").outputStream().use { out -> image?.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out) }
                    image?.recycle()
                    clicked = allow.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                }
                if (!clicked) Thread.sleep(100)
            }
            if (!clicked) {
                val image = instrumentation.uiAutomation.takeScreenshot()
                context.cacheDir.resolve("task-notification-permission-failure.png").outputStream().use { out -> image?.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out) }
                image?.recycle()
            }
            assertTrue("System notification prompt was not shown; response=${response.get()}, rejection=${rejection.get()}", clicked)
            val resultDeadline = System.currentTimeMillis() + 10_000
            while (System.currentTimeMillis() < resultDeadline && response.get() == null && rejection.get() == null) Thread.sleep(100)
            assertNull(rejection.get())
            val result = JSONObject(requireNotNull(response.get()))
            assertEquals("authorized", result.getJSONObject("value").getString("notifications"))
        }
    }
}
