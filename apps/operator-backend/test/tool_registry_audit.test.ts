import assert from "node:assert/strict";
import test from "node:test";
import { buildRegistryAudit, canonicalRegistryDigestSha256, findRepoRoot, renderAuditCsv, renderAuditMarkdown } from "../src/tools/audit_tool_registry.js";

test("tool registry audit inventories the complete source catalog without claiming live usefulness", () => {
  const repoRoot = findRepoRoot(process.cwd());
  const audit = buildRegistryAudit({ repoRoot });
  assert.equal(audit.tools.length, 215);
  assert.equal(new Set(audit.tools.map(tool => tool.key)).size, audit.tools.length);
  assert.equal(audit.summary.manifest_entries, audit.tools.length);
  assert.ok(audit.tools.every(tool => tool.evidence.live_safe === null));
  assert.ok(audit.tools.every(tool => tool.evidence.useful === null));
  assert.ok(audit.tools.some(tool => tool.mcp.generic_call_available));
  assert.equal(audit.summary.generic_schema_only, audit.tools.filter(tool => tool.issues.includes("generic_request_schema_only")).length);
  assert.equal(audit.summary.missing_action_runtime, audit.tools.filter(tool => tool.issues.includes("missing_operator_action_runtime")).length);
  assert.equal(audit.summary.missing_http_runtime, audit.tools.filter(tool => tool.issues.includes("missing_direct_http_runtime")).length);
  assert.equal(audit.reconciliation.duplicate_manifest_keys.length, 0);
  assert.equal(audit.reconciliation.private_only_manifest_keys.length, 0);
  assert.equal(audit.reconciliation.public_only_manifest_keys.length, 0);
  assert.ok(audit.reconciliation.method_variant_paths.some(item => item.path === "/revit/views"));
  assert.ok(audit.reconciliation.shared_handler_aliases.some(item => item.paths.includes("/revit/warnings") && item.paths.includes("/revit/export-warnings-report")));
  assert.deepEqual(audit.reconciliation.control_plane_external_event_routes, []);
  assert.ok(audit.tools.filter(tool => tool.surface_kind === "ui_host").every(tool => !tool.issues.includes("generic_request_schema_only")));
  assert.ok(audit.tools.filter(tool => tool.surface_kind === "pane_backend").every(tool => !tool.mcp.generic_call_available));
  assert.equal(audit.tools.find(tool => tool.path === "/revit/capture-screenshare")?.surface_kind, "pane_backend");
  assert.equal(audit.tools.find(tool => tool.path === "/revit/schedules")?.contracts.request_schema_source, "explicit");
  assert.ok(!audit.tools.find(tool => tool.path === "/revit/schedules")?.issues.includes("reflected_request_schema_unverified"));
  assert.equal(audit.tools.find(tool => tool.path === "/revit/get-parameters")?.contracts.request_schema_source, "explicit");
  assert.ok(audit.tools.some(tool => tool.path === "/revit/duplicate-sheet"));
  assert.ok(!audit.tools.find(tool => tool.path === "/revit/get-parameters")?.issues.includes("reflected_request_schema_unverified"));
  assert.equal(audit.tools.find(tool => tool.path === "/revit/native-api-ops")?.contracts.request_schema_source, "explicit");
  assert.equal(audit.tools.find(tool => tool.path === "/revit/native-api-mutation-ops")?.contracts.request_schema_source, "explicit");
  for (const path of ["/revit/resolve-room-plan-view", "/revit/query-zone-data", "/revit/room_mep_intersect"]) {
    assert.equal(audit.tools.find(tool => tool.path === path)?.contracts.request_schema_source, "explicit");
    assert.ok(!audit.tools.find(tool => tool.path === path)?.issues.includes("reflected_request_schema_unverified"));
  }
  assert.match(renderAuditCsv(audit), /^key,group,risk,/);
  const markdown = renderAuditMarkdown(audit);
  assert.match(markdown, /live_safe=true.*bounded read-only.*useful=true/i);
  assert.match(markdown, /Cross-surface reconciliation/);
  assert.match(markdown, /Shared-handler aliases/);
});

test("typed MCP wrappers are attributed to the exact method and path", () => {
  const repoRoot = findRepoRoot(process.cwd());
  const audit = buildRegistryAudit({ repoRoot });
  const typed = (key: string) => audit.tools.find(tool => tool.key === key)?.mcp.typed_tools ?? [];

  assert.deepEqual(typed("GET /revit/views"), ["revit_list_views"]);
  assert.deepEqual(typed("POST /revit/views"), ["revit_query_views"]);
  assert.deepEqual(typed("GET /revit/native-api-policy"), ["revit_native_api_policy"]);
  assert.deepEqual(typed("POST /revit/native-api-policy"), ["revit_native_api_set_policy"]);
  assert.deepEqual(typed("POST /revit/tool-search"), ["revit_search_tools"]);
  assert.ok(!typed("GET /revit/tool-registry").includes("revit_call_tool"));
  assert.deepEqual(typed("POST /revit/repair-mep-connectors"), [
    "revit_dry_run_repair_mep_connectors",
    "revit_repair_mep_connectors"
  ]);
  assert.ok(!typed("POST /revit/repair-mep-connectors").includes("revit_repair_duct_continuity_by_scope"));
  assert.deepEqual(typed("POST /revit/fire-damper-audit"), ["fire_damper_audit"]);
  assert.deepEqual(typed("POST /revit/lighting-audit"), ["audit_lpd", "check_photometrics", "validate_ies_files"]);
  assert.ok(!typed("POST /revit/lighting-audit").includes("revit_run_fire_alarm_layout"));
});

test("registry digests use canonical LF-normalized UTF-8 bytes", () => {
  const lf = "{\n  \"tools\": [\n    \"GET /revit/ping\"\n  ]\n}\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  const loneCr = lf.replace(/\n/g, "\r");
  const digest = canonicalRegistryDigestSha256(lf);

  assert.match(digest, /^[A-F0-9]{64}$/);
  assert.equal(canonicalRegistryDigestSha256(crlf), digest);
  assert.equal(canonicalRegistryDigestSha256(loneCr), digest);
  assert.notEqual(canonicalRegistryDigestSha256(lf.replace("ping", "context")), digest);
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
