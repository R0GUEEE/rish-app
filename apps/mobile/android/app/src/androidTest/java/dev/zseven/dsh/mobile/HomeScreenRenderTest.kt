package dev.zseven.dsh.mobile

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Phase-1 instrumented smoke test: launch MainActivity and assert the React
 * home screen actually renders a non-empty view tree without a native crash.
 *
 * The JS layer guards every absent native module through capability probes
 * (see the isAvailable() capability probes in apps/mobile/src/native), so
 * the phase-1 skeleton
 * must show the home screen with its "persistence unavailable"/unverified
 * states instead of crashing. This test is intentionally structural (the
 * ReactRootView renders children) plus a native-crash assertion via the
 * window-focus path; UI-string assertions belong to a later phase once the
 * i18n keys are pinned.
 *
 * Run with one Gradle command:
 *   ./gradlew :app:connectedDebugAndroidTest
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class HomeScreenRenderTest {

    @Test
    fun homeScreenRendersReactRootView() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val deadline = System.currentTimeMillis() + 30_000L
            var rendered = false
            var lastError: Throwable? = null

            // Poll until the React root view mounts and draws children, or the
            // deadline passes. React mounts on a background thread, so busy-
            // wait with a bounded deadline keeps this dependency-free.
            while (System.currentTimeMillis() < deadline) {
                try {
                    scenario.onActivity { activity ->
                        val content = activity.window?.decorView?.findViewById<android.view.ViewGroup>(
                            android.R.id.content,
                        )
                        // The ReactRootView is the content view's child once RN
                        // attaches; before that the tree is empty or a splash.
                        val root = content?.getChildAt(0) ?: return@onActivity
                        if (root is android.view.ViewGroup && root.childCount > 0 && root.isAttachedToWindow) {
                            rendered = true
                        }
                    }
                } catch (error: Throwable) {
                    lastError = error
                }
                if (rendered) break
                Thread.sleep(500L)
            }

            if (lastError != null && !rendered) fail("activity interaction failed: " + lastError?.message)
            assertTrue("React home screen did not render within 30s", rendered)
        }
    }

    @Test
    fun homeScreenRendersWithoutNativeCrash() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val deadline = System.currentTimeMillis() + 30_000L
            var resumed = false
            while (System.currentTimeMillis() < deadline) {
                try {
                    scenario.onActivity { activity ->
                        resumed = !activity.isFinishing && activity.hasWindowFocus()
                    }
                } catch (_: Throwable) {
                    // Activity recreation during launch; retry below.
                }
                if (resumed) break
                Thread.sleep(500L)
            }
            assertTrue("MainActivity never reached a stable resumed state", resumed)
        }
    }
}
