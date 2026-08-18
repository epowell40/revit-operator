import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { findRepoRoot } from "../src/tools/audit_tool_registry.js";

function addinFile(relativePath: string): string {
  const root = findRepoRoot(process.cwd());
  const addin = fs.existsSync(path.join(root, "apps", "revit-bridge-addin"))
    ? path.join(root, "apps", "revit-bridge-addin")
    : path.join(root, "revit-bridge-addin");
  return fs.readFileSync(path.join(addin, relativePath), "utf8");
}

function repoFile(rootRelativePath: string, publicRelativePath: string): string {
  const root = findRepoRoot(process.cwd());
  const candidate = fs.existsSync(path.join(root, "apps", "operator-backend"))
    ? path.join(root, publicRelativePath)
    : path.join(root, rootRelativePath);
  return fs.readFileSync(candidate, "utf8");
}

test("Revit ExternalEvent scheduler is single-flight and reports raise failures", () => {
  const source = addinFile(path.join("RevitBridge", "Services", "RevitEventService.cs"));
  assert.match(source, /Interlocked\.CompareExchange\(ref _inFlight, 1, 0\)/);
  assert.doesNotMatch(source, /while\s*\(\s*_queue\.TryDequeue/);
  assert.match(source, /ExternalEventRequest\.Denied/);
  assert.match(source, /Accepted, Pending, and TimedOut all remain known pre-execution states/);
  assert.match(source, /MaintainRaiseUntilStartedAsync\(item\)/);
  assert.doesNotMatch(source, /revit_external_event_still_pending/);
  assert.match(source, /revit_external_event_busy/);
  assert.match(source, /cancellationToken\.Register\(\(\) => CancelQueuedItem\(item\)\)/);
  assert.match(source, /QueueItem\.CancelledBeforeStart/);
  assert.match(source, /CancelQueuedItem[\s\S]{0,1200}Interlocked\.Exchange\(ref _inFlight, 0\)/);
  assert.doesNotMatch(source, /cancellationToken\.Register\(\(\) => tcs\.TrySetCanceled\(\)\)/);
  const execute = source.slice(source.indexOf("public void Execute"), source.indexOf("public string GetName"));
  const releasesSingleFlight = execute.indexOf("Interlocked.Exchange(ref _inFlight, 0)");
  assert.ok(releasesSingleFlight >= 0);
  assert.ok(releasesSingleFlight < execute.indexOf("item.Completion.TrySetResult(result!)"));
  assert.ok(releasesSingleFlight < execute.indexOf("item.Completion.TrySetException(error)"));
});

test("metadata and native discovery bypass the Revit event queue while actions propagate cancellation", () => {
  const runner = addinFile(path.join("RevitBridge", "Operator", "OperatorActionRunner.cs"));
  const server = addinFile(path.join("RevitBridge", "Server", "RevitHttpServer.cs"));
  const courier = addinFile(path.join("RevitBridge", "Operator", "OperatorRevitCourierWorker.cs"));
  const courierBusyRetry = addinFile(path.join("RevitBridge.Common", "OperatorCourierBusyRetryExecutor.cs"));
  for (const route of ["tool-registry", "tool-search", "tool-doc", "tool-examples", "native-api-policy", "native-api-catalog", "native-api-search"]) {
    assert.match(runner, new RegExp(`/revit/${route}`));
    assert.match(server, new RegExp(`/revit/${route}`));
  }
  assert.match(runner, /OperatorActionDeadlinePolicy\.Resolve/);
  assert.match(runner, /},\s*localDeadline\.Token,\s*correlationId\)\.ConfigureAwait\(false\)/);
  assert.match(server, /X-Operator-Correlation-Id/);
  assert.match(server, /deadline\.CreateTimeoutException\(correlationId\)/);
  assert.match(server, /root is RevitEventQueueException/);
  assert.match(courier, /OperatorCourierBusyRetryExecutor\.ExecuteAsync/);
  assert.match(courierBusyRetry, /failure\.Code, "revit_external_event_busy"/);
  assert.match(courierBusyRetry, /failure\.Retryable[\s\S]{0,160}!failure\.OutcomeUnknown/);
  assert.match(courierBusyRetry, /Task\.Delay\(milliseconds, token\)/);
  assert.match(courierBusyRetry, /await delayAsync\(delayMs, cancellationToken\)/);
});

test("high-value spatial query contracts reject stale payloads before handler execution", () => {
  const schemas = addinFile(path.join("RevitBridge", "Operator", "OperatorToolIntrospection.cs"));
  const validator = addinFile(path.join("RevitBridge", "Operator", "OperatorActionSchemaValidator.cs"));
  const server = addinFile(path.join("RevitBridge", "Server", "RevitHttpServer.cs"));
  const examples = JSON.parse(addinFile(path.join("RevitBridge", "Tooling", "tool_examples.json"))) as { tools: Array<{ path: string; examples: Array<{ request: Record<string, unknown> }> }> };
  for (const route of ["/revit/resolve-room-plan-view", "/revit/query-zone-data", "/revit/room_mep_intersect"]) {
    assert.match(schemas, new RegExp(route.replace(/[/-]/g, match => `\\${match}`)));
    assert.match(validator, new RegExp(route.replace(/[/-]/g, match => `\\${match}`)));
  }
  assert.match(server, /root is ArgumentException[\s\S]{0,300}statusCode = 400/);
  const roomPlan = examples.tools.find(tool => tool.path === "/revit/resolve-room-plan-view")?.examples[0]?.request;
  assert.equal(roomPlan?.roomNumber, "403");
  assert.equal(roomPlan?.levelName, undefined);
  const zoneQuery = examples.tools.find(tool => tool.path === "/revit/query-zone-data")?.examples[0]?.request;
  assert.equal(zoneQuery?.levelName, "Level 1");
});

test("create-view discovery exposes a conditional tagged union instead of requiring every string selector", () => {
  const schemas = addinFile(path.join("RevitBridge", "Operator", "OperatorToolIntrospection.cs"));
  const manual = schemas.slice(
    schemas.indexOf('if (string.Equals(p, "/revit/create-view", StringComparison.OrdinalIgnoreCase))'),
    schemas.indexOf("// Some tools accept null bodies intentionally"),
  );
  assert.match(schemas, /create-view is a tagged union/);
  assert.match(manual, /required: Array\.Empty<string>\(\)/);
  assert.match(manual, /rename_batch/);
  assert.match(manual, /viewIds/);
  assert.match(manual, /findText/);
  assert.match(schemas, /Fields are conditional on action/);
  assert.match(schemas, /rename_batch requires viewIds or nameContains/);
});

test("parameter-query discovery does not require mutually exclusive aliases or optional filters together", () => {
  const schemas = addinFile(path.join("RevitBridge", "Operator", "OperatorToolIntrospection.cs"));
  const parameterQuery = schemas.slice(
    schemas.indexOf('if (string.Equals(p, "/revit/find-elements-by-parameter", StringComparison.OrdinalIgnoreCase))'),
    schemas.indexOf("// Default: schema from request type when known"),
  );
  assert.match(schemas, /alternative request shapes/);
  assert.match(parameterQuery, /WithRequiredFields\(SchemaFromType\(RequestTypesByPath\[p\], depth: 0\)\)/);
  assert.doesNotMatch(parameterQuery, /WithRequiredFields\([^\n]+"parameterName"/);
  assert.doesNotMatch(parameterQuery, /WithRequiredFields\([^\n]+"systemName"/);
});

test("view-query discovery publishes the native paging bounds used by validation", () => {
  const schemas = addinFile(path.join("RevitBridge", "Operator", "OperatorToolIntrospection.cs"));
  const manifest = addinFile(path.join("RevitBridge", "Operator", "OperatorToolManifest.cs"));
  const viewSchema = schemas.slice(
    schemas.indexOf('if (string.Equals(p, "/revit/views", StringComparison.OrdinalIgnoreCase)'),
    schemas.indexOf("// Sheets listing (paging + prefix matching)."),
  );
  assert.match(viewSchema, /"offset", Int\(minimum: 0, maximum: 200000\)/);
  assert.match(viewSchema, /"limit", Int\(minimum: 1, maximum: 500\)/);
  assert.match(schemas, /schema\["minimum"\] = minimum\.Value/);
  assert.match(schemas, /schema\["maximum"\] = maximum\.Value/);
  assert.match(manifest, /offset is 0\.\.200000 and limit is 1\.\.500; page again when truncated=true/);
});

test("view visibility exposes a typed rollback-previewed Plan View Range setter", () => {
  const handler = addinFile(path.join("RevitBridge", "Handlers", "ViewVisibilityHandler.cs"));
  const logicHandler = addinFile(path.join("RevitBridge.Logic", "Handlers", "ViewVisibilityHandler.cs"));
  const validator = addinFile(path.join("RevitBridge", "Operator", "OperatorActionSchemaValidator.cs"));
  const schemas = addinFile(path.join("RevitBridge", "Operator", "OperatorToolIntrospection.cs"));
  const manifest = addinFile(path.join("RevitBridge", "Operator", "OperatorToolManifest.cs"));
  const examples = JSON.parse(addinFile(path.join("RevitBridge", "Tooling", "tool_examples.json"))) as { tools: Array<{ path: string; examples: Array<{ name: string; request: Record<string, unknown> }> }> };
  for (const source of [handler, logicHandler]) {
    assert.match(source, /case "set_view_range"/);
    assert.match(source, /PlanViewPlane\.TopClipPlane/);
    assert.match(source, /PlanViewPlane\.ViewDepthPlane/);
    assert.match(source, /plan\.SetViewRange\(range\)/);
    assert.match(source, /new Transaction\(doc, "Preview View Range"\)[\s\S]{0,500}tx\.RollBack\(\)/);
    assert.match(source, /current[\s\S]{0,250}proposed/);
    assert.match(source, /viewRange = BuildViewRangeState/);
  }
  assert.match(validator, /visibilityAction == "set_view_range"/);
  assert.match(validator, /viewRangeDepthOffsetFeet/);
  assert.match(schemas, /"set_view_range"/);
  assert.match(manifest, /set_view_range changes only supplied plane level\/offset fields/i);
  const visibility = examples.tools.find((tool) => tool.path === "/revit/visibility")!;
  const example = visibility.examples.find((candidate) => candidate.name === "Preview plan view range change")!;
  assert.equal(example.request.action, "set_view_range");
  assert.equal(example.request.dryRun, true);
  assert.equal(example.request.viewRangeDepthLevelName, "Level 2");
});

test("native API operation graph stays bounded, read-only, and request-ephemeral while supporting typed chaining", () => {
  const gateway = addinFile(path.join("RevitBridge", "Operator", "OperatorNativeApiGateway.cs"));
  const approval = addinFile(path.join("RevitBridge", "Operator", "OperatorApprovalPolicy.cs"));
  const manifest = addinFile(path.join("RevitBridge", "Operator", "OperatorToolManifest.cs"));
  assert.match(gateway, /InvokeReadOnlyOperations/);
  assert.match(gateway, /operations\.Count > 16/);
  assert.match(gateway, /get_property/);
  assert.match(gateway, /ResolveOperationTarget/);
  assert.match(gateway, /ResolveReadableProperty/);
  assert.match(gateway, /argument \$ref/);
  assert.match(gateway, /result_preview = OperationPreview\(raw\)/);
  assert.match(gateway, /deferred_enumeration = true/);
  assert.match(gateway, /maxOperationMs/);
  assert.match(gateway, /maxOperationMs must be less than or equal to maxTotalMs/);
  assert.match(gateway, /Math\.Min\(2000, maxTotalMs\)/);
  assert.doesNotMatch(gateway, /ClampBudget/);
  assert.match(
    addinFile(path.join("RevitBridge", "Handlers", "NativeApiHandlers.cs")),
    /catch \(InvalidOperationException ex\)[\s\S]{0,600}throw new ArgumentException\(ex\.Message, ex\)/,
  );
  assert.match(gateway, /static_calls = true/);
  assert.match(gateway, /descriptor\.RiskLevel != OperatorActionRisk\.Low/);
  assert.match(gateway, /ephemeral_handles = true/);
  assert.match(gateway, /read_only = true/);
  assert.match(approval, /\/revit\/native-api-ops["\s,]+StringComparison\.OrdinalIgnoreCase\)\) return OperatorActionRisk\.Low/);
  assert.match(manifest, /\/revit\/native-api-ops[\s\S]{0,160}OperatorActionRisk\.Low/);
  assert.doesNotMatch(gateway, /static\s+readonly\s+Dictionary<[^>]+>\s+_handles/i);
});

test("native API mutation graph uses a separate write-gated transaction envelope and rolls back out-of-scope effects", () => {
  const gateway = addinFile(path.join("RevitBridge", "Operator", "OperatorNativeApiGateway.cs"));
  const approval = addinFile(path.join("RevitBridge", "Operator", "OperatorApprovalPolicy.cs"));
  const manifest = addinFile(path.join("RevitBridge", "Operator", "OperatorToolManifest.cs"));
  const validator = addinFile(path.join("RevitBridge", "Operator", "OperatorActionSchemaValidator.cs"));
  const handler = addinFile(path.join("RevitBridge", "Handlers", "NativeApiHandlers.cs"));
  const runner = addinFile(path.join("RevitBridge", "Operator", "OperatorActionRunner.cs"));
  const scopePolicy = addinFile(path.join("RevitBridge.Common", "OperatorNativeMutationScopePolicy.cs"));

  assert.match(gateway, /InvokeMutationOperations/);
  assert.match(gateway, /native-api-ops is permanently read-only and does not accept a transaction envelope/);
  assert.match(gateway, /OperatorNativeMutationFailureRegistry/);
  assert.match(gateway, /RegisterMutationScopeUpdater\(app, transactionDocument!\)/);
  assert.match(gateway, /new Transaction\(transactionDocument!, transactionName\)/);
  assert.match(gateway, /new NativeMutationScopeFailuresPreprocessor/);
  assert.match(gateway, /SetFailuresPreprocessor\(mutationScopePreprocessor\)/);
  assert.match(gateway, /PostFailure\(checkpoint\)/);
  assert.match(gateway, /var transactionStatus = transaction\.Commit\(\)/);
  assert.match(gateway, /transactionMode == "rollback" \|\| !ScopeDecision\.Allowed[\s\S]{0,900}ProceedWithRollBack/);
  assert.match(gateway, /transactionMode == "rollback" \|\| !ScopeDecision\.Allowed[\s\S]{0,700}GetSeverity\(\) == FailureSeverity\.Warning[\s\S]{0,120}DeleteWarning\(failure\)/);
  assert.doesNotMatch(gateway, /new TransactionGroup\(/);
  assert.match(gateway, /ValidateMutationOwnership/);
  assert.match(gateway, /if \(!SameDocument\(operationOwner, activeDocument\)\)/);
  assert.match(gateway, /UpdaterRegistry\.RegisterUpdater\(updater, document\)/);
  assert.match(gateway, /UpdaterRegistry\.AddTrigger\(updater\.GetUpdaterId\(\), document/);
  assert.match(gateway, /private static bool SameDocument[\s\S]{0,280}left\.Equals\(right\) \|\| right\.Equals\(left\)/);
  assert.doesNotMatch(gateway, /ReferenceEquals\(operationOwner, activeDocument\)/);
  assert.match(gateway, /maxAffectedElements < 1 \|\| maxAffectedElements > 64/);
  assert.match(gateway, /OperatorNativeMutationScopePolicy\.Evaluate/);
  assert.match(gateway, /if \(!scopeDecision\.Allowed\)[\s\S]{0,260}transactionStatus != TransactionStatus\.RolledBack/);
  assert.match(gateway, /Verified failure-processing rollback status/);
  assert.match(gateway, /transactionMode == "rollback" && transactionStatus != TransactionStatus\.RolledBack/);
  assert.match(gateway, /transactionMode == "commit" && transactionStatus != TransactionStatus\.Committed/);
  assert.match(gateway, /Native mutation transaction cleanup could not be verified/);
  assert.doesNotMatch(scopePolicy, /was rolled back/);
  assert.match(gateway, /ElementIdCompat\.GetValue/);
  assert.match(gateway, /ElementIdCompat\.Create/);
  assert.match(scopePolicy, /affected existing elements outside transaction\.allowedExistingElementIds/);
  assert.match(scopePolicy, /affected_element_cap_exceeded/);
  assert.match(scopePolicy, /creation_not_allowed/);
  assert.match(scopePolicy, /allowUnexpectedExistingForRollback/);
  assert.match(scopePolicy, /rollback_scope_discovered/);
  assert.match(gateway, /allowUnexpectedExistingForRollback: _transactionMode == "rollback"/);
  assert.match(gateway, /scope_discovery_only = transactionMode == "rollback" && !scopeDecision\.ExistingScopeMatched/);
  assert.match(gateway, /commit_allowed_existing_element_ids/);
  assert.match(gateway, /mutationOperationCount == 0/);
  assert.match(gateway, /provided\.Count > ps\.Length/);
  assert.match(gateway, /descriptor\.FreezeRiskHint/);
  assert.match(gateway, /operator\.native_api_mutation_ops\.v1/);
  assert.match(approval, /\/revit\/native-api-mutation-ops["\s,]+StringComparison\.OrdinalIgnoreCase\)\) return OperatorActionRisk\.High/);
  assert.match(manifest, /\/revit\/native-api-mutation-ops[\s\S]{0,220}OperatorActionRisk\.High/);
  assert.match(validator, /native-api-mutation-ops\.transaction\.maxAffectedElements must be an integer between 1 and 64/);
  assert.match(handler, /class NativeApiMutationOpsHandler[\s\S]{0,500}InvokeMutationOperations/);
  assert.match(runner, /\/revit\/native-api-mutation-ops["\s,]+new NativeApiMutationOpsHandler/);
});

test("hosted MCP courier is session-bound, approval-gated, and never auto-replays an uncertain write", () => {
  const app = addinFile(path.join("RevitBridge", "App.cs"));
  const pane = addinFile(path.join("RevitBridge", "Operator", "OperatorPaneControl.cs"));
  const worker = addinFile(path.join("RevitBridge", "Operator", "OperatorRevitCourierWorker.cs"));
  const resultCompactor = addinFile(path.join("RevitBridge.Common", "OperatorCourierResultCompactor.cs"));
  const index = repoFile(path.join("operator-backend", "src", "index.ts"), path.join("apps", "operator-backend", "src", "index.ts"));
  const queue = repoFile(path.join("operator-backend", "src", "courier", "revit_tool_jobs.ts"), path.join("apps", "operator-backend", "src", "courier", "revit_tool_jobs.ts"));
  const mcpClient = repoFile(path.join("mcp-server", "src", "lib", "revitClient.ts"), path.join("apps", "mcp-server", "src", "lib", "revitClient.ts"));
  const codexBrain = repoFile(path.join("operator-backend", "src", "brains", "codex_brain.ts"), path.join("apps", "operator-backend", "src", "brains", "codex_brain.ts"));
  assert.match(worker, /ClaimNextRevitCourierJobJsonAsync/);
  assert.match(worker, /OperatorApprovalPolicy\.RequiresApproval/);
  assert.match(worker, /_actionRunner\.ExecuteAsync/);
  assert.match(worker, /ReadRequiredString\(job, "correlation_id", 160\)/);
  assert.match(worker, /OperatorActionDeadlinePolicy\.Resolve[\s\S]{0,200}ConstrainTo\(remaining\)/);
  assert.match(
    worker,
    /OperatorCourierResultCompactor\.Prepare\(result\)[\s\S]{0,240}_completionOutbox\.Save[\s\S]{0,240}CompleteRevitCourierJobJsonAsync/,
  );
  assert.match(
    worker,
    /OperatorCourierResultCompactor\.Prepare\(completion\.Result\)[\s\S]{0,500}_completionOutbox\.Save[\s\S]{0,500}CompleteRevitCourierJobJsonAsync/,
  );
  assert.match(worker, /catch \(OperatorCourierTerminalConflictException ex\)/);
  assert.match(worker, /ResolveTerminalConflict\(completion\.JobId, ex\.Message\)/);
  assert.match(worker, /courier\.completion\.reconciled_terminal/);
  assert.match(resultCompactor, /MaxTransportResultBytes = 600_000/);
  assert.match(resultCompactor, /requires_refinement_for_complete_rows/);
  assert.match(resultCompactor, /result is string text/);
  assert.match(resultCompactor, /JsonDocument\.Parse\(text\)/);
  assert.doesNotMatch(worker, /_turnBusy/);
  assert.match(app, /_revitCourierWorker = new OperatorRevitCourierWorker\(/);
  assert.match(app, /Application-lifetime Revit courier worker started/);
  assert.match(app, /_revitCourierWorker\?\.Dispose\(\)/);
  assert.match(app, /GetCourierApprovalMode[\s\S]{0,500}OperatorWriteGrant\.ReadStatus\(\)/);
  assert.doesNotMatch(pane, /new OperatorRevitCourierWorker\(/);
  assert.match(index, /\/api\/revit-courier\/claim-next/);
  assert.match(index, /pathname\.startsWith\("\/api\/revit-courier\/jobs\/"\)/);
  assert.match(queue, /execution_lease_expired_outcome_unknown/);
  assert.doesNotMatch(queue, /status:\s*"pending"[\s\S]{0,160}Previous claim expired/);
  assert.match(mcpClient, /OPERATOR_REVIT_TRANSPORT/);
  assert.match(mcpClient, /callRevitViaCourier/);
  assert.match(codexBrain, /clientsByProfile = new Map/);
  assert.match(codexBrain, /function clientCacheKey\(workspaceRoot: string, profile: CodexThreadStartProfile\)/);
  assert.match(codexBrain, /profile\.profileNamespace/);
  assert.match(codexBrain, /mcpRuntimesByWorkspace = new Map/);
  assert.match(codexBrain, /fn:\s*\(client: CodexAppServer\)/);
  assert.doesNotMatch(codexBrain, /let client:\s*CodexAppServer\s*\|\s*null/);
});

test("native direct Revit execution requires the authenticated fixed certification endpoint", () => {
  const index = repoFile(path.join("operator-backend", "src", "index.ts"), path.join("apps", "operator-backend", "src", "index.ts"));
  const authorization = repoFile(
    path.join("operator-backend", "src", "capabilities", "direct_revit_execution_authorization.ts"),
    path.join("apps", "operator-backend", "src", "capabilities", "direct_revit_execution_authorization.ts")
  );
  assert.match(index, /pathname === "\/api\/revit-direct\/authorize-execution"/);
  assert.match(index, /authorizeDirectRevitExecution\(body\)/);
  assert.match(authorization, /revit-operator\.revit-direct-admission-request\.v1/);
  assert.match(authorization, /revit-operator\.revit-direct-admission-request\.v2/);
  assert.match(authorization, /revit-operator\.revit-direct-admission-request\.v3/);
  assert.match(authorization, /phase:\s*"certification_native_direct_admission"/);
  assert.match(authorization, /valid_for_ms:\s*DIRECT_REVIT_AUTHORIZATION_VALID_FOR_MS/);
  assert.match(authorization, /DIRECT_REQUEST_V1_KEYS\s*=\s*\[[^\]]*"channel",\s*"alias"\]/);
  assert.match(authorization, /DIRECT_REQUEST_V2_KEYS\s*=\s*\[\.\.\.DIRECT_REQUEST_V1_KEYS,\s*"runtime_mode"\]/);
  assert.match(authorization, /DIRECT_REQUEST_V3_KEYS\s*=\s*\[[\s\S]{0,300}"request_family_admission"/);
  assert.match(authorization, /validateCertifiedRequestFamilyAdmission\(request\.request_family_admission/);
  assert.match(authorization, /evaluateTrustedToolExposurePolicy\(\{[\s\S]{0,300}channel,[\s\S]{0,80}alias/);
  assert.match(authorization, /request\.policy_hash !== trusted\.policy\.policy_hash/);
  assert.match(authorization, /request\.effect_hash !== record\.effect_hash/);
});

test("geometry-aware tag placement excludes only section-box control volumes from annotation obstacles", () => {
  const handler = addinFile(path.join("RevitBridge.Logic", "Handlers", "TagElementsHandler.cs"));

  const annotationObstacleBranch = handler.match(
    /if \((element\.Category\.CategoryType == CategoryType\.Annotation\s*&&\s*ElementIdCompat\.GetValue\(element\.Category\.Id\) != \(long\)BuiltInCategory\.OST_SectionBox)\)\s*\{([\s\S]*?)\r?\n\s*\}\r?\n\s*else if/,
  );
  assert.ok(annotationObstacleBranch);
  assert.equal(annotationObstacleBranch[1].match(/BuiltInCategory\./g)?.length, 1);
  assert.match(annotationObstacleBranch[2], /obstacles\.HeadObstacles\.Add\(rect\)/);
  assert.match(annotationObstacleBranch[2], /obstacles\.LeaderProtectedObstacles\.Add\(rect\)/);
});

test("Revit batch settlement forwards the exact fencing token", () => {
  const index = repoFile(path.join("operator-backend", "src", "index.ts"), path.join("apps", "operator-backend", "src", "index.ts"));
  const batch = repoFile(
    path.join("operator-backend", "src", "revit_batch", "service.ts"),
    path.join("apps", "operator-backend", "src", "revit_batch", "service.ts"),
  );

  assert.match(index, /claim_token\s*\?\?\s*\(body as any\)\?\.claimToken/);
  assert.match(index, /completeRevitBatchItem\(\{[\s\S]{0,220}claim_token:\s*claimToken/);
  assert.match(index, /failRevitBatchItem\(\{[\s\S]{0,260}claim_token:\s*claimToken/);
  assert.match(batch, /claim_token is required to settle this fenced batch claim/);
  assert.match(batch, /Stale or invalid batch claim_token/);
});
