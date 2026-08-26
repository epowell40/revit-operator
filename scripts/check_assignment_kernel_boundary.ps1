[CmdletBinding()]
param([string]$RepoRoot = "")

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $RepoRoot) { $RepoRoot = (& git rev-parse --show-toplevel | Select-Object -First 1) }
if (-not $RepoRoot) { throw "Unable to resolve repository root." }
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$registryPath = Join-Path $RepoRoot "scripts/assignment_kernel_allowed_adapters.v2.json"
$registry = Get-Content -Raw -LiteralPath $registryPath | ConvertFrom-Json
$domainRoot = Join-Path $RepoRoot ([string]$registry.domain_root)
if (-not (Test-Path -LiteralPath $domainRoot -PathType Container)) { throw "Assignment Kernel domain root was not found." }

$violations = [System.Collections.Generic.List[string]]::new()
$domainFiles = @(Get-ChildItem -LiteralPath $domainRoot -Recurse -File -Filter "*.ts")
foreach ($file in $domainFiles) {
  $content = Get-Content -Raw -LiteralPath $file.FullName
  $relative = $file.FullName.Substring($domainRoot.Length).TrimStart('\', '/').Replace('\', '/')
  foreach ($match in [regex]::Matches($content, '(?m)^\s*(?:import|export)\b[^\r\n]*?from\s+["'']([^"'']+)["'']')) {
    $specifier = $match.Groups[1].Value
    if (-not $specifier.StartsWith("./") -and -not $specifier.StartsWith("../")) {
      $violations.Add("$relative imports non-domain dependency '$specifier'")
    }
  }
  foreach ($token in @($registry.forbidden_domain_tokens)) {
    if ($content.IndexOf([string]$token, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $violations.Add("$relative contains forbidden domain token '$token'")
    }
  }
  if ($content -match '(?i)json[_ -]?path|payload\.[A-Za-z_]|selector[_ -]?dsl|completion[_ -]?assertion') {
    $violations.Add("$relative introduces a payload selector or completion assertion language")
  }
}

# The registry is the reviewed inventory of authoritative effect/outcome fields.
# These declaration checks make introducing another mutable owner an explicit
# architecture change instead of an unnoticed TypeScript addition.
$requestedEffectDeclarations = @($domainFiles | ForEach-Object {
  $relative = $_.FullName.Substring($domainRoot.Length).TrimStart('\', '/').Replace('\', '/')
  $count = @([regex]::Matches((Get-Content -Raw -LiteralPath $_.FullName), '(?m)^\s*requested_effect\??\s*:')).Count
  if ($count -gt 0) { [pscustomobject]@{ Path = $relative; Count = $count } }
})
$expectedRequestedEffect = @{
  'assignment_spec.ts' = 2
  'operation.ts' = 1
}
foreach ($declaration in $requestedEffectDeclarations) {
  if (-not $expectedRequestedEffect.ContainsKey($declaration.Path) -or $expectedRequestedEffect[$declaration.Path] -ne $declaration.Count) {
    $violations.Add("$($declaration.Path) introduces an unreviewed authoritative requested_effect declaration")
  }
}
foreach ($expectedPath in $expectedRequestedEffect.Keys) {
  if (-not ($requestedEffectDeclarations | Where-Object { $_.Path -eq $expectedPath })) {
    $violations.Add("$expectedPath no longer contains the reviewed requested_effect declarations")
  }
}

$outcomeDeclarations = @($domainFiles | ForEach-Object {
  $relative = $_.FullName.Substring($domainRoot.Length).TrimStart('\', '/').Replace('\', '/')
  $count = @([regex]::Matches((Get-Content -Raw -LiteralPath $_.FullName), '(?m)^\s*outcome\??\s*:')).Count
  if ($count -gt 0) { [pscustomobject]@{ Path = $relative; Count = $count } }
})
if ($outcomeDeclarations.Count -ne 1 -or $outcomeDeclarations[0].Path -ne 'snapshot.ts' -or $outcomeDeclarations[0].Count -ne 1) {
  $violations.Add("AssignmentSnapshotV2.outcome must remain the only independently stored Assignment outcome field")
}

$backendSource = Join-Path $RepoRoot "apps/operator-backend/src"
$projectionRoots = @("work_returns", "work_packets", "benchmark")
foreach ($projectionRoot in $projectionRoots) {
  $root = Join-Path $backendSource $projectionRoot
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
  foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File -Filter "*.ts") {
    $content = Get-Content -Raw -LiteralPath $file.FullName
    if ($content -match '\b(?:append|write|record|commit)AssignmentEventV2\b') {
      $relative = $file.FullName.Substring($RepoRoot.Length).TrimStart('\', '/').Replace('\', '/')
      $violations.Add("$relative attempts to write V2 Assignment truth from a projection/benchmark root")
    }
  }
}

$verificationRoot = Join-Path $backendSource "verification"
if (Test-Path -LiteralPath $verificationRoot -PathType Container) {
  foreach ($file in Get-ChildItem -LiteralPath $verificationRoot -Recurse -File -Filter "*.ts") {
    $content = Get-Content -Raw -LiteralPath $file.FullName
    if ($content -match '(?i)assignment-kernel' -and $content -match '(?i)evidence_projection') {
      $relative = $file.FullName.Substring($RepoRoot.Length).TrimStart('\', '/').Replace('\', '/')
      $violations.Add("$relative makes V2 verification depend on EvidenceProjection")
    }
  }
}

$registryKinds = @($registry.allowed_semantic_adapters | ForEach-Object { [string]$_.kind })
$expectedKinds = @("external_input_edge", "native_result_edge", "legacy_v1_read_adapter", "presentation_projection")
if (@(Compare-Object -ReferenceObject $expectedKinds -DifferenceObject $registryKinds).Count -ne 0) {
  $violations.Add("Allowed-adapter registry must contain exactly the four reviewed semantic adapter kinds")
}

if ($violations.Count -gt 0) {
  $violations | Sort-Object -Unique | ForEach-Object { Write-Host "FAIL: $_" -ForegroundColor Red }
  throw "Assignment Kernel V2 architecture boundary failed with $($violations.Count) violation(s)."
}

Write-Host "PASS: Assignment Kernel V2 domain is transport-independent and semantic adapters are machine-registered."
