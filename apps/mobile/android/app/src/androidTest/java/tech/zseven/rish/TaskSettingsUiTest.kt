package tech.zseven.rish

import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.hamcrest.Matcher
import android.view.View
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TaskSettingsUiTest {
    private fun awaitView(matcher: Matcher<View>) {
        val deadline = System.currentTimeMillis() + 30_000
        var failure: Throwable? = null
        while (System.currentTimeMillis() < deadline) {
            try { onView(matcher).check(matches(isDisplayed())); return } catch (error: Throwable) { failure = error }
            Thread.sleep(250)
        }
        throw AssertionError("React task settings did not render", failure)
    }
    @Test fun realReactScreenShowsAndroidTaskNotificationControls() {
        ActivityScenario.launch(MainActivity::class.java).use {
            awaitView(withContentDescription("Open navigation"))
            onView(withContentDescription("Open navigation")).perform(click())
            awaitView(withContentDescription("Settings"))
            onView(withContentDescription("Settings")).perform(click())
            awaitView(withText("Task alerts & background work"))
            onView(withText("Ongoing task notification")).check(matches(isDisplayed()))
            onView(withText("Task completed")).check(matches(isDisplayed()))
            val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
            // Espresso can be idle while a React Native render-thread animation
            // is still moving. Require two stable frames before exporting proof.
            var bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
            var stable = false
            val deadline = System.currentTimeMillis() + 5_000
            while (System.currentTimeMillis() < deadline) {
                Thread.sleep(250)
                val next = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
                stable = bitmap.sameAs(next)
                bitmap.recycle(); bitmap = next
                if (stable) break
            }
            check(stable) { "Task settings screenshot did not stabilize" }
            instrumentation.targetContext.cacheDir.resolve("task-settings-android.png").outputStream().use { out ->
                check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out))
            }
            bitmap.recycle()
        }
    }
}
