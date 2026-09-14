// C ABI of the shared Rish agent core (modules/rish/core, crate rish-agent-ffi).
//
// Every string-returning function hands back a NUL-terminated UTF-8 buffer
// owned by the library; release it with rish_agent_string_free. Inputs are
// UTF-8 with explicit lengths and are never retained. All functions are safe
// to call from any thread and never unwind across the boundary.
#ifndef RISH_AGENT_CORE_H
#define RISH_AGENT_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// JSON protocol version implemented by the library (see PROTOCOL_VERSION).
uint32_t rish_agent_protocol_version(void);

/// Releases a string returned by any function below. NULL is ignored.
void rish_agent_string_free(char *value);

/// Canonical JSON of a JSON text, or NULL when it is not JSON or cannot be
/// canonicalised (non-finite, negative zero, unsafe integer, depth > 64).
char *rish_agent_canonical_json(const char *json, size_t json_length);

/// DSHAgentHJ: SHA-256("rish.<tag>.v1\0" || canonical JSON), lowercase hex.
char *rish_agent_hash_json(const char *tag, size_t tag_length,
                           const char *json, size_t json_length);

/// DSHAgentHB: SHA-256("rish.<tag>.v1\0" || u64 big-endian length || bytes).
char *rish_agent_hash_bytes(const char *tag, size_t tag_length,
                            const uint8_t *bytes, size_t length);

/// Canonical form of tool arguments when the strict parser accepts them.
char *rish_agent_parse_arguments(const char *json, size_t json_length);

/// One schema-3 round-journal operation over a JSON envelope
/// {"op","args","env","view"}; returns {"ok":true,...} or
/// {"ok":false,"error":<DSHAgentNativeStoreErrorCode>}. NULL only when the
/// input is not UTF-8.
char *rish_agent_round_reduce(const char *json, size_t json_length);

/// One execution-ledger row operation over a JSON envelope
/// {"op","args","env","view"}; returns {"ok":true,...} with the change list
/// and optional operation commit, or {"ok":false,"error":<code>}. NULL only
/// when the input is not UTF-8.
char *rish_agent_ledger_reduce(const char *json, size_t json_length);

/// One batch-level ledger operation (prepare_tool_batch / open_effect_gate)
/// over {"op","request","env","view"}; same reply shape as the row reducer.
char *rish_agent_ledger_batch_reduce(const char *json, size_t json_length);

/// One transcript-store operation over {"op","request","env","view"}.
char *rish_agent_transcript_reduce(const char *json, size_t json_length);

/// One session-schema operation: `request` is {"op","env"} JSON, `input` the
/// operation's raw bytes (candidate JSON, stored envelope, tombstone file; any
/// bytes, empty allowed). Ops: candidate (validation + digest),
/// candidate_digest (lenient), envelope, tombstones, legacy_root. Same reply
/// shape as the reducers.
char *rish_agent_session_reduce(const char *request, size_t request_length,
                                const uint8_t *input, size_t input_length);

/// One tool-batch-service decision over {"op","request",...}: prepare_request,
/// prepare_gate, prepare_calls, prepare_finish, prepare_final,
/// prepare_ledger_failure, bind_request, bind_check.
char *rish_agent_tool_batch_reduce(const char *json, size_t json_length);

#ifdef __cplusplus
}
#endif

#endif
