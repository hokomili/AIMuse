param(
  [Parameter(Mandatory = $true)][ValidateSet('Build', 'Device')][string]$Phase,
  [Parameter(Mandatory = $true)][string]$RunRoot,
  [Parameter(Mandatory = $true)][string]$Workspace,
  [Parameter(Mandatory = $true)][string]$PlanPath,
  [Parameter(Mandatory = $true)][string]$ExpectedPlanSha256,
  [string]$ExpectedBuildSummarySha256,
  [string]$ExpectedAudioSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'qa-audited-native-process.ps1')

function Get-Sha256Text([string]$Value) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { return (($algorithm.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value)) | ForEach-Object { $_.ToString('x2') }) -join '').ToUpperInvariant() }
  finally { $algorithm.Dispose() }
}

function Get-FileIdentity([string]$Path) {
  $item = Get-Item -LiteralPath $Path
  return [ordered]@{
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToUpperInvariant()
    bytes = $item.Length
    productVersion = $item.VersionInfo.ProductVersion
  }
}

function Write-NewUtf8([string]$Path, [string]$Value) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  $bytes = $encoding.GetBytes($Value)
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length) }
  finally { $stream.Dispose() }
}

function Write-NewJson([string]$Path, $Value, [int]$Depth = 12) {
  Write-NewUtf8 $Path (($Value | ConvertTo-Json -Depth $Depth) + "`n")
}

function Sanitize([string]$Value, [string]$WorkspacePath, [string]$RunRootPath) {
  if ([string]::IsNullOrEmpty($Value)) { return $Value }
  return $Value.Replace($RunRootPath, '<run-root>').Replace($WorkspacePath, '<workspace>')
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

function Assert-PlannedIdentities($Plan, [string]$WorkspacePath) {
  $verifiedSources = [ordered]@{}
  foreach ($property in $Plan.sourceFiles.PSObject.Properties) {
    $path = Join-Path $WorkspacePath $property.Name
    $identity = Get-FileIdentity $path
    if ($identity.sha256 -ne $property.Value.sha256 -or $identity.bytes -ne $property.Value.bytes) {
      throw "Frozen source identity mismatch: $($property.Name)"
    }
    $verifiedSources[$property.Name] = $identity
  }
  $verifiedTools = [ordered]@{}
  foreach ($property in $Plan.tools.PSObject.Properties) {
    $identity = Get-FileIdentity $property.Value.path
    if ($identity.sha256 -ne $property.Value.sha256 -or $identity.bytes -ne $property.Value.bytes) {
      throw "Frozen toolchain identity mismatch: $($property.Name)"
    }
    if ($property.Value.productVersion -and $identity.productVersion -ne $property.Value.productVersion) {
      throw "Frozen toolchain version mismatch: $($property.Name)"
    }
    $verifiedTools[$property.Name] = $identity
  }
  return [ordered]@{ sources = $verifiedSources; tools = $verifiedTools }
}

function Invoke-LoggedNativeProcess(
  [string]$Name,
  [string]$Executable,
  [string[]]$Arguments,
  [string]$WorkingDirectory,
  [string]$EvidenceDirectory,
  [hashtable]$Environment = @{}
) {
  $result = Invoke-AuditedNativeProcess -Executable $Executable -Arguments $Arguments -WorkingDirectory $WorkingDirectory -Environment $Environment
  Write-NewUtf8 (Join-Path $EvidenceDirectory "$Name.stdout.log") $result.stdout
  Write-NewUtf8 (Join-Path $EvidenceDirectory "$Name.stderr.log") $result.stderr
  if ($result.exitCode -ne 0) { throw "$Name exited with code $($result.exitCode)." }
  return [ordered]@{ processId = $result.processId; exitCode = $result.exitCode; stdoutLog = "$Name.stdout.log"; stderrLog = "$Name.stderr.log" }
}

function Get-RunRootIdentity($Plan, [string]$RunRootPath, [string]$WorkspacePath) {
  $nodePath = $Plan.tools.node.path
  $runnerPath = Join-Path $WorkspacePath 'scripts\qa-aud02-exclusive-device.mjs'
  $result = Invoke-AuditedNativeProcess -Executable $nodePath -Arguments @($runnerPath, '--identity-only', '--run-root', $RunRootPath) -WorkingDirectory $WorkspacePath
  if ($result.exitCode -ne 0) { throw 'Run-root identity helper failed.' }
  return $result.stdout | ConvertFrom-Json
}

$workspacePath = [System.IO.Path]::GetFullPath($Workspace).TrimEnd('\')
$runRootPath = [System.IO.Path]::GetFullPath($RunRoot).TrimEnd('\')
$planFullPath = [System.IO.Path]::GetFullPath($PlanPath)
$testResultsRoot = [System.IO.Path]::GetFullPath((Join-Path $workspacePath 'test-results')).TrimEnd('\')
if ([System.IO.Path]::GetDirectoryName($runRootPath) -ne $testResultsRoot) { throw 'Run root must be an exact direct child of the workspace test-results directory.' }
$actualPlanHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $planFullPath).Hash.ToUpperInvariant()
if ($actualPlanHash -ne $ExpectedPlanSha256.ToUpperInvariant()) { throw 'Frozen checkpoint plan identity mismatch.' }
$plan = Get-Content -LiteralPath $planFullPath -Raw | ConvertFrom-Json
if ($plan.schemaVersion -ne 1 -or $plan.workspace -ne $workspacePath -or $plan.runRoot -ne $runRootPath) { throw 'Checkpoint plan paths or schema do not match the exact command.' }
$verifiedIdentities = Assert-PlannedIdentities $plan $workspacePath
$baselineProcesses = @(Get-RelevantProcesses)
if ($baselineProcesses.Count -ne 0) { throw 'Relevant AIMuse/Electron/audio processes must be absent before checkpoint work.' }

if ($Phase -eq 'Build') {
  if (Test-Path -LiteralPath $runRootPath) { throw 'Build run root must be absent; retained roots are never reused.' }
  $null = New-Item -ItemType Directory -Path $runRootPath
  $buildEvidence = Join-Path $runRootPath 'build-evidence'
  $nativeBuild = Join-Path $runRootPath 'native-build'
  $dependencyRoot = Join-Path $runRootPath 'dependencies'
  $null = New-Item -ItemType Directory -Path $buildEvidence
  $status = 'FAIL'
  $failure = $null
  $phaseName = 'preflight'
  $rootIdentity = $null
  $configure = $null
  $cmakeCache = $null
  $dependency = $null
  $build = $null
  $nativeTest = $null
  $audioExecutable = $null
  $nativeTestExecutable = $null
  try {
    $rootIdentity = Get-RunRootIdentity $plan $runRootPath $workspacePath
    $phaseName = 'configure'
    $configureEnvironment = @{
      CMAKE_GENERATOR = $plan.build.generator
      PATH = "$([System.IO.Path]::GetDirectoryName($plan.tools.git.path));$($env:PATH)"
    }
    $configureArguments = @(
      '--fresh', '-S', (Join-Path $workspacePath 'native'), '-B', $nativeBuild,
      '-A', 'x64', '-T', $plan.build.platformToolset,
      '-DCMAKE_BUILD_TYPE=RelWithDebInfo', "-DCMAKE_SYSTEM_VERSION=$($plan.build.windowsSdkVersion)",
      '-DAIMUSE_FETCH_AUDIO_DEPS=ON', '-DAIMUSE_ENABLE_WASAPI=ON',
      '-DAIMUSE_ENABLE_PLUGIN_SDKS=OFF', '-DAIMUSE_BUILD_QA_PRIVATE_ROOT_PROVIDER=OFF',
      "-DFETCHCONTENT_BASE_DIR=$dependencyRoot", '-DFETCHCONTENT_UPDATES_DISCONNECTED=ON'
    )
    $configure = Invoke-LoggedNativeProcess 'configure' $plan.tools.cmake.path $configureArguments $workspacePath $buildEvidence $configureEnvironment
    $cachePath = Join-Path $nativeBuild 'CMakeCache.txt'
    $cacheText = Get-Content -LiteralPath $cachePath -Raw
    foreach ($requiredCacheValue in @(
      "CMAKE_GENERATOR:INTERNAL=$($plan.build.generator)",
      'CMAKE_GENERATOR_PLATFORM:INTERNAL=x64',
      "CMAKE_GENERATOR_TOOLSET:INTERNAL=$($plan.build.platformToolset)",
      'AIMUSE_FETCH_AUDIO_DEPS:BOOL=ON', 'AIMUSE_ENABLE_WASAPI:BOOL=ON',
      'AIMUSE_ENABLE_PLUGIN_SDKS:BOOL=OFF', 'AIMUSE_BUILD_QA_PRIVATE_ROOT_PROVIDER:BOOL=OFF'
    )) {
      if (-not $cacheText.Contains($requiredCacheValue)) { throw "Configured native build selection changed: $requiredCacheValue" }
    }
    if (-not $cacheText.Contains($plan.build.windowsSdkVersion)) { throw 'Configured Windows SDK selection changed.' }
    $cmakeCache = [ordered]@{
      identity = Get-FileIdentity $cachePath
      generator = $plan.build.generator
      architecture = 'x64'
      platformToolset = $plan.build.platformToolset
      windowsSdkVersion = $plan.build.windowsSdkVersion
      wasapiEnabled = $true
      pluginSdksEnabled = $false
      privateRootProviderEnabled = $false
    }

    $phaseName = 'dependency-identity'
    $miniaudioRoot = Join-Path $dependencyRoot 'miniaudio-src'
    $gitResult = Invoke-LoggedNativeProcess 'miniaudio-revision' $plan.tools.git.path @('-C', $miniaudioRoot, 'rev-parse', 'HEAD') $workspacePath $buildEvidence
    $gitRevision = (Get-Content -LiteralPath (Join-Path $buildEvidence $gitResult.stdoutLog) -Raw).Trim().ToLowerInvariant()
    if ($gitRevision -ne $plan.dependency.miniaudioRevision) { throw 'Fetched miniaudio revision does not match the frozen dependency lock.' }
    $miniaudioHeader = Get-FileIdentity (Join-Path $miniaudioRoot 'miniaudio.h')
    $dependency = [ordered]@{ revision = $gitRevision; header = $miniaudioHeader }

    $phaseName = 'build'
    $build = Invoke-LoggedNativeProcess 'build' $plan.tools.cmake.path @('--build', $nativeBuild, '--config', 'RelWithDebInfo', '--target', 'aimuse-audio', 'aimuse-native-tests', '--parallel') $workspacePath $buildEvidence
    $phaseName = 'native-unit-test'
    $nativeTest = Invoke-LoggedNativeProcess 'native-unit-test' $plan.tools.ctest.path @('--test-dir', $nativeBuild, '-C', 'RelWithDebInfo', '--output-on-failure', '-R', '^aimuse-native-dsp$') $workspacePath $buildEvidence

    $phaseName = 'artifact-identity'
    $audioPath = Join-Path $nativeBuild 'aimuse-audio.exe'
    $nativeTestPath = Join-Path $nativeBuild 'aimuse-native-tests.exe'
    $audioExecutable = Get-FileIdentity $audioPath
    $audioExecutable['relativePath'] = 'native-build\aimuse-audio.exe'
    $nativeTestExecutable = Get-FileIdentity $nativeTestPath
    $nativeTestExecutable['relativePath'] = 'native-build\aimuse-native-tests.exe'
    $status = 'PASS'
  } catch {
    $failure = Sanitize $_.Exception.Message $workspacePath $runRootPath
  }
  $postflightProcesses = @(Get-RelevantProcesses)
  $allowedEntries = @('build-evidence', 'dependencies', 'native-build')
  $unexpectedEntries = @(Get-ChildItem -LiteralPath $runRootPath -Force | Where-Object { $_.Name -notin $allowedEntries } | Select-Object -ExpandProperty Name)
  if ($postflightProcesses.Count -ne 0 -or $unexpectedEntries.Count -ne 0) { $status = 'FAIL' }
  $summary = [ordered]@{
    schemaVersion = 1
    status = $status
    phase = $phaseName
    scope = 'AUD-02 exclusive-WASAPI build and native-unit checkpoint only; no service or endpoint execution'
    planSha256 = $actualPlanHash
    rootIdentity = $rootIdentity
    sourceAndToolIdentitiesVerified = $true
    verifiedIdentities = $verifiedIdentities
    configure = $configure
    cmakeCache = $cmakeCache
    dependency = $dependency
    build = $build
    nativeUnitTest = $nativeTest
    audioExecutable = $audioExecutable
    nativeTestExecutable = $nativeTestExecutable
    processBaseline = $baselineProcesses
    processPostflight = $postflightProcesses
    unexpectedRunRootEntries = $unexpectedEntries
    failure = $failure
    automaticCleanupPerformed = $false
    serviceOrEndpointAccessed = $false
    networkScope = 'Pinned miniaudio Git revision fetch during configure only'
    providerCredentialPaidActivityAuthorized = $false
  }
  Write-NewJson (Join-Path $buildEvidence 'summary.json') $summary
  $nativeTestExit = if ($null -eq $nativeTest) { 'not-run' } else { [string]$nativeTest.exitCode }
  $audioHashText = if ($null -eq $audioExecutable) { 'not-produced' } else { [string]$audioExecutable.sha256 }
  Write-NewUtf8 (Join-Path $buildEvidence 'report.md') ((@(
    '# AUD-02 exclusive native build checkpoint', '', "Overall: **$status**", '',
    "- Phase: $phaseName", "- Failure: $failure", "- Native unit test: $nativeTestExit",
    "- Audio SHA-256: $audioHashText", "- Relevant postflight processes: $($postflightProcesses.Count)",
    '- Service/endpoint execution: false.', '- Automatic cleanup: false.'
  ) -join "`r`n") + "`r`n")
  if ($status -ne 'PASS') { exit 1 }
  exit 0
}

if (-not (Test-Path -LiteralPath $runRootPath -PathType Container)) { throw 'Device phase requires the retained build root.' }
$runRootItem = Get-Item -LiteralPath $runRootPath -Force
if (($runRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Retained run root must not be a reparse point.' }
if ([string]::IsNullOrWhiteSpace($ExpectedBuildSummarySha256) -or [string]::IsNullOrWhiteSpace($ExpectedAudioSha256)) {
  throw 'Device phase requires exact build-summary and audio-executable SHA-256 values.'
}
$buildSummaryPath = Join-Path $runRootPath 'build-evidence\summary.json'
$actualBuildSummaryHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $buildSummaryPath).Hash.ToUpperInvariant()
if ($actualBuildSummaryHash -ne $ExpectedBuildSummarySha256.ToUpperInvariant()) { throw 'Retained build-summary identity mismatch.' }
$buildSummary = Get-Content -LiteralPath $buildSummaryPath -Raw | ConvertFrom-Json
if ($buildSummary.status -ne 'PASS' -or $buildSummary.audioExecutable.sha256 -ne $ExpectedAudioSha256.ToUpperInvariant()) { throw 'Device subject is not the exact accepted build output.' }
$currentRootIdentity = Get-RunRootIdentity $plan $runRootPath $workspacePath
if ($currentRootIdentity.device -ne $buildSummary.rootIdentity.device -or $currentRootIdentity.inode -ne $buildSummary.rootIdentity.inode -or
    $currentRootIdentity.canonicalPathSha256 -ne $buildSummary.rootIdentity.canonicalPathSha256) {
  throw 'Retained run-root identity changed after the build phase.'
}
if ($buildSummary.audioExecutable.relativePath -ne 'native-build\aimuse-audio.exe') { throw 'Build summary audio path is not the frozen run-owned output.' }
$audioPath = [System.IO.Path]::GetFullPath((Join-Path $runRootPath $buildSummary.audioExecutable.relativePath))
if (-not $audioPath.StartsWith($runRootPath + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Audio executable escaped the retained run root.' }
$audioIdentity = Get-FileIdentity $audioPath
if ($audioIdentity.sha256 -ne $ExpectedAudioSha256.ToUpperInvariant() -or $audioIdentity.bytes -ne $buildSummary.audioExecutable.bytes) {
  throw 'Audio executable changed after the build phase.'
}
$deviceEvidence = Join-Path $runRootPath 'device-evidence'
if (Test-Path -LiteralPath $deviceEvidence) { throw 'Device evidence already exists; device phase is exactly once and never reused.' }
$preDeviceEntries = @(Get-ChildItem -LiteralPath $runRootPath -Force | Select-Object -ExpandProperty Name)
$expectedPreDeviceEntries = @('build-evidence', 'dependencies', 'native-build')
if ([string]::Join('|', @($preDeviceEntries | Sort-Object)) -ne [string]::Join('|', @($expectedPreDeviceEntries | Sort-Object))) {
  throw 'Retained build root contains an unexpected top-level entry before device execution.'
}
$endpointBefore = Get-DefaultRenderEndpointId
if ([string]::IsNullOrWhiteSpace($endpointBefore)) { throw 'The Windows default render endpoint identity is unavailable.' }
$endpointBeforeHash = Get-Sha256Text $endpointBefore
$null = New-Item -ItemType Directory -Path $deviceEvidence
$status = 'FAIL'
$failure = $null
$runner = $null
try {
  $runner = Invoke-LoggedNativeProcess 'device-runner' $plan.tools.node.path @(
    (Join-Path $workspacePath 'scripts\qa-aud02-exclusive-device.mjs'), '--device',
    '--run-root', $deviceEvidence, '--audio-exe', $audioPath, '--expected-audio-sha256', $ExpectedAudioSha256.ToUpperInvariant()
  ) $workspacePath $deviceEvidence
  $status = 'PASS'
} catch {
  $failure = Sanitize $_.Exception.Message $workspacePath $runRootPath
}
$endpointAfterHash = $null
$endpointPostflightError = $null
try {
  $endpointAfter = Get-DefaultRenderEndpointId
  if (-not [string]::IsNullOrWhiteSpace($endpointAfter)) { $endpointAfterHash = Get-Sha256Text $endpointAfter }
} catch { $endpointPostflightError = Sanitize $_.Exception.Message $workspacePath $runRootPath }
$postflightProcesses = @(Get-RelevantProcesses)
$casePath = Join-Path $deviceEvidence 'device-case.json'
$nativeCase = $null
$caseReadError = $null
if (Test-Path -LiteralPath $casePath) {
  try { $nativeCase = Get-Content -LiteralPath $casePath -Raw | ConvertFrom-Json }
  catch { $caseReadError = Sanitize $_.Exception.Message $workspacePath $runRootPath }
}
$allowedDeviceEntries = @('aud02-exclusive-probe.wav', 'device-case.json', 'device-runner.stderr.log', 'device-runner.stdout.log')
$unexpectedDeviceEntries = @(Get-ChildItem -LiteralPath $deviceEvidence -Force | Where-Object { $_.Name -notin $allowedDeviceEntries } | Select-Object -ExpandProperty Name)
$passed = $status -eq 'PASS' -and $null -ne $nativeCase -and $nativeCase.status -eq 'PASS' -and
  $nativeCase.forceAttempted -eq $false -and $endpointAfterHash -eq $endpointBeforeHash -and
  $postflightProcesses.Count -eq 0 -and $unexpectedDeviceEntries.Count -eq 0 -and $null -eq $endpointPostflightError -and $null -eq $caseReadError
$summary = [ordered]@{
  schemaVersion = 1
  status = if ($passed) { 'PASS' } else { 'FAIL' }
  scope = 'AUD-02 default-shared plus explicit-exclusive endpoint checkpoint only'
  planSha256 = $actualPlanHash
  buildSummarySha256 = $actualBuildSummaryHash
  runRootIdentity = $currentRootIdentity
  audioExecutable = $audioIdentity
  endpoint = @{ acquisition = 'Windows.Media.Devices.MediaDevice.GetDefaultAudioRenderId(Default)'; beforeSha256 = $endpointBeforeHash; afterSha256 = $endpointAfterHash; unchanged = $endpointAfterHash -eq $endpointBeforeHash; postflightError = $endpointPostflightError }
  runner = $runner
  nativeCase = $nativeCase
  nativeCaseReadError = $caseReadError
  processBaseline = $baselineProcesses
  processPostflight = $postflightProcesses
  unexpectedDeviceEntries = $unexpectedDeviceEntries
  failure = $failure
  maximumAudibleDurationMs = 360
  automaticCleanupPerformed = $false
  forceOrSignalAuthorized = $false
  networkProviderCredentialPaidActivityAuthorized = $false
}
Write-NewJson (Join-Path $deviceEvidence 'summary.json') $summary
Write-NewUtf8 (Join-Path $deviceEvidence 'report.md') ((@(
  '# AUD-02 exclusive native device checkpoint', '', "Overall: **$($summary.status)**", '',
  "- Failure: $failure", "- Endpoint identity unchanged: $($summary.endpoint.unchanged)",
  "- Relevant postflight processes: $($postflightProcesses.Count)",
  '- Default shared and explicit exclusive/rejection results are in device-case.json.',
  '- Maximum generated audible duration: 360 ms.', '- Force/signal/cleanup: not authorized.'
) -join "`r`n") + "`r`n")
if (-not $passed) { exit 1 }
