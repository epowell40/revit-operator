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
    $sharedPayloadContract = $specifier -eq "@revitoperator/payload-digest-v2" -and @("canonical.ts", "payload_provenance.ts") -contains $relative
    if (-not $specifier.StartsWith("./") -and -not $specifier.StartsWith("../") -and -not $sharedPayloadContract) {
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

# Payload identity is a cross-process protocol. These reviewed producers and
# consumers must import the one shared package, and may not grow another local
# canonical-payload implementation.
$payloadDigestPackage = Join-Path $RepoRoot "packages/payload-digest-v2/index.js"
if (-not (Test-Path -LiteralPath $payloadDigestPackage -PathType Leaf)) {
  $violations.Add("Shared payload digest V2 package is missing")
}
$payloadContractConsumers = @(
  "apps/mcp-server/src/lib/assignmentKernelV2.ts",
  "apps/operator-backend/src/domain/assignment-kernel/canonical.ts",
  "apps/operator-backend/src/execution_truth/assignment_kernel_v2_result_adapter.ts",
  "apps/operator-backend/src/execution_truth/assignment_kernel_v2_payload_provenance.ts",
  "apps/operator-backend/src/assignments/dynamic_runtime_settlement.ts"
)
foreach ($relativePath in $payloadContractConsumers) {
  $path = Join-Path $RepoRoot $relativePath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    $violations.Add("Reviewed payload digest consumer is missing: $relativePath")
    continue
  }
  $content = Get-Content -Raw -LiteralPath $path
  if ($content -notmatch '@revitoperator/payload-digest-v2') {
    $violations.Add("$relativePath does not import the shared payload digest V2 contract")
  }
  if ($content -match '(?m)function\s+canonicalValue\s*\(' -or $content -match '(?m)function\s+canonicalDigest\s*\(') {
    $violations.Add("$relativePath introduces a local V2 canonical-payload implementation")
  }
}
$mcpPayloadEdge = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "apps/mcp-server/src/lib/assignmentKernelV2.ts")
if ($mcpPayloadEdge -match 'localeCompare\s*\(') {
  $violations.Add("MCP Assignment Kernel payload identity must not use locale-sensitive key ordering")
}

# Native route effect is also cross-process admission truth. The backend and
# independently packaged MCP must import the same contract so a read cannot be
# widened to apply (or vice versa) by drift between local route tables.
$routeEffectPackage = Join-Path $RepoRoot "packages/revit-action-effect-v1/index.js"
if (-not (Test-Path -LiteralPath $routeEffectPackage -PathType Leaf)) {
  $violations.Add("Shared Revit action-effect package is missing")
}
foreach ($relativePath in @(
  "apps/operator-backend/src/action_path_mutability.ts",
  "apps/mcp-server/src/lib/revitRouteEffect.ts"
)) {
  $path = Join-Path $RepoRoot $relativePath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    $violations.Add("Reviewed Revit action-effect consumer is missing: $relativePath")
    continue
  }
  $content = Get-Content -Raw -LiteralPath $path
  if ($content -notmatch '@revitoperator/revit-action-effect-v1') {
    $violations.Add("$relativePath does not import the shared Revit action-effect contract")
  }
  if ($content -match 'READ_ONLY_(?:POST_)?PATHS' -or $content -match 'new\s+Set') {
    $violations.Add("$relativePath introduces local Revit action-effect metadata")
  }
}

# Semantic admissibility is deny-by-default. Control success cannot be emitted
# as a domain fact, and evidence class must come from the admitted fulfillment
# role rather than a generic non-verification shortcut.
$semanticContract = Join-Path $domainRoot "semantic_admissibility.ts"
if (-not (Test-Path -LiteralPath $semanticContract -PathType Leaf)) {
  $violations.Add("Shared semantic evidence-admissibility contract is missing")
}
$semanticProducers = @(
  "apps/mcp-server/src/lib/assignmentKernelV2.ts",
  "apps/operator-backend/src/assignments/dynamic_runtime_settlement.ts",
  "apps/operator-backend/src/assignments/assignment_kernel_v2_execution.ts"
)
foreach ($relativePath in $semanticProducers) {
  $path = Join-Path $RepoRoot $relativePath
  $content = Get-Content -Raw -LiteralPath $path
  if ($content -match '["'']result\.available["'']') {
    $violations.Add("$relativePath emits legacy generic result.available evidence")
  }
  if ($content -match '(?is)purpose\s*===\s*["'']verification["''].{0,120}task_result') {
    $violations.Add("$relativePath reintroduces non-verification => task_result classification")
  }
}

# Task fulfillment transfer is an explicit reviewed handler decision. A native
# child defaults to control evidence; these production surfaces must opt in via
# the shared current-operation helper instead of relying on route heuristics.
$mcpKernel = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "apps/mcp-server/src/lib/assignmentKernelV2.ts")
if ($mcpKernel -notmatch 'return\s+"supporting_control"') {
  $violations.Add("Unclassified MCP native children no longer default to supporting_control")
}
if ($mcpKernel -notmatch 'currentAssignmentKernelTaskFulfillmentRoleV2') {
  $violations.Add("Reviewed MCP task-fulfillment delegation helper is missing")
}
if ($mcpKernel -notmatch 'expected\.request_signature\s*===\s*sha256') {
  $violations.Add("Generic native parent claiming is not bound to the exact canonical request signature")
}
foreach ($relativePath in @(
  "apps/mcp-server/src/server.ts",
  "apps/mcp-server/src/skills/quantify.ts"
)) {
  $content = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot $relativePath)
  if ($content -notmatch 'assignmentFulfillmentRole:\s*currentAssignmentKernelTaskFulfillmentRoleV2\(\)') {
    $violations.Add("$relativePath does not explicitly delegate its reviewed task-producing native action")
  }
}

# Every new V2 session-index producer and consumer must share one response
# schema and field name. Historical artifact readers may live elsewhere, but
# production traffic cannot grow another alias.
$sessionIndexContract = Join-Path $RepoRoot "packages/assignment-kernel-v2-contracts/index.js"
if (-not (Test-Path -LiteralPath $sessionIndexContract -PathType Leaf)) {
  $violations.Add("Shared Assignment Kernel V2 session-index contract is missing")
}
foreach ($relativePath in @(
  "apps/operator-backend/src/assignments/http_routes.ts",
  "apps/operator-backend/src/benchmark/assignment_kernel_v2_collection.ts"
)) {
  $path = Join-Path $RepoRoot $relativePath
  $content = Get-Content -Raw -LiteralPath $path
  if ($content -notmatch '@revitoperator/assignment-kernel-v2-contracts') {
    $violations.Add("$relativePath does not import the shared V2 session-index contract")
  }
  if ($content -match 'assignment_kernel_v2_index') {
    $violations.Add("$relativePath retains the superseded V2 session-index alias")
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
