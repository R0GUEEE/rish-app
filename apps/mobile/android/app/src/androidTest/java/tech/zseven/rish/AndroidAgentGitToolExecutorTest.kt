package tech.zseven.rish

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import tech.zseven.rish.runtime.AndroidAgentGitToolExecutor
import tech.zseven.rish.runtime.AndroidAgentRootResolver
import tech.zseven.rish.runtime.AndroidWorkspaceProjects
import tech.zseven.rish.runtime.AndroidWorkspaceRegistry
import tech.zseven.rish.runtime.AndroidWorkspaceToolExecutor
import tech.zseven.rish.runtime.RishAgentCoreNative
import tech.zseven.rish.runtime.RishLibgit2Native
import java.io.File
import java.util.UUID

/**
 * The agent's git_status and git_commit on this device: a commit lands with
 * exactly the id its precondition predicted, a stale precondition is a
 * conflict rather than a second commit, and recovery can tell the two apart.
 */
@RunWith(AndroidJUnit4::class)
class AndroidAgentGitToolExecutorTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class Fixture(registryRoot: File) {
        val workspaces = AndroidWorkspaceRegistry(registryRoot)
        val projects = AndroidWorkspaceProjects(workspaces)
        val roots = AndroidAgentRootResolver(workspaces, projects)
        val tools = AndroidAgentGitToolExecutor(projects, workspaces, roots)
        val workspaceId: String = workspaces.create("Scratch").getString("workspace_id")
        val workDir: File = workspaces.rootFor(workspaceId)!!
        val projectId: String = projects.attach(
            JSONObject().put("schema_version", 1).put("operation_id", UUID.randomUUID().toString()).put("mode", "init")
                .put("root", JSONObject().put("schema_version", 1).put("workspace_id", workspaceId)
                    .put("binding_revision", 1).put("project_id", JSONObject.NULL)),
        ).getJSONObject("project").getString("project_id")
        val root: JSONObject = roots.resolve(workspaceId, projectId, 1)!!
        val workspaceRoot: JSONObject = roots.resolve(workspaceId, null, 1)!!
    }

    private fun fixture(): Fixture {
        assertTrue("the agent core is not staged", RishAgentCoreNative.available)
        assertTrue("libgit2 is not staged", RishLibgit2Native.available)
        return Fixture(File(context.noBackupFilesDir, "git-tools-${UUID.randomUUID()}").apply { mkdirs() })
    }

    private fun refusal(block: () -> Unit): String {
        try { block() } catch (refused: AndroidWorkspaceToolExecutor.Refused) { return refused.code }
        fail("expected a refusal"); throw IllegalStateException()
    }

    private fun payload(effect: JSONObject): JSONObject = JSONObject(effect.getString("feedback")).getJSONObject("payload")

    @Test
    fun aCommitLandsWithThePredictedIdAndAStalePreconditionConflicts() {
        val f = fixture()
        val status = f.tools.execute("git_status", JSONObject(), f.root, f.tools.prepare("git_status", JSONObject(), f.root).getJSONObject("precondition"))
        assertEquals("ok", status.getString("status"))
        assertTrue(payload(status).getBoolean("clean"))
        assertTrue(payload(status).isNull("head_oid"))

        File(f.workDir, "notes.md").writeText("first\n")
        val prepared = f.tools.prepare("git_commit", JSONObject().put("message", "first"), f.root)
        val precondition = prepared.getJSONObject("precondition")
        assertEquals("git_commit", precondition.getString("kind"))
        assertTrue(precondition.isNull("pre_head_oid"))
        assertEquals(0, precondition.getJSONArray("ordered_parent_oids").length())
        assertTrue(Regex("[0-9a-f]{40}").matches(precondition.getString("tree_oid")))
        assertTrue(Regex("[0-9a-f]{40}").matches(precondition.getString("expected_commit_oid")))
        assertEquals(5, precondition.getInt("message_bytes"))
        assertEquals("Rish Agent", precondition.getJSONObject("author").getString("name"))

        val committed = f.tools.execute("git_commit", JSONObject().put("message", "first"), f.root, precondition)
        assertEquals(committed.toString(), "ok", committed.getString("status"))
        assertTrue(committed.getBoolean("effect_may_have_occurred"))
        val commitOid = committed.getJSONObject("settled_facts").getString("actual_commit_oid")
        assertEquals(precondition.getString("expected_commit_oid"), commitOid)
        assertEquals(commitOid, payload(committed).getString("commit_oid"))
        // HEAD moved to it, the index was written, and status says so.
        val after = f.tools.execute("git_status", JSONObject(), f.root, f.tools.prepare("git_status", JSONObject(), f.root).getJSONObject("precondition"))
        assertEquals(commitOid, payload(after).getString("head_oid"))
        assertTrue(payload(after).getBoolean("clean"))
        assertTrue(File(f.projects.gitDirectory(f.workspaceId, f.projectId), "index").isFile)
        assertEquals("settled", f.tools.recover("git_commit", JSONObject().put("message", "first"), f.root, precondition).getString("status"))

        // The same precondition again: HEAD is no longer where it asserted.
        val stale = f.tools.execute("git_commit", JSONObject().put("message", "first"), f.root, precondition)
        assertEquals("failed", stale.getString("status"))
        assertEquals("E_AGENT_CONFLICT", payload(stale).getString("failure_code"))
        assertEquals(commitOid, payload(f.tools.execute("git_status", JSONObject(), f.root, f.tools.prepare("git_status", JSONObject(), f.root).getJSONObject("precondition"))).getString("head_oid"))

        // A second commit on top, with the first as its parent.
        File(f.workDir, "notes.md").writeText("first\nsecond\n")
        val second = f.tools.prepare("git_commit", JSONObject().put("message", "second"), f.root).getJSONObject("precondition")
        assertEquals(commitOid, second.getString("pre_head_oid"))
        assertEquals(commitOid, second.getJSONArray("ordered_parent_oids").getString(0))
        // Not dispatched yet: everything the commit would be made from is still as prepared.
        assertEquals("not_dispatched", f.tools.recover("git_commit", JSONObject().put("message", "second"), f.root, second).getString("status"))
        val landed = f.tools.execute("git_commit", JSONObject().put("message", "second"), f.root, second)
        assertEquals("ok", landed.getString("status"))
        assertNotEquals(commitOid, landed.getJSONObject("settled_facts").getString("actual_commit_oid"))
        assertEquals(second.getString("expected_commit_oid"), landed.getJSONObject("settled_facts").getString("actual_commit_oid"))
        // A precondition whose world moved on, with HEAD elsewhere: ambiguous.
        assertEquals("ambiguous", f.tools.recover("git_commit", JSONObject().put("message", "first"), f.root, precondition).getString("status"))
    }

    @Test
    fun theWorkingTreeChangingUnderAPreparedCommitIsAConflict() {
        val f = fixture()
        File(f.workDir, "a.txt").writeText("a\n")
        val precondition = f.tools.prepare("git_commit", JSONObject().put("message", "a"), f.root).getJSONObject("precondition")
        File(f.workDir, "a.txt").writeText("changed\n")
        val effect = f.tools.execute("git_commit", JSONObject().put("message", "a"), f.root, precondition)
        assertEquals("failed", effect.getString("status"))
        assertEquals("E_AGENT_CONFLICT", payload(effect).getString("failure_code"))
        assertTrue(payload(f.tools.execute("git_status", JSONObject(), f.root, f.tools.prepare("git_status", JSONObject(), f.root).getJSONObject("precondition"))).isNull("head_oid"))
        assertEquals("ambiguous", f.tools.recover("git_commit", JSONObject().put("message", "a"), f.root, precondition).getString("status"))
    }

    @Test
    fun requestsAreHeldToTheContract() {
        val f = fixture()
        assertEquals("E_AGENT_BAD_ARGUMENTS", refusal { f.tools.prepare("git_status", JSONObject().put("x", 1), f.root) })
        assertEquals("E_AGENT_BAD_ARGUMENTS", refusal { f.tools.prepare("git_commit", JSONObject().put("message", ""), f.root) })
        assertEquals("E_AGENT_BAD_ARGUMENTS", refusal { f.tools.prepare("git_commit", JSONObject().put("message", "x".repeat(501)), f.root) })
        assertEquals("E_AGENT_BAD_ARGUMENTS", refusal { f.tools.prepare("git_commit", JSONObject().put("message", "m").put("extra", 1), f.root) })
        // A workspace root carries no git capability.
        assertEquals("E_AGENT_BAD_ARGUMENTS", refusal { f.tools.prepare("git_status", JSONObject(), f.workspaceRoot) })
        // A precondition for another tool never runs this one.
        assertEquals("E_AGENT_BAD_ARGUMENTS", refusal {
            f.tools.execute("git_commit", JSONObject().put("message", "m"), f.root, JSONObject().put("kind", "git_status"))
        })
        assertEquals("E_AGENT_BAD_ARGUMENTS", refusal { f.tools.prepare("git_push", JSONObject(), f.root) })
    }
}
