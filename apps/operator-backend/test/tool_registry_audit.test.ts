import assert from "node:assert/strict";
import test from "node:test";
import { buildRegistryAudit, findRepoRoot, renderAuditCsv, renderAuditMarkdown } from "../src/tools/audit_tool_registry.js";

test("tool registry audit inventories the complete source catalog without claiming live usefulness", () => {
  const repoRoot = findRepoRoot(process.cwd());
  const audit = buildRegistryAudit({ repoRoot });
  assert.ok(audit.tools.length > 150);
  assert.equal(new Set(audit.tools.map(tool => tool.key)).size, audit.tools.length);
  assert.equal(audit.summary.manifest_entries, audit.tools.length);
  assert.ok(audit.tools.every(tool => tool.evidence.live_safe === null));
  assert.ok(audit.tools.every(tool => tool.evidence.useful === null));
  assert.ok(audit.tools.some(tool => tool.mcp.generic_call_available));
  assert.equal(audit.summary.generic_schema_only, audit.tools.filter(tool => tool.issues.includes("generic_request_schema_only")).length);
  assert.equal(audit.summary.missing_action_runtime, audit.tools.filter(tool => tool.issues.includes("missing_operator_action_runtime")).length);
  assert.equal(audit.summary.missing_http_runtime, audit.tools.filter(tool => tool.issues.includes("missing_direct_http_runtime")).length);
  assert.ok(audit.tools.filter(tool => tool.surface_kind === "ui_host").every(tool => !tool.issues.includes("generic_request_schema_only")));
  assert.ok(audit.tools.filter(tool => tool.surface_kind === "pane_backend").every(tool => !tool.mcp.generic_call_available));
  assert.equal(audit.tools.find(tool => tool.path === "/revit/capture-screenshare")?.surface_kind, "pane_backend");
  assert.equal(audit.tools.find(tool => tool.path === "/revit/schedules")?.contracts.request_schema_source, "explicit");
  assert.ok(!audit.tools.find(tool => tool.path === "/revit/schedules")?.issues.includes("reflected_request_schema_unverified"));
  assert.equal(audit.tools.find(tool => tool.path === "/revit/get-parameters")?.contracts.request_schema_source, "explicit");
  assert.ok(!audit.tools.find(tool => tool.path === "/revit/get-parameters")?.issues.includes("reflected_request_schema_unverified"));
  assert.equal(audit.tools.find(tool => tool.path === "/revit/native-api-ops")?.contracts.request_schema_source, "explicit");
  for (const path of ["/revit/resolve-room-plan-view", "/revit/query-zone-data", "/revit/room_mep_intersect"]) {
    assert.equal(audit.tools.find(tool => tool.path === path)?.contracts.request_schema_source, "explicit");
    assert.ok(!audit.tools.find(tool => tool.path === path)?.issues.includes("reflected_request_schema_unverified"));
  }
  assert.match(renderAuditCsv(audit), /^key,group,risk,/);
  assert.match(renderAuditMarkdown(audit), /live_safe=true.*bounded read-only.*useful=true/i);
});

test("tool registry audit attaches bounded live receipts to the exact method and path", () => {
  const repoRoot = findRepoRoot(process.cwd());
  const audit = buildRegistryAudit({
    repoRoot,
    liveProbeSource: "synthetic-receipts.json",
    liveProbeReport: {
      generated_at: "2026-07-24T20:16:26.959Z",
      receipts: [
        { name: "sheet count", method: "POST", path: "/revit/sheets", duration_ms: 42, transport_ok: true, useful: true },
        { name: "sheet count retry", method: "POST", path: "/revit/sheets", duration_ms: 75, transport_ok: false, useful: false }
      ]
    }
  });
  const sheets = audit.tools.find(tool => tool.key === "POST /revit/sheets");
  assert.ok(sheets);
  assert.equal(sheets.evidence.live_safe, false);
  assert.equal(sheets.evidence.useful, true);
  assert.deepEqual(sheets.live_probes.names, ["sheet count", "sheet count retry"]);
  assert.equal(sheets.live_probes.max_duration_ms, 75);
  assert.equal(audit.summary.live_probed, 1);
  assert.equal(audit.summary.live_useful, 1);
  assert.equal(audit.live_probe_source, "synthetic-receipts.json");
  assert.equal(audit.live_probe_generated_at, "2026-07-24T20:16:26.959Z");
});
