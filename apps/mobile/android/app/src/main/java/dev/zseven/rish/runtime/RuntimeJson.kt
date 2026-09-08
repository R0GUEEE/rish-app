package dev.zseven.rish.runtime

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

internal object RuntimeJson {
    fun now(): String = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date())

    fun canonical(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        is String -> quote(value)
        is Boolean, is Int, is Long -> value.toString()
        is Number -> { val number = value.toDouble(); require(number.isFinite() && number % 1.0 == 0.0 && number >= -9007199254740991.0 && number <= 9007199254740991.0); value.toLong().toString() }
        else -> error("Unsupported JSON value")
    }
    private fun quote(text: String): String = buildString {
        append('"')
        for (char in text) when(char) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000c' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if(char.code < 32) append("\\u%04x".format(char.code)) else append(char)
        }
        append('"')
    }
    fun sessionDigest(candidate: String): String = sha("rish.chat-session.v1\u0000" + canonical(JSONObject(candidate)))
    fun sha(text: String): String = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    fun uuid(value: String): Boolean = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").matches(value)
    // React Native exposes every JavaScript number as Double. JSON serialization
    // preserves the integer protocol representation without accepting fractions.
    fun fromBridgeMap(value: Map<String, Any?>): JSONObject = JSONObject(JSONObject(value).toString())
    fun checkVersion(request: JSONObject, version: Int) { require(request.opt("schema_version") is Int && request.getInt("schema_version") == version) }
    fun map(value: JSONObject): Map<String, Any?> = value.keys().asSequence().associateWith { plain(value.get(it)) }
    private fun plain(value: Any?): Any? = when(value) {
        null, JSONObject.NULL -> null
        is JSONObject -> map(value)
        is JSONArray -> (0 until value.length()).map { plain(value.get(it)) }
        else -> value
    }
}
