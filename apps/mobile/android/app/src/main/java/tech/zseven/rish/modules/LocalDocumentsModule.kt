package tech.zseven.rish.modules

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import org.json.JSONArray
import org.json.JSONObject
import tech.zseven.rish.runtime.AndroidDocumentTransfers
import tech.zseven.rish.runtime.AndroidRuntimeState
import tech.zseven.rish.runtime.RuntimeJson
import java.io.File

/**
 * LocalDocuments on Android: Import from Files, and Export to Files.
 *
 * The rules live in [AndroidDocumentTransfers]; this is the part that needs
 * an activity. As with the attachment picker, one transfer is in flight at a
 * time, because a second would leave the first promise unanswered.
 *
 * An import stages every document before anything lands in the workspace, so
 * the operation the caller named can be queried, finished or forgotten after
 * a crash. An export writes through a URI the person chose and has nothing
 * to recover.
 */
class LocalDocumentsModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    private val runtime = AndroidRuntimeState.get(reactContext)

    private class Pending(
        val code: Int,
        val kind: Kind,
        val promise: Promise,
        val operationId: String,
        val root: JSONObject,
        val destination: String,
        val staging: File?,
        val sources: List<String>,
    ) {
        enum class Kind { IMPORT, EXPORT }
    }

    @Volatile private var pending: Pending? = null

    init {
        reactContext.addActivityEventListener(this)
    }

    override fun getConstants(): MutableMap<String, Any> = mutableMapOf("implemented" to true)

    override fun getName(): String = "LocalDocuments"

    override fun invalidate() {
        reactApplicationContext.removeActivityEventListener(this)
        super.invalidate()
    }

    @ReactMethod
    fun presentImportPicker(request: ReadableMap?, promise: Promise) {
        val captured = captured(request, promise) ?: return
        val operationId = captured.optString("operation_id")
        val root = captured.optJSONObject("root")
        val destination = captured.optString("destination_path")
        if (root == null) {
            promise.reject("E_WORKSPACE_INVALID", "Workspace root is invalid")
            return
        }
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.reject("E_WORKSPACE_UNAVAILABLE", "There is no screen to present a picker on")
            return
        }
        synchronized(this) {
            if (pending != null) {
                promise.reject("E_WORKSPACE_BUSY", "A transfer is already under way")
                return
            }
            val staging = try {
                // The directory has to resolve before a picker opens: a root
                // that moved is not something to discover after the copying.
                runtime.documentTransfers.directory(root, destination)
                runtime.documentTransfers.begin(operationId, "import", destination)
            } catch (refused: AndroidDocumentTransfers.Refused) {
                promise.reject(refused.code, refused.reason)
                return
            }
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            val code = nextRequestCode()
            pending = Pending(
                code, Pending.Kind.IMPORT, promise, operationId, root, destination, staging,
                emptyList(),
            )
            start(activity, intent, code, promise)
        }
    }

    @ReactMethod
    fun presentExportPicker(request: ReadableMap?, promise: Promise) {
        val captured = captured(request, promise) ?: return
        val operationId = captured.optString("operation_id")
        val root = captured.optJSONObject("root")
        val paths = captured.optJSONArray("source_paths") ?: JSONArray()
        if (root == null || paths.length() == 0) {
            promise.reject("E_WORKSPACE_INVALID", "Export request is invalid")
            return
        }
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.reject("E_WORKSPACE_UNAVAILABLE", "There is no screen to present a picker on")
            return
        }
        val sources = (0 until paths.length()).map { paths.optString(it) }
        synchronized(this) {
            if (pending != null) {
                promise.reject("E_WORKSPACE_BUSY", "A transfer is already under way")
                return
            }
            // Every source is checked before a picker opens, so a person is
            // never asked where to put something that is not there.
            try {
                sources.forEach { runtime.documentTransfers.file(root, it) }
            } catch (refused: AndroidDocumentTransfers.Refused) {
                promise.reject(refused.code, refused.reason)
                return
            }
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            val code = nextRequestCode()
            pending = Pending(
                code, Pending.Kind.EXPORT, promise, operationId, root, "", null, sources,
            )
            start(activity, intent, code, promise)
        }
    }

    @ReactMethod
    fun queryOperation(request: ReadableMap?, promise: Promise) {
        val captured = captured(request, promise) ?: return
        answer("queryOperation", promise) {
            runtime.documentTransfers.query(captured.optString("operation_id"))
        }
    }

    @ReactMethod
    fun retryOperation(request: ReadableMap?, promise: Promise) {
        val captured = captured(request, promise) ?: return
        val root = captured.optJSONObject("root")
        if (root == null) {
            promise.reject("E_WORKSPACE_INVALID", "Workspace root is invalid")
            return
        }
        answer("retryOperation", promise) {
            runtime.documentTransfers.retry(captured.optString("operation_id"), root)
        }
    }

    @ReactMethod
    fun cleanupOperation(request: ReadableMap?, promise: Promise) {
        val captured = captured(request, promise) ?: return
        answer("cleanupOperation", promise) {
            runtime.documentTransfers.cleanup(captured.optString("operation_id"))
        }
    }

    override fun onActivityResult(
        activity: Activity,
        requestCode: Int,
        resultCode: Int,
        data: Intent?,
    ) {
        val waiting = synchronized(this) {
            val current = pending ?: return
            if (current.code != requestCode) return
            pending = null
            current
        }
        runtime.io.execute {
            try {
                waiting.promise.resolve(
                    Arguments.makeNativeMap(RuntimeJson.map(finish(waiting, resultCode, data))),
                )
            } catch (refused: AndroidDocumentTransfers.Refused) {
                Log.w(TAG, "A transfer could not finish: ${refused.code}")
                waiting.promise.reject(refused.code, refused.reason)
            } catch (failure: Exception) {
                Log.w(TAG, "A transfer could not finish", failure)
                waiting.promise.reject("E_WORKSPACE_PERSISTENCE", "The transfer could not finish")
            }
        }
    }

    override fun onNewIntent(intent: Intent) = Unit

    private fun finish(waiting: Pending, resultCode: Int, data: Intent?): JSONObject =
        if (waiting.kind == Pending.Kind.IMPORT) imported(waiting, resultCode, data)
        else exported(waiting, resultCode, data)

    private fun imported(waiting: Pending, resultCode: Int, data: Intent?): JSONObject {
        val uris = pickedUris(resultCode, data)
        if (uris.isEmpty()) {
            // Nothing chosen: the operation never happened, and the staging
            // it opened goes with it.
            runtime.documentTransfers.abandon(waiting.operationId)
            return JSONObject()
                .put("schema_version", 1).put("status", "cancelled")
                .put("root", waiting.root).put("operation_id", waiting.operationId)
                .put("destination_path", waiting.destination)
                .put("entries", JSONArray())
        }
        val resolver = reactApplicationContext.contentResolver
        val staging = waiting.staging ?: throw AndroidDocumentTransfers.Refused(
            "E_WORKSPACE_PERSISTENCE", "The import was not staged",
        )
        for (uri in uris) runtime.documentTransfers.stage(resolver, uri, staging)
        runtime.documentTransfers.commit(waiting.operationId, waiting.root, waiting.destination)
        return JSONObject()
            .put("schema_version", 1).put("status", "imported")
            .put("root", waiting.root).put("operation_id", waiting.operationId)
            .put("destination_path", waiting.destination)
            .put("entries", runtime.documentTransfers.entries(waiting.operationId))
    }

    private fun exported(waiting: Pending, resultCode: Int, data: Intent?): JSONObject {
        val tree = if (resultCode == Activity.RESULT_OK) data?.data else null
        if (tree == null) {
            return JSONObject()
                .put("schema_version", 1).put("status", "cancelled")
                .put("root", waiting.root).put("operation_id", waiting.operationId)
                .put("item_count", 0)
        }
        // The framework's own contract rather than `DocumentFile`: this needs
        // one call per file and no extra dependency in a shipped app.
        val resolver = reactApplicationContext.contentResolver
        val parent = try {
            DocumentsContract.buildDocumentUriUsingTree(
                tree, DocumentsContract.getTreeDocumentId(tree),
            )
        } catch (_: Exception) {
            throw AndroidDocumentTransfers.Refused(
                "E_WORKSPACE_UNAVAILABLE", "That folder could not be opened",
            )
        }
        var written = 0
        for (path in waiting.sources) {
            val source = runtime.documentTransfers.file(waiting.root, path)
            val created = try {
                DocumentsContract.createDocument(
                    resolver, parent, "application/octet-stream", source.name,
                )
            } catch (_: Exception) {
                null
            } ?: throw AndroidDocumentTransfers.Refused(
                "E_WORKSPACE_PERSISTENCE", "That folder could not be written to",
            )
            resolver.openOutputStream(created).use { output ->
                output ?: throw AndroidDocumentTransfers.Refused(
                    "E_WORKSPACE_PERSISTENCE", "That folder could not be written to",
                )
                source.inputStream().use { input -> input.copyTo(output) }
            }
            written += 1
        }
        runtime.documentTransfers.exported(waiting.operationId, written)
        return JSONObject()
            .put("schema_version", 1).put("status", "exported")
            .put("root", waiting.root).put("operation_id", waiting.operationId)
            .put("item_count", written)
    }

    private fun pickedUris(resultCode: Int, data: Intent?): List<Uri> {
        if (resultCode != Activity.RESULT_OK) return emptyList()
        val uris = mutableListOf<Uri>()
        data?.data?.let { uris.add(it) }
        data?.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) clip.getItemAt(index)?.uri?.let { uris.add(it) }
        }
        return uris.distinct()
    }

    private fun start(activity: Activity, intent: Intent, code: Int, promise: Promise) {
        try {
            activity.startActivityForResult(intent, code)
        } catch (failure: android.content.ActivityNotFoundException) {
            Log.w(TAG, "No app can answer that picker", failure)
            pending = null
            promise.reject("E_WORKSPACE_UNAVAILABLE", "No app can answer that picker")
        } catch (failure: Exception) {
            Log.w(TAG, "A picker could not be opened", failure)
            pending = null
            promise.reject("E_WORKSPACE_UNAVAILABLE", "The picker could not be opened")
        }
    }

    private fun captured(request: ReadableMap?, promise: Promise): JSONObject? = try {
        request?.let { JSONObject(it.toHashMap()) }
            ?: throw IllegalArgumentException("missing")
    } catch (failure: Exception) {
        Log.w(TAG, "A documents request is invalid", failure)
        promise.reject("E_WORKSPACE_INVALID", "Workspace request is invalid")
        null
    }

    private fun answer(operation: String, promise: Promise, body: () -> JSONObject) {
        runtime.io.execute {
            try {
                promise.resolve(Arguments.makeNativeMap(RuntimeJson.map(body())))
            } catch (refused: AndroidDocumentTransfers.Refused) {
                Log.w(TAG, "$operation refused: ${refused.code}")
                promise.reject(refused.code, refused.reason)
            } catch (failure: Exception) {
                Log.w(TAG, "$operation could not be answered", failure)
                promise.reject("E_WORKSPACE_PERSISTENCE", "The operation could not be read")
            }
        }
    }

    private fun nextRequestCode(): Int = (nextCode++ and 0xffff) or 0x6000

    private companion object {
        const val TAG = "RishDocuments"
        var nextCode = 1
    }
}
