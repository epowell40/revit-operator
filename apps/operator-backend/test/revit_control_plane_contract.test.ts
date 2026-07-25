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
});

test("metadata and native discovery bypass the Revit event queue while actions propagate cancellation", () => {
  const runner = addinFile(path.join("RevitBridge", "Operator", "OperatorActionRunner.cs"));
  const server = addinFile(path.join("RevitBridge", "Server", "RevitHttpServer.cs"));
  for (const route of ["tool-registry", "tool-search", "tool-doc", "tool-examples", "native-api-policy", "native-api-catalog", "native-api-search"]) {
    assert.match(runner, new RegExp(`/revit/${route}`));
    assert.match(server, new RegExp(`/revit/${route}`));
  }
  assert.match(runner, /},\s*cancellationToken\)\.ConfigureAwait\(false\)/);
  assert.match(server, /root is RevitEventQueueException/);
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

test("native API operation graph retains only ephemeral per-request references", () => {
  const gateway = addinFile(path.join("RevitBridge", "Operator", "OperatorNativeApiGateway.cs"));
  assert.match(gateway, /InvokeReadOnlyOperations/);
  assert.match(gateway, /operations\.Count > 16/);
  assert.match(gateway, /target must reference a prior result/);
  assert.match(gateway, /descriptor\.RiskLevel != OperatorActionRisk\.Low/);
  assert.match(gateway, /ephemeral_handles = true/);
  assert.doesNotMatch(gateway, /static\s+readonly\s+Dictionary<[^>]+>\s+_handles/i);
});

test("hosted MCP courier is session-bound, approval-gated, and never auto-replays an uncertain write", () => {
  const worker = addinFile(path.join("RevitBridge", "Operator", "OperatorRevitCourierWorker.cs"));
  const index = repoFile(path.join("operator-backend", "src", "index.ts"), path.join("apps", "operator-backend", "src", "index.ts"));
  const queue = repoFile(path.join("operator-backend", "src", "courier", "revit_tool_jobs.ts"), path.join("apps", "operator-backend", "src", "courier", "revit_tool_jobs.ts"));
  const mcpClient = repoFile(path.join("mcp-server", "src", "lib", "revitClient.ts"), path.join("apps", "mcp-server", "src", "lib", "revitClient.ts"));
  const codexBrain = repoFile(path.join("operator-backend", "src", "brains", "codex_brain.ts"), path.join("apps", "operator-backend", "src", "brains", "codex_brain.ts"));
  assert.match(worker, /ClaimNextRevitCourierJobJsonAsync/);
  assert.match(worker, /OperatorApprovalPolicy\.RequiresApproval/);
  assert.match(worker, /_actionRunner\.ExecuteAsync/);
  assert.doesNotMatch(worker, /_turnBusy/);
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
