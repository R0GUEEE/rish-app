package tech.zseven.rish.runtime

import org.json.JSONObject

/**
 * JNI binding for the shared Rust agent core (modules/rish/core, see
 * src/main/cpp/rish_agent_core_jni.cpp).
 *
 * The library is only present in builds that staged it through
 * scripts/prepare-rish-agent-core-android.sh. [available] answers whether it
 * loaded; without it the session store refuses to persist rather than falling
 * back to a second set of rules.
 */
internal object RishAgentCoreNative {
    val available: Boolean by lazy {
        try {
            System.loadLibrary("rish_agent_ffi")
            System.loadLibrary("rish_agent_core_jni")
            true
        } catch (_: UnsatisfiedLinkError) {
            false
        } catch (_: SecurityException) {
            false
        }
    }

    @JvmStatic external fun protocolVersion(): Int

    /** "rish-agent-core <version> <git sha>" of the linked build. */
    @JvmStatic external fun buildId(): String?

    /**
     * One session-schema decision. [requestJson] is the `{"op", ...}` envelope
     * and [input] the operation's raw bytes (a candidate, a stored envelope, a
     * tombstone ledger), empty for ops that take none.
     */
    @JvmStatic external fun sessionReduce(requestJson: String, input: String?): String?

    /** Canonical JSON of a JSON text, or null when it cannot be canonicalised. */
    @JvmStatic external fun canonicalJson(json: String): String?

    /**
     * Runs one session decision and returns its reply, or throws when the core
     * refused. A refusal is never downgraded into a local decision: the whole
     * point of routing through the core is that both platforms answer alike.
     */
    fun session(request: JSONObject, input: String? = null): JSONObject {
        check(available) { "the shared agent core is not staged in this build" }
        val reply = sessionReduce(request.toString(), input)
            ?: error("the shared agent core produced no reply for ${request.optString("op")}")
        val parsed = JSONObject(reply)
        if (parsed.optBoolean("ok")) return parsed
        error("the shared agent core refused ${request.optString("op")}: ${parsed.opt("error")}")
    }

    /** The same call, with a refusal reported as null instead of thrown. */
    fun sessionOrNull(request: JSONObject, input: String? = null): JSONObject? {
        if (!available) return null
        val reply = sessionReduce(request.toString(), input) ?: return null
        val parsed = JSONObject(reply)
        return if (parsed.optBoolean("ok")) parsed else null
    }
}
