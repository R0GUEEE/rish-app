package tech.zseven.rish

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SmallTest
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import tech.zseven.rish.runtime.AndroidCredentialStore
import tech.zseven.rish.runtime.AndroidModelTransport
import tech.zseven.rish.runtime.AndroidProviderConfiguration
import java.util.UUID

/**
 * Reassembling a streamed reply.
 *
 * The preview is display-only, but the reply the round settles on is built
 * from the same chunks, so the assembler has to produce exactly what the
 * non-streaming path would have received. These hold the two things chunked
 * transports get wrong: arguments split mid-token across frames, and frames
 * that carry nothing at all.
 */
@RunWith(AndroidJUnit4::class)
@SmallTest
class AndroidModelTransportStreamTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun transport(): AndroidModelTransport {
        val namespace = "stream-${UUID.randomUUID()}"
        return AndroidModelTransport(
            AndroidCredentialStore(context, namespace),
            AndroidProviderConfiguration(context, "$namespace.providers"),
        )
    }

    private fun stream(vararg lines: String) =
        lines.joinToString("\n", postfix = "\n").byteInputStream(Charsets.UTF_8)

    @Test
    fun textAndReasoningArriveInPiecesAndEndAsOneReply() {
        val seen = mutableListOf<JSONObject>()
        val reply = transport().assembleStream(
            stream(
                """data: {"id":"r-1","model":"deepseek-v4-flash","choices":[{"delta":{"reasoning_content":"think"}}]}""",
                ": keep-alive",
                "",
                """data: {"id":"r-1","model":"deepseek-v4-flash","choices":[{"delta":{"content":"Hel"}}]}""",
                """data: {"id":"r-1","model":"deepseek-v4-flash","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}""",
                "data: [DONE]",
            ),
        ) { seen.add(it) }
        val choice = reply.getJSONArray("choices").getJSONObject(0)
        val message = choice.getJSONObject("message")
        assertEquals("r-1", reply.getString("id"))
        assertEquals("Hello", message.getString("content"))
        assertEquals("think", message.getString("reasoning_content"))
        assertEquals("stop", choice.getString("finish_reason"))
        // The keep-alive and the blank line are not events.
        assertEquals("$seen", 3, seen.size)
        assertEquals("think", seen[0].getString("reasoning"))
        assertEquals("Hel", seen[1].getString("text"))
    }

    /**
     * A tool call arrives as a name once and arguments a few characters at a
     * time. Reassembled wrongly, the round asks the model to write a file with
     * half a path.
     */
    @Test
    fun toolCallFragmentsAreJoinedInOrder() {
        val seen = mutableListOf<JSONObject>()
        val reply = transport().assembleStream(
            stream(
                """data: {"id":"r-2","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write_file","arguments":"{\"pa"}}]}}]}""",
                """data: {"id":"r-2","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"a.txt\"}"}}]}}]}""",
                """data: {"id":"r-2","model":"m","choices":[{"delta":{},"finish_reason":"tool_calls"}]}""",
                "data: [DONE]",
            ),
        ) { seen.add(it) }
        val call = reply.getJSONArray("choices").getJSONObject(0)
            .getJSONObject("message").getJSONArray("tool_calls").getJSONObject(0)
        assertEquals("call_1", call.getString("id"))
        assertEquals("write_file", call.getJSONObject("function").getString("name"))
        assertEquals(
            """{"path":"a.txt"}""",
            call.getJSONObject("function").getString("arguments"),
        )
        // Each fragment was previewed as it arrived, not only at the end.
        assertTrue("$seen", seen.size >= 2)
        assertEquals(
            "write_file",
            seen[0].getJSONArray("tool_calls").getJSONObject(0).getString("name"),
        )
    }

    /** A stream that stops without a finish reason is a truncated reply. */
    @Test
    fun aStreamWithoutAFinishReasonIsRefused() {
        val refused = try {
            transport().assembleStream(
                stream("""data: {"id":"r-3","model":"m","choices":[{"delta":{"content":"half"}}]}"""),
            ) {}
            false
        } catch (_: Exception) {
            true
        }
        assertTrue("a truncated stream must not answer as a complete reply", refused)
    }
}
