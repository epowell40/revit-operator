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
    $sharedControlEvidenceContract = $specifier -eq "@revitoperator/assignment-kernel-v2-contracts" -and @("operation.ts", "progress/provider_call.ts", "semantic_admissibility.ts", "snapshot.ts") -contains $relative
    if (-not $specifier.StartsWith("./") -and -not $specifier.StartsWith("../") -and -not $sharedPayloadContract -and -not $sharedControlEvidenceContract) {
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
$previewEvidenceContract = Resolve-RepoPath "apps/mcp-server/src/lib/previewSemanticEvidenceV2.ts"
if (-not (Test-Path -LiteralPath $previewEvidenceContract -PathType Leaf)) {
  $violations.Add("Typed V2 preview semantic-evidence contract is missing")
} else {
  $previewEvidence = Get-Content -Raw -LiteralPath $previewEvidenceContract
  if ($previewEvidence -notmatch 'return\s+\{\s*recognized:\s*false,\s*admitted:\s*false,\s*facts:\s*\[\]\s*\}') {
    $violations.Add("Unknown V2 preview routes no longer deny semantic completion by default")
  }
  if ($previewEvidence -notmatch 'control\.preview_proposal_matches_request' -or
      $previewEvidence -notmatch 'control\.preview_actual_state_unchanged' -or
      $previewEvidence -notmatch 'task\.preview_valid') {
    $violations.Add("Typed V2 preview evidence no longer binds proposal identity and persistent-state truth")
  }
}
if ($mcpKernel -notmatch 'previewSemanticEvidenceV2' -or $mcpKernel -match 'fact_id:\s*["'']task\.preview_valid["'']') {
  $violations.Add("Generic MCP settlement may not mint task.preview_valid outside the typed preview adapter")
}
$previewFactWriters = @(
  (Get-ChildItem -LiteralPath (Resolve-RepoPath "apps/mcp-server/src") -Recurse -File -Filter "*.ts") +
  (Get-ChildItem -LiteralPath (Resolve-RepoPath "apps/operator-backend/src") -Recurse -File -Filter "*.ts") |
  Where-Object { (Get-Content -Raw -LiteralPath $_.FullName) -match 'fact_id\s*:\s*["'']task\.preview_valid["'']' }
)
$expectedPreviewFactWriter = [System.IO.Path]::GetFullPath($previewEvidenceContract)
if ($previewFactWriters.Count -ne 1 -or $previewFactWriters[0].FullName -ne $expectedPreviewFactWriter) {
  $violations.Add("task.preview_valid may be minted only by the reviewed typed preview adapter")
}
$progressController = Get-Content -Raw -LiteralPath (Join-Path $domainRoot "progress/controller.ts")
if ($progressController -notmatch 'preview_semantic_proof_missing' -or $progressController -notmatch 'task\.preview_valid') {
  $violations.Add("Transport-neutral progress no longer blocks a settled task preview without typed semantic proof")
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
$sharedControlEvidenceContract = Join-Path $RepoRoot "packages/assignment-kernel-v2-contracts/index.js"
if (-not (Test-Path -LiteralPath $sharedControlEvidenceContract -PathType Leaf)) {
  $violations.Add("Shared Assignment Kernel V2 control-evidence contract is missing")
}
foreach ($relativePath in @(
  "apps/mcp-server/src/lib/assignmentKernelV2.ts",
  "apps/operator-backend/src/domain/assignment-kernel/semantic_admissibility.ts"
)) {
  $path = Resolve-RepoPath $relativePath
  $content = Get-Content -Raw -LiteralPath $path
  if ($content -notmatch '@revitoperator/assignment-kernel-v2-contracts') {
    $violations.Add("$relativePath does not import the shared V2 control-evidence contract")
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

# TextNote content has a native Revit representation rule. Backend settlement,
# benchmark verification, and MCP preview evidence must share one TypeScript
# implementation, while native C# proves parity against the same versioned
# vectors. Field-name heuristics may not grow another normalization algorithm.
$textNoteContract = Join-Path $RepoRoot "packages/text-note-round-trip-v1/index.js"
$textNoteVectors = Join-Path $RepoRoot "packages/text-note-round-trip-v1/golden-vectors.json"
if (-not (Test-Path -LiteralPath $textNoteContract -PathType Leaf)) {
  $violations.Add("Shared TextNote round-trip contract is missing")
}
if (-not (Test-Path -LiteralPath $textNoteVectors -PathType Leaf)) {
  $violations.Add("Shared TextNote round-trip golden vectors are missing")
}
foreach ($relativePath in @(
  "apps/operator-backend/src/postcondition_verification_v2.ts",
  "apps/operator-backend/src/benchmark/revit_workflows.ts",
  "apps/mcp-server/src/lib/previewSemanticEvidenceV2.ts"
)) {
  $path = Resolve-RepoPath $relativePath
  $content = Get-Content -Raw -LiteralPath $path
  if ($content -notmatch '@revitoperator/text-note-round-trip-v1') {
    $violations.Add("$relativePath does not import the shared TextNote round-trip contract")
  }
  if ($content -match '(?s)function\s+canonicalRevitText\s*\(' -or $content -match '(?s)function\s+normalizeTextNoteTextV2[\s\S]{0,500}replace(?:All)?\s*\(') {
    $violations.Add("$relativePath introduces an independent TextNote normalization implementation")
  }
}
foreach ($relativePath in @(
  "apps/operator-backend/test/postcondition_verification_v2.test.ts",
  "apps/revit-bridge-addin/RevitBridge.Common.Tests/TextNoteCanonicalizationTests.cs"
)) {
  $content = Get-Content -Raw -LiteralPath (Resolve-RepoPath $relativePath)
  if ($content -notmatch 'text-note-round-trip-v1') {
    $violations.Add("$relativePath does not enforce the shared cross-runtime TextNote vectors")
  }
}
$textNoteHandler = Get-Content -Raw -LiteralPath (Resolve-RepoPath "apps/revit-bridge-addin/RevitBridge.Logic/Handlers/Families/SetTextNoteTextHandler.cs")
$roundTripAdmissionCount = [regex]::Matches($textNoteHandler, 'TextNoteTextCanonicalizer\.IsExactRevitRoundTrip\s*\(').Count
$usesLegacyExactNormalizedAdmission = $textNoteHandler -match 'string\.Equals\s*\(\s*TextNoteTextCanonicalizer\.Normalize\s*\(\s*before'
if ($roundTripAdmissionCount -lt 3 -or $usesLegacyExactNormalizedAdmission) {
  $violations.Add("Native TextNote mutation no longer uses the shared round-trip rule for no-op and stale-state admission")
}
$sourceProvenancePath = Resolve-RepoPath "apps/operator-backend/src/capabilities/epic_0437_source_provenance.ts"
if (Test-Path -LiteralPath $sourceProvenancePath -PathType Leaf) {
  $sourceProvenance = Get-Content -Raw -LiteralPath $sourceProvenancePath
  if ($sourceProvenance -notmatch 'packages/text-note-round-trip-v1') {
    $violations.Add("Exact source certification does not bind the shared TextNote round-trip contract")
  }
} elseif ($usesAppsDirectory) {
  $violations.Add("Exact source-certification provenance authority is missing")
}

# Every new V2 session-index producer and consumer must share one response
# schema and field name. Historical artifact readers may live elsewhere, but
# production traffic cannot grow another alias.
$sessionIndexContract = Join-Path $RepoRoot "packages/assignment-kernel-v2-contracts/index.js"
if (-not (Test-Path -LiteralPath $sessionIndexContract -PathType Leaf)) {
  $violations.Add("Shared Assignment Kernel V2 session-index contract is missing")
}
$sessionIndexConsumers = @(
  "apps/operator-backend/src/assignments/http_routes.ts",
  "apps/operator-backend/src/benchmark/assignment_kernel_v2_collection.ts"
)
if (Test-Path -LiteralPath (Resolve-RepoPath "apps/operator-desktop/server.js") -PathType Leaf) {
  $sessionIndexConsumers += "apps/operator-desktop/server.js"
}
foreach ($relativePath in $sessionIndexConsumers) {
  $path = Resolve-RepoPath $relativePath
  $content = Get-Content -Raw -LiteralPath $path
  if ($content -notmatch '@revitoperator/assignment-kernel-v2-contracts') {
    $violations.Add("$relativePath does not import the shared V2 session-index contract")
  }
  if ($content -match 'assignment_kernel_v2_index') {
    $violations.Add("$relativePath retains the superseded V2 session-index alias")
  }
}

# Native execution identity in V2 publications comes from the result-schema
# contract. Request identities on controller wrappers may describe a target
# route and must not be promoted into actual Revit execution by consumers.
$nativeEvidenceAdapter = Resolve-RepoPath "apps/operator-backend/src/benchmark/assignment_kernel_v2_native_evidence.ts"
if (-not (Test-Path -LiteralPath $nativeEvidenceAdapter -PathType Leaf)) {
  $violations.Add("Shared Assignment Kernel V2 native-evidence projection is missing")
} else {
  $nativeEvidenceContent = Get-Content -Raw -LiteralPath $nativeEvidenceAdapter
  if ($nativeEvidenceContent -notmatch 'nativeOperationIdentityFromResultSchemaV2') {
    $violations.Add("Shared V2 native-evidence projection no longer owns native result-schema identity")
  }
}

# Exact-ID publication, snapshot, and provider-ledger identities are one shared
# wire contract. Every new V2 consumer validates that contract rather than
# copying schema strings or accepting a merely plausible wrapper.
$publicationContractConsumers = @(
  @{ Path = "apps/operator-backend/src/assignments/assignment_kernel_v2_publication.ts"; Token = "parseAssignmentKernelPublicationV2" },
  @{ Path = "apps/operator-backend/src/benchmark/assignment_kernel_v2_collection.ts"; Token = "parseAssignmentKernelPublicationV2" },
  @{ Path = "apps/operator-backend/src/benchmark/assignment_kernel_v2_acceptance.ts"; Token = "parseAssignmentKernelPublicationV2" },
  @{ Path = "apps/operator-backend/src/benchmark/assignment_kernel_v2_native_evidence.ts"; Token = "parseAssignmentKernelPublicationV2" },
  @{ Path = "apps/operator-backend/src/benchmark/v2_session_receipt_binding.ts"; Token = "parseAssignmentKernelPublicationV2" },
  @{ Path = "apps/operator-backend/src/benchmark/protocol_v2_kernel.ts"; Token = "parseAssignmentKernelPublicationV2" },
  @{ Path = "apps/operator-backend/src/benchmark/protocol_v2_runner.ts"; Token = "ASSIGNMENT_SNAPSHOT_V2_SCHEMA" },
  @{ Path = "apps/operator-backend/src/benchmark/canonical_assignment_truth.ts"; Token = "ASSIGNMENT_SNAPSHOT_V2_SCHEMA" }
)
if (Test-Path -LiteralPath (Resolve-RepoPath "apps/operator-desktop/server.js") -PathType Leaf) {
  $publicationContractConsumers += @{ Path = "apps/operator-desktop/server.js"; Token = "parseAssignmentKernelPublicationV2" }
}
foreach ($consumer in $publicationContractConsumers) {
  $path = Resolve-RepoPath ([string]$consumer.Path)
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    $violations.Add("Reviewed V2 publication consumer is missing: $($consumer.Path)")
    continue
  }
  $content = Get-Content -Raw -LiteralPath $path
  if ($content -notmatch '@revitoperator/assignment-kernel-v2-contracts' -or
      $content -notmatch [regex]::Escape([string]$consumer.Token)) {
    $violations.Add("$($consumer.Path) does not consume the shared exact V2 publication contract")
  }
}
$v2SchemaLiterals = @(
  'revit-operator\.assignment-kernel-publication/v2',
  'revit-operator\.assignment-provider-ledger/v2',
  'revit-operator\.assignment-snapshot/v2',
  'revit-operator\.provider-call/v2'
)
$publicationProductionFiles = @(
  (Get-ChildItem -LiteralPath (Resolve-RepoPath "apps/operator-backend/src") -Recurse -File -Filter "*.ts")
)
$desktopProductionPath = Resolve-RepoPath "apps/operator-desktop/server.js"
if (Test-Path -LiteralPath $desktopProductionPath -PathType Leaf) {
  $publicationProductionFiles += Get-Item -LiteralPath $desktopProductionPath
}
foreach ($file in $publicationProductionFiles) {
  $content = Get-Content -Raw -LiteralPath $file.FullName
  if ($v2SchemaLiterals | Where-Object { $content -match $_ }) {
    $relative = $file.FullName.Substring($RepoRoot.Length).TrimStart('\', '/').Replace('\', '/')
    $violations.Add("$relative copies an exact V2 publication schema literal outside the shared contract")
  }
  if (($content -match 'ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA' -or $content -match '\bprovider_ledger\b') -and
      $content -notmatch 'parseAssignmentKernelPublicationV2' -and
      $content -notmatch 'directKernelPublicationsV2\s*\(') {
    $relative = $file.FullName.Substring($RepoRoot.Length).TrimStart('\', '/').Replace('\', '/')
    $violations.Add("$relative reads exact V2 publication truth without the shared publication parser")
  }
}
$benchmarkBundleLiteral = 'revit-operator\.benchmark-assignment-kernel-v2/v1'
$benchmarkBundleOwners = @(Get-ChildItem -LiteralPath (Resolve-RepoPath "apps/operator-backend/src") -Recurse -File -Filter "*.ts" | Where-Object {
  (Get-Content -Raw -LiteralPath $_.FullName) -match $benchmarkBundleLiteral
})
$expectedBenchmarkBundleOwner = [System.IO.Path]::GetFullPath((Resolve-RepoPath "apps/operator-backend/src/benchmark/assignment_kernel_v2_collection.ts"))
if ($benchmarkBundleOwners.Count -ne 1 -or $benchmarkBundleOwners[0].FullName -ne $expectedBenchmarkBundleOwner) {
  $violations.Add("The benchmark V2 bundle schema must have exactly one production owner")
}

# Tool retrieval relevance is a cross-process behavioral contract. Native and
# MCP implementations must remain vector-equivalent, ordinal, schema-size
# immune, and explicitly version-gated at the mixed-release boundary.
$rankingPackage = Join-Path $RepoRoot "packages/revit-tool-search-ranking-v3"
$rankingReadme = Join-Path $rankingPackage "README.md"
$rankingVectorsPath = Join-Path $rankingPackage "golden-vectors.json"
if (-not (Test-Path -LiteralPath $rankingReadme -PathType Leaf) -or
    -not (Test-Path -LiteralPath $rankingVectorsPath -PathType Leaf)) {
  $violations.Add("Shared tool-search ranking V3 contract or golden vectors are missing")
} else {
  try {
    $rankingVectors = Get-Content -Raw -LiteralPath $rankingVectorsPath | ConvertFrom-Json
    if ([string]$rankingVectors.schema -cne "revit_operator.tool_search_ranking_golden_vectors/v3" -or
        [string]$rankingVectors.ranking_version -cne "operator.tool_search_ranking.v3" -or
        @($rankingVectors.candidates).Count -lt 2 -or @($rankingVectors.queries).Count -lt 2) {
      $violations.Add("Shared tool-search ranking V3 vectors have the wrong identity or insufficient coverage")
    }
  } catch {
    $violations.Add("Shared tool-search ranking V3 vectors are not valid JSON")
  }
}
$rankingTsPath = Resolve-RepoPath "apps/mcp-server/src/lib/toolSearchRanking.ts"
$rankingCsPath = Resolve-RepoPath "apps/revit-bridge-addin/RevitBridge.Common/OperatorToolSearchRanking.cs"
$rankingMcpServerPath = Resolve-RepoPath "apps/mcp-server/src/server.ts"
$rankingNativeConsumerPath = Resolve-RepoPath "apps/revit-bridge-addin/RevitBridge/Operator/OperatorToolIntrospection.cs"
foreach ($path in @($rankingTsPath, $rankingCsPath, $rankingMcpServerPath, $rankingNativeConsumerPath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    $violations.Add("Reviewed tool-search ranking file is missing: $path")
  }
}
if (Test-Path -LiteralPath $rankingTsPath -PathType Leaf) {
  $rankingTs = Get-Content -Raw -LiteralPath $rankingTsPath
  if ($rankingTs -notmatch 'scoreToolSearchCandidateV3' -or
      $rankingTs -notmatch 'compareToolSearchCandidatesV3' -or
      $rankingTs -notmatch 'normalize\("NFKC"\)' -or
      $rankingTs -match 'localeCompare\s*\(' -or
      $rankingTs -match 'candidate\.(?:required_fields|optional_fields)') {
    $violations.Add("MCP tool-search ranking no longer follows the reviewed ordinal, schema-size-immune V3 contract")
  }
}
if (Test-Path -LiteralPath $rankingCsPath -PathType Leaf) {
  $rankingCs = Get-Content -Raw -LiteralPath $rankingCsPath
  if ($rankingCs -notmatch 'public const string ContractVersion' -or
      $rankingCs -notmatch 'public static int Score\s*\(' -or
      $rankingCs -notmatch 'NormalizationForm\.FormKC' -or
      $rankingCs -notmatch 'StringComparer\.Ordinal' -or
      $rankingCs -notmatch 'ToLowerInvariant') {
    $violations.Add("Native tool-search ranking no longer follows the reviewed ordinal V3 contract")
  }
}
if (Test-Path -LiteralPath $rankingMcpServerPath -PathType Leaf) {
  $rankingMcpServer = Get-Content -Raw -LiteralPath $rankingMcpServerPath
  if ($rankingMcpServer -notmatch 'scoreToolSearchCandidateV3' -or
      $rankingMcpServer -notmatch 'sort\(compareToolSearchCandidatesV3\)' -or
      $rankingMcpServer -notmatch '!isToolSearchRankingVersionV3\(' -or
      $rankingMcpServer -notmatch 'ranking_version:\s*TOOL_SEARCH_RANKING_VERSION_V3') {
    $violations.Add("MCP tool search does not enforce and publish the shared ranking V3 contract")
  }
}
if (Test-Path -LiteralPath $rankingNativeConsumerPath -PathType Leaf) {
  $rankingNativeConsumer = Get-Content -Raw -LiteralPath $rankingNativeConsumerPath
  if ($rankingNativeConsumer -notmatch 'OperatorToolSearchRanking\.Score\(' -or
      $rankingNativeConsumer -notmatch 'ranking_version\s*=\s*OperatorToolSearchRanking\.ContractVersion' -or
      $rankingNativeConsumer -notmatch 'ThenBy\(m\s*=>\s*m\.Tool\.RiskLevel\)' -or
      $rankingNativeConsumer -notmatch 'ThenBy\(m\s*=>\s*m\.Tool\.Path,\s*StringComparer\.Ordinal\)') {
    $violations.Add("Native tool search does not score, version, and tie-break with the shared ranking V3 contract")
  }
}
$rankingLiteralOwners = @()
foreach ($root in @(
  (Resolve-RepoPath "apps/mcp-server/src"),
  (Resolve-RepoPath "apps/revit-bridge-addin/RevitBridge.Common"),
  (Resolve-RepoPath "apps/revit-bridge-addin/RevitBridge/Operator")
)) {
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
  $rankingLiteralOwners += Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object {
    $_.Name -notmatch '\.test\.' -and $_.FullName -notmatch 'Common\.Tests' -and
    (Get-Content -Raw -LiteralPath $_.FullName) -match 'operator\.tool_search_ranking\.v3'
  }
}
$expectedRankingOwners = @([System.IO.Path]::GetFullPath($rankingTsPath), [System.IO.Path]::GetFullPath($rankingCsPath)) | Sort-Object
$actualRankingOwners = @($rankingLiteralOwners | ForEach-Object { $_.FullName } | Sort-Object -Unique)
if (@(Compare-Object -ReferenceObject $expectedRankingOwners -DifferenceObject $actualRankingOwners).Count -ne 0) {
  $violations.Add("Tool-search ranking V3 must have exactly the reviewed MCP and native algorithm owners")
}
foreach ($relativePath in @(
  "apps/mcp-server/src/lib/toolSearchRanking.test.ts",
  "apps/revit-bridge-addin/RevitBridge.Common.Tests/OperatorToolSearchRankingTests.cs"
)) {
  $path = Resolve-RepoPath $relativePath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
      (Get-Content -Raw -LiteralPath $path) -notmatch 'revit_operator\.tool_search_ranking_golden_vectors/v3') {
    $violations.Add("$relativePath does not enforce the shared cross-process ranking vectors")
  }
}
$nativeEvidenceConsumers = @(
  @{ Path = "apps/operator-backend/src/benchmark/assignment_kernel_v2_acceptance.ts"; Function = "nativeOperationIdentityFromResultSchemaV2" },
  @{ Path = "apps/operator-backend/src/benchmark/durable_tool_evidence.ts"; Function = "assignmentKernelNativeEvidenceProjectionV2" },
  @{ Path = "apps/operator-backend/src/benchmark/general_revit_latency.ts"; Function = "assignmentKernelNativeEvidenceProjectionV2" },
  @{ Path = "apps/operator-backend/src/benchmark/protocol_v2_case.ts"; Function = "assignmentKernelNativeEvidenceProjectionV2" }
)
foreach ($consumer in $nativeEvidenceConsumers) {
  $path = Resolve-RepoPath $consumer.Path
  $content = Get-Content -Raw -LiteralPath $path
  if ($content -notmatch [regex]::Escape($consumer.Function)) {
    $violations.Add("$($consumer.Path) does not consume the shared V2 native-evidence contract")
  }
  if ($content -match 'operation\.request_identity') {
    $violations.Add("$($consumer.Path) reconstructs native execution from a wrapper request identity")
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
