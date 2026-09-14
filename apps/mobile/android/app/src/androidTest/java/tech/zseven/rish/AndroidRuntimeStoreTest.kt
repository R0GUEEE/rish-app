package tech.zseven.rish

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.zseven.rish.runtime.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class AndroidRuntimeStoreTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    @Test fun credentialsAreEncryptedAndIsolatedByAccount() {
        val namespace = "rish.credentials.test." + UUID.randomUUID()
        val store = AndroidCredentialStore(context, namespace)
        val secret = "fixture-secret-not-a-real-key"
        try {
            store.put("DEEPSEEK_API_KEY", secret)
            assertEquals(secret, store.get("DEEPSEEK_API_KEY"))
            val preferences = context.getSharedPreferences(namespace, 0)
            val cipher = preferences.getString("DEEPSEEK_API_KEY", "")!!
            assertFalse(cipher.contains(secret))
            preferences.edit().putString("BIGMODEL_API_KEY", cipher).commit()
            try { store.get("BIGMODEL_API_KEY"); fail("Cross-slot ciphertext was accepted") } catch (_: javax.crypto.AEADBadTagException) { }
            store.clear("DEEPSEEK_API_KEY"); assertFalse(store.configured("DEEPSEEK_API_KEY"))
        } finally {
            context.getSharedPreferences(namespace, 0).edit().clear().commit()
            java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry("$namespace.aes") }
        }
    }
    @Test fun providerEndpointChangesDoNotReuseCredentials() {
        val namespace = "rish.providers.test." + UUID.randomUUID()
        val config = AndroidProviderConfiguration(context, namespace)
        try {
            val original = config.effectiveAccount("OPENAI_API_KEY")
            val profile = JSONObject().put("schema_version", 1).put("harness_id", "codex").put("name", "Fixture")
                .put("endpoint_url", "https://example.com/v1").put("protocol", "chat-completions").put("auth_type", "bearer")
                .put("model_mappings", JSONObject().put("gpt-5.6", "test-model")).put("send_reasoning", false)
            config.save(profile); val first = config.effectiveAccount("OPENAI_API_KEY")
            config.save(profile.put("endpoint_url", "https://other.example.com/v1")); val second = config.effectiveAccount("OPENAI_API_KEY")
            assertNotEquals(original, first); assertNotEquals(first, second)
            config.reset("codex"); assertEquals(original, config.effectiveAccount("OPENAI_API_KEY"))
        } finally { context.getSharedPreferences(namespace, 0).edit().clear().commit() }
    }
    @Test fun endpointNormalizationAndStoredProfilesRemainValidated() {
        val namespace = "rish.providers.test." + UUID.randomUUID()
        val config = AndroidProviderConfiguration(context, namespace)
        val preferences = context.getSharedPreferences(namespace, 0)
        try {
            val profile = JSONObject().put("schema_version", 1).put("harness_id", "claude-code").put("name", "Fixture")
                .put("endpoint_url", "https://example.com/api/anthropic").put("protocol", "messages").put("auth_type", "x-api-key")
                .put("model_mappings", JSONObject()).put("send_reasoning", false)
            assertEquals("https://example.com/api/anthropic/v1/messages", config.normalize(profile).getString("endpoint_url"))
            profile.put("endpoint_url", "https://example.com/custom/").put("full_url", true)
            assertEquals("https://example.com/custom/", config.normalize(profile).getString("endpoint_url"))
            config.save(profile)
            assertEquals("https://example.com/custom/", config.read("claude-code").getString("endpoint_url"))
            preferences.edit().putString("claude-code", profile.put("official", true).toString()).commit()
            try { config.read("claude-code"); fail("Forged official configuration accepted") } catch (_: IllegalArgumentException) { }
        } finally { preferences.edit().clear().commit() }
    }
    @Test fun bridgeNumericVersionsAcceptIntegersButRejectFractions() {
        val nativeMap = com.facebook.react.bridge.Arguments.createMap()
        nativeMap.putDouble("schema_version", 1.0)
        RuntimeJson.checkVersion(RuntimeJson.fromBridgeMap(nativeMap.toHashMap()), 1)
        val fractionalMap = com.facebook.react.bridge.Arguments.createMap()
        fractionalMap.putDouble("schema_version", 1.5)
        try {
            RuntimeJson.checkVersion(RuntimeJson.fromBridgeMap(fractionalMap.toHashMap()), 1)
            fail("Fractional bridge version accepted")
        } catch (_: IllegalArgumentException) { }
    }
    @Test fun customDshCatalogRoutesNewModelsAndRetainsRetiredIdentity() {
        AndroidDshModelCatalog.initialize(context)
        val prefs = context.getSharedPreferences("rish.dsh-models.v1", 0)
        val previous = prefs.getString("catalog", null)
        try {
            prefs.edit().remove("catalog").commit()
            val initial = AndroidDshModelCatalog.read()
            val models = org.json.JSONArray(initial.getJSONArray("models").toString())
            val model = "catalog-fixture-vNext"
            assertFalse(AndroidDshModelCatalog.isKnown(model))
            models.put(JSONObject().put("id", model).put("name", "Future model").put("supports_images", false))
            AndroidDshModelCatalog.save(JSONObject().put("schema_version", 1).put("models", models))
            assertEquals("dsh", AndroidProviderConfiguration.harness(model))
            AndroidDshModelCatalog.save(JSONObject().put("schema_version", 1).put("models", initial.getJSONArray("models")))
            assertTrue(AndroidDshModelCatalog.isKnown(model))
            assertEquals(1, AndroidDshModelCatalog.read().getJSONArray("retired_models").length())
            val reserved = org.json.JSONArray().put(JSONObject().put("id", "gpt-5.6").put("name", "Wrong provider").put("supports_images", false))
            try { AndroidDshModelCatalog.validateModels(reserved); fail("Reserved model accepted") } catch (_: IllegalArgumentException) { }
        } finally {
            if (previous == null) prefs.edit().remove("catalog").commit()
            else prefs.edit().putString("catalog", previous).commit()
        }
    }
    @Test fun sessionDigestMatchesTheSharedJcsDomainVector() {
        val candidate = JSONObject().put("schema_version", 9).put("z", "https://example.com/你好😀")
            .put("a", org.json.JSONArray().put(true).put(JSONObject.NULL).put(1))
        assertEquals("4604b724aeae709f20da9f323bac4618a16cba34701dadb069e4e68f930f8d97", RuntimeJson.sessionDigest(candidate.toString()))
    }
    @Test fun snapshotCASIsAtomicIdempotentAndDetectsConflicts() {
        val name = "session-test-${UUID.randomUUID()}.db"
        val store = AndroidSessionStore(context, name)
        try {
            val operation = UUID.randomUUID().toString()
            val request = JSONObject().put("schema_version", 1).put("operation_id", operation)
                .put("expected", JSONObject().put("schema_version", 1).put("kind", "missing"))
                .put("candidate_json", "{ \"schema_version\": 9 }")
            val first = store.persist(request)
            assertEquals("committed", first.getString("status")); assertEquals(1, first.getJSONObject("snapshot").getInt("generation"))
            assertEquals(first.toString(), store.persist(request).toString())
            assertEquals("{ \"schema_version\": 9 }", store.load().getString("session_json"))
            val competing = JSONObject(request.toString()).put("operation_id", UUID.randomUUID().toString())
            assertEquals("conflict", store.persist(competing).getString("status"))
            try { store.persist(JSONObject(request.toString()).put("candidate_json", "{\"schema_version\":9}")); fail("Operation reuse accepted different bytes") } catch (_: IllegalArgumentException) { }
            assertEquals("committed", store.query(JSONObject().put("schema_version", 1).put("operation_id", operation)).getString("status"))
            assertEquals(1, store.load().getJSONObject("snapshot").getInt("generation"))
        } finally { store.close(); context.deleteDatabase(name) }
    }
    @Test fun unsupportedAuthorityNeverGetsCommitted() {
        val name = "session-authority-test-${UUID.randomUUID()}.db"
        val store = AndroidSessionStore(context, name)
        try {
            val request = JSONObject().put("schema_version", 1).put("operation_id", UUID.randomUUID().toString())
                .put("expected", JSONObject().put("schema_version", 1).put("kind", "missing"))
                .put("candidate_json", "{\"schema_version\":9,\"workspace_authority_outbox\":[{}]}")
            try { store.persist(request); fail("Unsupported authority committed") } catch (_: IllegalArgumentException) { }
            assertEquals("missing", store.load().getString("status"))
        } finally { store.close(); context.deleteDatabase(name) }
    }
    @Test fun cancellationBeforeWorkerBindingNeverReachesNetwork() {
        val namespace = "runtime-cancel-test-${UUID.randomUUID()}"
        val credentials = AndroidCredentialStore(context, namespace)
        val config = AndroidProviderConfiguration(context, "$namespace.providers")
        val transport = AndroidModelTransport(credentials, config)
        val request = JSONObject().put("schema_version", 1).put("request_id", UUID.randomUUID().toString())
            .put("model", "deepseek-v4-flash").put("thinking_mode", "off").put("history", org.json.JSONArray().put(JSONObject().put("role", "user").put("content", "fixture")))
            .put("tools", org.json.JSONArray())
        val prepared = transport.prepare(request.toString())
        try { transport.whenIdle { fail("Catalog changed during a prepared request") } } catch (error: RuntimeFailure) { assertEquals("E_COMPLETION_BUSY", error.code) }
        transport.cancel(prepared.id)
        try { transport.execute(prepared); fail("Cancelled request executed") } catch(error: RuntimeFailure) { assertEquals("E_COMPLETION_CANCELLED", error.code) }
    }
}
