package dev.zseven.dsh.mobile

import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.*
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.zseven.rish.runtime.AndroidDshModelCatalog
import org.hamcrest.Matcher
import org.hamcrest.Matchers.allOf
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DshModelCatalogUiTest {
    private fun awaitView(matcher: Matcher<View>) {
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            try { onView(allOf(matcher, isDisplayed())).check(matches(isDisplayed())); return } catch (_: Throwable) { }
            Thread.sleep(250)
        }
        val inst = InstrumentationRegistry.getInstrumentation()
        inst.uiAutomation.takeScreenshot()?.let { bitmap ->
            inst.targetContext.cacheDir.resolve("catalog-ui-failure.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        fail("Expected catalog UI not displayed")
    }
    @Test fun addModelThroughReactEditorPersistsInNativeCatalog() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefs = context.getSharedPreferences("rish.dsh-models.v1", 0)
        val previous = prefs.getString("catalog", null)
        val credentials = dev.zseven.rish.runtime.AndroidRuntimeState.get(context).credentials
        val previousKey = credentials.get("DEEPSEEK_API_KEY")
        try {
            prefs.edit().remove("catalog").commit()
            credentials.put("DEEPSEEK_API_KEY", "fixture-key-not-sent-to-network")
            ActivityScenario.launch(MainActivity::class.java).use {
                awaitView(withContentDescription("Open navigation"))
                onView(withContentDescription("Open navigation")).perform(click())
                awaitView(withContentDescription("Settings"))
                onView(withContentDescription("Settings")).perform(click())
                awaitView(withText("Task alerts & background work"))
                onView(withContentDescription("Add model")).perform(scrollTo(), click())
                val inputDeadline = System.currentTimeMillis() + 10_000
                while (System.currentTimeMillis() < inputDeadline) {
                    try { onView(withContentDescription("Model ID 4")).check(matches(withEffectiveVisibility(Visibility.VISIBLE))); break } catch (_: Throwable) { Thread.sleep(250) }
                }
                onView(withContentDescription("Model ID 4")).perform(scrollTo(), replaceText("catalog-ui-fixture-vNext"), closeSoftKeyboard())
                onView(withContentDescription("Display name 4")).perform(scrollTo(), replaceText("Future model fixture"), closeSoftKeyboard())
                onView(withContentDescription("Save model catalog")).perform(scrollTo(), click())
                awaitView(withText("Model catalog saved"))
                val catalog = AndroidDshModelCatalog.read().getJSONArray("models")
                assertEquals(4, catalog.length())
                assertEquals("catalog-ui-fixture-vNext", catalog.getJSONObject(3).getString("id"))
                onView(withContentDescription("Model ID 4")).perform(scrollTo())
                Thread.sleep(400)
                val bitmap = requireNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
                context.cacheDir.resolve("dsh-model-catalog-ui.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
                onView(withContentDescription("Close settings")).perform(click())
                Thread.sleep(400)
                val drawerClose = withTagKey(com.facebook.react.R.id.react_test_id, org.hamcrest.Matchers.equalTo("drawer-close"))
                awaitView(drawerClose)
                onView(drawerClose).perform(click())
                val options = withContentDescription(org.hamcrest.Matchers.startsWith("Model V4 Flash,"))
                awaitView(options)
                onView(options).perform(click())
                awaitView(withText("Future model fixture"))

            }
        } finally {
            if (previousKey == null) credentials.clear("DEEPSEEK_API_KEY") else credentials.put("DEEPSEEK_API_KEY", previousKey)
            if (previous == null) prefs.edit().remove("catalog").commit() else prefs.edit().putString("catalog", previous).commit()
        }
    }
}
