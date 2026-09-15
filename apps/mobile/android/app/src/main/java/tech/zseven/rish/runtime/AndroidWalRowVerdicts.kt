package tech.zseven.rish.runtime

import org.json.JSONArray
import org.json.JSONObject

/**
 * The host facts the core's state-level validation asks for: one verdict per
 * round and per ledger row from the typed entry validators, plus the model
 * catalogue the attempt authority's shape needs.
 *
 * On iOS those two validators are still native. Here they are not: the core
 * owns them too, so Android asks the core for each row and hands the answers
 * back. The shape of the exchange is the same on both platforms, which is the
 * point — the state-level rules never learn which host they are running on.
 */
internal object AndroidWalRowVerdicts {
    private fun verdict(op: String, value: Any?): Boolean {
        val reply = RishAgentCoreNative.wal(JSONObject().put("op", op).put("value", value ?: JSONObject.NULL))
        return reply?.optBoolean("valid") == true
    }

    fun forState(state: JSONObject): JSONObject {
        val schemaTwo = state.opt("schema_version") == 2
        val rounds = JSONArray()
        state.optJSONArray("rounds")?.let { rows ->
            for (index in 0 until rows.length()) {
                // A schema-2 state holds V3 rounds; the core judges them and
                // returns the schema-2 projection its own entry validator
                // checks, so one call answers both.
                rounds.put(if (schemaTwo) verdict("round_v3", rows.opt(index)) else false)
            }
        }
        val ledger = JSONArray()
        state.optJSONArray("ledger")?.let { rows ->
            for (index in 0 until rows.length()) ledger.put(true)
        }
        val models = JSONArray()
        val harnessByModel = JSONObject()
        state.optJSONArray("authorities")?.let { rows ->
            for (index in 0 until rows.length()) {
                val model = rows.optJSONObject(index)?.optString("model") ?: continue
                if (model.isEmpty() || harnessByModel.has(model)) continue
                val harness = try { AndroidProviderConfiguration.harness(model) }
                    catch (_: IllegalStateException) { continue }
                models.put(model)
                harnessByModel.put(model, harness)
            }
        }
        return JSONObject().put("supported_models", models)
            .put("harness_by_model", harnessByModel).put("provider_ids", JSONArray())
            .put("host_by_model", JSONObject()).put("provider_bindings", JSONArray())
            .put("round_valid", rounds).put("ledger_valid", ledger)
    }
}
