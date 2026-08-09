# AIMuse QA report

## Result

- Overall: `PASS | FAIL | BLOCKED`
- Level: `1 | 2 | 3`
- Run ID:
- Started/finished UTC:
- Tester model:
- Tester reasoning effort:
- Report path:

## Subject and environment

- Test subject/change:
- Source revision and dirty/untracked summary:
- Node/npm versions:
- Windows/display/audio/MIDI details:
- Executable path and SHA-256:
- App version/window title:
- Isolated profile:
- Initially active project ID/name:

## Build and engine identity preflight

| Assertion | Result | Evidence without credentials |
| --- | --- | --- |
| Node runtime is 24.x | | |
| Post-package executable/native/fuse verifier passed | | |
| Native process launched outside filesystem sandbox | | |
| QA session status is `okay: true` | | |
| Manifest PID equals connection PID and live process | | |
| Manifest hash equals current executable hash | | |
| Computer Use app path equals manifest executable | | |
| Agents/Activity MCP URL equals manifest/client URL | | |

## Automated gate

| Command | Result | Duration | Evidence/notes |
| --- | --- | ---: | --- |
| `node scripts/npm-node24.mjs run test:levelN:auto` | Pass/Fail/Blocked | | |

## MCP cases

| Case | Result | Project/revision | Evidence/notes |
| --- | --- | --- | --- |
| Authentication/session | | | |
| Observe/resources | | | |
| Apply/idempotency | | | |
| Actor undo/redo | | | |
| Level-specific cases | | | |

## Computer Use UI cases

| Case | Result | Expected | Actual/visual evidence |
| --- | --- | --- | --- |
| Window selection/render health | | | |
| Native menu/dialog/focus | | | |
| Timeline/piano-roll/mixer/SFX pointer action | | | |
| Panels/tabs/transport/status | | | |
| Level-specific cases | | | |

## Cross-surface assertions

| Direction | Result | Evidence |
| --- | --- | --- |
| MCP → visible UI | | |
| Computer Use UI → MCP state | | |

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
- QA projects saved/closed safely:
- Isolated engine stopped and PID absent:
- Remaining QA and pre-existing processes listed separately:
- Evidence retained and cleanup warnings:

## Final gate decision

State why the level passed, failed or was blocked and name the exact next action.

