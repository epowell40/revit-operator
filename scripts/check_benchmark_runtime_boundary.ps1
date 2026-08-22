[CmdletBinding()]
param([string]$RepoRoot = "")

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (-not $RepoRoot) { $RepoRoot = (& git rev-parse --show-toplevel | Select-Object -First 1) }
if (-not $RepoRoot) { throw "Unable to resolve repository root." }
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$backend = Join-Path $RepoRoot "apps/operator-backend"
if (-not (Test-Path -LiteralPath $backend -PathType Container)) { $backend = Join-Path $RepoRoot "operator-backend" }
$source = Join-Path $backend "src"
if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Operator backend source was not found." }

$violations = @()
$forbidden = @(
  '(?im)^\s*(?:import|export)\b[^\r\n]*?(?:from\s*)?["''][^"'']*benchmark(?:/|\\)',
  '(?im)\bimport\s*\([^\r\n]*["''][^"'']*benchmark(?:/|\\)',
  '(?i)general_revit_capability_acceptance|benchmark_cases|answer_oracle|benchmark[_ -]settlement[_ -]rule|fixture[_ -]specific[_ -]element'
)
foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File -Filter "*.ts") {
  $relative = $file.FullName.Substring($source.Length).TrimStart('\', '/').Replace('\', '/')
  if ($relative.StartsWith("benchmark/") -or $relative.StartsWith("tools/")) { continue }
  $content = Get-Content -LiteralPath $file.FullName -Raw
  foreach ($pattern in $forbidden) {
    if ($content -match $pattern) {
      $violations += "$relative matched $pattern"
      break
    }
  }
}

if ($violations.Count -gt 0) {
  $violations | ForEach-Object { Write-Host "FAIL: $_" -ForegroundColor Red }
  throw "Production runtime has $($violations.Count) forbidden benchmark dependency or oracle reference(s)."
}
Write-Host "PASS: production runtime has no benchmark imports, prompts, case oracles, or fixture-specific repair references."
