# AIMuse QA report

## Result

- Overall: `PASS | FAIL | BLOCKED`
- Level: `1 | 2 | 3`
- Run ID:
- Started/finished UTC:
- Tester model:
- Tester reasoning effort:
- Report path:
- Certification started/finished UTC (must match schema-2 JSON):

## Subject and environment

- Source/input change under test:
- Source revision, branch, index and dirty/untracked input identity:
- Frozen package-input identity versus final checkout identity; authorized concurrent drift, if any:
- Pre-existing package identity, if observed, explicitly labeled non-subject:
- Node/npm versions:
- Platform/display/audio/MIDI details:
- Formal evidence root and retained filesystem identity:
- Playwright output and HTML-report paths, disjoint from formal evidence:
- Declared release-input manifest path and SHA-256:
- Declared Node/npm/direct-tool/dependency-inventory identity:
- Copied miniaudio revision/tree inventory and fresh native build/dist paths:
- Execution-witness SHA-256 and receipt count:
- Automation-observation manifest path and SHA-256:
- Independent automated-verification path and SHA-256 (`AUTOMATED_GATES_PASS`, not Level Pass):
- Package-subject manifest path and SHA-256:
- Subject identity SHA-256:
- Executable, ASAR and native-helper paths/bytes/SHA-256:
- Architecture, bundle and signature identity:
- App version/window title:
- Isolated profile:
- Initially active project ID/name:

## Build and engine identity preflight

| Assertion | Result | Evidence without credentials |
| --- | --- | --- |
| Node runtime is 24.x | | |
| Source/branch/index/dirty identity captured before packaging | | |
| Frozen source inputs remained stable through packaging and subject publication | | |
| Final checkout identity matches frozen inputs, or later authorized drift is retained and scoped out | | |
| Package ran exactly once before subject declaration | | |
| Immutable manifest was published once below the formal root | | |
| Manifest-bound executable/ASAR/native/fuse/signature verifier passed | | |
| Manifest/component reverify passed after verifier and packaged E2E | | |
| Formal root, preflight and automation log survived Playwright cleanup | | |
| Playwright output and HTML report are disjoint from formal evidence | | |
| Manifest/component reverify passed at coordinator handoff | | |
| Native process launched outside filesystem sandbox | | |
| QA session status is `okay: true` | | |
| `processAlive`, `processInspection`, supported/denied/status/identity fields recorded | | |
| Normal path is performed/supported/not-denied/alive with `processAlive: true` | | |
| No `ESRCH`, absent, unsupported or process-identity-mismatch result | | |
| Alternate path, if used, is sandbox `EPERM` and denied/not-supported/permission-denied/alive-null | | |
| Alternate path has `packageSubjectVerified: true` and exact manifest/subject/executable fields | | |
| Connection/session and health PID/instance/profile/URL identity matches exactly | | |
| `mcpAuthentication` is verified / HTTP 400 / `initialization_required` | | |
| Alternate path has `inspectionFallbackVerified: true` | | |
| No coordinator/unsandboxed tester-status substitution occurred | | |
| Session executable/hash equals package-subject executable/hash | | |
| Computer Use app path equals package-subject executable | | |
| Agents/Activity MCP URL equals session manifest/client URL | | |

## Automated gate

| Command | Result | Duration | Evidence/notes |
| --- | --- | ---: | --- |
| Formal environment plus `node scripts/npm-node24.mjs run test:levelN:auto` with preserved `pipefail`/`tee` exit | Pass/Fail/Blocked | | |
| Caller-declared schema-2 source/tool/dependency/environment inputs | Pass/Fail/Blocked | | |
| Exact caller-pinned execution-witness receipts and raw logs | Pass/Fail/Blocked | | |
| Post-automation `package-subject-verifier.mjs` at handoff | Pass/Fail/Blocked | | |
| Caller-pinned `release-evidence-verifier.mjs` derived exactly `AUTOMATED_GATES_PASS` with full level pending | Pass/Fail/Blocked | | |

## MCP cases

| Case | Result | Project/revision | Evidence/notes |
| --- | --- | --- | --- |
| Authentication/session | | | |
| Observe/resources | | | |
| Apply/idempotency | | | |
| Actor undo/redo | | | |
| Public authenticated `trace_replay`: selected durable transaction, entry/transaction/audit digests, zero applied operations and unchanged canonical before/after state | | | |
| Human drag grace lock: exact observed range/phase/expiry, colliding `locked`, unchanged revision, then zero lock + stale conflict after release/expiry | | | |
| Durable discard/recovery: dirty `force:false` refusal, successful `force:true`, discarded ID absent after same-profile restart, separate dirty control recovered without canonical drift | | | |
| Serialized approvals: maximum pending count, per-job request/resolution/terminal timestamps, zero overlap and zero second-job publication | | | |
| Level-specific cases | | | |

## Computer Use UI cases

| Case | Result | Expected | Actual/visual evidence |
| --- | --- | --- | --- |
| Window selection/render health | | | |
| Native menu/dialog/focus | | | |
| Distinct native Save As destination and MCP-observed project path | | | |
| Timeline/piano-roll/mixer/SFX pointer action | | | |
| Inspector clip move/trim/split transaction labels and geometry | | | |
| Song marker/section/lyrics surfaces and MCP-observed attributed state | | | |
| Disposable-project discard confirmation, pre-restart absence and post-restart native-tab absence; recovery-control tab present | | | |
| Native Jobs surface showed at most one pending approval and returned to zero before each next request | | | |
| Panels/tabs/transport/status | | | |
| Level-specific cases | | | |

## Cross-surface assertions

| Direction | Result | Evidence |
| --- | --- | --- |
| MCP → visible UI | | |
| Computer Use UI → MCP state | | |
| Computer Use clip drag → visible nonzero grace countdown → authenticated MCP `locked` → bounded cleanup | | |

## Findings

### `BLOCKER/P0/P1/P2/P3` — Short title

- Tracker IDs:
- Reproduction:
- Expected:
- Actual:
- Project ID/revision:
- Window/modal/focus/transport state:
- Evidence/log excerpt:
- Reproducibility:

Repeat for each finding. Write `None` when there are none.

## Coverage exceptions

List every skipped, unavailable, confirmation-blocked or environment-dependent requirement. An unexplained mandatory skip invalidates Pass.

## Cleanup

- MCP session left and state credentials redacted:
- Engine connection credentials redacted after stop:
- Initially active isolated project restored:
- Force-discarded run-owned project IDs absent before and after same-profile restart and at final cleanup:
- Separate dirty crash-recovery control restored with exact ID/revision/canonical state, then saved or closed safely:
- Other QA projects saved/closed safely:
- Maximum observed pending approval count and evidence that every approval job became terminal before the next request:
- Isolated engine stopped and PID absent:
- Remaining QA and pre-existing processes listed separately:
- Package-subject manifest and every component reverified after stop:
- Frozen source-input identity versus final checkout; concurrent remediation attribution and evidence:
- Original formal-root identity, preflight, automation log and report retained:
- Playwright output remained isolated; evidence and cleanup warnings:

## Final gate decision

State why the tester disposition is PASS, FAIL or BLOCKED and name the exact next action. For PASS, also record the schema-2 independent-certification manifest path/size/SHA-256, exact ordered case count, per-case evidence-binding count and the distinct tester/implementation task IDs. The full Level is not finally PASS until the caller-pinned `release-level-certifier.mjs` output is retained; record its path/size/SHA-256 when available.
