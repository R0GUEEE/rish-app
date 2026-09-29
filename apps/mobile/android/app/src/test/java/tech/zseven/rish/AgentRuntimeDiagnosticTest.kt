package tech.zseven.rish

import org.junit.Assert.assertTrue
import org.junit.Test
import tech.zseven.rish.modules.diagnosed

/**
 * What Android puts in a rejection's message has to be exactly what
 * `agent-runtime-diagnostic.ts` accepts, or JavaScript drops it in silence and
 * the tester's screenshot says nothing again. The pattern below mirrors it.
 */
class AgentRuntimeDiagnosticTest {
    private class Refused(val code: String) : Exception(code)

    private val accepted = Regex(
        "^agent_runtime/v1 operation=(?:complete_agent_round_v2|recover_agent_attempt) " +
            "kind=(?:persistence|unavailable|exception|unknown|refused)" +
            "(?: code=E_[A-Z0-9_]{1,48})?" +
            "(?: cause=[A-Za-z0-9_$]{1,64})?" +
            "(?: site=[A-Za-z0-9_.$:]{1,120})?$",
    )

    @Test fun aRefusalAndAnExceptionBothReadAsTheControllerExpects() {
        for ((code, failure) in listOf("E_AGENT_NATIVE" to Refused("E_AGENT_NATIVE"), "E_AGENT_NATIVE" to IllegalStateException("x /data/secret"))) {
            val message = diagnosed("complete_agent_round_v2", code, failure)
            val (first, diagnostic) = message.split('\n', limit = 2)
            assertTrue(message, first == code)
            assertTrue(diagnostic, accepted.matches(diagnostic))
            // The exception's own message never rides along.
            assertTrue(diagnostic, !diagnostic.contains("secret"))
        }
        val refused = diagnosed("recover_agent_attempt", "E_AGENT_CONFLICT", Refused("E_AGENT_CONFLICT"))
        assertTrue(refused, refused.contains("kind=refused") && refused.contains("site=AgentRuntimeDiagnosticTest."))
    }
}
