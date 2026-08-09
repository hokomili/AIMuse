# AUD-02 native teardown checkpoint

Status: **PASS for this exact frozen AUD-02 native audio-service teardown/cache-quiescence scenario**. Retry 3 independently verified the corrected bounded natural-exit sequencing and retained-preview cache quiescence against the prior premature-fallback and `ENOTEMPTY` classes. This is source/helper/controller/audio-binary/scenario-bound acceptance only; it is not package, application, UI, scanner, exclusive-mode, endpoint-hot-plug, broader-audio or release acceptance.

## Frozen subject and root

- Accepted retained root: `E:\AIMuse\test-results\20260807T072744Z-aud02-native-teardown-retry3`, 1 directory / 8 files / 15,369,593 bytes / tree SHA-256 `FB13BA605A85A71A646465172FAB38514BD14E78CCA588CD20F888F1190A0172`. It is immutable and must not be rerun, reused or cleaned.
- Failed-attempt provenance: reserved absent root `E:\AIMuse\test-results\20260807T065519Z-aud02-native-teardown` used controller 10,602 bytes / SHA-256 `84AFB3755871A88B2FDC1DBCE0BED586D3B39B19484AA3C04C196B1C106E22FD`; it reached no endpoint, root creation, test or process launch.
- Retry-1 provenance: immutable root `E:\AIMuse\test-results\20260807T070957Z-aud02-native-teardown-retry1` contains only its independently reported 3,953-byte `preflight.json`; controller SHA-256 was `08BD83756B673784D4EFF4538A0F4758F14029EB04254723A823BC683403D93C`. It acquired only the hashed endpoint identity and reached no Node test, audio service or audible output.
- Retry-2 provenance: immutable root `E:\AIMuse\test-results\20260807T071750Z-aud02-native-teardown-retry2` is 1 directory / 8 files / 15,370,687 bytes with tree SHA-256 `2473550B5A04806D81290CFAC417D724D84DD462A66C7C9C45DE565827D05546`. Its evidence path worked. WASAPI shared output connected at 48 kHz, the 180 ms preview peak was `0.02121320366859436`, refresh was pending, and PID 26248 exited naturally with code 0 and no signal. It is FAIL because the blocked premature `kill()` attempt set `forceAttempted=true`; endpoint identity was unchanged, relevant postflight process count was zero, no survivor existed and no cleanup ran.
- Controller: `scripts\qa-aud02-native-teardown.ps1`.
- Selected test only: `tests\native\audio-teardown.checkpoint.test.ts`; no scanner test or broad collection.
- Node: `C:\Users\hokom\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`, 91,380,224 bytes, version 24.14.0, SHA-256 `63C259C81E5D472B5F11C8D506070130CB04A1ECF84B80377A34ED6EC9048088`.
- Audio service: `E:\AIMuse\native\build\aimuse-audio.exe`, 1,262,080 bytes, SHA-256 `5D99577D6920416F65F9C078597029AFD56C435F3EC016D7839EA869BDEF294B`.
- Corrected host source: `src\main\audio-engine.ts`, 23,979 bytes / SHA-256 `1716AB8E4A18CAA0E031A5FC179799C8E5E992138737017F378B32ACE69A7643`; pure exit policy `src\main\audio-child-lifecycle.ts`, 2,384 bytes / SHA-256 `D174A8026F5F4AAFA4F34C3A429FBE6673F7A6E02F934937DE9FDA82E4A46103`; retained preview quiescence helper `src\main\audio-preview-lifecycle.ts` SHA-256 `E01584EF344432027188A3F3D6C1E6BB4B9D62CB5A6C4F1CC0CFCC134B32159C`.
- The controller embeds and verifies the complete selected source/config/core/Vitest hash set before creating the run root. ABI, packages and prior evidence are not rebuilt or modified.

- Controller: 12,118 bytes, SHA-256 `DD59D0468E62E5956A1DE933E67D73F240E20A29E1D677FF707D9E00F70E0236`.
- Audited native-process helper: 1,659 bytes, SHA-256 `8BD2EA81AC6F7FAAB5882364A454C02D64D1E7204C72318854624F94EF5CDAA2`.
- Selected test: 10,987 bytes, SHA-256 `F42AB120419ADC90968639D91B915B004B8C408570B81CAAE72AA540AD07409A`.
- Pure shutdown regression: 3,925 bytes, SHA-256 `710E1A7E08F48933693496EDA1B3EB4D510D4D40FEE5690B881553C2A095FB03`.
- Windows PowerShell 5.1 controller regression: 5,399 bytes, SHA-256 `9FB050A3F391DB86FFA7718F55A852CF34D6275B977C01C5AE9FDB36457B4219`.
- Frozen Vitest CAC option definition: 96,007 bytes, SHA-256 `9516D4611B7F7CE624D66D41DE5EB67093AD6F95690D41CDDC8E1ED318E0A499`.

A hash mismatch aborts before endpoint acquisition, root creation or process launch.

## Exact executed command

The Secretary independently audited and executed this command exactly once under the real launching user. It must not be rerun:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File E:\AIMuse\scripts\qa-aud02-native-teardown.ps1 -RunRoot E:\AIMuse\test-results\20260807T072744Z-aud02-native-teardown-retry3 -Workspace E:\AIMuse -NodeExe C:\Users\hokom\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe -AudioExe E:\AIMuse\native\build\aimuse-audio.exe
```

This was not an `npm` command. The controller invoked the frozen Vitest CLI with exactly one test file, `--pool=threads`, `--maxWorkers=1` and `--no-file-parallelism`. Static inspection of the exact installed CAC definitions proved those options exist and `minWorkers` does not. The retained run must not be split, retried or extended with another test.

Both nullable relevant-process assignments and the unexpected-entry assignment are explicitly array-bound at their call sites. `scripts\qa-aud02-controller-collections-regression.ps1` parses the exact controller and proves under Windows PowerShell 5.1 that the three `.Count` receivers remain zero-length arrays when their producers return no object.

Launch-free proof command:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File E:\AIMuse\scripts\qa-aud02-controller-collections-regression.ps1 -ControllerPath E:\AIMuse\scripts\qa-aud02-native-teardown.ps1 -VitestCliChunkPath E:\AIMuse\node_modules\vitest\dist\chunks\cac.DdICfEr1.js
```

Preparation result: PASS under Windows PowerShell `5.1.26100.8875`; baseline-process, postflight-process and unexpected-entry counts were all exactly zero and remained array-backed. Benign stderr was captured separately with exit 0 and stdout intact; an intentional stderr case returned exit 7 without throwing or losing its diagnostic. The exact controller contains no merged `2>&1` native invocation and no unsupported `minWorkers` option.

The new lifecycle regression imports only Node assertion/events/filesystem/test modules and `src\main\audio-child-lifecycle.ts`; it never imports the controller, child-process API, native code or a device/runtime entry point. The exact launch-free command below passes 4/4 under pinned Node 24.14.0. It proves that an acknowledged shutdown remains pending without force until natural exit, a true survivor reaches fallback only after 1,500 ms, a lost protocol response still allows natural exit during the grace window, listeners are removed, and the controller source awaits the helper rather than retaining its immediate-kill branch.

```powershell
C:\Users\hokom\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe --experimental-strip-types --test --test-isolation=none tests/main/audio-child-lifecycle.node.mjs
```

## Accepted result

- Frozen source/controller/Node/audio identities all matched.
- WASAPI shared output connected at 48 kHz; the 180 ms preview peak was `0.02121320366859436` and the second-revision refresh was observed pending.
- Exact audio PID 26876 exited naturally with code 0 and no signal; `forceAttempted=false`.
- The playback root renamed to retained evidence, the original stayed absent for the 2,000 ms quiet window, and the retained manifest remained byte-identical.
- Default endpoint hash was unchanged; relevant process baseline/postflight and unexpected-entry counts were zero.
- No automatic cleanup, network, provider, credential, force or signal authority was used.

These facts close the prior `ENOTEMPTY` and premature-fallback race classes for this exact subject and scenario only.

## Device and audibility boundary

Immediately before root creation, the controller reads the Windows default render endpoint ID using the documented WinRT `Windows.Media.Devices.MediaDevice.GetDefaultAudioRenderId(Default)` call. Evidence retains its uppercase SHA-256 and character count, not the raw endpoint ID. The same call after the test must produce the same hash. The frozen audio executable uses miniaudio's default WASAPI shared float32 endpoint; it requests no explicit alternate endpoint.

Expected device impact:

- open the current default render endpoint once in WASAPI shared mode at 48 kHz and a 256-frame requested period;
- play one 440 Hz managed-preview note for 180 ms at MIDI velocity 0.25, with rendered per-channel peak required between 0.005 and 0.05 before the user's existing system/device volume;
- do not change system volume, mute, endpoint default, endpoint format, exclusive state, enhancement, power, driver or device configuration;
- release the shared endpoint through protocol `shutdown` and a natural audio-service exit.

The run is expected to be briefly audible. Secretary authorization must therefore confirm the endpoint hash acquisition, that shared playback is safe at the user's current volume, and that no recording/input device is involved.

## Process and no-force boundary

The controller uses `Get-Process`, never CIM, for exact-name baseline/postflight observations of only `AIMuse`, `electron` and `aimuse-audio`. All must be absent at baseline. The selected test records the Node host PID and audio child PID.

Production `stop()` sends the protocol shutdown request with its existing 1,500 ms request timeout, then awaits the exact child's natural `exit` for a further bounded 1,500 ms. A natural exit suppresses fallback. If the response fails or the acknowledged child genuinely survives the grace window, the existing `ChildProcess.kill()` fallback remains, so ordinary production survivors are still managed. Startup and unexpected-error degradation retain their pre-existing immediate recovery behavior.

Vitest hoists a test-owned wrapper around the `node:child_process` import used by `AudioEngineController`: real `spawn` remains allowed for the one audio executable, while every `ChildProcess.kill()` call is replaced with a counter-only rejection. Therefore no signal or force termination can occur even on startup, shutdown or error paths. A fallback attempt makes the run FAIL. The test allows 3,000 ms for its independent PID-bound natural-exit observation; on timeout it records the survivor PID, unreferences parent-side event-loop handles only, and leaves the process uncontrolled. The checkpoint never stops, kills, signals or manages a survivor.

## ENOTEMPTY and retention oracle

The test creates only `<run-root>\playback-root`, renders and reads its WAV, commits a second revision, proves a refresh task is active, and then calls the corrected `controller.stop()`. After natural audio-child exit it:

1. hashes a relative-name/size/SHA-256 manifest of the run-owned playback root;
2. renames that directory once, within the same retained parent, to `retained-playback-root`;
3. observes a 2,000 ms quiet window;
4. requires the original path to remain absent and the retained manifest to remain byte-identical.

This detects an open/late producer without deleting anything. The renamed playback directory, WAV and all evidence remain retained. On any failure, whichever checkpoint-owned paths exist remain in place; there is no automatic cleanup, retry, rollback or reuse.

## Evidence and oracles

Allowed top-level evidence is `preflight.json`, `runner.log`, `runner-stdout.log`, `runner-stderr.log`, `native-case.json`, `summary.json`, `report.md`, and exactly one of `playback-root` or `retained-playback-root`. `System.Diagnostics.Process` captures stdout and stderr independently, and a nonzero runner exit is data rather than a PowerShell terminating error. Runner launch/capture failure, nonzero exit, endpoint-postflight failure or malformed/missing native case still proceeds through log, process/endpoint postflight, summary and report creation. Evidence contains fixed case/phase fields, hashes, sizes, PIDs, booleans and sanitized errors; it contains no provider, bearer, credential, user project or network data.

PASS requires all of the following:

- every frozen source/tool/executable identity matches before launch;
- baseline relevant-process count is zero;
- native status is connected WASAPI shared output and the bounded preview peak/rate checks pass;
- the second revision's refresh is observed active when stop begins;
- `controller.stop()` observes the protocol-driven natural exit before settling, no `kill()` attempt occurs, and PID-bound exit code 0 with no signal is confirmed within 3,000 ms;
- retained same-parent rename succeeds, the original playback path stays absent for 2,000 ms and the retained manifest stays identical;
- endpoint identity is unchanged, no unexpected run-root entry exists and relevant postflight process count is zero.

Retry 3 satisfied every oracle above. Its PASS is not permission to rerun, force, clean, broaden or reinterpret another subject.

## Prohibited boundaries

No application, Electron, package, scanner, recording input, provider, credential, network, paid call, Computer Use, CIM, desktop input, native compiler/build/rebuild, package staging, cleanup, commit, publish or deployment is part of this command. The frozen Vitest CLI performs only its normal in-memory TypeScript transform for the one selected test/source graph. The command must not read, reuse or remove any prior temporary directory, retained run or incident artifact. The QA-10 companion proposal and provider remain unchanged and pending their separate decision.
