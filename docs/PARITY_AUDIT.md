# Human/agent parity audit

Last audited: 2026-08-21

## Verdict

AIMuse has practical parity for the current native DAW loop: an authenticated external agent can create/configure a Song or SFX project, inspect canonical state and attached-editor hints, apply granular revision-checked edits, import/analyze/audition media, manage jobs, checkpoint/branch, export, and undo/redo without an editor. A human can attach and edit the same project with priority locks and visible attribution.

AIMuse is not a built-in generative-AI platform. Neither surface exposes a provider adapter, provider credential, content-generation job, generation candidate, source-separation adapter, or spending/generation policy. An external agent can use capabilities it owns outside AIMuse and import resulting media through the same controlled file boundary.

Parity does not imply v1 DAW completeness. Recording/physical MIDI, deep audio and piano-roll gestures, complete mixer/automation, SDK-backed plug-ins, codecs, endpoint/hot-plug behavior, PDC, performance, accessibility, packaging, and Level 3 remain incomplete or separately gated.

## Shared canonical boundary

Renderer IPC and MCP commit through `ProjectService`, the same schema/reducer, per-project mutation queue, two-phase native graph handshake, recovery journal, and trace. Authenticated direct/branch edits, history, checkpoints/variants, plug-in device edits, WAV analysis, and audition/consolidation job creation share bounded external-agent admission. Server-owned actor identity, timestamps, and revisions are normalized at the boundary.

Legacy generation-provenance fields remain in schema/reducer validation only so existing project files stay readable. MCP and `ProjectService` reject provenance registration, update, and deletion, and the renderer has no generation workflow. Checkpoint restore and snapshot undo/redo preserve the currently opened provenance map and generation-source asset subset even when the historical snapshot diverges. This compatibility data is never treated as executable authority or a live mutation route.

## Current parity map

| Area | Current contract |
| --- | --- |
| Project creation/state | MCP and editor create Song/SFX projects against the same defaults and observe canonical tracks, clips, devices, automation, assets, structure, history, and optional editor/transport/lock state. |
| Editing/collaboration | Both surfaces use revision-checked granular operations. Human gesture/grace locks take priority over conflicting agent edits; unrelated work proceeds. |
| Jobs/approvals | Jobs and approval details are owner-scoped. MCP cannot grant approval; one human decision surface resolves a globally serialized pending request. |
| Media/interchange | Both surfaces use controlled import, analysis, deterministic audition/consolidation/render/export, DAWproject, and portable-pack services. No inline agent-supplied bytes or external provider call exists. |
| History/recovery | Actor-scoped undo/redo, trace replay, checkpoints/variants, dirty close/discard, and same-profile recovery share canonical persistence. |
| Plug-ins | Stable descriptor/preset/parameter operations share project semantics; real SDK discovery/hosting and managed native editor windows remain incomplete. |
| MCP connection | Both headless and attached-editor operation publish the same private engine run-state for a stable AIMuse stdio bridge. The human copies one no-secret setup once; each engine restart rotates authority and the configured bridge reinitializes automatically without token exposure or client-config writes. |
| Attribution | Server-authenticated actor/client metadata and destination-free `file.saved` audit records remain durable without adding undoable content history. |

## Remaining parity backlog

| Tracker | Gap | Why it matters |
| --- | --- | --- |
| AGT-02/QA-04 | Complete subscription/action acceptance | Agents need proven live observation across every retained public resource/tool action. |
| AGT-10 | Musical three-way merge depth | Variants need selective entity/range conflict review. |
| AGT-16 | Spectrogram/key/transient and synchronized before/after | Autonomous iteration needs richer auditory/visual comparison. |
| SONG-02–12 / SFX rows | Editor semantic completeness | Deeper audio, piano-roll, mixer, automation, hierarchy, and SFX workflows remain thinner than the model. |
| AUD-02/AUD-03/UX-02 | Live graph, endpoints, physical MIDI, callback telemetry | Current preview/discovery seams do not establish full device operation. AUD-03 remains a separately bounded pending native candidate. |
| PLG-06/07 | Native plug-in hosting/UI | Process shells and descriptor edits are not SDK-backed hosting. |
| QA-09/10 / REL rows | Exact-package certification | Historical exact-subject results do not certify changed bytes; formal Levels 2/3 and release packaging remain. |

## Boundary asymmetries by design

| Agent | Human |
| --- | --- |
| Bounded operations, idempotency, fair admission, owner-scoped jobs, and re-observation before repeating non-idempotent actions | Pointer previews remain local, human commits do not consume external-agent lanes, and human gestures receive priority locks |
| Addressed paths plus policy/approval for reads, writes, and overwrites | Native dialogs carry direct one-time intent |
| No microphone/MIDI by default and no inline media bytes | Direct UI recording still requires OS/user permission and an explicit arm/record action |
| Plug-ins by stable descriptor/preset/parameter ID | Managed native plug-in editors are a future human-only UI surface |
| Uses one static target-only AIMuse stdio setup; a canonically checked link-free Electron sibling keeps fresh bearer/session authority internal, recovers notification-stream loss, and follows engine restarts automatically | Can view/copy the same no-secret one-time setup and bridge status, but cannot reveal engine authority through the renderer or supply/force bridge browser state into the editor profile |

There is no human/agent provider or protected-storage asymmetry because those product surfaces have been removed from both sides.

## Maintenance rule

Any material change to human or agent capability updates this audit and [FEATURE_TRACKER.md](FEATURE_TRACKER.md) together. “Working” means usable now; “Verified” requires automated acceptance evidence. Formal release confidence additionally requires the independent [three-level workflow](TESTING.md).
