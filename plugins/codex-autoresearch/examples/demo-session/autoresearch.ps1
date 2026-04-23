$ErrorActionPreference = "Stop"

$sessionPath = Join-Path $PSScriptRoot "autoresearch.jsonl"
if (-not (Test-Path -LiteralPath $sessionPath)) {
  throw "Demo session file not found: $sessionPath"
}

$records = Get-Content -LiteralPath $sessionPath |
  Where-Object { $_.Trim() } |
  ForEach-Object { $_ | ConvertFrom-Json }

$lastRun = $records |
  Where-Object { $null -ne $_.run } |
  Select-Object -Last 1

if ($null -eq $lastRun) {
  throw "The demo session does not contain any runs to replay."
}

$culture = [System.Globalization.CultureInfo]::InvariantCulture
$seconds = [double]$lastRun.metric
Write-Output ("METRIC seconds={0}" -f $seconds.ToString($culture))

$memoryMb = $lastRun.metrics.memory_mb
if ($null -ne $memoryMb -and "$memoryMb" -ne "") {
  Write-Output ("METRIC memory_mb={0}" -f ([double]$memoryMb).ToString($culture))
}

Write-Output ("Replayed demo packet #{0} from the embedded run log." -f $lastRun.run)
