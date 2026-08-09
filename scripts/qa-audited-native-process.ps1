function Invoke-AuditedNativeProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [hashtable]$Environment = @{}
  )

  foreach ($argument in $Arguments) {
    if ([string]::IsNullOrEmpty($argument) -or $argument -match '[\s"]') {
      throw 'Audited native-process arguments must be non-empty and require no command-line quoting.'
    }
  }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = [System.IO.Path]::GetFullPath($Executable)
  $startInfo.WorkingDirectory = [System.IO.Path]::GetFullPath($WorkingDirectory)
  $startInfo.Arguments = [string]::Join(' ', $Arguments)
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($entry in $Environment.GetEnumerator()) { $startInfo.EnvironmentVariables[$entry.Key] = [string]$entry.Value }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw 'The audited native process did not start.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    return [pscustomobject][ordered]@{
      exitCode = $process.ExitCode
      processId = $process.Id
      stdout = $stdout
      stderr = $stderr
    }
  } finally {
    $process.Dispose()
  }
}
