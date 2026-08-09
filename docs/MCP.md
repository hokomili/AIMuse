# Authenticated MCP interface

AIMuse binds only to `127.0.0.1` on a private port in the `48300–48331` range. Every MCP request requires `Authorization: Bearer <token>`. Tokens are random, stored with Windows protected storage, compared in constant time, and never accepted in a URL. The health endpoint is intentionally non-sensitive.

Start a private headless engine with an absolute connection-file path:

```powershell
AIMuse.exe --headless --write-mcp-connection=C:\private\aimuse-mcp.json --authority-policy=C:\private\authority.json
```

The caller must create the parent as an owner-only operating-system directory before launch. On Windows, remove inherited broad-group access and retain only the launching user, SYSTEM and Administrators; Node's `0o600` creation mode is not a substitute for that ACL. General QA coordination requires this existing directory explicitly as `--private-root` for session start/MCP initialization and every follow-up. Coordinator manifest/state persist only its non-secret canonical filesystem identity; follow-ups reject ACL, link, containment or directory-object drift before bearer, request or evidence activity. Re-read the connection after every restart because the protected localhost bearer may rotate.

The atomic connection file has this shape:

```json
{
  "version": 1,
  "url": "http://127.0.0.1:48000/mcp",
  "token": "private bearer token",
  "activeProjectId": "project_...",
  "pid": 1234,
  "instanceId": "11111111-1111-4111-8111-111111111111",
  "profileId": "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
  "trustedFolders": []
}
```

`instanceId` is a fresh non-secret UUID for one engine process. `profileId` is a non-secret SHA-256 identity for the normalized local user-data path; the raw profile path is not exposed by health. QA coordination binds connection, health, manifest, show, stop and redaction evidence to these identities before touching a process or requesting a window.

## Client setup

The editor’s **Agents → Connect an external agent** flow has first-class profiles for Codex, Claude Code, OpenCode and Antigravity, plus a generic Streamable HTTP profile. Automatic setup always shows a native confirmation before writing. It names the target configuration, explains that the private bearer will be stored there, creates a timestamped backup when the file already exists, and replaces only the `aimuse` MCP entry. Unrelated settings and MCP servers are preserved; malformed JSON/JSONC is rejected without overwriting the file. A successful automatic setup also enables the headless AIMuse engine at sign-in.

| Client | User configuration written | AIMuse entry |
| --- | --- | --- |
| Codex | `$CODEX_HOME/config.toml` or `~/.codex/config.toml` | `[mcp_servers.aimuse]` with `url` and an Authorization `http_headers` value |
| Claude Code | `~/.claude.json` | `mcpServers.aimuse` with `type: "http"`, `url`, and Authorization header |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json[c]` or `~/.config/opencode/opencode.json[c]` | Stable `mcp.aimuse`, or `mcp.servers.aimuse` when that V2 wrapper already exists; comments and sibling servers remain |
| Antigravity | `~/.gemini/config/mcp_config.json` | `mcpServers.aimuse` with `serverUrl` and Authorization header |

The generic profile performs no file write and instead displays exact `transport: "streamable-http"`, URL, and header settings for copying. Treat every generated client config or snippet as a credential-bearing file, and restart or reconnect the selected client after setup.

## Health and show acknowledgement

The unauthenticated, non-sensitive `/health` response includes a bounded `showAcknowledgements` array. Each record contains only a fresh show-request UUID, `pending`/`accepted`/`rejected` state, PID, engine `instanceId`, hashed `profileId`, timestamps, attempt count and—when rejected—a fixed reason. It never contains the bearer token, raw profile path, MCP session ID or project data. Pending and recent terminal records are never evicted to admit another request; ledger saturation rejects the new request, while expired terminal records may be pruned.

A receiver inserts `pending` before starting window work, then publishes `accepted` only after that exact instance/profile-bound request completes. A wrong or malformed binding is rejected; a duplicate request poisons the record as rejected rather than allowing either caller to claim success. The QA coordinator requires the request ID to be absent before launch, treats helper exit zero only as permission to poll, accepts exactly one timely same-generation acknowledgement, and re-probes the unchanged acknowledgement plus PID/health identity before setting `windowRequested`. Missing, pending-at-deadline, rejected, stale, late, duplicate or malformed evidence fails closed without a manifest update.

Clients initialize standard stateful Streamable HTTP MCP, retain the returned `mcp-session-id`, then call `session_manage.join` to provide their display name and client/model metadata. The server supports at most 32 concurrent sessions and releases capacity on MCP `DELETE`.

Cold clients do not need repository documentation. Initialize returns concise cross-tool instructions; `tools/list` exposes described inputs/outputs plus action-specific `oneOf` branches for conditional requiredness; every incomplete or job-returning call includes explicit `next` guidance. Call `aimuse_help` for focused workflow/privacy topics. Clients that support resources can additionally read the complete `aimuse://guide`, but correctness never depends on instructions, prompts or resources being rendered.

## Tools

| Tool | Actions |
| --- | --- |
| `aimuse_help` | Focused getting-started, tool-contract, project/edit, job/approval, file/audit, collaboration, and resource guidance |
| `session_manage` | Join, inspect presence/locks, update cursor/range, leave |
| `project_manage` | List, new, activate, open, save, close, checkpoint, branch, compare, merge, discard, pack, unpack |
| `project_observe` | Snapshot/diff and optional editor selection, transport, locks, and observation references |
| `project_apply` | Granular idempotent operations with direct, checkpointed, or branch commit mode |
| `transport_manage` | Status, play, pause, stop, seek, loop, and policy-gated recording |
| `history_manage` | Actor-scoped undo/redo |
| `media_manage` | List, controlled import, analyze, audition, consolidate, or configured separation |
| `plugin_manage` | Catalog, authority-gated scan/instantiate, parameter/preset, bypass, remove |
| `generation_manage` | Capabilities, start, inspect, accept, reject, explicit variation |
| `export_manage` | Master, stems, MIDI, DAWproject, SFX batch, or portable pack |
| `job_manage` | List, inspect, bounded wait, cancel, and approval dependency |

`project_apply` accepts at most 512 operations and never accepts server-owned asset, provenance, checkpoint, or variant registration operations. Use the corresponding media, generation, or project tool instead.

Direct and branch `project_apply` calls pass through four shared admission lanes. Queued work is served round-robin by authenticated actor, with at most four queued transactions per actor and a global queued cost of 2,048 operations. Overflow returns `status: "busy"` with `actor_queue_full` or `global_queue_full`, a bounded retry delay, queue depths and explicit next-step guidance; it does not mutate the project. Closing an MCP session cancels that actor’s queued work, while **Stop agents** cancels matching queued project work. Already-running reducer commits are not preempted, and the project service continues to serialize commits to the same project. Other domain-tool mutations have not yet been moved behind this admission layer.

Active human entity and timeline-range locks are enforced before an authenticated agent transaction is reduced. A conflicting `project_apply` returns `status: "locked"` with the fixed human-edit message and `conflict.retryable: true`, leaves the project unchanged, and includes `conflict.entityId` only when the lock identifies one. Unrelated operations remain eligible to commit while the lock is held.

Public job data is owner-scoped at every tool and resource boundary. A session cannot list, inspect, wait on, obtain an approval dependency for, cancel, vary, accept or reject another authenticated actor's job. `aimuse://sessions` retains shared authenticated presence but filters job summaries to the exact reader; `aimuse://jobs/{id}` and job-oriented tools make a foreign ID indistinguishable from a missing ID. Waiting summaries may include approval request details only for the owner.

MCP exposes no approval action. A waiting job's `next` field says that a human must review it in AIMuse and suggests a bounded owner-only `job_manage wait`; helper exit, polling or a successful MCP call never grants authority. An out-of-root save creates only that owner job and performs no file write.

A successful `project_manage save` carries the server-authenticated actor through the save boundary and returns a `file.saved` audit record. The same destination-free record is atomically retained in `activity/file-audit.jsonl` and can be requested with `project_observe.includeFileAudit`. It contains only event version/ID/type, project ID, actor, timestamp and `succeeded`; it is separate from reducer activity/transaction trace, does not increment revision, does not create an undo step and never publishes the destination or approval request.

## Resources

- `aimuse://projects`
- `aimuse://sessions`
- `aimuse://plugins`
- `aimuse://guide`
- `aimuse://projects/{id}/manifest`
- `aimuse://projects/{id}/snapshot`
- `aimuse://projects/{id}/changes/{revision}`
- `aimuse://projects/{id}/trace`
- `aimuse://jobs/{id}`
- `aimuse://projects/{projectId}/media/{assetId}` for bounded analysis/audition assets only

Project commits emit resource-updated notifications for manifest, snapshot, and revision changes. Observation blobs are capped at 64 MiB. Inline agent-supplied audio is intentionally absent from every schema.
