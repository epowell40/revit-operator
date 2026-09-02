[CmdletBinding()]
param([string]$RepoRoot = "")

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $RepoRoot) { $RepoRoot = (& git rev-parse --show-toplevel | Select-Object -First 1) }
if (-not $RepoRoot) { throw "Unable to resolve repository root." }
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

# This boundary runs in both supported repository compositions: the public
# monorepo keeps applications under apps/, while the private integration repo
# mirrors them at its root. Resolve that composition once so every reviewed
# path below follows the same deterministic rule.
$usesAppsDirectory = Test-Path -LiteralPath (Join-Path $RepoRoot "apps/operator-backend") -PathType Container
if (-not $usesAppsDirectory -and -not (Test-Path -LiteralPath (Join-Path $RepoRoot "operator-backend") -PathType Container)) {
  throw "Unable to resolve the operator application layout under $RepoRoot."
}
function Resolve-RepoPath([string]$RelativePath) {
  $normalized = $RelativePath.Replace('\', '/')
  if (-not $usesAppsDirectory -and $normalized.StartsWith("apps/", [System.StringComparison]::Ordinal)) {
    $normalized = $normalized.Substring(5)
  }
  return Join-Path $RepoRoot $normalized
}

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
  $path = Resolve-RepoPath $relativePath
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
$mcpPayloadEdge = Get-Content -Raw -LiteralPath (Resolve-RepoPath "apps/mcp-server/src/lib/assignmentKernelV2.ts")
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
$routeEffectGoldenVectors = Join-Path $RepoRoot "packages/revit-action-effect-v1/golden-vectors.json"
if (-not (Test-Path -LiteralPath $routeEffectGoldenVectors -PathType Leaf)) {
  $violations.Add("Cross-runtime Revit action-effect golden vectors are missing")
}
foreach ($relativePath in @(
  "apps/operator-backend/src/action_path_mutability.ts",
  "apps/mcp-server/src/lib/revitRouteEffect.ts"
)) {
  $path = Resolve-RepoPath $relativePath
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

$routeEffectRuntimeConsumers = @(
  @{
    Path = "apps/operator-backend/src/teammate_loop_runtime.ts"
    Import = './action_path_mutability.js'
    Function = 'revitRouteEffect'
  },
  @{
    Path = "apps/operator-backend/src/assignments/turn_journal.ts"
    Import = '../action_path_mutability.js'
    Function = 'revitRouteEffect'
  },
  @{
    Path = "apps/operator-backend/src/revit_batch/tool_result_normalization.ts"
    Import = '../action_path_mutability.js'
    Function = 'revitRouteEffect'
  },
  @{
    Path = "apps/operator-backend/src/benchmark/durable_tool_evidence.ts"
    Import = '../action_path_mutability.js'
    Function = 'revitRouteEffect'
  },
  @{
    Path = "apps/operator-backend/src/goals/auto_goal_runtime.ts"
    Import = '../action_path_mutability.js'
    Function = 'revitRouteEffect'
  },
  @{
    Path = "apps/mcp-server/src/lib/revitClient.ts"
    Import = './revitRouteEffect.js'
    Function = 'revitRouteEffect'
  },
  @{
    Path = "apps/mcp-server/src/lib/toolExposurePolicy.ts"
    Import = './revitRouteEffect.js'
    Function = 'revitRouteCertificationEffect'
  }
)
foreach ($consumer in $routeEffectRuntimeConsumers) {
  $path = Resolve-RepoPath $consumer.Path
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    $violations.Add("Reviewed Revit action-effect runtime consumer is missing: $($consumer.Path)")
    continue
  }
  $content = Get-Content -Raw -LiteralPath $path
  $functionPattern = '\b' + [regex]::Escape($consumer.Function) + '\s*\('
  if ($content -notmatch [regex]::Escape($consumer.Import) -or $content -notmatch $functionPattern) {
    $violations.Add("$($consumer.Path) does not classify native requests through the shared Revit action-effect contract")
  }
  if ($content -match '\bconditionalActionPathEffect\s*\(' -or $content -match '\bpathLooksWrite\s*\(') {
    $violations.Add("$($consumer.Path) independently composes native route-effect classification")
  }
}

# Native transports use one C# policy adapter and prove parity with the same
# vectors as the MCP and backend processes. Risk/grant policy remains separate
# from requested-effect identity, so a safe rollback can be low-risk without
# being mislabeled as a read.
$nativeEffectConsumers = @(
  @{
    Path = "apps/revit-bridge-addin/RevitBridge/Server/RevitHttpServer.cs"
    Required = 'OperatorApprovalPolicy.GetEffectWireValue(effectiveMethod, path, requestBody)'
  },
  @{
    Path = "apps/revit-bridge-addin/RevitBridge/Operator/OperatorActionRunner.cs"
    Required = 'OperatorApprovalPolicy.ResolveRequestedEffectWireValue(action.RequestEffect, method, path, jsonBody)'
  },
  @{
    Path = "apps/revit-bridge-addin/RevitBridge/Operator/OperatorRevitCourierWorker.cs"
    Required = 'OperatorApprovalPolicy.GetEffectWireValue(method, path, bodyJson)'
  },
  @{
    Path = "apps/revit-bridge-addin/RevitBridge/Operator/OperatorPaneControl.cs"
    Required = 'OperatorApprovalPolicy.GetEffectWireValue(action.Method, action.Path, bodyJson)'
  }
)
foreach ($consumer in $nativeEffectConsumers) {
  $path = Resolve-RepoPath $consumer.Path
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    $violations.Add("Reviewed native Revit action-effect consumer is missing: $($consumer.Path)")
    continue
  }
  $content = Get-Content -Raw -LiteralPath $path
  if ($content -notmatch [regex]::Escape($consumer.Required)) {
    $violations.Add("$($consumer.Path) does not classify requested effect through OperatorApprovalPolicy")
  }
  if ($content -match 'private\s+static\s+string\s+Resolve(?:Canonical)?RequestedEffect\s*\(') {
    $violations.Add("$($consumer.Path) reintroduces an independent native requested-effect classifier")
  }
}

foreach ($relativePath in @(
  "apps/mcp-server/src/lib/revitRouteEffect.test.ts",
  "apps/operator-backend/test/endpoint_mutability.test.ts",
  "apps/revit-bridge-addin/RevitBridge.Common.Tests/OperatorApprovalPolicyTests.cs"
)) {
  $path = Resolve-RepoPath $relativePath
  $content = Get-Content -Raw -LiteralPath $path
  if ($content -notmatch 'revit_action_effect_v1_golden_vectors') {
    $violations.Add("$relativePath does not enforce the shared cross-runtime action-effect vectors")
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
  $path = Resolve-RepoPath $relativePath
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
$mcpKernel = Get-Content -Raw -LiteralPath (Resolve-RepoPath "apps/mcp-server/src/lib/assignmentKernelV2.ts")
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
  $content = Get-Content -Raw -LiteralPath (Resolve-RepoPath $relativePath)
  if ($content -notmatch 'assignmentFulfillmentRole:\s*currentAssignmentKernelTaskFulfillmentRoleV2\(\)') {
    $violations.Add("$relativePath does not explicitly delegate its reviewed task-producing native action")
  }
}

# A successful read is not itself proof that an applied postcondition holds.
# Live execution and restart recovery must share one deterministic value matcher,
# and only the reviewed settlement edge may mint the typed verification fact.
$postconditionContract = Resolve-RepoPath "apps/operator-backend/src/postcondition_verification_v2.ts"
if (-not (Test-Path -LiteralPath $postconditionContract -PathType Leaf)) {
  $violations.Add("Shared postcondition verification V2 contract is missing")
}
foreach ($relativePath in @(
  "apps/operator-backend/src/teammate_loop_runtime.ts",
  "apps/operator-backend/src/assignments/assignment_kernel_v2_execution.ts"
)) {
  $path = Resolve-RepoPath $relativePath
  $content = Get-Content -Raw -LiteralPath $path
  if ($content -notmatch 'postcondition_verification_v2') {
    $violations.Add("$relativePath does not import the shared postcondition verification V2 contract")
  }
}
$verificationFactWriters = @(Get-ChildItem -LiteralPath (Resolve-RepoPath "apps/operator-backend/src") -Recurse -File -Filter "*.ts" | Where-Object {
  (Get-Content -Raw -LiteralPath $_.FullName) -match 'fact_id\s*:\s*["'']verification\.postcondition_satisfied["'']'
})
$expectedVerificationWriter = [System.IO.Path]::GetFullPath((Resolve-RepoPath "apps/operator-backend/src/assignments/assignment_kernel_v2_execution.ts"))
if ($verificationFactWriters.Count -ne 1 -or $verificationFactWriters[0].FullName -ne $expectedVerificationWriter) {
  $violations.Add("verification.postcondition_satisfied may be minted only by the reviewed V2 settlement edge")
}
$outcomeSource = Get-Content -Raw -LiteralPath (Join-Path $domainRoot "outcome.ts")
if ($outcomeSource -notmatch 'verification\.postcondition_satisfied') {
  $violations.Add("Applied V2 completion no longer requires the typed positive postcondition fact")
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
  $path = Resolve-RepoPath $relativePath
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

$backendSource = Resolve-RepoPath "apps/operator-backend/src"
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
