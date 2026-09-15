package tech.zseven.rish.runtime

import org.json.JSONObject

/**
 * The tool registry, read from the shared core rather than typed out again.
 *
 * The table is a pure table and the digest taken over it is what every stored
 * authority is bound to, so there is exactly one copy of it — in
 * `tool_registry.rs`. All this side contributes is the build fact the core
 * cannot know: whether the guest CGI tools exist here. They do not yet on
 * Android, and saying so is what makes this build's `toolset_sha256` honest.
 */
internal object AndroidAgentToolRegistry {
    /** Android ships no guest CGI tools, so they are not in its toolset. */
    private const val GUEST_CGI = false

    class Refused(val code: Int) : RuntimeException("E_AGENT_STORE_$code")

    private fun reduce(op: String, fields: JSONObject): JSONObject {
        check(RishAgentCoreNative.available) { "the shared agent core is not staged in this build" }
        val envelope = JSONObject(fields.toString()).put("op", op).put("guest_cgi", GUEST_CGI)
        val reply = RishAgentCoreNative.toolRegistryReduce(envelope.toString())
            ?: throw Refused(2)
        val parsed = JSONObject(reply)
        if (!parsed.optBoolean("ok")) throw Refused(parsed.optInt("error", 2))
        return parsed
    }

    /** The digest a stored authority's registry must carry. */
    fun toolsetSha256(): String =
        reduce("toolset_sha256", JSONObject()).getString("toolset_sha256")

    fun registryForRoot(root: JSONObject): JSONObject =
        reduce("registry", JSONObject().put("root", root)).getJSONObject("registry")

    fun policyForRoot(root: JSONObject): JSONObject =
        reduce("policy", JSONObject().put("root", root)).getJSONObject("policy")

    /** The safe projection for one tool, or a durable denial. */
    fun descriptorForTool(name: String, root: JSONObject): JSONObject =
        reduce("descriptor", JSONObject().put("name", name).put("root", root))
            .getJSONObject("descriptor")

    /** The full descriptor, for building a provider request. */
    fun nativeDescriptor(name: String): JSONObject =
        reduce("native_descriptor", JSONObject().put("name", name)).getJSONObject("descriptor")

    fun validateRegistry(registry: JSONObject, root: JSONObject): Boolean =
        reduce("registry_shape", JSONObject().put("registry", registry).put("root", root))
            .optBoolean("valid") &&
            registry.optString("toolset_sha256") == toolsetSha256()
}
