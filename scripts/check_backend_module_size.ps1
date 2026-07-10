[CmdletBinding()]
param(
  [string]$RepoRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $RepoRoot = (& git rev-parse --show-toplevel | Select-Object -First 1)
}
if (-not $RepoRoot) { throw "Unable to resolve repository root." }
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

$backendRoot = Join-Path $RepoRoot "operator-backend"
if (-not (Test-Path -LiteralPath (Join-Path $backendRoot "src") -PathType Container)) {
  $backendRoot = Join-Path $RepoRoot "apps/operator-backend"
}
$sourceRoot = Join-Path $backendRoot "src"
if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
  throw "Unable to locate operator backend source under $RepoRoot"
}

$manifestPath = Join-Path $PSScriptRoot "backend_module_size_manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$defaultMax = [int]$manifest.default_max_lines
if ($defaultMax -lt 1) { throw "default_max_lines must be positive." }

$exceptions = @{}
foreach ($entry in @($manifest.exceptions)) {
  $relativePath = ([string]$entry.path).Replace("\", "/")
  if (-not $relativePath) { throw "Every module-size exception requires a path." }
  if ([int]$entry.max_lines -lt 1) { throw "Invalid max_lines for $relativePath" }
  if (-not ([string]$entry.reason).Trim()) { throw "Every module-size exception requires a reason: $relativePath" }
  if ($exceptions.ContainsKey($relativePath)) { throw "Duplicate module-size exception: $relativePath" }
  $exceptions[$relativePath] = $entry
}

$results = foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Filter "*.ts") {
  if ($file.Name.EndsWith(".d.ts", [System.StringComparison]::OrdinalIgnoreCase)) { continue }
  $relativePath = $file.FullName.Substring($sourceRoot.Length).TrimStart("\", "/").Replace("\", "/")
  $lineCount = [System.IO.File]::ReadAllLines($file.FullName).Length
  $limit = if ($exceptions.ContainsKey($relativePath)) { [int]$exceptions[$relativePath].max_lines } else { $defaultMax }
  [pscustomobject]@{
    Path = $relativePath
    Lines = $lineCount
    Limit = $limit
    Status = if ($lineCount -le $limit) { "PASS" } else { "FAIL" }
  }
}

$failures = @($results | Where-Object { $_.Status -eq "FAIL" } | Sort-Object Lines -Descending)
$largest = @($results | Sort-Object Lines -Descending | Select-Object -First 15)
$largest | Format-Table -AutoSize

if ($failures.Count -gt 0) {
  Write-Host ""
  Write-Host "Backend module size ratchet failed:" -ForegroundColor Red
  $failures | Format-Table -AutoSize
  throw "$($failures.Count) TypeScript module(s) exceed their reviewed line limit. Extract behavior or update the manifest with an explicit reason."
}

Write-Host "PASS: $($results.Count) backend TypeScript modules satisfy the $defaultMax-line default and reviewed exception ratchets."
