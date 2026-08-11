# Human/agent parity audit

Last audited: 2026-08-11

## Verdict

AIMuse has practical parity for the current canonical alpha loop: an authenticated agent can create/configure a Song or SFX project, inspect exact state and attached-editor hints, apply granular revision-checked edits, audition bounded renders, manage jobs, checkpoint/branch, and undo/redo without an editor. A human can attach and edit the same project with priority locks and visible attribution.

Parity does not imply v1 DAW completeness. Managed-preview WASAPI shared playback is available to both Windows surfaces, and the shared CoreAudio runtime now has bounded native development evidence on macOS. The exact macOS editor/MCP bidirectional workflow has not been independently certified. Live-graph/exclusive CoreAudio, recording/MIDI, deep audio gestures, complete mixer/automation, SDK-backed plug-ins and several observation modalities remain incomplete or absent. Some asymmetries are intentional security or responsiveness boundaries.

## Shared canonical boundary

Renderer IPC and MCP commit through `ProjectService`, the same operation schema/reducer, per-project mutation queue, two-phase native graph handshake, journal and trace. Authenticated MCP direct/branch transactions and actor history additionally share a fair bounded external-agent admission layer; human renderer commits do not consume those lanes. Server-owned policies normalize actor identity, timestamps, revisions and trusted generation provenance. Agents receive semantic music operations rather than replacing tracks or reimplementing quantize/humanize/transpose/legato/arpeggiate algorithms.

## Closed parity gaps

| Area | Current contract and evidence |
| --- | --- |
| Project creation | MCP and editor create Song/SFX projects against the same schema and defaults. |
| State observation | Snapshot/diff includes canonical tracks/clips/devices/automation/assets/provenance plus optional selection/transport/locks. |
| Collaboration | Human entity/time locks conflict with agent edits; unrelated work proceeds and retry guidance is returned. |
| Actor history | Selective undo/redo changes only values still matching that actor's edit and preserves later work by others. |
| Checkpoints/variants | Agents and humans use the same immutable project checkpoints and named variant service. |
| Auditory feedback | Bounded audition/stem renders are addressable MCP media resources with engine-owned asset metadata. The same real non-silent 32-bit-float audition is visible and playable in the packaged editor through the stream-enabled custom media scheme. |
| Real-time transport | Editor IPC and MCP transport use the same background-prewarmed revision preview and native playback state. Windows has packaged WASAPI cross-surface evidence; macOS has bounded native shared-CoreAudio callback evidence but not yet formal editor/MCP parity evidence. Preview rendering does not block Electron, revision swaps preserve cursor/play state, and both surfaces share the same transport contract. |
| Throughput | Per-project serialized mutation tails prevent simultaneous UI/MCP lost updates. Agent direct/branch transactions and actor undo/redo share four fair bounded admission lanes; transactions retain explicit idempotency while non-idempotent history returns re-observation guidance after pre-start backpressure/cancellation. Paired no-socket and bearer-authenticated loopback acceptance covers the same five-session history scenario without starting audio; packaged acceptance remains separate. |
| Editor control integrity | Enabled renderer buttons are mechanically audited for an action, high-frequency draft controls serialize and rebase canonical commits, and action failures surface in the editor instead of looking inert. Headless Chrome covers the main toolbar, timeline tools, devices, mixer, automation, candidate audition and agent connection; exact packaged QA additionally covers Windows Escape normalization, tab-scoped search, global history after blur, native dirty Cancel/Save and real audition playback. Historical hash `E558…412` passed authorized disposable-project Discard; current hash `CFCC…30621` did not repeat that destructive action without action-time confirmation. |
| Attribution/provenance | Server actor/client metadata is durable; generated provenance is engine-only and candidates remain outside the arrangement until acceptance. Human and authenticated-agent saves carry their actor through a separate durable destination-free `file.saved` audit without changing content revision or undo history. |

## Remaining parity backlog

| Tracker | Gap | Why it matters |
| --- | --- | --- |
| AGT-02/QA-04 | Subscription and complete action acceptance | Agents need proven live observation across every public resource/tool action. |
| AGT-10 | Musical three-way merge depth | Current project-level variants need selective entity/range conflict review. |
| AGT-16/GEN-09 | Spectrogram/key/transient and synchronized before/after | Autonomous iteration needs richer auditory/visual comparison. |
| SONG-02–12 | Editor semantic completeness | Fold/split/MIDI draw, device insertion and initial automation-lane creation now commit through the canonical operation surface; deeper audio, piano-roll, mixer, automation and hierarchy workflows remain thinner or model-only. |
| PLG-06/07 | Plug-in descriptors versus native UI | Agents will use stable parameters/presets by design; humans still need managed native editor windows. |
| AUD-02/UX-02 | Live graph, exclusive endpoints and callback telemetry | Shared preview playback now refreshes revisions without blocking or rewinding; both surfaces still need endpoint controls, hot-plug behavior, true streaming graph updates, meters and xruns. |
| QA-09/10 | Higher-level packaged certification | Independent Luna/high Level 1 passed for Windows exact hash `4CF335C1…B16EC7`, including exact-URI subscriptions, both cross-surface directions, native history, cleanup and redaction with no P0–P3 finding. Separate Windows hashes remain retained and scoped. The local macOS package/headless evidence is not transferable certification; a fresh independent task must still prove human→agent and agent→human behavior with native Computer Use on the exact Mac package. Formal Levels 2/3 remain; provider generation stays an explicit unconfigured/no-paid-call exception. |

## Boundary asymmetries by design

| Agent | Human |
| --- | --- |
| Bounded operation count, explicit transaction idempotency, fair project/history admission, and re-observation before repeating non-idempotent history; coarse locks/advisory UI state | Pointer previews remain local, human commits do not consume external-agent lanes, and human edits have priority inside an active gesture |
| Addressed paths and policy/approval for reads, writes and every overwrite | Native dialogs carry direct one-time intent |
| Provider/model/budget authority and approval for unknown-cost requests | Human-started generation does not ask a second agent-authority question |
| No microphone/MIDI by default and no inline media bytes | Direct UI recording still requires OS/user permission and explicit arm/record action |
| Plug-ins by stable descriptor/preset/parameter ID | Managed native plug-in editors are a human-only UI surface |

These boundaries must remain visible and tested; parity work must operate within them rather than remove them.

## Maintenance rule

Any material change to human or agent capabilities updates this audit and [FEATURE_TRACKER.md](FEATURE_TRACKER.md) together. “Working” means usable now; “Verified” requires automated acceptance evidence. Formal release confidence additionally requires the independent [three-level workflow](TESTING.md).
