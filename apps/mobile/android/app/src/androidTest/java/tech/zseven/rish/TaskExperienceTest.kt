package tech.zseven.rish

import android.Manifest
import android.app.NotificationManager
import android.os.Build
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.zseven.rish.tasks.TaskExperience
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Real Android notification/service APIs, synthetic task events. No model/Agent proof. */
@RunWith(AndroidJUnit4::class)
class TaskExperienceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val manager get() = context.getSystemService(NotificationManager::class.java)
    private fun main(block: () -> Unit) = instrumentation.runOnMainSync(block)
    private fun call(op: String, vararg fields: Pair<String, Any>): Any {
        val request = JSONObject().put("schema_version", 1).put("op", op)
        fields.forEach { request.put(it.first, it.second) }
        return TaskExperience.handle(request)
    }
    private fun waitUntil(check: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            var done = false; main { done = check() }; if (done) return
            Thread.sleep(100)
        }
        fail("Timed out waiting for Android system state")
    }
    private fun scenario(background: Boolean = false, body: (ActivityScenario<MainActivity>, String) -> Unit) {
        if (Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        ActivityScenario.launch(MainActivity::class.java).use { activity ->
            val id = UUID.randomUUID().toString()
            var original: JSONObject? = null
            main {
                original = TaskExperience.settings().getJSONObject("preferences")
                val preferences = JSONObject(original.toString()).put("completed", true).put("failed", true).put("attention", true).put("background", background)
                call("preferences", "preferences" to preferences)
                call("visible", "conversationId" to "conversation-$id")
                call("begin", "runId" to id, "conversationId" to "conversation-$id")
            }
            try { body(activity, id) } finally {
                main {
                    TaskExperience.activeRun()?.let { call("end", "runId" to it.id, "status" to "cancelled") }
                    original?.let { call("preferences", "preferences" to it) }
                    call("drain")
                }
                (1..3).forEach { manager.cancel(id, it) }
            }
        }
    }
    @Test fun foregroundViewerReceivesNoCompletionAlert() = scenario { _, id ->
        main { call("end", "runId" to id, "status" to "completed") }
        assertFalse(manager.activeNotifications.any { it.tag == id })
    }
    @Test fun alertIsGenericDeduplicatedAndOpensTheCorrectConversation() = scenario { _, id ->
        main {
            call("visible", "conversationId" to JSONObject.NULL)
            call("update", "runId" to id, "phase" to "approval_pending")
            call("update", "runId" to id, "phase" to "approval_pending")
        }
        waitUntil { manager.activeNotifications.count { it.tag == id } == 1 }
        val alert = manager.activeNotifications.single { it.tag == id }.notification
        assertEquals("Rish", alert.extras.getString("android.title"))
        assertFalse(alert.extras.getString("android.text")!!.contains(id))
        alert.contentIntent.send()
        waitUntil { (call("drain") as org.json.JSONArray).let { events ->
            (0 until events.length()).any { events.getJSONObject(it).let { event -> event.getString("action") == "open" && event.getString("conversationId") == "conversation-$id" } }
        } }
    }
    @Test fun oldNotificationStopCannotCancelNewTask() = scenario { _, id ->
        waitUntil { manager.activeNotifications.any { it.id == TaskExperience.ONGOING_ID } }
        val oldAction = manager.activeNotifications.single { it.id == TaskExperience.ONGOING_ID }.notification.actions[0].actionIntent
        val next = "new-$id"
        main { call("begin", "runId" to next, "conversationId" to "conversation-$next") }
        oldAction.send()
        instrumentation.waitForIdleSync()
        main { assertEquals(next, TaskExperience.activeRun()?.id); assertFalse(TaskExperience.activeRun()!!.stopRequested) }
        waitUntil { manager.activeNotifications.any { it.id == TaskExperience.ONGOING_ID } }
        manager.activeNotifications.single { it.id == TaskExperience.ONGOING_ID }.notification.actions[0].actionIntent.send()
        waitUntil { TaskExperience.activeRun()?.stopRequested == true }
    }
    @Test fun foregroundServiceKeepsTheExistingTaskWhenActivityStops() = scenario(background = true) { activity, id ->
        waitUntil { TaskExperience.backgroundAdmission == "accepted" }
        activity.moveToState(Lifecycle.State.CREATED)
        main { assertFalse(TaskExperience.foreground); assertEquals(id, TaskExperience.activeRun()?.id); assertFalse(TaskExperience.activeRun()!!.stopRequested) }
        assertTrue(manager.activeNotifications.any { it.id == TaskExperience.ONGOING_ID })
        main { call("end", "runId" to id, "status" to "completed") }
        waitUntil { manager.activeNotifications.none { it.id == TaskExperience.ONGOING_ID } }
        assertTrue(manager.activeNotifications.any { it.tag == id })
    }
    @Test fun staleForegroundStartStopsBeforeItsPromotionDeadline() = scenario { _, id ->
        main {
            val intent = android.content.Intent(context, dev.zseven.rish.tasks.TaskForegroundService::class.java).putExtra("runId", "obsolete-$id")
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
        Thread.sleep(6_000)
        main {
            assertEquals(id, TaskExperience.activeRun()?.id)
            assertFalse(TaskExperience.activeRun()!!.stopRequested)
            assertEquals("notRequested", TaskExperience.backgroundAdmission)
            assertTrue(manager.activeNotifications.any { it.id == TaskExperience.ONGOING_ID })
            assertFalse(manager.activeNotifications.any { it.id == TaskExperience.RETIRED_START_ID })
        }
    }
    @Test fun unavailableReactBridgeKeepsCancellationQueued() = scenario { _, id ->
        main {
            val previous = TaskExperience.emit
            try {
                TaskExperience.emit = { throw IllegalStateException("React unavailable") }
                assertTrue(TaskExperience.requestCancel(id, "conversation-$id"))
                val events = call("drain") as org.json.JSONArray
                assertTrue((0 until events.length()).any { events.getJSONObject(it).getString("runId") == id })
            } finally { TaskExperience.emit = previous }
        }
    }
    @Test fun withoutBackgroundOptInStoppingActivityRequestsCancellation() = scenario { activity, _ ->
        activity.moveToState(Lifecycle.State.CREATED)
        main { assertTrue(TaskExperience.activeRun()!!.stopRequested) }
    }
}
