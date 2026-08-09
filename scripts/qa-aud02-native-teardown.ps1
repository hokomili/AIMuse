param(
  [Parameter(Mandatory = $true)][string]$RunRoot,
  [Parameter(Mandatory = $true)][string]$Workspace,
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [Parameter(Mandatory = $true)][string]$AudioExe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'qa-audited-native-process.ps1')

$expectedFiles = [ordered]@{
  'src\main\audio-engine.ts' = '1716AB8E4A18CAA0E031A5FC179799C8E5E992138737017F378B32ACE69A7643'
  'src\main\audio-child-lifecycle.ts' = 'D174A8026F5F4AAFA4F34C3A429FBE6673F7A6E02F934937DE9FDA82E4A46103'
  'src\main\audio-preview-lifecycle.ts' = 'E01584EF344432027188A3F3D6C1E6BB4B9D62CB5A6C4F1CC0CFCC134B32159C'
  'src\main\project-renderer.ts' = 'E7812D2BB4C7EACE7026112DF646C2819F322F665FC2BFAAF0EAD8186A86CF73'
  'src\main\persistence.ts' = 'A8C047C1727D661398E44B16A26226235397C64C54DD7F3338470FE4F1BFF968'
  'src\main\wav.ts' = '81C65A383FF5758155DEF097F9BC4CF3831B9DC98F0E14BA7B686D3217A2FCF0'
  'src\common\audio-protocol.ts' = '81BC81B88ECC542AEEA9515ADC285699C044476DC74B0F749C049328483B4650'
  'tests\native\audio-teardown.checkpoint.test.ts' = 'F42AB120419ADC90968639D91B915B004B8C408570B81CAAE72AA540AD07409A'
  'tests\main\audio-child-lifecycle.node.mjs' = '710E1A7E08F48933693496EDA1B3EB4D510D4D40FEE5690B881553C2A095FB03'
  'vitest.config.ts' = '6E39F9506C7816283024E09127F1357651436DA735A4988193216B2E8B79EDAD'
  'package.json' = '01AB22E847626725A04D5035CC65FDADE9A1883B10411E98BDA3E988B58017BC'
  'package-lock.json' = '3D0C2B432D667EF7BEA257A74A1B9F2A1534A6838EDB262C505822DBF583346A'
  'node_modules\vitest\vitest.mjs' = '39DB22F579ACF5639BBB17A261408DEBBDE03F4692C0C439E77E7F13AEBA74D6'
  'node_modules\vitest\package.json' = 'CAA41F04799BD42F3CFD100C4282E630D77FFC7DEB1E7E4927794FCB7F137F34'
  'node_modules\vitest\dist\chunks\cac.DdICfEr1.js' = '9516D4611B7F7CE624D66D41DE5EB67093AD6F95690D41CDDC8E1ED318E0A499'
  'scripts\qa-audited-native-process.ps1' = '8BD2EA81AC6F7FAAB5882364A454C02D64D1E7204C72318854624F94EF5CDAA2'
  'packages\core\src\authority.ts' = '454D55F56FDD2DF51B60EA570CB713B7C6E41DD7518E1E810C4127BB1EE070ED'
  'packages\core\src\defaults.ts' = '2020AAA1DE855792AA997C3898B065F39DEB47AFBFE6C8E98481F326ED4BB2BE'
  'packages\core\src\ids.ts' = 'F81D7BE8BF8AD09908568BC13A2908647D5E78DAE35AF3D340575513E2357AC5'
  'packages\core\src\index.ts' = 'F31DB4693141F61B976D35AE212BCEFA38419B01415C160F329C2099FBC3B8F0'
  'packages\core\src\migrations.ts' = '0C4E8D40D899CDDA096AF49E3BC4D963B7B32A9656AA4F671B873720E37BAB8C'
  'packages\core\src\model.ts' = '96A11125ABACFBD4E9D26AD54D22D701D9F3324FA47BE239EBB3D3DDFE716F82'
  'packages\core\src\operations.ts' = 'D1BBD4F3D49CDCD148A9F443FE8512A73481B5C85F48C56A771B79FD173C9C88'
  'packages\core\src\reducer.ts' = 'D1837112576D3574C3650AA09C435CDDD11B9AFAB52169BD4072F1BE4508B4D4'
  'packages\core\src\schemas.ts' = '157259CBE33AD8358C6478893471AA2B9D44460666DD453C9BC13863559D09B0'
  'packages\core\src\time.ts' = 'F74EEFEA4B1AF4DACF695A972A9A34A16B5D7AF6CF9DD6B65E13A0F6490EFB11'
}
$expectedNode = @{ sha256 = '63C259C81E5D472B5F11C8D506070130CB04A1ECF84B80377A34ED6EC9048088'; bytes = 91380224; version = '24.14.0' }
$expectedAudio = @{ sha256 = '5D99577D6920416F65F9C078597029AFD56C435F3EC016D7839EA869BDEF294B'; bytes = 1262080 }

function Get-Sha256Text([string]$Value) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { return (($algorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value)) | ForEach-Object { $_.ToString('x2') }) -join '').ToUpperInvariant() }
  finally { $algorithm.Dispose() }
}

function Get-RelevantProcesses {
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in @('AIMuse', 'electron', 'aimuse-audio') } | Sort-Object Id | ForEach-Object {
    [ordered]@{ name = $_.ProcessName; pid = $_.Id }
  })
}

function Get-DefaultRenderEndpointId {
  $null = [Windows.Media.Devices.MediaDevice, Windows.Media.Devices, ContentType = WindowsRuntime]
  $null = [Windows.Media.Devices.AudioDeviceRole, Windows.Media.Devices, ContentType = WindowsRuntime]
  return [Windows.Media.Devices.MediaDevice]::GetDefaultAudioRenderId([Windows.Media.Devices.AudioDeviceRole]::Default)
}

$workspacePath = [System.IO.Path]::GetFullPath($Workspace).TrimEnd('\')
$testResultsRoot = [System.IO.Path]::GetFullPath((Join-Path $workspacePath 'test-results')).TrimEnd('\')
$runRootPath = [System.IO.Path]::GetFullPath($RunRoot).TrimEnd('\')
if ([System.IO.Path]::GetDirectoryName($runRootPath) -ne $testResultsRoot) { throw 'Run root must be an exact direct child of the workspace test-results directory.' }
if (Test-Path -LiteralPath $runRootPath) { throw 'Run root must be absent; retained roots are never reused.' }

$sourceIdentities = [ordered]@{}
foreach ($entry in $expectedFiles.GetEnumerator()) {
  $path = Join-Path $workspacePath $entry.Key
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToUpperInvariant()
  if ($actual -ne $entry.Value) { throw "Frozen source identity mismatch: $($entry.Key)" }
  $sourceIdentities[$entry.Key] = $actual
}
$nodeItem = Get-Item -LiteralPath $NodeExe
$nodeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $NodeExe).Hash.ToUpperInvariant()
if ($nodeHash -ne $expectedNode.sha256 -or $nodeItem.Length -ne $expectedNode.bytes -or $nodeItem.VersionInfo.ProductVersion -ne $expectedNode.version) { throw 'Frozen Node executable identity mismatch.' }
$audioItem = Get-Item -LiteralPath $AudioExe
$audioHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $AudioExe).Hash.ToUpperInvariant()
if ($audioHash -ne $expectedAudio.sha256 -or $audioItem.Length -ne $expectedAudio.bytes) { throw 'Frozen audio executable identity mismatch.' }

$baselineProcesses = @(Get-RelevantProcesses)
if ($baselineProcesses.Count -ne 0) { throw 'Relevant AIMuse/Electron/audio processes must be absent before creating the retained run root.' }
$endpointBefore = Get-DefaultRenderEndpointId
if ([string]::IsNullOrWhiteSpace($endpointBefore)) { throw 'The Windows default render endpoint identity is unavailable.' }
$endpointBeforeHash = Get-Sha256Text $endpointBefore

$null = New-Item -ItemType Directory -Path $runRootPath
$preflight = [ordered]@{
  schemaVersion = 1
  runRootLeaf = [System.IO.Path]::GetFileName($runRootPath)
  sourceIdentities = $sourceIdentities
  node = @{ sha256 = $nodeHash; bytes = $nodeItem.Length; version = $nodeItem.VersionInfo.ProductVersion }
  audioExecutable = @{ sha256 = $audioHash; bytes = $audioItem.Length }
  endpoint = @{ acquisition = 'Windows.Media.Devices.MediaDevice.GetDefaultAudioRenderId(Default)'; sha256 = $endpointBeforeHash; characterCount = $endpointBefore.Length }
  processBaseline = $baselineProcesses
  networkAllowed = $false
  providerOrCredentialAccessAllowed = $false
  forceSignalOrCleanupAllowed = $false
}
$preflight | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runRootPath 'preflight.json') -Encoding UTF8

$runnerArguments = @(
  (Join-Path $workspacePath 'node_modules\vitest\vitest.mjs'),
  'run',
  'tests/native/audio-teardown.checkpoint.test.ts',
  '--config', 'vitest.config.ts',
  '--pool=threads',
  '--maxWorkers=1',
  '--no-file-parallelism'
)
$runnerExit = -1
$runnerPid = $null
$runnerStdout = ''
$runnerStderr = ''
$runnerFailure = $null
try {
  $runnerResult = Invoke-AuditedNativeProcess -Executable $NodeExe -Arguments $runnerArguments -WorkingDirectory $workspacePath -Environment @{
    AIMUSE_AUD02_RUN_ROOT = $runRootPath
    AIMUSE_AUD02_AUDIO_EXE = [System.IO.Path]::GetFullPath($AudioExe)
  }
  $runnerExit = $runnerResult.exitCode
  $runnerPid = $runnerResult.processId
  $runnerStdout = $runnerResult.stdout
  $runnerStderr = $runnerResult.stderr
} catch {
  $runnerFailure = $_.Exception.Message
  $runnerStderr = "Runner launch/capture failure: $runnerFailure`r`n"
}
$runnerStdout | Set-Content -LiteralPath (Join-Path $runRootPath 'runner-stdout.log') -Encoding UTF8
$runnerStderr | Set-Content -LiteralPath (Join-Path $runRootPath 'runner-stderr.log') -Encoding UTF8
(@('# stdout', $runnerStdout, '# stderr', $runnerStderr) -join "`r`n") | Set-Content -LiteralPath (Join-Path $runRootPath 'runner.log') -Encoding UTF8

$endpointAfterHash = $null
$endpointPostflightError = $null
try {
  $endpointAfter = Get-DefaultRenderEndpointId
  $endpointAfterHash = if ([string]::IsNullOrWhiteSpace($endpointAfter)) { $null } else { Get-Sha256Text $endpointAfter }
} catch { $endpointPostflightError = $_.Exception.Message }
$postflightProcesses = @(Get-RelevantProcesses)
$casePath = Join-Path $runRootPath 'native-case.json'
$nativeCase = $null
$nativeCaseReadError = $null
if (Test-Path -LiteralPath $casePath) {
  try { $nativeCase = Get-Content -LiteralPath $casePath -Raw | ConvertFrom-Json }
  catch { $nativeCaseReadError = $_.Exception.Message }
}
$allowedEntries = @('native-case.json', 'playback-root', 'preflight.json', 'retained-playback-root', 'runner.log', 'runner-stderr.log', 'runner-stdout.log')
$unexpectedEntries = @(Get-ChildItem -LiteralPath $runRootPath -Force | Where-Object { $_.Name -notin $allowedEntries } | Select-Object -ExpandProperty Name)

$passed = $null -eq $runnerFailure -and $runnerExit -eq 0 -and $null -eq $endpointPostflightError -and
  $null -eq $nativeCaseReadError -and $null -ne $nativeCase -and $nativeCase.status -eq 'PASS' -and
  $nativeCase.forceAttempted -eq $false -and $nativeCase.gracefulExitObserved -eq $true -and
  $nativeCase.playbackRootRenamed -eq $true -and $nativeCase.originalPlaybackRootAbsentAfterQuietWindow -eq $true -and
  $nativeCase.retainedManifestStable -eq $true -and $endpointAfterHash -eq $endpointBeforeHash -and
  $postflightProcesses.Count -eq 0 -and $unexpectedEntries.Count -eq 0

$summary = [ordered]@{
  schemaVersion = 1
  status = if ($passed) { 'PASS' } else { 'FAIL' }
  scope = 'AUD-02 native audio-service teardown and retained cache-quiescence checkpoint only'
  runner = @{ processId = $runnerPid; exitCode = $runnerExit; launchOrCaptureError = $runnerFailure; stdoutLog = 'runner-stdout.log'; stderrLog = 'runner-stderr.log' }
  sourceIdentitiesVerified = $true
  node = $preflight.node
  audioExecutable = $preflight.audioExecutable
  endpoint = @{ acquisition = $preflight.endpoint.acquisition; beforeSha256 = $endpointBeforeHash; afterSha256 = $endpointAfterHash; unchanged = $endpointAfterHash -eq $endpointBeforeHash; postflightError = $endpointPostflightError }
  nativeCase = $nativeCase
  nativeCaseReadError = $nativeCaseReadError
  processBaseline = $baselineProcesses
  processPostflight = $postflightProcesses
  unexpectedRunRootEntries = $unexpectedEntries
  automaticCleanupPerformed = $false
  forceOrSignalAuthorized = $false
  networkProviderCredentialActivityAuthorized = $false
}
$summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $runRootPath 'summary.json') -Encoding UTF8
$caseGracefulExit = if ($null -eq $nativeCase) { $false } else { $nativeCase.gracefulExitObserved }
$caseForceAttempted = if ($null -eq $nativeCase) { $false } else { $nativeCase.forceAttempted }
$caseRenamed = if ($null -eq $nativeCase) { $false } else { $nativeCase.playbackRootRenamed }
$caseStable = if ($null -eq $nativeCase) { $false } else { $nativeCase.retainedManifestStable }
$report = @(
  '# AUD-02 native teardown checkpoint',
  '',
  "Overall: **$($summary.status)**",
  '',
  '- Scope: one retained audio-service protocol/lifecycle case; no scanner, application or package.',
  "- Audio executable: $audioHash ($($audioItem.Length) bytes).",
  "- Runner exit: $runnerExit; launch/capture error: $runnerFailure.",
  "- Default endpoint identity unchanged: $($summary.endpoint.unchanged).",
  "- Graceful exit observed: $caseGracefulExit; force attempted: $caseForceAttempted.",
  "- Retained rename/quiet-window oracle: $caseRenamed / $caseStable.",
  "- Relevant postflight processes: $($postflightProcesses.Count).",
  '- Automatic cleanup: false. A survivor is reported by PID and left uncontrolled.'
) -join "`r`n"
$report | Set-Content -LiteralPath (Join-Path $runRootPath 'report.md') -Encoding UTF8
if (-not $passed) { exit 1 }
