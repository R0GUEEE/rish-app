package tech.zseven.rish.runtime

import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.TimeUnit

internal class RuntimeFailure(val code: String, val httpStatus: Int? = null) : Exception(code)
internal class AndroidModelTransport(private val credentials: AndroidCredentialStore, val configurations: AndroidProviderConfiguration) {
    private val lock = Any()
    private var revision = 0L
    private val active = mutableMapOf<String, Prepared>()
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .retryOnConnectionFailure(false).connectTimeout(20, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).callTimeout(150, TimeUnit.SECONDS).build()
    @Volatile var sentRequestCount = 0
        private set
    fun activeRequestCount(): Int = synchronized(lock) { active.size }
    @Volatile var lastProof: JSONObject? = null
        private set
    @Volatile var lastModel: String? = null
        private set
    class Prepared(val input: JSONObject, val id: String, val model: String, val harness: String,
        val configuration: JSONObject, val account: String, val revision: Long) {
        var call: Call? = null
        var cancelled = false
    }
    private fun fail(code: String): Nothing = throw RuntimeFailure(code)
    fun prepare(text: String): Prepared = synchronized(lock) {
        if (text.toByteArray().size > 4 * 1024 * 1024) fail("E_COMPLETION_BODY_TOO_LARGE")
        val input = try { JSONObject(text) } catch (_: Exception) { fail("E_COMPLETION_BODY_INVALID") }
        val schema = input.opt("schema_version")
        if (schema !is Int || schema !in 1..2) fail("E_COMPLETION_CONTEXT_UNSUPPORTED")
        val model = input.getString("model"); val harness = AndroidProviderConfiguration.harness(model)
        if (schema == 2 && input.getString("harness_id") != harness) fail("E_COMPLETION_MODEL_MISMATCH")
        val id = input.getString(if(schema == 2) "round_id" else "request_id")
        if (!RuntimeJson.uuid(id)) fail("E_COMPLETION_IDENTIFIER")
        if (input.getString("thinking_mode") !in setOf("off", "high", "max")) fail("E_COMPLETION_THINKING")
        // Tools travel now. Bounded here rather than trusted: the round decides
        // which tools exist, and this only refuses a list no provider would
        // accept anyway.
        val toolCount = input.optJSONArray("tools")?.length() ?: 0
        if (toolCount > 64) fail("E_COMPLETION_CONTEXT_UNSUPPORTED")
        if (schema == 2) {
            if (!input.isNull("project_context")) fail("E_COMPLETION_CONTEXT_UNSUPPORTED")
            // The round transcript is judged in execute, where the protocol is
            // known: only chat-completions can carry one.
            if ((input.optJSONArray("round_transcript")?.length() ?: 0) > 64) fail("E_COMPLETION_CONTEXT_UNSUPPORTED")
            if (!RuntimeJson.uuid(input.getString("turn_id")) || !RuntimeJson.uuid(input.getString("attempt_id"))) fail("E_COMPLETION_IDENTIFIER")
            if (input.opt("round_index") !is Int || input.getInt("round_index") !in 0..7) fail("E_COMPLETION_ROUND")
        }
        if (active.size >= 4 || active.containsKey(id)) fail("E_COMPLETION_BUSY")
        val config = configurations.forModel(model)
        val account = migratedAccount(AndroidProviderConfiguration.slot(harness))
        Prepared(input, id, model, harness, config, account, revision).also { active[id] = it }
    }
    fun cancel(id: String): String = synchronized(lock) {
        val request = active[id] ?: return@synchronized "idle"
        request.cancelled = true; request.call?.cancel(); "cancelled"
    }
    fun <T> whenIdle(change: () -> T): T = synchronized(lock) {
        if (active.isNotEmpty()) fail("E_COMPLETION_BUSY")
        change()
    }
    fun <T> mutate(change: () -> T): T = synchronized(lock) {
        revision += 1
        active.values.forEach { it.cancelled = true; it.call?.cancel() }
        change()
    }
    private fun migratedAccount(slot: String): String {
        val current = configurations.effectiveAccount(slot)
        credentials.migrateAccount(configurations.previousAccount(slot), current)
        return current
    }
    fun account(slot: String): String = synchronized(lock) { configurations.effectiveAccount(slot) }
    fun configured(slot: String): Boolean = synchronized(lock) { credentials.configured(migratedAccount(slot)) }
    fun put(slot: String, expectedAccount: String, secret: String) = mutate {
        if (expectedAccount != configurations.effectiveAccount(slot)) fail("E_COMPLETION_CREDENTIAL_CHANGED")
        credentials.put(expectedAccount, secret)
        credentials.migrateAccount(configurations.previousAccount(slot), expectedAccount)
    }
    fun clear(slot: String) = mutate { credentials.clearAccounts(configurations.effectiveAccount(slot), configurations.previousAccount(slot)) }
    private fun own(request: Prepared) {
        if (active[request.id] !== request) fail("E_COMPLETION_CANCELLED")
        if (request.revision != revision || request.account != configurations.effectiveAccount(AndroidProviderConfiguration.slot(request.harness))) fail("E_COMPLETION_CREDENTIAL_CHANGED")
        if (request.cancelled) fail("E_COMPLETION_CANCELLED")
    }
    /**
     * A tool as the chat-completions protocol spells one. The name, the
     * description and the schema are the registry's; the wrapper around them
     * is this protocol's, and that is the only part this file decides.
     */
    /**
     * The chat-completions wrapper, reachable from a test. It is the one part
     * of a tool's trip to the model this platform decides, and the two lines
     * that used to refuse tools entirely are the reason it is worth seeing
     * directly rather than only through a network call.
     */
    internal fun functionToolsForTest(declared: JSONArray): JSONArray = functionTools(declared)

    /**
     * One round-transcript entry as a provider message.
     *
     * The core has already shaped these -- an assistant turn with its
     * `tool_calls`, or a `tool` result against a call id. What is dropped here
     * is only the nulls: a provider sent `"content": null` beside tool calls,
     * or a null `reasoning_content`, rejects the whole request.
     */
    private fun roundMessage(entry: JSONObject): JSONObject {
        val message = JSONObject()
        for (key in entry.keys()) {
            val value = entry.opt(key)
            if (value == null || value == JSONObject.NULL) continue
            if (value is JSONArray && value.length() == 0) continue
            message.put(key, value)
        }
        if (!message.has("content")) message.put("content", "")
        return message
    }

    private fun functionTools(declared: JSONArray): JSONArray {
        val tools = JSONArray()
        for (index in 0 until declared.length()) {
            val tool = declared.optJSONObject(index) ?: continue
            tools.put(
                JSONObject().put("type", "function").put(
                    "function",
                    JSONObject()
                        .put("name", tool.optString("name"))
                        .put("description", tool.optString("description"))
                        .put("parameters", tool.opt("parameters") ?: JSONObject()),
                ),
            )
        }
        return tools
    }

    /**
     * Reads a server-sent event stream into the reply the rest of this file
     * already knows how to read.
     *
     * Each `data:` line is a chat-completions chunk: the first carries the
     * response id and the model, the rest carry deltas. Text, reasoning and
     * tool-call fragments are accumulated by the same rules the provider would
     * have applied itself, and handed to the sink as they arrive. `[DONE]`
     * ends it; a stream that ends without a finish reason is a truncated
     * response, not a silent success.
     */
    internal fun assembleStream(stream: java.io.InputStream, sink: (JSONObject) -> Unit): JSONObject {
        var id: String? = null
        var model: String? = null
        var finish: String? = null
        val text = StringBuilder()
        val reasoning = StringBuilder()
        // Tool calls arrive in fragments keyed by index: the name once, the
        // arguments a few characters at a time.
        val calls = sortedMapOf<Int, JSONObject>()
        var read = 0L
        stream.bufferedReader(Charsets.UTF_8).use { reader ->
            while (true) {
                val line = reader.readLine() ?: break
                read += line.length + 1
                if (read > 4 * 1024 * 1024) fail("E_COMPLETION_RESPONSE_SIZE")
                if (!line.startsWith("data:")) continue
                val payload = line.removePrefix("data:").trim()
                if (payload.isEmpty()) continue
                if (payload == "[DONE]") break
                val chunk = try {
                    JSONObject(payload)
                } catch (_: Exception) {
                    fail("E_COMPLETION_RESPONSE_JSON")
                }
                if (id == null) id = chunk.optString("id").takeIf { it.isNotEmpty() }
                if (model == null) model = chunk.optString("model").takeIf { it.isNotEmpty() }
                val choice = chunk.optJSONArray("choices")?.optJSONObject(0) ?: continue
                choice.optString("finish_reason").takeIf { it.isNotEmpty() && it != "null" }
                    ?.let { finish = it }
                val delta = choice.optJSONObject("delta") ?: JSONObject()
                val event = JSONObject()
                stringOrEmpty(delta, "content").takeIf { it.isNotEmpty() }?.let {
                    text.append(it); event.put("text", it)
                }
                stringOrEmpty(delta, "reasoning_content").takeIf { it.isNotEmpty() }?.let {
                    reasoning.append(it); event.put("reasoning", it)
                }
                delta.optJSONArray("tool_calls")?.let { fragments ->
                    val previewed = JSONArray()
                    for (index in 0 until fragments.length()) {
                        val fragment = fragments.optJSONObject(index) ?: continue
                        val slot = fragment.optInt("index", index)
                        val call = calls.getOrPut(slot) {
                            JSONObject().put("id", "").put("name", "").put("arguments", "")
                        }
                        val preview = JSONObject().put("index", slot)
                        fragment.optString("id").takeIf { it.isNotEmpty() }?.let {
                            call.put("id", it); preview.put("id", it)
                        }
                        val function = fragment.optJSONObject("function")
                        function?.optString("name")?.takeIf { it.isNotEmpty() }?.let {
                            call.put("name", it); preview.put("name", it)
                        }
                        function?.optString("arguments")?.takeIf { it.isNotEmpty() }?.let {
                            call.put("arguments", call.optString("arguments") + it)
                            preview.put("arguments", it)
                        }
                        previewed.put(preview)
                    }
                    if (previewed.length() > 0) event.put("tool_calls", previewed)
                }
                finish?.let { event.put("finish_reason", it) }
                // An empty chunk -- a keep-alive, or usage-only -- is nothing
                // to show.
                if (event.length() > 0) sink(event)
            }
        }
        if (id == null || model == null || finish == null) fail("E_COMPLETION_RESPONSE_JSON")
        val message = JSONObject().put("role", "assistant")
            .put("content", text.toString()).put("reasoning_content", reasoning.toString())
        if (calls.isNotEmpty()) {
            val assembled = JSONArray()
            for ((_, call) in calls) {
                assembled.put(
                    JSONObject().put("id", call.optString("id")).put("type", "function")
                        .put(
                            "function",
                            JSONObject().put("name", call.optString("name"))
                                .put("arguments", call.optString("arguments")),
                        ),
                )
            }
            message.put("tool_calls", assembled)
        }
        return JSONObject().put("id", id).put("model", model)
            .put(
                "choices",
                JSONArray().put(
                    JSONObject().put("index", 0).put("message", message)
                        .put("finish_reason", finish),
                ),
            )
    }

    /**
     * Runs one prepared request.
     *
     * `sink` asks for the reply as it arrives: on chat-completions the request
     * is sent with `stream: true` and each chunk is handed over as it is
     * parsed, for display only. What the round *decides* never comes from the
     * chunks -- they are reassembled into exactly the reply shape the
     * non-streaming path produces, and everything below this point is the same
     * code reading the same object. A preview that disagreed with the settled
     * round would be worse than no preview.
     */
    fun execute(request: Prepared, sink: ((JSONObject) -> Unit)? = null): JSONObject {
        val started = android.os.SystemClock.elapsedRealtime()
        try {
            val input = request.input
            val history = input.getJSONArray(if(input.getInt("schema_version") == 2) "visible_history" else "history")
            if (history.length() !in 1..512) fail("E_COMPLETION_HISTORY")
            val messages = JSONArray()
            for (index in 0 until history.length()) {
                val item = history.getJSONObject(index)
                if (item.getString("role") !in setOf("user", "assistant") || (item.optJSONArray("attachments")?.length() ?: 0) != 0) fail("E_COMPLETION_CONTEXT_UNSUPPORTED")
                val text = item.getString("content")
                if (text.toByteArray().size > 1024 * 1024) fail("E_COMPLETION_BODY_TOO_LARGE")
                messages.put(JSONObject().put("role", item.getString("role")).put("content", text))
            }
            val config = request.configuration
            val protocol = config.getString("protocol")
            // What this round already did: the assistant turn that asked for a
            // tool, and the results that came back. Without it the model is
            // told nothing of the call it just made and asks for it again, so
            // a turn with a tool in it could never finish.
            val round = input.optJSONArray("round_transcript") ?: JSONArray()
            if (round.length() != 0) {
                if (protocol != "chat-completions") fail("E_COMPLETION_CONTEXT_UNSUPPORTED")
                for (index in 0 until round.length()) {
                    messages.put(roundMessage(round.getJSONObject(index)))
                }
            }
            val declared = input.optJSONArray("tools") ?: JSONArray()
            val wireModel = config.getJSONObject("model_mappings").optString(request.model, request.model)
            val streaming = sink != null && protocol == "chat-completions"
            val body = JSONObject().put("model", wireModel).put("stream", streaming)
            when(protocol) {
                "messages" -> {
                    body.put("messages", messages).put("max_tokens", 8192)
                    if(config.getBoolean("send_reasoning") && input.getString("thinking_mode") != "off") {
                        if(wireModel.startsWith("glm", true) || wireModel.startsWith("claude-haiku")) {
                            val budget = if(input.getString("thinking_mode") == "max") 16000 else 4096
                            body.put("thinking", JSONObject().put("type", "enabled").put("budget_tokens", budget)).put("max_tokens", budget + 8192)
                        } else body.put("thinking", JSONObject().put("type", "adaptive")).put("output_config", JSONObject().put("effort", input.getString("thinking_mode")))
                    }
                }
                "chat-completions" -> {
                    body.put("messages", messages).put("max_tokens", 8192)
                    if (declared.length() > 0) body.put("tools", functionTools(declared))
                    if(config.getBoolean("send_reasoning")) {
                        body.put("thinking", JSONObject().put("type", if(input.getString("thinking_mode") == "off") "disabled" else "enabled"))
                        if(input.getString("thinking_mode") != "off") body.put("reasoning_effort", input.getString("thinking_mode"))
                    }
                }
                "responses" -> {
                    body.put("input", messages).put("max_output_tokens", 8192)
                    if(config.getBoolean("send_reasoning") && input.getString("thinking_mode") != "off")
                        body.put("reasoning", JSONObject().put("effort", input.getString("thinking_mode")))
                }
                else -> fail("E_COMPLETION_BODY_INVALID")
            }
            val encoded = RuntimeJson.canonical(body)
            val providerRequestId = UUID.randomUUID().toString()
            val httpCall: Call = synchronized(lock) {
                own(request)
                val secret = credentials.get(request.account) ?: fail("E_COMPLETION_CREDENTIAL_UNAVAILABLE")
                val builder = Request.Builder().url(config.getString("endpoint_url"))
                    .header("User-Agent", "Rish/Android").header("X-Client-Request-Id", providerRequestId)
                    .post(encoded.toRequestBody("application/json".toMediaType()))
                if (streaming) builder.header("Accept", "text/event-stream")
                when(config.getString("auth_type")) {
                    "bearer" -> builder.header("Authorization", "Bearer $secret")
                    "x-api-key" -> builder.header("x-api-key", secret)
                    "api-key" -> builder.header("api-key", secret)
                }
                if(protocol == "messages") builder.header("anthropic-version", "2023-06-01")
                client.newCall(builder.build()).also { request.call = it; sentRequestCount += 1 }
            }
            val response = httpCall.execute().use { http ->
                if(http.code in 300..399) fail("E_COMPLETION_REDIRECT")
                if(http.code == 429) fail("E_COMPLETION_HTTP_429")
                if(!http.isSuccessful) throw RuntimeFailure("E_COMPLETION_HTTP_STATUS", http.code)
                val stream = http.body?.byteStream() ?: fail("E_COMPLETION_RESPONSE_JSON")
                if (streaming) {
                    assembleStream(stream, sink!!)
                } else {
                    val bytes = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                    stream.use { source ->
                        while(true) { val count = source.read(buffer); if(count < 0) break
                            if(bytes.size() + count > 4 * 1024 * 1024) fail("E_COMPLETION_RESPONSE_SIZE")
                            bytes.write(buffer, 0, count)
                        }
                    }
                    try { JSONObject(bytes.toString("UTF-8")) } catch (_: Exception) { fail("E_COMPLETION_RESPONSE_JSON") }
                }
            }
            synchronized(lock) { own(request) }
            val reported = response.optString("model", "")
            val glmWire = wireModel.startsWith("glm", ignoreCase = true)
            // DeepSeek's 2026-09-10 announcement routes these two retired
            // request ids to V4.1 Flash (deepseek-flash). Mirrors the closed
            // compatibility map in modules/rish/ios/Sources/DshProviderTransport.mm:
            // the same two ids, the same official endpoint, the same single
            // accepted alias. V4 Pro is deliberately excluded -- its announced
            // transition is later. Without this the provider's own answer is
            // refused as E_COMPLETION_RESPONSE_MODEL, for a plain chat as much
            // as for an agent round.
            val documentedLegacyAlias =
                config.getString("endpoint_url") == "https://api.deepseek.com/chat/completions" &&
                    wireModel in setOf("deepseek-v4-flash", "deepseek-v4-flash-vision-exp") &&
                    reported == "deepseek-flash"
            if (!(reported == wireModel || documentedLegacyAlias ||
                    (glmWire && reported.all { it.code < 128 } && reported.equals(wireModel, ignoreCase = true)))
            ) {
                fail("E_COMPLETION_RESPONSE_MODEL")
            }
            if (documentedLegacyAlias) {
                // Never claim raw equality: the receipt keeps the canonical
                // requested model its schema requires, and the wire identity
                // is recorded beside it.
                response.put("model", wireModel)
                android.util.Log.i(
                    "RishRuntime",
                    "completion_model_alias harness=dsh requested_model=$wireModel reported_model=deepseek-flash",
                )
            }
            val text: String
            val reasoning: String
            val finish: String
            val calls = JSONArray()
            when(protocol) {
                "chat-completions" -> {
                    val choice = response.getJSONArray("choices").getJSONObject(0)
                    val message = choice.getJSONObject("message")
                    text = stringOrEmpty(message, "content"); reasoning = stringOrEmpty(message, "reasoning_content")
                    finish = choice.getString("finish_reason")
                    // The calls the model asked for, carried back as the
                    // provider stated them. What they *mean* -- whether the
                    // name is a tool, whether the arguments parse, what may
                    // run -- stays the core's; this only stops discarding
                    // them, which is what left a round with tools it could
                    // send and no way to hear an answer.
                    val raw = message.optJSONArray("tool_calls") ?: JSONArray()
                    for (index in 0 until raw.length()) {
                        val call = raw.optJSONObject(index) ?: continue
                        val function = call.optJSONObject("function") ?: continue
                        calls.put(
                            JSONObject().put("id", call.optString("id"))
                                .put("name", function.optString("name"))
                                .put("arguments", function.optString("arguments")),
                        )
                    }
                }
                "messages" -> {
                    val content = response.getJSONArray("content")
                    val chunks = mutableListOf<String>(); val thoughts = mutableListOf<String>()
                    for(index in 0 until content.length()) {
                        val block = content.getJSONObject(index)
                        when(block.getString("type")) {
                            "text" -> chunks.add(block.getString("text"))
                            "thinking" -> thoughts.add(stringOrEmpty(block, "thinking"))
                            else -> fail("E_COMPLETION_TOOL_CALL_INVALID")
                        }
                    }
                    text = chunks.joinToString(""); reasoning = thoughts.joinToString("")
                    finish = when(response.getString("stop_reason")) { "end_turn", "stop_sequence" -> "stop"; "max_tokens" -> "length"; else -> fail("E_COMPLETION_FINISH_RELATION") }
                }
                else -> {
                    val chunks = mutableListOf<String>(); val output = response.getJSONArray("output")
                    for(index in 0 until output.length()) {
                        val item = output.getJSONObject(index)
                        if(item.getString("type") == "message") {
                            val content = item.getJSONArray("content")
                            for(i in 0 until content.length()) {
                                val block = content.getJSONObject(i)
                                if(block.getString("type") == "output_text") chunks.add(block.getString("text"))
                            }
                        } else if(item.getString("type") != "reasoning") fail("E_COMPLETION_TOOL_CALL_INVALID")
                    }
                    text = chunks.joinToString(""); reasoning = ""
                    finish = when(response.optString("status")) {
                        "completed" -> "stop"
                        "incomplete" -> if(response.optJSONObject("incomplete_details")?.optString("reason") == "max_output_tokens") "length" else fail("E_COMPLETION_FINISH_RELATION")
                        else -> fail("E_COMPLETION_FINISH_RELATION")
                    }
                }
            }
            // A turn that only asks for a tool carries no text, and that is
            // not an empty response -- it is the answer.
            if(text.isBlank() && calls.length() == 0) fail("E_COMPLETION_EMPTY_RESPONSE")
            if(finish !in setOf("stop", "length", "tool_calls")) fail("E_COMPLETION_FINISH_RELATION")
            if((finish == "tool_calls") != (calls.length() > 0)) fail("E_COMPLETION_FINISH_RELATION")
            val responseId = response.getString("id"); if(responseId.isBlank() || responseId.length > 256) fail("E_COMPLETION_PROVIDER_RESPONSE_ID")
            val result = JSONObject().put("schema_version", input.getInt("schema_version"))
                .put("text", text).put("reasoning", reasoning).put("tool_calls", calls).put("finish_reason", finish)
                .put("model", request.model).put("thinking_mode", input.getString("thinking_mode"))
                .put("latency_ms", android.os.SystemClock.elapsedRealtime() - started)
            if(input.getInt("schema_version") == 1) result.put("request_id", request.id)
            else {
                result.put("harness_id", request.harness).put("turn_id", input.getString("turn_id"))
                    .put("attempt_id", input.getString("attempt_id")).put("round_id", request.id).put("round_index", input.getInt("round_index"))
                    .put("requested_model", request.model).put("provider_request_id", providerRequestId).put("provider_response_id", responseId)
                    .put("visible_history_sha256", RuntimeJson.sha(RuntimeJson.canonical(history)))
                    .put("model_input_sha256", RuntimeJson.sha(RuntimeJson.canonical(messages)))
                    .put("request_body_sha256", RuntimeJson.sha(encoded)).put("project_context_receipt", JSONObject.NULL)
                configurations.binding(config, request.model)?.let { result.put("provider_configuration", it) }
            }
            synchronized(lock) {
                own(request); lastModel = request.model
                lastProof = JSONObject().put("proof_run_id", request.id).put("launch_instance_id", AndroidSessionStore.launchId)
                    .put("received_at", RuntimeJson.now()).put("http_status", 200).put("model", request.model).put("requested_model", request.model)
                    .put("thinking_mode", input.getString("thinking_mode")).put("finish_reason", finish).put("response_id", responseId)
                    .put("assistant_text_sha256", RuntimeJson.sha(text)).put("reasoning_text_sha256", RuntimeJson.sha(reasoning))
            }
            return result
        } catch(error: RuntimeFailure) { throw error }
        catch (_: Exception) { synchronized(lock) { own(request) }; fail("E_COMPLETION_TRANSPORT") }
        finally { synchronized(lock) { if(active[request.id] === request) active.remove(request.id) } }
    }
    private fun stringOrEmpty(value: JSONObject, key: String): String = if(value.isNull(key)) "" else value.getString(key)
}
