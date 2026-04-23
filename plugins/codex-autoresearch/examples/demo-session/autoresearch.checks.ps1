$ErrorActionPreference = "Stop"

$sessionPath = Join-Path $PSScriptRoot "autoresearch.jsonl"
if (-not (Test-Path -LiteralPath $sessionPath)) {
  throw "Demo session file not found: $sessionPath"
}

$records = Get-Content -LiteralPath $sessionPath |
  Where-Object { $_.Trim() } |
  ForEach-Object { $_ | ConvertFrom-Json }

$config = $records | Where-Object { $_.type -eq "config" } | Select-Object -First 1
$runs = @($records | Where-Object { $null -ne $_.run })

if ($null -eq $config) {
  throw "The demo session is missing its config entry."
}

if ($runs.Count -eq 0) {
  throw "The demo session does not contain any runs."
}

$missingMemory = @(
  $runs | Where-Object {
    $null -eq $_.metrics -or
    $null -eq $_.metrics.memory_mb -or
    "$($_.metrics.memory_mb)".Trim() -eq ""
  }
).Count

if ($missingMemory -gt 0) {
  throw "Every demo run should carry memory_mb; found $missingMemory missing value(s)."
}

$missingAsi = @(
  $runs | Where-Object {
    $null -eq $_.asi -or
    "$($_.asi.hypothesis)".Trim() -eq "" -or
    "$($_.asi.evidence)".Trim() -eq ""
  }
).Count

if ($missingAsi -gt 0) {
  throw "Every demo run should carry basic ASI; found $missingAsi incomplete packet(s)."
}

Write-Output ("Demo checks passed for {0} embedded runs." -f $runs.Count)
