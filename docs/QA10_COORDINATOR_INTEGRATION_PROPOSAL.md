# QA-10 coordinator integration proposal

Status: **decision-ready proposal only**. The ABI-v2 Node-API provider has exact provider-only Windows PASS evidence, but it remains opt-in, explicit-path loaded, unstaged and unwired. This document does not authorize a source, coordinator, build, staging, signing, package or runtime change.

## Decision requested

Approve one narrow direction: a separately built and sealed **QA coordinator companion bundle** consumed only by the external Node 24 `qa-session` and `qa-mcp` processes. Do not place the addon in the AIMuse application ASAR or `resources/native`, and never load it in Electron. Coordinator integration remains fail-closed and opt-in until the complete acceptance matrix below passes; formal QA mode may later require it under separate authorization.

The decision must also approve these two implementation consequences:

1. An audit build may retain diagnostic exports, but a coordinator build must exclude them and expose only the versioned lease-provider surface.
2. Follow-up commands must use a nested bootstrap/operational lease sequence because protected connection/profile paths are discovered from manifest or state bytes.

## Current boundary that must not regress

- `qa-session` and `qa-mcp` are external Node scripts. They currently use path/ACL revalidation and are not part of the Electron runtime.
- The provider-only addon is ABI v2 and the lease contract is version 1. The provider holds root and parent handles without delete sharing, validates final path/file identity/reparse/security from handles, returns fresh read snapshots, commits validated same-parent stages to pinned absolute destinations, makes validation failure sticky and closes exactly once.
- Snapshot desired access is read plus security. Its share mask admits read and delete for atomic replacement, but never write. Root/parent leases still deny delete sharing and stages remain share-zero.
- Existing certified application packages do not contain or inherit this provider. The retained provider PASS is not an application, package or release certificate.
- Seven project-root incident artifacts and every retained run remain immutable evidence and are outside this proposal.

## Recommended companion-bundle design

One coordinator bundle is an independently identified subject beside, not inside, an AIMuse application package:

```text
<package-prep-root>\AIMuse-QA-Coordinator-win32-x64\
  qa-coordinator-artifacts.json
  qa-coordinator-artifacts.sig
  provider\aimuse-qa-private-root-provider.node
```

`qa-coordinator-artifacts.json` uses one canonical serialization and binds:

- manifest schema and signing-key ID;
- target `win32-x64`, Node major 24 and minimum N-API 8;
- provider API version 2, lease-contract version 1 and build profile `coordinator`;
- exact relative filename, byte length and SHA-256;
- a build/source identity and `diagnosticsEnabled: false`;
- bundle creation identity, never a credential, private-root path or bearer-derived value.

The coordinator is given the exact absolute manifest path. It never searches, globs, walks upward, resolves through ambient CWD, selects the newest file or falls back to another configuration. The addon path is the one signed relative entry resolved beneath the manifest's canonical sealed directory.

### Integrity and signing

Runtime trust uses a detached Ed25519 signature over the canonical manifest, verified with a versioned public key embedded in the coordinator source. The signed manifest binds the addon hash and size, so runtime verification needs no PowerShell, shell helper, network lookup or preloaded native verifier.

Windows distribution additionally requires Authenticode signing of the `.node` file. Authenticode is a release/provenance gate; the detached manifest signature is the coordinator's deterministic runtime trust decision. Package evidence records both results without embedding certificate details in credential-bearing state.

The formal bundle directory must have a protected, non-link Windows ACL that grants the launching non-elevated user read/execute but no write/delete/permission-change rights, with modification reserved for the installation/package authority, SYSTEM and Administrators. The coordinator validates canonical path, containment, regular-file/non-reparse state, filesystem identity, size and SHA-256 before load and repeats identity/size/hash checks immediately after load. The sealed ACL closes the replacement interval for the supported non-administrator threat model; administrator or OS compromise remains outside the coordinator boundary.

Development mode may accept an explicitly supplied absolute addon plus exact SHA-256 without the sealed/signed bundle, but must return and persist `nonCertifying: true`. It cannot satisfy a formal package, QA-10 closure or release gate, and it cannot silently transition to formal mode.

## ABI and load policy

- Coordinator processes remain pinned to Node 24 x64 on Windows and require `process.versions.napi >= 8`.
- The production companion artifact is rebuilt from the pinned Node 24 header/import-library set. The retained Node-16-cache N-API PASS remains compatibility evidence, not the production build-input decision.
- The coordinator profile exports only `providerVersion`, immutable build metadata and `acquireLease`. Diagnostic exports are compile-time disabled.
- The loader requires provider API 2, lease contract 1, build profile `coordinator`, exact signed build identity and all eight declared lease capabilities. An extra/missing field or capability is failure.
- Each command loads once from the exact canonical path. There is no dynamic unload, hot swap, retry under another path, ABI downgrade or module-cache alias.
- The addon never loads in Electron, the renderer, preload, audio service, plug-in scanner or bridge.

## Development and packaged staging

| Context | Artifact | Allowed claim |
| --- | --- | --- |
| Provider development/audit | Fresh explicit build-root addon; diagnostic profile allowed; exact hash required | Provider development evidence only |
| Source coordinator development | Explicit coordinator-profile addon and hash; unsigned mode clearly marked `nonCertifying` | Launch-free/mock or disposable-root integration only |
| Formal packaged QA | Sealed signed companion bundle beside the immutable AIMuse package-prep root | Eligible for QA-10 coordinator evidence after all gates pass |
| Product application package | No provider in ASAR or `resources/native` | Unchanged AIMuse application subject |

`native-build.mjs` continues staging only the audio, scanner and bridge executables. Forge `extraResource` remains unchanged. A future dedicated coordinator-bundle task owns the provider build and manifest; `verify-package.mjs` gains a separate companion-bundle verifier without implying that the application's executable hash covers the bundle.

## Coordinator lifecycle mediation

Every Windows command receives an exact provider-manifest argument. Formal mode rejects omission before private bytes, executable access, process inspection/launch, window action, request, signal, output or evidence mutation.

| Command | Required lease lifetime |
| --- | --- |
| `qa-session start` | One operational lease over the declared private root, profile, connection and manifest starts before executable/policy access or directory creation and remains through readiness, manifest atomic commit and sanitized output. |
| `qa-session show/status/stop/redact` | A bootstrap lease over the manifest remains open while a nested operational lease is acquired over manifest/profile/connection. The operational lease re-reads the manifest and must match bootstrap bytes and file identity before the bootstrap lease closes. It remains through all process/health/window/signal/redaction/write/output work. |
| `qa-mcp init` | One operational lease over connection and state starts before bearer read and remains through initialize/join, atomic state commit and sanitized output. |
| `qa-mcp tool/resource/close` | A bootstrap lease over state remains open while a nested operational lease is acquired over state/connection. The operational state snapshot must match bootstrap bytes and identity before bootstrap close. It remains through bearer use, request/DELETE, atomic state update and output. |

All private reads use `readSnapshot`; manifest, connection-redaction and MCP-state writes use `atomicReplace`. Process, health, window, signal, network request and output actions run only through `runSensitive`. Existing PID/URL/UUID/profile/hash and health-generation checks remain mandatory inside that mediation rather than being replaced by it.

The current lease helper owns close. Each lease closes exactly once on success or error. Operation-plus-close failure remains an aggregate failure; close is never retried or treated as known-safe. Nested flow closes the operational lease before the bootstrap lease while retaining both errors if either close is ambiguous.

## Authority and CWD rules

- Replace coordinator uses of `resolve('test-results')` as an authority default with the module-derived workspace `test-results` root before wiring.
- Every private root and path remains explicit and absolute. The provider-manifest path is also absolute.
- No coordinator command changes process CWD. The provider receives only canonical absolute roots/paths, and atomic replacement receives only the validated pinned absolute target.
- Existing owner/protected Allow-only DACL, allowed-principal, containment, link/reparse, canonical/device/inode, legacy-state, sticky-failure and bearer-rotation rules remain additive requirements.
- Provider artifact authority and credential/evidence private-root authority are distinct. A package bundle must never be accepted merely because the evidence root is private, or vice versa.

## Fail-closed behavior

Missing manifest/signature/addon, invalid signature, unsafe ACL, link/reparse, containment escape, wrong filesystem identity, size/hash drift, wrong platform/architecture/Node/N-API/provider/contract/build profile, diagnostic-enabled artifact, loader exception, capability mismatch, lease acquisition/guard/snapshot/replace/close failure or bootstrap/operational byte/identity mismatch aborts before the next sensitive boundary.

There is no path-only fallback. Existing coordinator behavior may remain available only as an explicitly named legacy/non-certifying mode during migration; formal mode and any QA-10 closure claim require the provider. State/manifest persists only non-secret provider bundle ID/hash/profile metadata, and every follow-up must be invoked with the same signed manifest identity.

## Upgrade and rollback

- An active session pins one bundle manifest hash, provider API and lease-contract version. It cannot upgrade or downgrade in place.
- A new compatible provider build is a new signed companion bundle and requires the full source, Windows and package matrix below.
- Rollback starts a new session with an explicitly selected previously approved bundle. It is never automatic, never a fallback after current-bundle failure and never reuses credential-bearing state from another bundle identity.
- Unknown future state, manifest, provider or lease versions fail closed. Removing support for an old version requires a tracker/release decision and migration evidence; no compatibility shim may weaken the current contract.
- Signing-key rotation is a source/release change with a bounded overlap list of explicit key IDs. Network key discovery is forbidden.

## Minimum acceptance matrix before enablement

No coordinator source wiring task is authorized by this document. If wiring is later approved, it must remain disabled until this minimum matrix passes.

### Source and injected contract

- Exact signed-manifest parsing, canonical serialization and Ed25519 verification; wrong key/signature/hash/size/path/platform/architecture/Node/N-API/API/contract/profile fails before load.
- Sealed-bundle ACL, link/reparse, containment and pre/post-load identity/hash drift rejection with zero loader/sensitive calls.
- Audit/diagnostic artifacts rejected by the coordinator loader; no glob, CWD, environment-only or cached-artifact fallback.
- Every session/MCP command proves its complete sensitive-call order and zero downstream activity on each precondition failure.
- Bootstrap and operational leases overlap, compare exact snapshot bytes and file identity, and close exactly once across success, parse failure, acquisition failure, action failure and double-close stand-ins.
- All private reads/writes use lease snapshots/replacement; bearer rotation forces a fresh snapshot. No provider or bearer metadata leaks through output/error/evidence.
- Module-derived authority is invariant under hostile ambient CWD. Existing identity/health/PID-generation and stop/redaction contracts remain green.
- Development mode is visibly non-certifying; formal mode cannot run without a sealed signed coordinator-profile bundle.
- Upgrade, explicit rollback and unknown-version fixtures prove no in-place transition or fallback.

### Real Windows provider/coordinator

- Re-run the eight provider scenarios against the exact coordinator-profile artifact with diagnostics disabled.
- Test sealed-bundle acceptance plus wrong principal, writable owner, inherited/broad ACL, reparse, canonical replacement and pre/post-load identity/hash drift rejection.
- Exercise nested manifest/state discovery using only disposable roots and injected process/network/window stand-ins; prove no credential or external action before operational lease agreement.
- Repeat ACL/path/object drift at every command boundary and atomic bearer/state rotation while leases are held.
- Prove success/error/ambiguous-close ordering and zero surviving provider, application or build process.

### Companion package and release

- Deterministic companion layout with exact manifest/signature/addon hashes and no unexpected files.
- Authenticode verification, detached-manifest signature verification, protected read/execute-only user ACL and clean-machine Node-24 load.
- Application ASAR/resources/native layout and all existing executable/fuse checks remain byte-for-byte independent of the companion bundle.
- Package verifier reports separate application and coordinator subjects; neither hash is allowed to stand in for the other.
- Fresh formal Level 1 exercises every session/MCP command through the provider with stopped-redacted cleanup. Levels 2/3 remain separate.

## Rejected alternatives

| Alternative | Rejection reason |
| --- | --- |
| Put the addon in ASAR or application `resources/native` | Mixes QA trust with product runtime, invites Electron loading/ABI confusion and falsely suggests the application certificate covers the coordinator. |
| Search/glob/latest-build or CWD-relative discovery | Can select stale, wrong-configuration or attacker-placed artifacts. |
| Hash-only path check in a writable directory | Leaves replacement between observation and load; formal mode requires a signed manifest plus sealed bundle and post-load identity/hash agreement. |
| Automatic fallback to path/ACL rechecks | Reopens the exact TOCTOU interval this provider exists to close. |
| Load the audit artifact in coordinators | Retains diagnostic exports and an unnecessarily broad native surface. |
| Dedicated broker executable | Adds bearer-bearing IPC, process authentication, crash/restart and credential-transfer boundaries without a demonstrated need. |
| PowerShell, shell signature checks or undocumented NT/Zw APIs | Adds mutable interpreter/tool dependencies or weakens the documented Win32 boundary. |
| Auto-upgrade or rollback after failure | Converts integrity failure into implicit substitution and can act under a different provider identity. |

## Authorization boundary and next action

Production/source wiring, build-profile changes, coordinator-bundle staging/signing, package verification changes and formal QA remain pending user authorization. The recommended next action is an explicit approval or rejection of this companion-bundle and nested-lease design. If approved, the first implementation slice should be **manifest/signature/artifact-policy plus injected loader tests only**—no coordinator wiring, native build, package staging or application launch in that slice.
