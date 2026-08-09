# Security policy

AIMuse is pre-release software. Do not use this alpha as the sole copy of important recordings or grant it broad autonomous filesystem, recording, plug-in, or provider authority.

## Security boundaries

- The Electron renderer is sandboxed with context isolation, no Node integration, a narrow preload API, navigation/window denial, CSP, ASAR integrity enforcement, and hardened Electron fuses.
- MCP listens only on loopback and requires a protected bearer token. Treat `--write-mcp-connection` output as a secret.
- Autonomous access is deny-by-default and limited by a process-lifetime `AuthorityPolicy`.
- Media bytes enter through controlled import, provider, recording contract, or render jobs. Project operations do not accept inline bytes.
- Project extraction rejects absolute/traversal paths, excessive entry counts, excessive total size and unsafe compression ratios.
- Provider credentials use Electron `safeStorage` (Windows protected storage today; a Keychain-backed boundary is declared but unverified on macOS) and are not written to project files.
- Root-local MCP connection, coordinator, profile and retained QA evidence is never source. The initial Git snapshot must use the allowlist in `docs/INITIAL_COMMIT.md`, never a repository-root wildcard.
- Third-party plug-ins are intended to run outside the canonical engine process. The current alpha does not yet provide production SDK-backed hosting; do not interpret its process shells as a completed sandbox.

Use narrow read/write roots, an empty overwrite list, no microphone permission, a small spend budget, and explicit provider/model and plug-in allowlists. Stop the engine when an autonomous session is complete.

Report a suspected vulnerability privately to the repository owner with the affected build, reproduction steps and impact. Do not include bearer tokens, provider keys, private audio, or project archives in a public report.

## Known alpha audit status

As of 2026-08-04, `npm audit --omit=dev` reports zero high or critical production findings and two moderate entries. Both trace to `@modelcontextprotocol/node@2.0.0` depending on `@hono/node-server@^1.19.9`, whose separately exported `serve-static` middleware has a Windows encoded-backslash traversal advisory. AIMuse imports only the adapter's root `getRequestListener` path and does not register `serve-static`, but the dependency remains present and npm reports no compatible upstream fix. Removing that residual finding through an upstream-compatible MCP update is a pre-v1 release gate; this repository does not force an unsupported major override.
