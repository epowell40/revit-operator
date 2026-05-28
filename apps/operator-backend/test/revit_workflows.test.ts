import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { MockBridgeTransport, buildRevitBridgeHeaders, resolveRevitBridgeUrl, resolveRevitBridgeUrlCandidates, runRevitDemoWorkflow, shouldUseMockBridgeFixtures } from "../src/benchmark/revit_workflows.js";

function tempDir(name: string): string {
  const dir = path.join(process.cwd(), "local-work", "revit-workflow-tests", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tinyPdfBytes(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 72 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const pdf = `%PDF-1.4
1 0 obj<<>>endobj
2 0 obj<< /Type /Catalog /Pages 3 0 R>>endobj
3 0 obj<< /Type /Pages /Kids [4 0 R] /Count 1>>endobj
4 0 obj<< /Type /Page /Parent 3 0 R /MediaBox [0 0 300 144] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >>endobj
5 0 obj<< /Length ${stream.length}>>stream
${stream}
endstream endobj
6 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica>>endobj
xref
0 7
0000000000 65535 f 
trailer<< /Root 2 0 R /Size 7>>
startxref
0
%%EOF`;
  return Buffer.from(pdf, "utf8");
}

test("bridge headers include active write grant when present", () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const previousToken = process.env.OPERATOR_TOKEN;
  const root = tempDir("write-grant-header");
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_TOKEN = "test-operator-token";
  fs.writeFileSync(
    path.join(root, "write_grant.json"),
    JSON.stringify({
      token: "grant-token",
      expires_at_utc: new Date(Date.now() + 60_000).toISOString()
    }),
    "utf8"
  );

  try {
    const headers = buildRevitBridgeHeaders();
    assert.equal(headers["x-operator-token"], "test-operator-token");
    assert.equal(headers["x-operator-write-grant"], "grant-token");
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    if (previousToken === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = previousToken;
  }
});

test("sheet export workflow verifies readable PDF page count and sheet identifiers", async () => {
  const dir = tempDir("sheet-pdf-content");
  const pdfPath = path.join(dir, "AEC_Demo_Selected_Sheets.pdf");
  fs.writeFileSync(pdfPath, tinyPdfBytes("A101 Demo Sheet"));

  const result = await runRevitDemoWorkflow(
    {
      workflow: "sheet_export",
      request: {
        sheetNumbers: ["A101"],
        outputFolder: dir,
        baseFileName: "AEC_Demo_Selected_Sheets.pdf",
        combine: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/export-pdf:1": {
        dryRun: true,
        selectedCount: 1,
        selectedSheets: [{ sheetNumber: "A101", name: "Demo Sheet" }],
        plan: [{ path: pdfPath }]
      },
      "/revit/export-pdf:2": {
        dryRun: false,
        combine: true,
        selectedCount: 1,
        selectedSheets: [{ sheetNumber: "A101", name: "Demo Sheet" }],
        outputs: [pdfPath],
        verification: { ok: true, path: pdfPath, exists: true, sizeBytes: fs.statSync(pdfPath).size }
      }
    })
  );

  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "pdf_page_count" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "pdf_contains_sheet_identifiers" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "dry_run_resolved_requested_sheets" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "output_filename_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "output_folder_matches_request" && entry.ok), true);
});

test("sheet export workflow stops before export when requested sheets do not resolve", async () => {
  const dir = tempDir("sheet-missing");
  const bridge = new MockBridgeTransport({
    "/revit/export-pdf:1": {
      dryRun: true,
      selectedCount: 1,
      selectedSheets: [{ sheetNumber: "A101", name: "Demo Sheet" }],
      missingSheets: ["A999"]
    }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "sheet_export",
      request: {
        sheetNumbers: ["A101", "A999"],
        outputFolder: dir,
        baseFileName: "AEC_Demo_Selected_Sheets.pdf",
        combine: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.success, false);
  assert.equal(result.tool_calls, 1);
  assert.equal(bridge.calls.length, 1);
  assert.equal(result.output_artifacts.length, 0);
  assert.equal(result.verification_results.some((entry) => entry.name === "dry_run_resolved_requested_sheets" && !entry.ok), true);
});

test("sheet export workflow fails verification when bridge writes a different requested path", async () => {
  const dir = tempDir("sheet-wrong-path");
  const wrongDir = path.join(dir, "wrong");
  fs.mkdirSync(wrongDir, { recursive: true });
  const pdfPath = path.join(wrongDir, "Wrong_Name.pdf");
  fs.writeFileSync(pdfPath, tinyPdfBytes("A101 Demo Sheet"));

  const result = await runRevitDemoWorkflow(
    {
      workflow: "sheet_export",
      request: {
        sheetNumbers: ["A101"],
        outputFolder: dir,
        baseFileName: "AEC_Demo_Selected_Sheets.pdf",
        combine: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/export-pdf:1": {
        dryRun: true,
        selectedCount: 1,
        selectedSheets: [{ sheetNumber: "A101", name: "Demo Sheet" }]
      },
      "/revit/export-pdf:2": {
        dryRun: false,
        combine: true,
        selectedCount: 1,
        selectedSheets: [{ sheetNumber: "A101", name: "Demo Sheet" }],
        outputs: [pdfPath],
        verification: { ok: true, path: pdfPath, exists: true, sizeBytes: fs.statSync(pdfPath).size }
      }
    })
  );

  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "output_filename_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "output_folder_matches_request" && !entry.ok), true);
});

test("takeoff workflow verifies grouped totals and writes CSV", async () => {
  const dir = tempDir("takeoff");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "takeoff_csv",
      request: {
        intent: "count_and_list",
        categories: ["OST_ElectricalFixtures"],
        group_by: ["Type", "Level", "Room"],
        room_resolution: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/quantify": {
        summary: { total: 2, groups: { "Duplex | Level 1 | 101": 2 } },
        rows: [
          { id: 1, type: "Duplex", level: "Level 1", room: "101" },
          { id: 2, type: "Duplex", level: "Level 1", room: "101" }
        ]
      }
    })
  );

  assert.equal(result.success, true);
  assert.equal(result.tool_calls, 1);
  assert.equal(result.output_artifacts.length, 2);
  assert.ok(fs.existsSync(result.output_artifacts[0]));
  assert.ok(fs.existsSync(result.output_artifacts[1]));
  assert.match(result.user_message, /\| id \| type \| level \| room \|/);
  assert.match(fs.readFileSync(result.output_artifacts[1], "utf8"), /\| 1 \| Duplex \| Level 1 \| 101 \|/);
});

test("parameter workflow fails when readback does not match", async () => {
  const dir = tempDir("parameter-fail");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "parameter_edit",
      request: { elementIds: [10], parameterName: "Comments", value: "EXPECTED" }
    },
    dir,
    new MockBridgeTransport({
      "/revit/get-parameters:1": { items: [{ id: 10, parameters: { Comments: "" } }] },
      "/revit/set-parameter:1": { diffs: [{ elementId: 10, changed: true }] },
      "/revit/set-parameter:2": { changedCount: 1, diffs: [{ elementId: 10, changed: true }] },
      "/revit/get-parameters:2": { items: [{ id: 10, parameters: { Comments: "WRONG" } }] }
    })
  );

  assert.equal(result.success, false);
  assert.equal(result.output_artifacts.length, 1);
  assert.match(fs.readFileSync(result.output_artifacts[0], "utf8"), /\| 10 \| Comments \|  \| EXPECTED \| WRONG \|/);
  assert.equal(result.verification_results.some((entry) => entry.name === "readback_matches_requested_value" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "old_values_captured" && entry.ok), true);
});

test("parameter workflow stops before commit when dry-run reports read-only parameter", async () => {
  const dir = tempDir("parameter-readonly");
  const bridge = new MockBridgeTransport({
    "/revit/get-parameters:1": { items: [{ id: 10, parameters: { Mark: "OLD" } }] },
    "/revit/set-parameter:1": {
      status: "Dry Run",
      dryRun: true,
      diffs: [{ elementId: 10, parameterName: "Mark", ok: false, readOnly: true, error: "Parameter is read-only." }]
    }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "parameter_edit",
      request: { elementIds: [10], parameterName: "Mark", value: "NEW" }
    },
    dir,
    bridge
  );

  assert.equal(result.success, false);
  assert.equal(result.tool_calls, 2);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/set-parameter").length, 1);
  assert.equal(result.verification_results.some((entry) => entry.name === "dry_run_all_changes_ok" && !entry.ok), true);
  assert.match(result.failure_reason ?? "", /dry-run/i);
  assert.match(fs.readFileSync(result.output_artifacts[0], "utf8"), /\| 10 \| Mark \| OLD \| NEW \|  \| dry-run failed \|/);
});

test("mock fixture usage can be disabled for live Revit benchmark runs", () => {
  const original = process.env.OPERATOR_BENCHMARK_USE_MOCKS;
  try {
    assert.equal(shouldUseMockBridgeFixtures({ workflow: "takeoff_csv", mock: { "/revit/quantify": {} } }), true);
    process.env.OPERATOR_BENCHMARK_USE_MOCKS = "0";
    assert.equal(shouldUseMockBridgeFixtures({ workflow: "takeoff_csv", mock: { "/revit/quantify": {} } }), false);
    process.env.OPERATOR_BENCHMARK_USE_MOCKS = "1";
    assert.equal(shouldUseMockBridgeFixtures({ workflow: "takeoff_csv", mock: { "/revit/quantify": {} }, use_mocks: false }), true);
  } finally {
    if (original === undefined) delete process.env.OPERATOR_BENCHMARK_USE_MOCKS;
    else process.env.OPERATOR_BENCHMARK_USE_MOCKS = original;
  }
});

test("bridge URL resolver uses env first and discovered add-in URL second", () => {
  const originalRevitUrl = process.env.REVIT_BRIDGE_URL;
  const originalOperatorUrl = process.env.OPERATOR_REVIT_BRIDGE_URL;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const dir = tempDir("bridge-url-discovery");
  const bridgeDir = path.join(dir, "RevitOperator");
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.writeFileSync(path.join(bridgeDir, "bridge_url.txt"), "http://localhost:5010/\n", "utf8");

  try {
    delete process.env.REVIT_BRIDGE_URL;
    delete process.env.OPERATOR_REVIT_BRIDGE_URL;
    process.env.LOCALAPPDATA = dir;
    assert.equal(resolveRevitBridgeUrl(), "http://localhost:5010");

    process.env.OPERATOR_REVIT_BRIDGE_URL = "http://localhost:5011/";
    assert.equal(resolveRevitBridgeUrl(), "http://localhost:5011");

    process.env.REVIT_BRIDGE_URL = "http://localhost:5012/";
    assert.equal(resolveRevitBridgeUrl(), "http://localhost:5012");
  } finally {
    if (originalRevitUrl === undefined) delete process.env.REVIT_BRIDGE_URL;
    else process.env.REVIT_BRIDGE_URL = originalRevitUrl;
    if (originalOperatorUrl === undefined) delete process.env.OPERATOR_REVIT_BRIDGE_URL;
    else process.env.OPERATOR_REVIT_BRIDGE_URL = originalOperatorUrl;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
  }
});

test("redline receptacle workflow sends chainage inside create-similar placements", async () => {
  const dir = tempDir("redline-payload");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": { elements: [] },
    "/revit/create-similar-from-instance": { elementIds: [6001] },
    "/revit/audit-hosted-instance-placement": { ok: true },
    "/revit/export-visible-elements:2": { elements: [{ id: 6001 }] }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_receptacles",
      request: {
        viewId: 4001,
        placements: [
          {
            exemplarElementId: 3001,
            hostElementId: 5001,
            targetChainageFt: 12.5,
            parameterOverrides: { Mark: "R-DEM-01" }
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.success, true);
  assert.equal(result.output_artifacts.length, 2);
  assert.ok(fs.existsSync(result.output_artifacts[0]));
  assert.ok(fs.existsSync(result.output_artifacts[1]));
  assert.match(result.user_message, /\| index \| exemplarElementId \| hostElementId \| createdElementId \| roomSide \| mark \| panel \| circuit \|/);
  const createCall = bridge.calls.find((call) => call.pathname === "/revit/create-similar-from-instance");
  assert.ok(createCall);
  const body = createCall.body as any;
  assert.equal(body.targetChainageFt, undefined);
  assert.equal(body.placements[0].targetChainageFt, 12.5);
  assert.deepEqual(body.parameterOverrides, { Mark: "R-DEM-01-R01" });
  const summary = JSON.parse(fs.readFileSync(result.output_artifacts[0], "utf8"));
  assert.deepEqual(summary.createdElementIds, [6001]);
  assert.equal(summary.placements[0].mark, "R-DEM-01-R01");
});

test("redline receptacle workflow can clean up created elements for repeat live runs", async () => {
  const dir = tempDir("redline-cleanup");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": { elements: [] },
    "/revit/create-similar-from-instance": { elementIds: [6001] },
    "/revit/audit-hosted-instance-placement": { ok: true },
    "/revit/export-visible-elements:2": { elements: [{ id: 6001 }] },
    "/revit/delete": { ok: true, deletedIds: [6001] }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_receptacles",
      request: {
        viewId: 4001,
        cleanupCreatedElements: true,
        placements: [
          {
            exemplarElementId: 3001,
            hostElementId: 5001,
            targetChainageFt: 12.5,
            parameterOverrides: { Mark: "R-DEM-01" }
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.success, true);
  const deleteCall = bridge.calls.find((call) => call.pathname === "/revit/delete");
  assert.ok(deleteCall);
  assert.deepEqual((deleteCall.body as any).ids, [6001]);
  assert.equal((deleteCall.body as any).apply, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "cleanup_completed_when_requested" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(result.output_artifacts[0], "utf8"));
  assert.equal(summary.cleanupRequested, true);
  assert.deepEqual(summary.cleanup.deletedIds, [6001]);
});

test("redline receptacle workflow verifies room, host, and source circuit evidence", async () => {
  const dir = tempDir("redline-strong-audit");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": { elements: [] },
    "/revit/create-similar-from-instance": {
      elementIds: [6001],
      exemplar: { id: 3001, electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" } },
      placements: [{ elementId: 6001, electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" } }]
    },
    "/revit/audit-hosted-instance-placement": {
      ok: true,
      items: [
        {
          elementId: 6001,
          onRequestedRoomSide: true,
          roomSide: "left",
          electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" },
          placementContext: {
            room: { number: "405" },
            placementHost: { id: 5001, category: "Walls", builtInCategory: "OST_Walls" },
            diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } }
          }
        }
      ]
    },
    "/revit/export-visible-elements:2": { elements: [{ id: 6001 }] }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_receptacles",
      request: {
        viewId: 4001,
        requireAuditItems: true,
        placements: [
          {
            exemplarElementId: 3001,
            hostElementId: 5001,
            roomNumber: "405",
            roomSide: "left",
            targetChainageFt: 12.5,
            matchElectricalCircuitFromSource: true,
            expectedCircuitLabel: "P405/1",
            parameterOverrides: { Mark: "R-DEM-01" }
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.success, true);
  for (const name of [
    "audit_contains_created_ids",
    "audit_host_evidence_ok",
    "created_room_matches_expected",
    "created_room_side_matches_expected",
    "created_circuit_matches_expected",
    "created_circuit_matches_source_when_requested"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
});

test("redline receptacle workflow fails when requested room side audit evidence is wrong", async () => {
  const dir = tempDir("redline-side-fail");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_receptacles",
      request: {
        viewId: 4001,
        requireAuditItems: true,
        placements: [
          {
            exemplarElementId: 3001,
            hostElementId: 5001,
            roomNumber: "405",
            roomSide: "left",
            targetChainageFt: 12.5
          }
        ]
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/export-visible-elements:1": { elements: [] },
      "/revit/create-similar-from-instance": { elementIds: [6001], placements: [{ elementId: 6001 }] },
      "/revit/audit-hosted-instance-placement": {
        ok: true,
        items: [
          {
            elementId: 6001,
            onRequestedRoomSide: false,
            roomSide: "right",
            placementContext: {
              room: { number: "405" },
              placementHost: { id: 5001, category: "Walls", builtInCategory: "OST_Walls" },
              diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } }
            }
          }
        ]
      },
      "/revit/export-visible-elements:2": { elements: [{ id: 6001 }] }
    })
  );

  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "created_room_side_matches_expected" && !entry.ok), true);
});

test("redline receptacle workflow fails strong audit when source circuit evidence is missing", async () => {
  const dir = tempDir("redline-source-circuit-fail");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_receptacles",
      request: {
        viewId: 4001,
        requireAuditItems: true,
        placements: [
          {
            exemplarElementId: 3001,
            hostElementId: 5001,
            roomNumber: "405",
            targetChainageFt: 12.5,
            matchElectricalCircuitFromSource: true
          }
        ]
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/export-visible-elements:1": { elements: [] },
      "/revit/create-similar-from-instance": {
        elementIds: [6001],
        exemplar: { id: 3001 },
        placements: [{ elementId: 6001, electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" } }]
      },
      "/revit/audit-hosted-instance-placement": {
        ok: true,
        items: [
          {
            elementId: 6001,
            electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" },
            placementContext: {
              room: { number: "405" },
              placementHost: { id: 5001, category: "Walls", builtInCategory: "OST_Walls" }
            }
          }
        ]
      },
      "/revit/export-visible-elements:2": { elements: [{ id: 6001 }] }
    })
  );

  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "created_circuit_matches_source_when_requested" && !entry.ok), true);
});

test("bridge URL candidates include default and configured fallback ports", () => {
  const originalRevitUrl = process.env.REVIT_BRIDGE_URL;
  const originalOperatorUrl = process.env.OPERATOR_REVIT_BRIDGE_URL;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalFallbackPorts = process.env.OPERATOR_REVIT_BRIDGE_FALLBACK_PORTS;

  try {
    delete process.env.REVIT_BRIDGE_URL;
    delete process.env.OPERATOR_REVIT_BRIDGE_URL;
    delete process.env.LOCALAPPDATA;
    process.env.OPERATOR_REVIT_BRIDGE_FALLBACK_PORTS = "5020,5021";

    assert.deepEqual(resolveRevitBridgeUrlCandidates(), [
      "http://localhost:5000",
      "http://localhost:5020",
      "http://localhost:5021"
    ]);
  } finally {
    if (originalRevitUrl === undefined) delete process.env.REVIT_BRIDGE_URL;
    else process.env.REVIT_BRIDGE_URL = originalRevitUrl;
    if (originalOperatorUrl === undefined) delete process.env.OPERATOR_REVIT_BRIDGE_URL;
    else process.env.OPERATOR_REVIT_BRIDGE_URL = originalOperatorUrl;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    if (originalFallbackPorts === undefined) delete process.env.OPERATOR_REVIT_BRIDGE_FALLBACK_PORTS;
    else process.env.OPERATOR_REVIT_BRIDGE_FALLBACK_PORTS = originalFallbackPorts;
  }
});

test("redline receptacle workflow fails when audit reports placement failure", async () => {
  const dir = tempDir("redline-audit-fail");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_receptacles",
      request: {
        viewId: 4001,
        placements: [{ exemplarElementId: 3001, hostElementId: 5001, targetChainageFt: 12.5 }]
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/export-visible-elements:1": { elements: [{ id: 3001 }] },
      "/revit/create-similar-from-instance": { elementIds: [6001] },
      "/revit/audit-hosted-instance-placement": { ok: false, items: [{ elementId: 6001, visible: false, hostOk: false }] },
      "/revit/export-visible-elements:2": { elements: [{ id: 3001 }] }
    })
  );

  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "audit_passed" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "after_visible_count_increased" && !entry.ok), true);
  assert.ok(fs.existsSync(result.output_artifacts[0]));
});
