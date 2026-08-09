param(
  [Parameter(Mandatory = $true)][string]$ControllerPath,
  [Parameter(Mandatory = $true)][string]$VitestCliChunkPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
  throw 'This regression must run under Windows PowerShell 5.1.'
}

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ControllerPath, [ref]$tokens, [ref]$parseErrors)
$parseErrors = @($parseErrors)
if ($parseErrors.Count -ne 0) { throw 'The controller has PowerShell parser errors.' }
$source = $ast.Extent.Text
$vitestCliSource = Get-Content -LiteralPath $VitestCliChunkPath -Raw

$requiredArrayAssignments = [ordered]@{
  baselineProcesses = '\$baselineProcesses\s*=\s*@\(Get-RelevantProcesses\)'
  postflightProcesses = '\$postflightProcesses\s*=\s*@\(Get-RelevantProcesses\)'
  unexpectedEntries = '\$unexpectedEntries\s*=\s*@\(Get-ChildItem'
}
foreach ($entry in $requiredArrayAssignments.GetEnumerator()) {
  if ($source -notmatch $entry.Value) { throw "Controller collection assignment is not array-bound: $($entry.Key)" }
}

$countMembers = @($ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.MemberExpressionAst] -and $node.Member.Value -eq 'Count'
}, $true) | ForEach-Object { $_.Expression.Extent.Text } | Sort-Object -Unique)
$expectedCountMembers = @('$baselineProcesses', '$postflightProcesses', '$unexpectedEntries')
$actualCountSurface = [string]::Join('|', @($countMembers | Sort-Object))
$expectedCountSurface = [string]::Join('|', @($expectedCountMembers | Sort-Object))
if ($actualCountSurface -ne $expectedCountSurface) {
  throw "Unexpected .Count collection surface: $($countMembers -join ', ')"
}

foreach ($requiredControllerText in @('Invoke-AuditedNativeProcess', 'runner-stdout.log', 'runner-stderr.log', '--pool=threads', '--maxWorkers=1', '--no-file-parallelism')) {
  if (-not $source.Contains($requiredControllerText)) { throw "Corrected runner contract is missing: $requiredControllerText" }
}
foreach ($forbiddenControllerText in @('& $NodeExe', '2>&1', '--minWorkers')) {
  if ($source.Contains($forbiddenControllerText)) { throw "Unsafe or unsupported runner contract remains: $forbiddenControllerText" }
}
foreach ($requiredCliText in @('pool:', 'maxWorkers:', 'fileParallelism:', 'Use `--no-file-parallelism` to disable')) {
  if (-not $vitestCliSource.Contains($requiredCliText)) { throw "Installed Vitest CLI contract is missing: $requiredCliText" }
}
if ($vitestCliSource.Contains('minWorkers:')) { throw 'The installed Vitest CLI unexpectedly declares minWorkers; re-audit the frozen argument set.' }

function Invoke-EmptyProducer { return }
$baselineProcesses = @(Invoke-EmptyProducer)
$postflightProcesses = @(Invoke-EmptyProducer)
$unexpectedEntries = @(@() | Where-Object { $_ -eq 'never' })
if ($baselineProcesses -isnot [System.Array] -or $baselineProcesses.Count -ne 0) { throw 'The empty baseline-process result is not a zero-length array.' }
if ($postflightProcesses -isnot [System.Array] -or $postflightProcesses.Count -ne 0) { throw 'The empty postflight-process result is not a zero-length array.' }
if ($unexpectedEntries -isnot [System.Array] -or $unexpectedEntries.Count -ne 0) { throw 'The empty unexpected-entry result is not a zero-length array.' }

$helperPath = Join-Path (Split-Path -Parent $ControllerPath) 'qa-audited-native-process.ps1'
. $helperPath
$powershellExe = Join-Path $PSHOME 'powershell.exe'
$workingDirectory = Split-Path -Parent (Split-Path -Parent $ControllerPath)
function ConvertTo-EncodedCommand([string]$Command) {
  return [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
}

$benignStderr = Invoke-AuditedNativeProcess -Executable $powershellExe -WorkingDirectory $workingDirectory -Arguments @(
  '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  (ConvertTo-EncodedCommand "[Console]::Out.WriteLine('stdout-ok'); [Console]::Error.WriteLine('benign-stderr'); exit 0")
)
if ($benignStderr.exitCode -ne 0 -or $benignStderr.stdout.Trim() -ne 'stdout-ok' -or $benignStderr.stderr.Trim() -ne 'benign-stderr') {
  throw 'Benign stderr was not retained separately from a successful exit.'
}

$nonzeroExit = Invoke-AuditedNativeProcess -Executable $powershellExe -WorkingDirectory $workingDirectory -Arguments @(
  '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  (ConvertTo-EncodedCommand "[Console]::Error.WriteLine('expected-failure'); exit 7")
)
if ($nonzeroExit.exitCode -ne 7 -or $nonzeroExit.stderr.Trim() -ne 'expected-failure') {
  throw 'A genuine nonzero native exit was not returned with its stderr evidence.'
}

[ordered]@{
  status = 'PASS'
  powershell = $PSVersionTable.PSVersion.ToString()
  parsedController = [System.IO.Path]::GetFullPath($ControllerPath)
  countMembers = $countMembers
  zeroProcessArrayCount = $baselineProcesses.Count
  zeroPostflightArrayCount = $postflightProcesses.Count
  zeroUnexpectedEntryArrayCount = $unexpectedEntries.Count
  benignStderr = @{ exitCode = $benignStderr.exitCode; stdoutCaptured = $benignStderr.stdout.Trim() -eq 'stdout-ok'; stderrCaptured = $benignStderr.stderr.Trim() -eq 'benign-stderr' }
  nonzeroExit = @{ exitCode = $nonzeroExit.exitCode; stderrCaptured = $nonzeroExit.stderr.Trim() -eq 'expected-failure' }
} | ConvertTo-Json -Depth 4
