# AUD-02 exclusive WASAPI native checkpoint

Status: **PASS FOR THE EXACT NATIVE SCENARIO**. The independently audited Build and Device phases each ran exactly once and retained their evidence. AUD-02 remains Partial because this does not cover package/app/UI, endpoint contention/rejection, hot-plug or the wider audio graph.

## Frozen plan and root

- Plan: `scripts\qa-aud02-exclusive-native-plan.json`, SHA-256 `3F3F85F8A603728B2FF8C9579650A83F2DEA372D365D271018921543A055E6C7`.
- Retained root: `E:\AIMuse\test-results\20260807T194500Z-aud02-exclusive-native-acceptance`, device `3698481203`, inode `1125899908201929`, canonical-path SHA-256 `1F5C2790…C3D1`.
- Launch-free self-test proved the then-absent root, all 19 source/controller inputs and 14 toolchain/SDK inputs, bound commands, empty process arrays and device-phase-only endpoint access before authorization.
- Build and device evidence is immutable and retained without cleanup or reuse.

The plan freezes CMake/CTest 4.2.3-msvc3, Visual Studio 18/MSBuild 18.4, MSVC 14.50.35717 (`cl`/`link` 14.50.35728), platform toolset `v145`, Windows SDK 10.0.26100.0 headers/libraries, Git, PowerShell 5.1, Node 24.14.0, every native source/test/config hash and miniaudio 0.11.25 revision `9634bedb5b5a2ca38c1ee7108a9358a4e233f14d`.

## Launch-free self-test

Executed during preparation only:

```powershell
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File E:\AIMuse\scripts\qa-aud02-exclusive-checkpoint-self-test.ps1 -PlanPath E:\AIMuse\scripts\qa-aud02-exclusive-native-plan.json -ControllerPath E:\AIMuse\scripts\qa-aud02-exclusive-native-checkpoint.ps1 -DeviceRunnerPath E:\AIMuse\scripts\qa-aud02-exclusive-device.mjs
```

Result: PASS under Windows PowerShell `5.1.26100.8875`; run root absent; 19/19 source identities and 14/14 tool identities verified; controller parsed; process/root/command guards passed; no native build/service, endpoint, network or filesystem mutation occurred. Pinned Node `--check` also passed for the device runner.

## Phase 1: build and native unit verification — PASS

The exact authorized whole command completed with exit code 0:

```powershell
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File E:\AIMuse\scripts\qa-aud02-exclusive-native-checkpoint.ps1 -Phase Build -RunRoot E:\AIMuse\test-results\20260807T194500Z-aud02-exclusive-native-acceptance -Workspace E:\AIMuse -PlanPath E:\AIMuse\scripts\qa-aud02-exclusive-native-plan.json -ExpectedPlanSha256 3F3F85F8A603728B2FF8C9579650A83F2DEA372D365D271018921543A055E6C7
```

The granted boundary was limited to:

- run the whole command outside the filesystem sandbox under the real launching user because MSBuild/Windows SDK access may otherwise invalidate it;
- create only the absent retained root and its `build-evidence`, `dependencies` and `native-build` children;
- permit outbound Git HTTPS only for CMake FetchContent to clone the frozen miniaudio repository/revision into the run root; no other network destination or dependency is authorized;
- invoke only frozen PowerShell, Node identity-only mode, CMake, Git, MSBuild/compiler/linker children, CTest and `aimuse-native-tests.exe`;
- configure `Visual Studio 18 2026`, x64, `v145`, Windows SDK 10.0.26100.0, RelWithDebInfo, WASAPI ON, plug-in SDKs/private-root provider OFF;
- build only `aimuse-audio` and `aimuse-native-tests`, then run only CTest case `aimuse-native-dsp` (pure DSP/callback/parser coverage; it constructs no playback device);
- do not launch `aimuse-audio.exe`, enumerate/acquire an endpoint, use app/package/UI/Computer Use, signal a process or clean any output.

The independently accepted result is build summary SHA-256 `BE465730CFC157BCA798604B3AAB6702E703A8C3BA1E70459CF34D1FF51EA547`; `aimuse-audio.exe` is 1,275,904 bytes / `651BF50F604A52F8E847CDDCEED11A382A62D6661A7D2A9B7D1E6823BA4FD1A7`; `aimuse-native-tests.exe` is 1,200,640 bytes / `596DDEDF406CA2B4EF0EF25E31CD1D8E1A2C37492E795EB56A7AB53DCC5A6062`. CTest passed 1/1. Generator/toolset/SDK, pinned miniaudio revision/header, stable root, empty process baseline/postflight, expected entries and no service/endpoint execution all passed.

## Phase 2: default-shared and explicit-exclusive endpoint acceptance — PASS

The exact independently authorized command used the accepted hashes:

```powershell
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File E:\AIMuse\scripts\qa-aud02-exclusive-native-checkpoint.ps1 -Phase Device -RunRoot E:\AIMuse\test-results\20260807T194500Z-aud02-exclusive-native-acceptance -Workspace E:\AIMuse -PlanPath E:\AIMuse\scripts\qa-aud02-exclusive-native-plan.json -ExpectedPlanSha256 3F3F85F8A603728B2FF8C9579650A83F2DEA372D365D271018921543A055E6C7 -ExpectedBuildSummarySha256 BE465730CFC157BCA798604B3AAB6702E703A8C3BA1E70459CF34D1FF51EA547 -ExpectedAudioSha256 651BF50F604A52F8E847CDDCEED11A382A62D6661A7D2A9B7D1E6823BA4FD1A7
```

The device permission was limited to:

- hash the default render endpoint ID before and after (raw ID is never retained);
- launch only the exact accepted audio executable, one child at a time, first with `--stdio`, then with `--stdio --playback-mode=exclusive`;
- create one retained stereo float32 48 kHz probe: 440 Hz, peak 0.02, 180 ms;
- play 180 ms in shared mode and, only if exclusive starts successfully, another 180 ms in exclusive mode (maximum generated audible duration 360 ms before existing system/device volume);
- make no volume, mute, endpoint-default, endpoint-format, enhancement, driver, power or input/recording change;
- send protocol shutdown exactly once per child and wait 3,000 ms for natural code-0/no-signal exit;
- never kill, signal, force, retry, clean or control a survivor; retain its PID and leave it uncontrolled;
- use no network, provider, credential, paid call, application, package, browser, Computer Use or unrelated-process control.

The retained result passed the success branch in both cases. Shared PID 15528 and exclusive PID 10268 each reported matching requested/effective WASAPI mode, played the fixed 180 ms probe and exited naturally code 0/no signal. Endpoint hash `64D342DC…EE159` was unchanged; process baseline/postflight and unexpected entries were empty; fallback, force, network, settings changes and cleanup were absent. Device summary SHA-256 is `558B04F08C51931E405461A3FF912BC4DAE97458DB80AFE073C81D04FEB1211E`; case evidence is `D3E3600F823F2218575D3CE9B198070736E202C51A2EF4AD5CF63BABACAB451F`.

## Retention and certificate boundary

Build and device evidence is append-only within the one run root; no automatic cleanup, retry, overwrite or root reuse exists. Build phase permits only the pinned miniaudio fetch; device phase is offline. This checkpoint can earn native scenario evidence only. It does not certify a package, app, UI, endpoint selection/hot-plug, wider audio graph, release, recording, MIDI, plug-ins, PDC, meters or xruns. Existing package/report certificates remain hash-scoped and unchanged.
