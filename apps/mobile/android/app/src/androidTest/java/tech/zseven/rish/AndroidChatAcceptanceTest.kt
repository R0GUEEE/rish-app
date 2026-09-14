package tech.zseven.rish

import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.*
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import tech.zseven.rish.runtime.AndroidRuntimeState
import org.hamcrest.Matcher
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidChatAcceptanceTest {
    private var marker = "ANDROID_UI_CHAT_OK"
    private fun waitFor(matcher: Matcher<View>) {
        val deadline = System.currentTimeMillis() + 120_000
        while(System.currentTimeMillis() < deadline) {
            try { onView(org.hamcrest.Matchers.allOf(matcher, isDisplayed())).check(matches(isDisplayed())); return } catch (_: Throwable) { }
            Thread.sleep(250)
        }
        fail("Expected chat UI was not displayed")
    }
    private fun screenshot(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        Thread.sleep(400)
        val image = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        instrumentation.targetContext.cacheDir.resolve(name).outputStream().use { image.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }
    private fun hasAssistant(loaded: JSONObject): Boolean {
        if(loaded.getString("status") != "present") return false
        val conversations = JSONObject(loaded.getString("session_json")).getJSONArray("conversations")
        for(i in 0 until conversations.length()) {
            val messages = conversations.getJSONObject(i).getJSONArray("messages")
            for(j in 0 until messages.length()) {
                val message = messages.getJSONObject(j)
                if(message.getString("role") == "assistant" && message.optString("text").trim() == marker) return true
            }
        }
        return false
    }
    @Test fun inspectExistingChatDisplay() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("rishChatAcceptance") == "inspect")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            Thread.sleep(2500)
            screenshot("chat-inspect.png")
            val found = org.json.JSONArray()
            scenario.onActivity { activity ->
                fun scan(view: android.view.View) {
                    if(view is android.widget.TextView && view !is android.widget.EditText) {
                        val text = view.text.toString()
                        if(text.contains("ANDROID") || text.contains("E_")) {
                            val rect = android.graphics.Rect(); val visible = view.getGlobalVisibleRect(rect)
                            found.put(JSONObject().put("text", text).put("visible", visible).put("rect", rect.toShortString()))
                        }
                    }
                    if(view is android.view.ViewGroup) for(index in 0 until view.childCount) scan(view.getChildAt(index))
                }
                scan(activity.window.decorView)
            }
            context.filesDir.resolve("chat-ui-inspection.json").writeText(found.toString(2))
        }
    }
    @Test fun sendAndPersistRealDshReply() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("rishChatAcceptance") == "send")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        marker = "ANDROID_UI_" + java.util.UUID.randomUUID().toString().take(8).uppercase()
        context.filesDir.resolve("chat-acceptance-marker.txt").writeText(marker)
        ActivityScenario.launch(MainActivity::class.java).use {
            waitFor(withContentDescription("Message DSH"))
            onView(withContentDescription("Message DSH")).perform(replaceText("Reply with exactly $marker. No explanation."), closeSoftKeyboard())
            onView(withContentDescription("Send message")).perform(click())
            waitFor(withText(marker))
            val runtime = AndroidRuntimeState.get(context)
            val deadline = System.currentTimeMillis() + 10_000
            var loaded = runtime.sessions.load()
            while(System.currentTimeMillis() < deadline && !hasAssistant(loaded)) { Thread.sleep(100); loaded = runtime.sessions.load() }
            assertTrue("Assistant reply not durably stored", hasAssistant(loaded))
            assertTrue(runtime.transport.sentRequestCount > 0)
            context.filesDir.resolve("chat-acceptance-send.json").writeText(JSONObject().put("schema_version",1)
                .put("snapshot", loaded.getJSONObject("snapshot")).put("writer", loaded.getString("writer_launch_instance_id"))
                .put("request_count",runtime.transport.sentRequestCount).put("assistant_persisted",true).toString(2))
            screenshot("chat-acceptance-send.png")
        }
    }
    @Test fun reopenRestoresTheReplyWithoutSendingAgain() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("rishChatAcceptance") == "restore")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        marker = context.filesDir.resolve("chat-acceptance-marker.txt").readText()
        val before = AndroidRuntimeState.get(context).sessions.load()
        assertNotEquals(before.getString("writer_launch_instance_id"), before.getString("current_launch_instance_id"))
        ActivityScenario.launch(MainActivity::class.java).use {
            waitFor(withText(marker))
            Thread.sleep(1500)
            val runtime = AndroidRuntimeState.get(context)
            assertEquals(0, runtime.transport.sentRequestCount)
            assertEquals(0, runtime.transport.activeRequestCount())
            val loaded = runtime.loadSnapshot()
            context.filesDir.resolve("chat-acceptance-restore.json").writeText(JSONObject().put("schema_version",1)
                .put("snapshot",loaded.getJSONObject("snapshot")).put("writer",loaded.getString("writer_launch_instance_id"))
                .put("current_launch",loaded.getString("current_launch_instance_id")).put("request_count",0).put("restored",true).toString(2))
            screenshot("chat-acceptance-restore.png")
        }
    }
}
