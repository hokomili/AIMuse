# Authority and approval boundaries

An external agent has no ambient authority. AIMuse can install one versioned policy for the lifetime of an engine process. Missing policy, expiry, runtime exhaustion, or an operation outside policy produces either an owner-scoped approval job or an explicit refusal—never an implicit grant.

The policy controls:

- Expiry and maximum runtime.
- Canonicalized file read roots and write roots.
- Exact existing files that may be overwritten; a write-root grant alone does not grant overwrite.
- Stable plug-in ID allowlist.
- Separate microphone, MIDI input, and MIDI output permissions.

`--trust-folder` adds an absolute folder to both read and write roots but does not add an overwrite path, plug-in, recording, or MIDI permission. Microphone and MIDI permissions default to false.

Native Open, Save As, unpack, import, and export panels receive a fresh absolute starting path for every engine session. A contextual project or pack directory is retained only when it belongs to a current launch-trusted or applicable policy root; otherwise the launch-trusted root takes priority, followed by a policy root. An ordinary unbounded launch uses the current project directory or the user's Documents folder. macOS file-panel history therefore cannot silently supply authority from an older session; navigating to another location in the native panel remains an explicit human choice.

Out-of-root paths, existing destinations not listed for overwrite, unlisted plug-ins, recording, expired policies, and exhausted runtime can pause for approval where the tool supports approval. Decisions are `allow-once`, `allow-session`, `allow-always`, or `deny`; persistent policy editing remains a user action and is not inferred from a one-time decision.

Approval jobs and their request details are owner-scoped on every public MCP tool/resource read. `aimuse://sessions` exposes authenticated collaboration presence, but each reader sees only its own job summaries; `aimuse://jobs/{id}` treats a foreign ID exactly like a missing ID. MCP deliberately exposes no approval action: only a human in AIMuse can allow or deny. An out-of-root save therefore creates one owner-only waiting job and performs no write. A successful authorized save appends a destination-free actor-attributed `file.saved` audit record without adding undoable content history or exposing the destination through public observation.

An example process-lifetime policy is available at [authority-policy.example.json](authority-policy.example.json). Replace its paths and IDs before use.

`--authority-policy=<absolute path>` accepts UTF-8 JSON with or without a leading byte-order mark (BOM), including BOM-prefixed output from Windows PowerShell. Both application startup and the headless runtime use the same reader. Malformed JSON reports the policy filename and encoding guidance; schema validation, expiry and permission checks still apply.

## MCP authority lifetime

Every engine start creates a fresh random 32-byte MCP bearer. Empty or malformed values are never authority. Each request captures the current authority/admission generation; POST requests revalidate it after the complete body read and immediately before allocation or transport handling. Stop synchronously closes admission, advances that generation, then discards the bearer. A slow request authenticated before stop and any request reaching the still-closing listener during pending-session cleanup therefore receive only the authentication rejection once shutdown begins. Authority is not loaded from or written to an AIMuse credential store. The installed application requires no Keychain, DPAPI, libsecret, Electron `safeStorage`, or equivalent persistent protected-secret backend.

After the authenticated listener is ready, `EngineRuntime` atomically publishes one ephemeral run-state record below the profile's AIMuse-owned private directory. It binds the bearer to the current PID, engine instance, profile identity, URL and start time. POSIX owner/mode and Windows protected-ACL checks fail closed; linked, malformed, stale, wrong-profile, dead-process or authenticated-health-mismatched state is never authority. Clean stop unlinks only the exact current record before closing the listener, and a dead-PID crash residue is useless and replaceable once that engine dies. If the recorded PID is still alive but authenticated identity does not match or cannot be verified, publication fails closed instead of guessing that the record is stale.

The renderer and preload expose neither bearer nor direct URL. Client-specific onboarding displays a static stdio command containing only the product executable, `--mcp-bridge`, and the stable target engine profile; AIMuse never modifies client configuration and the snippet never supplies Chromium browser state. The real entry derives a deterministic sibling, creates only that final directory, rejects link/reparse/case or filesystem-identity aliases, revalidates it around `app.setPath`, prohibits macOS activation, and uses only the target path for private run-state discovery. The bridge authenticates health/MCP, recovers same-session notification EOF/error on the next client message, reinitializes against fresh engine authority after restart, and DELETEs a session whose initialization completes after bridge close. These entry semantics are source-tested; installed-package no-flash/runtime-contention remains a separate gate. An explicit `--write-mcp-connection=<absolute path>` remains test-harness coordination only and must stay in its formal owner-private/redacted evidence boundary; it is not durable product-client setup. The persisted preferred port and profile identities are non-secret and cannot authenticate.

## Removed authority domains

AIMuse has no built-in generative-content provider, provider/model allowlist, spending or generation budget, provider credential surface, or generation approval kind. External agents remain free to use capabilities under their own authority outside AIMuse and then import ordinary media through the controlled file boundary.

Legacy project generation-provenance records are accepted only to keep existing files readable. Their fields are not credentials or authority. Supported UI/MCP transactions cannot create, update, or delete them, and checkpoint restore plus snapshot undo/redo preserve the currently opened map and generation-source assets rather than installing divergent historical values. No compatibility path can invoke a provider or become an executable request.
