package tech.zseven.rish

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import android.os.SystemClock
import android.content.Intent
import tech.zseven.rish.runtime.OfficialCliProbeService
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs only in a CLI-enabled arm64 build. This is the app-UID gate: shell
 * execution of the same files is insufficient evidence for the product.
 */
@RunWith(AndroidJUnit4::class)
class AndroidSubscriptionCliExecutionTest {
    private val context = ApplicationProvider.getApplicationContext<android.app.Application>()

    @Test
    fun officialClisExecuteFromExtractedNativeLibraryDir() {
        assertTrue("Run this probe only with -PrishOfficialCliDir=...", BuildConfig.RISH_OFFICIAL_CLI_ENABLED)
        assertTrue("CLI probe requires an arm64 emulator/device", android.os.Build.SUPPORTED_ABIS.contains("arm64-v8a"))
        val nativeDir = File(context.applicationInfo.nativeLibraryDir)
        val codex = File(nativeDir, "libcodex.so")
        val claude = File(nativeDir, "libclaude_code.so")
        val loader = File(nativeDir, "libmusl_loader.so")
        assertTrue("Codex is not in extracted nativeLibraryDir", codex.isFile)
        assertTrue("Claude is not in extracted nativeLibraryDir", claude.isFile)
        assertTrue("musl loader is not in extracted nativeLibraryDir", loader.isFile)
        val resultFile = File(context.cacheDir, OfficialCliProbeService.RESULT_FILE)
        resultFile.delete()
        context.startService(Intent(context, OfficialCliProbeService::class.java).setAction(OfficialCliProbeService.ACTION))
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (!resultFile.isFile && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50)
        assertTrue("app UID probe did not finish", resultFile.isFile)
        val result = JSONObject(resultFile.readText())
        assertTrue("probe did not run under an app UID", result.getInt("uid") > 10_000)
        assertEquals("0.153.4", result.getString("codex"))
        assertEquals("2.1.263", result.getString("claude"))
        assertTrue(result.getBoolean("codex_login_help_device_auth"))
        assertEquals(0, result.getInt("codex_status_help_exit"))
        assertEquals(0, result.getInt("claude_status_help_exit"))
        assertTrue("Codex status unexpectedly accepted unsupported --json", result.getInt("codex_status_json_exit") != 0)
        assertTrue("Claude stdin code flow was advertised without help support", !result.getBoolean("claude_login_help_stdin_code"))
        assertTrue("Codex device challenge URL was not emitted", result.getBoolean("codex_challenge_url_present"))
        assertTrue("Codex device challenge code was not emitted", result.getBoolean("codex_challenge_code_present"))
        assertTrue("Codex challenge encountered a TLS validation failure", !result.getBoolean("codex_challenge_tls_error"))
        assertTrue("Claude auth challenge encountered a TLS validation failure", !result.getBoolean("claude_challenge_tls_error"))
    }

}
