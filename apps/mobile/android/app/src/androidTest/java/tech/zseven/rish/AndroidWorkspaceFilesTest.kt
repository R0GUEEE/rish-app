package tech.zseven.rish

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.MediumTest
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import tech.zseven.rish.runtime.AndroidAgentRootResolver
import tech.zseven.rish.runtime.AndroidWorkspaceFiles
import tech.zseven.rish.runtime.AndroidWorkspaceRegistry
import tech.zseven.rish.runtime.RishAgentCoreNative
import java.io.File
import java.util.UUID

/**
 * What the Files drawer may see.
 *
 * The entries it reads are a contract with the JS reader, which refuses a
 * result whose revision is not a digest, whose name does not end the path, or
 * whose timestamp is not canonical — so these hold the shape as much as the
 * behaviour. The containment rules are the same ones the agent's executor
 * keeps, because a person browsing and an agent writing have to agree about
 * which bytes belong to the workspace.
 */
@RunWith(AndroidJUnit4::class)
@MediumTest
class AndroidWorkspaceFilesTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class Fixture(
        val files: AndroidWorkspaceFiles,
        val root: JSONObject,
        val directory: File,
    )

    private fun fixture(body: (Fixture) -> Unit) {
        assumeTrue("rish agent core is not staged in this build", RishAgentCoreNative.available)
        val home = File(context.cacheDir, "files-${UUID.randomUUID()}")
        try {
            val workspaces = AndroidWorkspaceRegistry(home)
            val created = workspaces.create("demo")
            val workspaceId = created.getString("workspace_id")
            val root = JSONObject().put("schema_version", 1)
                .put("workspace_id", workspaceId)
                .put("binding_revision", 1)
                .put("project_id", JSONObject.NULL)
            body(
                Fixture(
                    AndroidWorkspaceFiles(workspaces, AndroidAgentRootResolver(workspaces)),
                    root,
                    workspaces.rootFor(workspaceId)!!,
                ),
            )
        } finally {
            home.deleteRecursively()
        }
    }

    private fun refusal(body: () -> JSONObject): String = try {
        "answered: " + body()
    } catch (refused: AndroidWorkspaceFiles.Refused) {
        refused.code
    }

    private fun listRequest(f: Fixture, path: String, max: Int = 1000): JSONObject = JSONObject()
        .put("schema_version", 1).put("root", f.root).put("path", path).put("max_entries", max)

    private fun readRequest(f: Fixture, path: String, max: Int = 1024 * 1024): JSONObject =
        JSONObject().put("schema_version", 1).put("root", f.root).put("path", path)
            .put("max_bytes", max)

    private fun writeRequest(
        f: Fixture,
        path: String,
        content: String,
        expected: Any = JSONObject.NULL,
        createOnly: Boolean = true,
    ): JSONObject = JSONObject().put("schema_version", 1).put("root", f.root).put("path", path)
        .put("content", content).put("expected_revision", expected).put("create_only", createOnly)

    /**
     * A write, a listing and a read over the same file, in the shapes the
     * reader validates: the name ends the path, the revision is a digest, and
     * the timestamp is the canonical one.
     */
    @Test fun aFileIsWrittenListedAndReadBack() = fixture { f ->
        val written = f.files.write(writeRequest(f, "notes.md", "hello\n"))
        assertEquals(true, written.getBoolean("created"))
        val file = written.getJSONObject("file")
        assertEquals("notes.md", file.getString("path"))
        assertEquals("notes.md", file.getString("name"))
        assertEquals("file", file.getString("kind"))
        assertEquals(6L, file.getLong("size"))
        assertTrue(file.getString("revision").matches(Regex("^[0-9a-f]{64}$")))
        assertTrue(
            file.getString("modified_at"),
            file.getString("modified_at")
                .matches(Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")),
        )

        val listing = f.files.list(listRequest(f, ""))
        assertEquals("", listing.getString("path"))
        val entries = listing.getJSONArray("entries")
        assertEquals(1, entries.length())
        assertEquals("notes.md", entries.getJSONObject(0).getString("path"))

        val read = f.files.read(readRequest(f, "notes.md"))
        assertEquals("hello\n", read.getString("content"))
        assertEquals(file.getString("revision"), read.getJSONObject("file").getString("revision"))
    }

    /** A nested path is listed under its own prefix, not its bare name. */
    @Test fun aNestedEntryKeepsItsPath() = fixture { f ->
        File(f.directory, "src").mkdirs()
        f.files.write(writeRequest(f, "src/main.kt", "fun main() {}\n"))
        val listing = f.files.list(listRequest(f, "src"))
        val entry = listing.getJSONArray("entries").getJSONObject(0)
        assertEquals("src/main.kt", entry.getString("path"))
        assertEquals("main.kt", entry.getString("name"))
    }

    /**
     * The two ways of saying "I know what is there". A create that would
     * overwrite and a stale revision are both conflicts, not silent writes.
     */
    @Test fun aWriteWillNotOverwriteWhatItDidNotExpect() = fixture { f ->
        val first = f.files.write(writeRequest(f, "notes.md", "one\n"))
        val revision = first.getJSONObject("file").getString("revision")
        assertEquals(
            "E_WORKSPACE_CONFLICT",
            refusal { f.files.write(writeRequest(f, "notes.md", "two\n")) },
        )
        assertEquals(
            "E_WORKSPACE_CONFLICT",
            refusal {
                f.files.write(
                    writeRequest(f, "notes.md", "two\n", expected = "0".repeat(64), createOnly = false),
                )
            },
        )
        val second = f.files.write(
            writeRequest(f, "notes.md", "two\n", expected = revision, createOnly = false),
        )
        assertEquals(false, second.getBoolean("created"))
        assertEquals("two\n", f.files.read(readRequest(f, "notes.md")).getString("content"))
    }

    /** Nothing outside the workspace is readable through this. */
    @Test fun aPathThatLeavesTheWorkspaceIsRefused() = fixture { f ->
        for (path in listOf("../escape.txt", "/etc/hosts", "src/../../escape.txt")) {
            val code = refusal { f.files.list(listRequest(f, path)) }
            assertTrue(path + " -> " + code, code.startsWith("E_WORKSPACE_"))
            assertTrue(path + " -> " + code, code != "E_WORKSPACE_PERSISTENCE")
        }
    }

    /** A file the reader cannot show is refused rather than half-shown. */
    @Test fun aFileTooLargeOrNotTextIsRefused() = fixture { f ->
        File(f.directory, "big.txt").writeText("0123456789")
        assertEquals(
            "E_WORKSPACE_UNAVAILABLE",
            refusal { f.files.read(readRequest(f, "big.txt", max = 4)) },
        )
        File(f.directory, "binary.bin").writeBytes(byteArrayOf(0xC3.toByte(), 0x28))
        assertEquals(
            "E_WORKSPACE_UNAVAILABLE",
            refusal { f.files.read(readRequest(f, "binary.bin")) },
        )
    }

    /** A root this device does not hold is refused before any path is read. */
    @Test fun anUnheldRootIsRefused() = fixture { f ->
        val unknown = JSONObject(f.root.toString()).put("workspace_id", UUID.randomUUID().toString())
        assertEquals(
            "E_WORKSPACE_NOT_FOUND",
            refusal {
                f.files.list(
                    JSONObject().put("schema_version", 1).put("root", unknown)
                        .put("path", "").put("max_entries", 10),
                )
            },
        )
        val moved = JSONObject(f.root.toString()).put("binding_revision", 7)
        assertEquals(
            "E_WORKSPACE_ROOT_CHANGED",
            refusal {
                f.files.list(
                    JSONObject().put("schema_version", 1).put("root", moved)
                        .put("path", "").put("max_entries", 10),
                )
            },
        )
    }

    /** A malformed request is refused rather than half-read. */
    @Test fun aMalformedRequestIsRefused() = fixture { f ->
        assertEquals("E_WORKSPACE_INVALID", refusal { f.files.list(null) })
        assertEquals(
            "E_WORKSPACE_INVALID",
            refusal { f.files.list(JSONObject(listRequest(f, "").toString()).also { it.remove("path") }) },
        )
        assertEquals(
            "E_WORKSPACE_INVALID",
            refusal { f.files.list(JSONObject(listRequest(f, "").toString()).put("extra", 1)) },
        )
        assertEquals("E_WORKSPACE_INVALID", refusal { f.files.list(listRequest(f, "", max = 0)) })
    }

    /**
     * The trash is empty and says so. Nothing can be put there on this
     * platform, and the drawer asks for this list beside every directory it
     * opens -- a refusal would stop it browsing at all.
     */
    @Test fun theTrashIsEmptyRatherThanUnavailable() = fixture { f ->
        val trash = f.files.listTrash(
            JSONObject().put("schema_version", 1).put("root", f.root).put("max_entries", 8),
        )
        assertEquals(0, trash.getJSONArray("entries").length())
    }

    /** The bridge serves the three operations the reader requires. */
    @Test fun theBridgeOwnsTheseOperations() {
        val methods = tech.zseven.rish.modules.LocalWorkspaceModule::class.java.methods.map { it.name }
        for (name in listOf("listV2", "readV2", "writeV2", "listTrashV2")) {
            assertTrue("$name must be declared", name in methods)
        }
    }
}
