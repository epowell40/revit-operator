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
  assert.match(source, /ExternalEventRequest\.TimedOut/);
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
  assert.match(gateway, /transactionMode == "rollback" \|\| !ScopeDecision\.Allowed[\s\S]{0,120}ProceedWithRollBack/);
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
  assert.match(codexBrain, /clientsByWorkspace = new Map/);
  assert.match(codexBrain, /fn:\s*\(client: CodexAppServer\)/);
  assert.doesNotMatch(codexBrain, /let client:\s*CodexAppServer\s*\|\s*null/);
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
