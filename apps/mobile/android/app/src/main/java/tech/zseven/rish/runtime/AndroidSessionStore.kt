package tech.zseven.rish.runtime

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject
import java.util.UUID

/** Snapshot and idempotency receipt commit in one FULL-synchronous SQLite transaction. */
internal class AndroidSessionStore(context: Context, name: String = "rish.sessions.v1.db") : SQLiteOpenHelper(context.applicationContext, name, null, 2) {
    companion object { val launchId: String = UUID.randomUUID().toString(); const val MAX_BYTES = 16 * 1024 * 1024 }
    override fun onConfigure(db: SQLiteDatabase) { db.execSQL("PRAGMA synchronous=FULL") }
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, digest TEXT NOT NULL, candidate TEXT NOT NULL, writer TEXT NOT NULL)")
        db.execSQL("CREATE TABLE operations (operation TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result TEXT NOT NULL)")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        check(oldVersion == 1 && newVersion == 2)
        // Preserve prototype snapshots while migrating their digest protocol.
        // Old operation receipts remain explicitly indeterminate, never replayed.
        db.rawQuery("SELECT candidate FROM snapshot WHERE id=1", null).use { cursor ->
            if(cursor.moveToFirst()) db.execSQL("UPDATE snapshot SET digest=? WHERE id=1", arrayOf(RuntimeJson.sessionDigest(cursor.getString(0))))
        }
        db.execSQL("UPDATE operations SET result=?", arrayOf("{\"schema_version\":1,\"status\":\"unknown\"}"))
    }
    private fun reference(generation: Long, digest: String) = JSONObject().put("schema_version", 1).put("generation", generation).put("session_sha256", digest)
    private fun load(db: SQLiteDatabase): JSONObject {
        db.rawQuery("SELECT generation,digest,candidate,writer FROM snapshot WHERE id=1", null).use { cursor ->
            if (!cursor.moveToFirst()) return JSONObject().put("schema_version", 1).put("status", "missing")
                .put("snapshot", JSONObject.NULL).put("session_json", JSONObject.NULL).put("writer_launch_instance_id", JSONObject.NULL).put("current_launch_instance_id", launchId)
            val candidate = cursor.getString(2)
            check(RuntimeJson.sessionDigest(candidate) == cursor.getString(1)) { "Corrupt session snapshot" }
            return JSONObject().put("schema_version", 1).put("status", "present")
                .put("snapshot", reference(cursor.getLong(0), cursor.getString(1))).put("session_json", candidate)
                .put("writer_launch_instance_id", cursor.getString(3)).put("current_launch_instance_id", launchId)
        }
    }
    @Synchronized fun load(): JSONObject = load(readableDatabase)
    private fun authority(loaded: JSONObject): JSONObject = JSONObject().put("schema_version", 1)
        .put("kind", if (loaded.getString("status") == "missing") "missing" else "present").apply {
            if (loaded.getString("status") == "present") put("snapshot", loaded.getJSONObject("snapshot"))
        }
    @Synchronized fun persist(request: JSONObject): JSONObject {
        RuntimeJson.checkVersion(request, 1)
        require(request.keys().asSequence().toSet() == setOf("schema_version", "operation_id", "expected", "candidate_json"))
        val operation = request.getString("operation_id"); require(RuntimeJson.uuid(operation))
        val candidate = request.getString("candidate_json")
        require(candidate.toByteArray(Charsets.UTF_8).size <= MAX_BYTES)
        val parsed = JSONObject(candidate)
        require(parsed.opt("schema_version") == 9)
        for (field in listOf("workspace_authority_outbox", "agent_transcript_cleanup_outbox", "session_events")) {
            require((parsed.optJSONArray(field)?.length() ?: 0) == 0) { "Native authority journals are not supported on Android yet" }
        }
        require(parsed.isNull("project_context_destructive_transition"))
        parsed.optJSONArray("conversations")?.let { conversations ->
            for(index in 0 until conversations.length()) {
                val conversation = conversations.getJSONObject(index)
                for(field in listOf("project_id", "workspace_id", "workspace_binding", "project_context")) require(conversation.isNull(field))
                require((conversation.optJSONArray("agent_grants")?.length() ?: 0) == 0)
                conversation.optJSONArray("attempts")?.let { attempts ->
                    for(i in 0 until attempts.length()) require(attempts.getJSONObject(i).isNull("agent"))
                }
            }
        }
        // Storage preserves opaque JSON bytes; it does not issue project,
        // workspace, tool or Agent authority. Those native APIs remain closed.
        val expected = request.getJSONObject("expected")
        RuntimeJson.checkVersion(expected, 1)
        require(expected.getString("kind") in setOf("missing", "present"))
        val requestDigest = RuntimeJson.sha(RuntimeJson.canonical(request))
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.rawQuery("SELECT request_digest,result FROM operations WHERE operation=?", arrayOf(operation)).use { cursor ->
                if (cursor.moveToFirst()) {
                    require(cursor.getString(0) == requestDigest) { "Operation reused with different bytes" }
                    return JSONObject(cursor.getString(1))
                }
            }
            val loaded = load(db)
            val current = authority(loaded)
            val result: JSONObject
            if (RuntimeJson.canonical(expected) != RuntimeJson.canonical(current)) {
                result = JSONObject().put("schema_version", 1).put("status", "conflict").put("current", current)
            } else {
                val generation = if (loaded.getString("status") == "missing") 1L else loaded.getJSONObject("snapshot").getLong("generation") + 1
                require(generation in 1..9007199254740991L)
                val digest = RuntimeJson.sessionDigest(candidate)
                db.insertOrThrow("snapshot", null, ContentValues().apply {
                    put("id", 1); put("generation", generation); put("digest", digest); put("candidate", candidate); put("writer", launchId)
                }.also { if (loaded.getString("status") == "present") db.delete("snapshot", "id=1", null) })
                result = JSONObject().put("schema_version", 1).put("status", "committed").put("snapshot", reference(generation, digest))
            }
            db.insertOrThrow("operations", null, ContentValues().apply { put("operation", operation); put("request_digest", requestDigest); put("result", result.toString()) })
            db.setTransactionSuccessful()
            return result
        } finally { db.endTransaction() }
    }
    @Synchronized fun query(request: JSONObject): JSONObject {
        RuntimeJson.checkVersion(request, 1)
        val operation = request.getString("operation_id"); require(RuntimeJson.uuid(operation))
        readableDatabase.rawQuery("SELECT result FROM operations WHERE operation=?", arrayOf(operation)).use { cursor ->
            return if (cursor.moveToFirst()) JSONObject(cursor.getString(0)) else JSONObject().put("schema_version", 1).put("status", "not_started")
        }
    }
}
