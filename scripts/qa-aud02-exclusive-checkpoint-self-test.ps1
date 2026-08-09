param(
  [Parameter(Mandatory = $true)][string]$PlanPath,
  [Parameter(Mandatory = $true)][string]$ControllerPath,
  [Parameter(Mandatory = $true)][string]$DeviceRunnerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
  throw 'Checkpoint self-test must run under Windows PowerShell 5.1.'
}

$planFullPath = [System.IO.Path]::GetFullPath($PlanPath)
$controllerFullPath = [System.IO.Path]::GetFullPath($ControllerPath)
$runnerFullPath = [System.IO.Path]::GetFullPath($DeviceRunnerPath)
$planHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $planFullPath).Hash.ToUpperInvariant()
$plan = Get-Content -LiteralPath $planFullPath -Raw | ConvertFrom-Json
if ($plan.schemaVersion -ne 1) { throw 'Unexpected checkpoint plan schema.' }
$workspacePath = [System.IO.Path]::GetFullPath($plan.workspace).TrimEnd('\')
$runRootPath = [System.IO.Path]::GetFullPath($plan.runRoot).TrimEnd('\')
$testResultsRoot = [System.IO.Path]::GetFullPath((Join-Path $workspacePath 'test-results')).TrimEnd('\')
if ([System.IO.Path]::GetDirectoryName($runRootPath) -ne $testResultsRoot) { throw 'Planned run root is not an exact direct child of test-results.' }
if (Test-Path -LiteralPath $runRootPath) { throw 'Planned run root must remain absent during launch-free preparation.' }

$verifiedSourceCount = 0
foreach ($property in $plan.sourceFiles.PSObject.Properties) {
  $path = Join-Path $workspacePath $property.Name
  $item = Get-Item -LiteralPath $path
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToUpperInvariant()
  if ($hash -ne $property.Value.sha256 -or $item.Length -ne $property.Value.bytes) { throw "Plan source identity mismatch: $($property.Name)" }
  ++$verifiedSourceCount
}
$verifiedToolCount = 0
foreach ($property in $plan.tools.PSObject.Properties) {
  $item = Get-Item -LiteralPath $property.Value.path
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $property.Value.path).Hash.ToUpperInvariant()
  if ($hash -ne $property.Value.sha256 -or $item.Length -ne $property.Value.bytes) { throw "Plan tool identity mismatch: $($property.Name)" }
  if ($property.Value.productVersion -and $item.VersionInfo.ProductVersion -ne $property.Value.productVersion) { throw "Plan tool version mismatch: $($property.Name)" }
  ++$verifiedToolCount
}

$tokens = $null
$parseErrors = $null
$controllerAst = [System.Management.Automation.Language.Parser]::ParseFile($controllerFullPath, [ref]$tokens, [ref]$parseErrors)
$parseErrors = @($parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Checkpoint controller has PowerShell parser errors.' }
$controllerSource = $controllerAst.Extent.Text
$runnerSource = Get-Content -LiteralPath $runnerFullPath -Raw

foreach ($required in @(
  "[ValidateSet('Build', 'Device')]", 'ExpectedPlanSha256', 'ExpectedBuildSummarySha256', 'ExpectedAudioSha256',
  "Join-Path `$runRootPath 'native-build'", "Join-Path `$runRootPath 'dependencies'", 'FETCHCONTENT_UPDATES_DISCONNECTED=ON',
  "'aimuse-audio', 'aimuse-native-tests'", "'^aimuse-native-dsp$'", 'Get-RunRootIdentity', 'Configured native build selection changed',
  '$baselineProcesses = @(Get-RelevantProcesses)', '$postflightProcesses = @(Get-RelevantProcesses)',
  'GetDefaultAudioRenderId', 'Device evidence already exists', 'forceOrSignalAuthorized = $false',
  'automaticCleanupPerformed = $false'
)) {
  if (-not $controllerSource.Contains($required)) { throw "Checkpoint controller guard is missing: $required" }
}
foreach ($forbidden in @(
  'E:\AIMuse\native\build', 'Remove-Item', 'Stop-Process', 'taskkill', '.Kill(', 'Start-Process',
  'connection.json', 'rename-visibility.json', 'identity-01-target.dat', 'aimuse-playback-contract-5uarYE'
)) {
  if ($controllerSource.Contains($forbidden)) { throw "Checkpoint controller contains a prohibited boundary: $forbidden" }
}
$deviceMarker = $controllerSource.IndexOf("if (-not (Test-Path -LiteralPath `$runRootPath -PathType Container))")
$endpointInvocation = $controllerSource.LastIndexOf('Get-DefaultRenderEndpointId')
if ($deviceMarker -lt 0 -or $endpointInvocation -lt $deviceMarker) { throw 'Endpoint acquisition is not confined to the device phase.' }

foreach ($required in @(
  "mode === 'exclusive' ? ['--stdio', '--playback-mode=exclusive'] : ['--stdio']", 'spawn(audioExecutable, arguments_',
  'shell: false', 'process.chdir(deviceRoot)', 'requestedPlaybackMode', 'effectivePlaybackMode',
  'wasapi-exclusive-opt-in', 'precise-rejection', 'maximumAudibleDurationMs: 360',
  "await client.request('shutdown'", 'detachSurvivor(child)', 'forceAttempted: false'
)) {
  if (-not $runnerSource.Contains($required)) { throw "Device runner contract is missing: $required" }
}
foreach ($forbidden in @('.kill(', "from 'node:http'", "from 'node:https'", "from 'node:net'", "from 'node:tls'", 'fetch(', 'WebSocket')) {
  if ($runnerSource.Contains($forbidden)) { throw "Device runner contains a prohibited control/network surface: $forbidden" }
}
if (([regex]::Matches($runnerSource, [regex]::Escape('spawn(audioExecutable, arguments_'))).Count -ne 1) { throw 'Device runner must have exactly one audio spawn surface.' }

function Invoke-EmptyProducer { return }
$baselineProcesses = @(Invoke-EmptyProducer)
$postflightProcesses = @(Invoke-EmptyProducer)
$unexpectedEntries = @(@() | Where-Object { $_ -eq 'never' })
if ($baselineProcesses -isnot [System.Array] -or $baselineProcesses.Count -ne 0) { throw 'Empty baseline process result is not an array.' }
if ($postflightProcesses -isnot [System.Array] -or $postflightProcesses.Count -ne 0) { throw 'Empty postflight process result is not an array.' }
if ($unexpectedEntries -isnot [System.Array] -or $unexpectedEntries.Count -ne 0) { throw 'Empty unexpected-entry result is not an array.' }

$powershellPath = $plan.tools.powershell.path
$expectedBuildTemplate = "$powershellPath -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $controllerFullPath -Phase Build -RunRoot $runRootPath -Workspace $workspacePath -PlanPath $planFullPath -ExpectedPlanSha256 <PLAN_SHA256>"
$expectedDeviceTemplate = "$powershellPath -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $controllerFullPath -Phase Device -RunRoot $runRootPath -Workspace $workspacePath -PlanPath $planFullPath -ExpectedPlanSha256 <PLAN_SHA256> -ExpectedBuildSummarySha256 <BUILD_SUMMARY_SHA256> -ExpectedAudioSha256 <AUDIO_SHA256>"
if ($plan.commands.buildTemplate -ne $expectedBuildTemplate) { throw 'Frozen build command template changed.' }
if ($plan.commands.deviceTemplate -ne $expectedDeviceTemplate) { throw 'Frozen device command template changed.' }
if ($plan.build.generator -ne 'Visual Studio 18 2026' -or $plan.build.platformToolset -ne 'v145' -or $plan.build.windowsSdkVersion -ne '10.0.26100.0') {
  throw 'Frozen compiler/generator/SDK selection changed.'
}
if ($plan.dependency.miniaudioRevision -ne '9634bedb5b5a2ca38c1ee7108a9358a4e233f14d') { throw 'Frozen miniaudio revision changed.' }

[ordered]@{
  status = 'PASS'
  powershell = $PSVersionTable.PSVersion.ToString()
  planSha256 = $planHash
  runRoot = $runRootPath
  runRootAbsent = $true
  sourceIdentitiesVerified = $verifiedSourceCount
  toolIdentitiesVerified = $verifiedToolCount
  controllerParsed = $true
  buildAndDeviceCommandsBound = $true
  zeroProcessCollectionsArrayBound = $true
  endpointAcquisitionConfinedToDevicePhase = $true
  nativeBuildOrServiceExecuted = $false
  endpointAccessed = $false
  filesystemMutationPerformed = $false
} | ConvertTo-Json -Depth 4
