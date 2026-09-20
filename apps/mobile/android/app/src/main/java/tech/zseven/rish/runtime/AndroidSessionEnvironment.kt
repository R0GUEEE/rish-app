package tech.zseven.rish.runtime

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject

/**
 * The host facts the shared core needs to judge a session candidate: which of
 * the strings the candidate carries name a model this build supports, which
 * harness and provider host each belongs to, and which provider ids exist.
 * The core owns the rules; only the host knows its own catalogue.
 *
 * This mirrors `DSHSessionCoreEnvironment` in SessionSnapshotStore.mm — the
 * facts are collected from the candidate's own strings, so a session that
 * never mentions a model needs no catalogue at all.
 */
internal object AndroidSessionEnvironment {
    /**
     * `DSHCatalogProviderByHarness` and `DSHCatalogHostByProvider`: the
     * provider each harness talks to, and the official host of each
     * provider. The two vocabularies are distinct -- a harness is `dsh`, its
     * provider is `deepseek` -- and the session schema asks about provider
     * ids, which is what JavaScript writes into a verified attempt.
     *
     * A project-context manifest records the host its snapshot was prepared
     * for, and the core accepts the manifest only when that host is the one
     * this build would reach for the model -- or the host of a provider
     * binding it has been told is valid.
     */
    private val providerByHarness = mapOf(
        "dsh" to "deepseek",
        "claude-code" to "anthropic",
        "codex" to "openai",
        "glm" to "bigmodel",
    )
    private val hostByProvider = mapOf(
        "deepseek" to "api.deepseek.com",
        "anthropic" to "api.anthropic.com",
        "openai" to "api.openai.com",
        "bigmodel" to "open.bigmodel.cn",
    )
    private val providerIds = hostByProvider.keys
    private val officialHostByHarness = providerByHarness.mapValues { hostByProvider.getValue(it.value) }

    private class Facts {
        val strings = sortedSetOf<String>()
        val bindings = JSONArray()
        val bindingKeys = HashSet<String>()
    }

    /**
     * `DSHSessionCoreCollectFacts`: every string, and every provider binding
     * a record carries, judged once against the model that record names.
     * The key is what the core computes when it meets the same record, so
     * the answer is found by identity rather than by position.
     */
    private fun collect(node: Any?, facts: Facts) {
        when (node) {
            is String -> facts.strings.add(node)
            is JSONArray -> for (index in 0 until node.length()) collect(node.opt(index), facts)
            is JSONObject -> {
                val binding = node.opt("provider_configuration")
                if (binding != null && binding != JSONObject.NULL) {
                    val model = node.opt("model")
                    val key = RuntimeJson.sha(RuntimeJson.canonical(JSONObject().put("binding", binding).put("model", model ?: JSONObject.NULL)))
                    if (facts.bindingKeys.add(key)) {
                        val valid = AndroidProviderConfiguration.validBinding(binding, model as? String)
                        val host = if (valid) (binding as JSONObject).getString("endpoint_url").toHttpUrlOrNull()?.host else null
                        facts.bindings.put(JSONObject().put("canonical_sha256", key).put("valid", valid).put("host", host ?: JSONObject.NULL))
                    }
                }
                for (key in node.keys()) collect(node.opt(key), facts)
            }
        }
    }

    /** Whether this build can talk to `model` at all, and through which
     *  harness. Both are facts only the host has. */
    fun isSupported(model: String): Boolean = harnessOrNull(model) != null

    fun harnessIdFor(model: String): String? = harnessOrNull(model)

    /** `DSHProviderHostForModel`: the official host, whatever binding is
     *  configured; a binding's host travels with the binding. */
    fun hostFor(model: String): String? = harnessOrNull(model)?.let { officialHostByHarness[it] }

    /** `DSHProviderIdForModel`: `deepseek` for a DeepSeek model, not `dsh`. */
    fun providerFor(model: String): String? = harnessOrNull(model)?.let { providerByHarness[it] }

    private fun harnessOrNull(model: String): String? =
        try { AndroidProviderConfiguration.harness(model) } catch (_: IllegalStateException) { null }

    /**
     * The catalogue facts carried by whatever JSON is handed in. The mechanism
     * is the value's own strings, so this serves a session candidate and an
     * agent round request alike -- which is what `DSHProviderEnvironment` does
     * on iOS, over the request it is about to judge.
     */
    fun facts(value: JSONObject): JSONObject {
        val collected = Facts()
        collect(value, collected)
        val models = JSONArray()
        val harnessByModel = JSONObject()
        val hostByModel = JSONObject()
        val providers = JSONArray()
        for (string in collected.strings) {
            harnessOrNull(string)?.let { harness ->
                models.put(string)
                harnessByModel.put(string, harness)
                officialHostByHarness[harness]?.let { hostByModel.put(string, it) }
            }
            if (string in providerIds) providers.put(string)
        }
        return JSONObject().put("supported_models", models).put("harness_by_model", harnessByModel)
            .put("provider_ids", providers).put("host_by_model", hostByModel)
            .put("provider_bindings", collected.bindings)
    }
}
