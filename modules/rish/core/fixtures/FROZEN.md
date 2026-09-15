# Frozen assets

Every asset listed here was recorded from a native implementation that has
since been deleted. **None of them can be regenerated.** A test that disagrees
with one of them is either a real behaviour change — which belongs in a new
fixture beside these, never in an edit to one — or a porting mistake.

`scripts/verify-agent-core-fixtures.sh` checks the digests below. Run it
before trusting a green core suite; the repository's Actions are disabled, so
nothing else will.

| asset | sha256 | recorded at | what it locks |
|---|---|---|---|
| `canonical-corpus.json` | `342560f7e5a434ffb041723e70e298223ae2227bdf89c1cf3a2c2a6e5e949b7e` | `97b547f` | the canonical-JSON inputs |
| `canonical-golden.json` | `541058d02d0ce07549b5eeffdf73518cd594b3be75a111261e7aa750e39511bb` | `97b547f` | canonical JSON and the two hash domains, from `DSHAgentCanonicalJSON` |
| `session-corpus.json` | `77efb9c996eabf295017bf97d83055d9359d453f8a2b013213a7cd807ae394fa` | `c3d9b83` | the session candidates the mutation walk expands |
| `session-golden.json` | `56f5a04c79442c7e13acb2a3b72e79f6df0a16847dd3dde3f11eef1d5f05cd00` | `c3d9b83` | ~17,500 answers from the ObjC `SessionSnapshotStore` validators |
| `wal-transaction-golden.json` | `9c885e3d013107f40f6f620d3a6dfe396bb3e31919073749ba54ce1e90066bbd` | `854f541` | 440 WAL operation-relation commands from `AgentNativeWAL.mm` |
| `runtime-coordinator-golden.json` | `34d23d4939ac173fc7bf741dcc5b41b47c37e575fd36912e83503b8742c7c4b9` | `7fb4e82` | 29 finalize/discard/interrupt settlements from `AgentRuntimeCoordinator.mm` |

The mutation walk that expands `session-corpus.json` into `session-golden.json`
is part of the frozen contract: remove / null / `"x"` / `0` / `[]` over
pre-order paths, object keys in UTF-16 order, thinned to the golden's `cap` by
`floor(i * count / cap)`. It is implemented in
`crates/rish-agent-core/tests/session_schema.rs`; changing it invalidates the
golden just as surely as editing the file would.
