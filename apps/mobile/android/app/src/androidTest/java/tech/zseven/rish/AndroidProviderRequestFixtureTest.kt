package tech.zseven.rish

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SmallTest
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import tech.zseven.rish.runtime.AndroidCredentialStore
import tech.zseven.rish.runtime.AndroidModelTransport
import tech.zseven.rish.runtime.AndroidProviderConfiguration
import tech.zseven.rish.runtime.RuntimeJson
import java.util.UUID

/**
 * The frozen request bodies, replayed through this host's transport.
 *
 * The fixture lives next to the iOS suite that first recorded it and is read
 * from there rather than copied, so there is one truth. Two things it caught
 * the first time it ran here: this host sent one token ceiling where iOS
 * sends four, and it hashed the request with the canonical encoding rather
 * than the one a receipt binds -- which differ on any round whose tool
 * arguments carry a path.
 */
@RunWith(AndroidJUnit4::class)
@SmallTest
class AndroidProviderRequestFixtureTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    /** The fixture rides in the test apk, not the app's own assets. */
    private fun fixture(name: String): JSONObject = JSONObject(
        InstrumentationRegistry.getInstrumentation().context.assets
            .open(name).bufferedReader().use { it.readText() },
    )

    private fun transport(): AndroidModelTransport {
        val namespace = "request-fixture-${UUID.randomUUID()}"
        return AndroidModelTransport(
            AndroidCredentialStore(context, namespace),
            AndroidProviderConfiguration(context, "$namespace.providers"),
        )
    }

    @Test fun deepSeekRequestBodiesMatchTheFrozenOnes() {
        val fixture = fixture("deepseek-request-cases.json")
        assertEquals(1, fixture.getInt("schema_version"))
        assertEquals("dsh", fixture.getString("harness_id"))
        val cases = fixture.getJSONArray("cases")
        assertTrue("${cases.length()}", cases.length() > 3)
        val transport = transport()
        for (index in 0 until cases.length()) {
            val entry = cases.getJSONObject(index)
            val name = entry.getString("name")
            val body = transport.chatCompletionsBody(
                JSONObject().put("model", entry.getString("model"))
                    .put("stream", entry.getBoolean("streaming")),
                entry.getString("thinking_mode"),
                // The official DeepSeek configuration always sends reasoning.
                true,
                entry.getJSONArray("messages"),
                entry.getJSONArray("tools"),
            )
            // Compared through the receipt encoding, which is both what goes
            // on the wire and what the digest is taken over -- so a key this
            // host adds or drops shows up here rather than on a provider.
            assertEquals(
                "$name body",
                RuntimeJson.receiptJson(entry.getJSONObject("body")),
                RuntimeJson.receiptJson(body),
            )
            assertEquals(
                "$name digest",
                entry.getString("body_sha256"),
                RuntimeJson.sha(RuntimeJson.receiptJson(body)),
            )
        }
    }

    /**
     * The encoding a receipt binds is not the canonical one, and the two are
     * only ever the same when nothing needs escaping. A round that names a
     * file has a slash in it, which is the case that matters.
     */
    /**
     * The Anthropic bodies, for the cases this host claims. A case the
     * fixture lists as `ios` only is a gap it records rather than a test that
     * fails; `host_gaps` in the fixture says what those gaps are.
     *
     * The turns go in already shaped, taken from the frozen body: what is
     * under test here is the body built around them, because turning turns
     * into content blocks is a layer this host does not have.
     */
    @Test fun anthropicRequestBodiesMatchTheOnesThisHostClaims() {
        val fixture = fixture("anthropic-request-cases.json")
        assertEquals("claude-code", fixture.getString("harness_id"))
        val cases = fixture.getJSONArray("cases")
        val transport = transport()
        var claimed = 0
        for (index in 0 until cases.length()) {
            val entry = cases.getJSONObject(index)
            val hosts = entry.getJSONArray("hosts")
            if ((0 until hosts.length()).none { hosts.getString(it) == "android" }) continue
            claimed += 1
            val name = entry.getString("name")
            val frozen = entry.getJSONObject("body")
            val body = transport.messagesBody(
                JSONObject().put("model", entry.getString("model"))
                    .put("stream", entry.getBoolean("streaming")),
                entry.getString("model"),
                entry.getString("thinking_mode"),
                true,
                frozen.getJSONArray("messages"),
            )
            assertEquals(
                "$name body",
                RuntimeJson.receiptJson(frozen),
                RuntimeJson.receiptJson(body),
            )
            assertEquals(
                "$name digest",
                entry.getString("body_sha256"),
                RuntimeJson.sha(RuntimeJson.receiptJson(body)),
            )
        }
        assertTrue("no case claimed android", claimed > 0)
        // And every gap the fixture records says which host it is about.
        val gaps = fixture.getJSONArray("host_gaps")
        assertTrue("$gaps", gaps.length() > 0)
        for (index in 0 until gaps.length()) {
            assertTrue(gaps.getJSONObject(index).getString("detail").isNotEmpty())
        }
    }

    @Test fun theReceiptEncodingEscapesWhatTheCanonicalOneDoesNot() {
        val value = JSONObject().put("path", "workspace/notes.txt")
        assertEquals("""{"path":"workspace\/notes.txt"}""", RuntimeJson.receiptJson(value))
        assertEquals("""{"path":"workspace/notes.txt"}""", RuntimeJson.canonical(value))
        // Everything else the two agree on, so nothing else moves with it.
        val plain = JSONObject().put("b", 2).put("a", JSONArray().put(true).put("x"))
        assertEquals(RuntimeJson.canonical(plain), RuntimeJson.receiptJson(plain))
    }
}
