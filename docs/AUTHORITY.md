# Authority and approval boundaries

An external agent has no ambient authority. A versioned policy can be installed for the lifetime of one engine process. No policy, expiry, runtime exhaustion, or a value outside the policy produces a visible approval job rather than an implicit grant.

The policy controls:

- Expiry and maximum runtime.
- Currency, total estimated spend, generation request count, and unknown-cost request count.
- Enabled provider/model allowlists.
- Canonicalized file read roots and write roots.
- Exact existing files that may be overwritten; a write-root grant alone does not grant overwrite.
- Stable plug-in ID allowlist.
- Separate microphone, MIDI input, and MIDI output permissions.

Microphone and MIDI permissions default to false. `--trust-folder` adds an absolute folder to both read and write roots but does not add any overwrite path, provider, plug-in, recording permission, or spend.

Unknown-cost requests, out-of-root paths, existing destinations not listed for overwrite, unlisted providers/models or plug-ins, recording, expired policies, and exhausted limits pause for approval. Approval decisions are `allow-once`, `allow-session`, `allow-always`, or `deny`; persistent policy editing is a user action and is not inferred from a one-time decision.

Approval jobs and their request details are owner-scoped on every public MCP tool/resource read. `aimuse://sessions` still exposes authenticated collaboration presence, but each reader sees only its own job summaries; `aimuse://jobs/{id}` treats a foreign ID exactly like a missing ID. MCP deliberately exposes no approval action: only a human in AIMuse can allow or deny. An out-of-root save therefore creates one owner-only waiting job and performs no write. A successful authorized save appends a destination-free actor-attributed `file.saved` audit record without adding undoable content history or exposing the destination through public observation.

An example process-lifetime policy is available at [authority-policy.example.json](authority-policy.example.json). Replace its paths and IDs before use. Provider credentials are user-supplied and encrypted with Electron `safeStorage`—Windows protected storage on Windows and a Keychain-backed boundary on macOS—and are not stored in projects or MCP connection files. Rotation/removal replaces the validated encrypted set atomically in the same directory so an interrupted write retains the known-good file and cleans its stage. If protected storage is unavailable or cannot encrypt/decrypt, AIMuse exposes only an unconfigured capability, sanitizes the failure and rejects generation before provider I/O. Provider diagnostics are also redacted against the active credential before a failed job can enter renderer or public MCP state. The Windows mock/headless contract is established; real macOS Keychain behavior remains unverified.

Chargeable generation has an additional invariant: AIMuse never silently changes providers, models, prompts, lyrics, or formats. It does not automatically retry a submitted request whose charge outcome is ambiguous.
