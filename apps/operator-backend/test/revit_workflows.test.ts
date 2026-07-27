import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  MockBridgeTransport,
  __testOnlyCadLinkViewportMatchesRequest,
  __testOnlyCategoryOverrideClearedProofMatchesRequest,
  __testOnlyVisibilityAppliedProofMatchesRequest,
  buildRevitBridgeHeaders,
  resolveRevitBridgeUrl,
  resolveRevitBridgeUrlCandidates,
  runRevitDemoWorkflow,
  shouldUseMockBridgeFixtures
} from "../src/benchmark/revit_workflows.js";

function tempDir(name: string): string {
  const dir = path.join(process.cwd(), "local-work", "revit-workflow-tests", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("CAD sheet placement evidence rejects sheet-owned import without viewport", () => {
  assert.equal(
    __testOnlyCadLinkViewportMatchesRequest(1543141, {
      status: "Success",
      mode: "link",
      targetMode: "view_then_sheet",
      sheetViewId: 1543141,
      ownerViewId: 1543141,
      viewId: 1543141,
      viewportId: null,
      elementId: 1543204,
      sourcePath: "artifacts/cad/Snowdon-M104-Plan-HVAC-L4.dwg"
    }),
    false
  );
});

test("CAD sheet placement evidence accepts owner view placed as viewport", () => {
  assert.equal(
    __testOnlyCadLinkViewportMatchesRequest(1543141, {
      status: "Success",
      mode: "link",
      targetMode: "view_then_sheet",
      sheetViewId: 1543141,
      ownerViewId: 1545001,
      viewId: 1545001,
      viewportId: 1545003,
      elementId: 1545002,
      sourcePath: "artifacts/cad/Snowdon-M104-Plan-HVAC-L4.dwg"
    }),
    true
  );
});

test("linked model category proof does not accept host category readback", () => {
  const request = {
    action: "set_category_override",
    viewId: 8251,
    linkedModelName: "Snowdon Towers Sample Architectural.rvt",
    categoryName: "Plumbing Fixtures",
    lineWeight: 5
  };

  assert.equal(__testOnlyVisibilityAppliedProofMatchesRequest(request, {
    status: "Success",
    action: "set_category_override",
    viewId: 8251,
    view: {
      id: 8251,
      categoryOverride: { categoryName: "Plumbing Fixtures", lineWeight: 5 }
    }
  }), false);

  assert.equal(__testOnlyVisibilityAppliedProofMatchesRequest(request, {
    status: "Success",
    action: "set_category_override",
    viewId: 8251,
    view: {
      id: 8251,
      categoryOverride: {
        linkedModelName: "Snowdon Towers Sample Architectural.rvt",
        categoryName: "Plumbing Fixtures",
        lineWeight: 5
      }
    }
  }), true);
});

test("linked model category cleanup proof must clear the linked target, not only host category overrides", () => {
  const request = {
    action: "clear_category_override",
    viewId: 8251,
    linkedModelName: "Snowdon Towers Sample Architectural.rvt",
    categoryName: "Plumbing Fixtures"
  };

  assert.equal(__testOnlyCategoryOverrideClearedProofMatchesRequest(request, {
    status: "Success",
    action: "clear_category_override",
    viewId: 8251,
    view: {
      id: 8251,
      categoryOverrides: [
        { categoryName: "Lines", lineWeight: 5 },
        { linkedModelName: "Snowdon Towers Sample Architectural.rvt", categoryName: "Plumbing Fixtures", lineWeight: 5 }
      ]
    }
  }), false);

  assert.equal(__testOnlyCategoryOverrideClearedProofMatchesRequest(request, {
    status: "Success",
    action: "clear_category_override",
    viewId: 8251,
    view: {
      id: 8251,
      categoryOverrides: [
        { categoryName: "Lines", lineWeight: 5 }
      ]
    }
  }), true);

  assert.equal(__testOnlyCategoryOverrideClearedProofMatchesRequest({
    action: "clear_category_override",
    viewId: 8251,
    categoryName: "Lines"
  }, {
    status: "Success",
    action: "clear_category_override",
    viewId: 8251,
    view: {
      id: 8251,
      categoryOverride: {
        categoryName: "Lines",
        lineWeight: -1,
        color: null
      }
    }
  }), true);
});

test("phase visibility proof requires exact phase and phase-filter readback", () => {
  assert.equal(__testOnlyVisibilityAppliedProofMatchesRequest({
    action: "set_phase",
    viewId: 8251,
    phaseName: "New Construction"
  }, {
    status: "Success",
    action: "set_phase",
    viewId: 8251,
    view: { id: 8251, phaseName: "Existing" }
  }), false);

  assert.equal(__testOnlyVisibilityAppliedProofMatchesRequest({
    action: "set_phase_filter",
    viewId: 8251,
    phaseFilterName: "Show Complete"
  }, {
    status: "Success",
    action: "set_phase_filter",
    viewId: 8251,
    view: { id: 8251, phaseFilterName: "Show All" }
  }), false);
});

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

test("workflow runner writes result artifact when bridge transport throws", async () => {
  const dir = tempDir("thrown-bridge-result-artifact");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "takeoff_csv",
      request: { categories: ["OST_MechanicalEquipment"] }
    },
    dir,
    {
      async post(): Promise<unknown> {
        throw new Error("fetch failed");
      }
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.execution_source, "injected");
  assert.equal(result.failure_classification, "workflow_error");
  assert.match(result.failure_reason ?? "", /fetch failed/);
  assert.equal(result.revit_transactions, 0);

  const artifact = JSON.parse(fs.readFileSync(path.join(dir, "revit_workflow_result.json"), "utf8"));
  assert.equal(artifact.success, false);
  assert.equal(artifact.failure_classification, "workflow_error");
  assert.match(artifact.failure_reason, /fetch failed/);
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

test("parameter workflow can revert after verified live-style write", async () => {
  const dir = tempDir("parameter-revert");
  const bridge = new MockBridgeTransport({
    "/revit/get-parameters:1": { items: [{ id: 10, parameters: { Comments: "ORIGINAL" } }, { id: 11, parameters: { Comments: "SECOND" } }] },
    "/revit/set-parameter:1": {
      status: "Dry Run",
      dryRun: true,
      changedCount: 2,
      diffs: [
        { elementId: 10, parameterName: "Comments", ok: true, changed: true },
        { elementId: 11, parameterName: "Comments", ok: true, changed: true }
      ]
    },
    "/revit/set-parameter:2": {
      status: "Applied",
      dryRun: false,
      changedCount: 2,
      diffs: [
        { elementId: 10, parameterName: "Comments", ok: true, changed: true },
        { elementId: 11, parameterName: "Comments", ok: true, changed: true }
      ]
    },
    "/revit/get-parameters:2": { items: [{ id: 10, parameters: { Comments: "EXPECTED" } }, { id: 11, parameters: { Comments: "EXPECTED" } }] },
    "/revit/set-parameter:3": {
      status: "Dry Run",
      dryRun: true,
      changedCount: 2,
      diffs: [
        { elementId: 10, parameterName: "Comments", ok: true, changed: true },
        { elementId: 11, parameterName: "Comments", ok: true, changed: true }
      ]
    },
    "/revit/set-parameter:4": {
      status: "Applied",
      dryRun: false,
      changedCount: 2,
      diffs: [
        { elementId: 10, parameterName: "Comments", ok: true, changed: true },
        { elementId: 11, parameterName: "Comments", ok: true, changed: true }
      ]
    },
    "/revit/get-parameters:3": { items: [{ id: 10, parameters: { Comments: "ORIGINAL" } }, { id: 11, parameters: { Comments: "SECOND" } }] }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "parameter_edit",
      request: { elementIds: [10, 11], parameterName: "Comments", value: "EXPECTED", minTargetCount: 2, revertAfterVerify: true }
    },
    dir,
    bridge
  );

  assert.equal(result.success, true);
  assert.equal(result.tool_calls, 7);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/set-parameter").length, 4);
  assert.equal(result.verification_results.some((entry) => entry.name === "target_count_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "revert_dry_run_all_changes_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "revert_apply_all_changes_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "revert_readback_matches_original_value" && entry.ok), true);
  const summary = fs.readFileSync(result.output_artifacts[0], "utf8");
  assert.match(summary, /\| 10 \| Comments \| ORIGINAL \| EXPECTED \| EXPECTED \| ORIGINAL \| ORIGINAL \|/);
  assert.match(summary, /\| 11 \| Comments \| SECOND \| EXPECTED \| EXPECTED \| SECOND \| SECOND \|/);
});

test("redline update parameter workflow wraps parameter edit with promotion evidence summary", async () => {
  const dir = tempDir("redline-update-parameter");
  const capturePath = path.join(dir, "captures", "parameter-after.jpg");
  fs.mkdirSync(path.dirname(capturePath), { recursive: true });
  fs.writeFileSync(capturePath, "fake image bytes");
  const bridge = new MockBridgeTransport({
    "/revit/get-parameters:1": { items: [{ id: 701, parameters: { Mark: "VAV-1" } }] },
    "/revit/set-parameter:1": { status: "Dry Run", dryRun: true, changedCount: 1, diffs: [{ elementId: 701, parameterName: "Mark", ok: true, changed: true }] },
    "/revit/set-parameter:2": { status: "Applied", dryRun: false, changedCount: 1, diffs: [{ elementId: 701, parameterName: "Mark", ok: true, changed: true }] },
    "/revit/get-parameters:2": { items: [{ id: 701, parameters: { Mark: "VAV-101" } }] },
    "/revit/export-image": { path: capturePath, viewId: 4001, widthPx: 1200, heightPx: 900, focusCrop: { requested: true, applied: true } },
    "/revit/set-parameter:3": { status: "Dry Run", dryRun: true, changedCount: 1, diffs: [{ elementId: 701, parameterName: "Mark", ok: true, changed: true }] },
    "/revit/set-parameter:4": { status: "Applied", dryRun: false, changedCount: 1, diffs: [{ elementId: 701, parameterName: "Mark", ok: true, changed: true }] },
    "/revit/get-parameters:3": { items: [{ id: 701, parameters: { Mark: "VAV-1" } }] }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_update_parameter",
      request: {
        elementIds: [701],
        parameterName: "Mark",
        value: "VAV-101",
        minTargetCount: 1,
        readbackRequired: true,
        revertAfterVerify: true,
        visualVerify: true,
        visualViewId: 4001
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_update_parameter");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "parameter_post_change_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "revert_readback_matches_original_value" && entry.ok), true);
  const summaryPath = path.join(dir, "artifacts", "redline_update_parameter_summary.json");
  assert.equal(result.output_artifacts.includes(summaryPath), true);
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  assert.equal(summary.workflowStatus, "success");
  assert.equal(summary.parameterName, "Mark");
  assert.deepEqual(summary.elementIds, [701]);
  assert.equal(summary.viewId, 4001);
  assert.equal(summary.capturePath, capturePath);
  assert.equal(summary.revertAfterVerify, true);
});

test("parameter workflow verifies existing MEP accessory identity and focused capture", async () => {
  const dir = tempDir("parameter-mep-accessory-visual");
  const bridge = new MockBridgeTransport({
    "/revit/get-parameters:1": {
      items: [
        {
          id: 801,
          category: "OST_DuctAccessory",
          familyName: "Manual Balancing Damper",
          typeName: "8x8",
          parameters: { Mark: "MBD-1" }
        }
      ]
    },
    "/revit/set-parameter:1": { status: "Dry Run", dryRun: true, changedCount: 1, diffs: [{ elementId: 801, parameterName: "Mark", ok: true, changed: true }] },
    "/revit/set-parameter:2": { status: "Applied", changedCount: 1, diffs: [{ elementId: 801, parameterName: "Mark", ok: true, changed: true }] },
    "/revit/get-parameters:2": {
      items: [
        {
          id: 801,
          category: "OST_DuctAccessory",
          familyName: "Manual Balancing Damper",
          typeName: "8x8",
          parameters: { Mark: "MBD-1A" }
        }
      ]
    },
    "/revit/export-image": {
      path: "artifacts/captures/mep-accessory-mark-after.png",
      viewId: 4001,
      widthPx: 1200,
      heightPx: 900,
      focusCrop: { requested: true, applied: true }
    },
    "/revit/set-parameter:3": { status: "Dry Run", dryRun: true, changedCount: 1, diffs: [{ elementId: 801, parameterName: "Mark", ok: true, changed: true }] },
    "/revit/set-parameter:4": { status: "Applied", changedCount: 1, diffs: [{ elementId: 801, parameterName: "Mark", ok: true, changed: true }] },
    "/revit/get-parameters:3": {
      items: [
        {
          id: 801,
          category: "OST_DuctAccessory",
          familyName: "Manual Balancing Damper",
          typeName: "8x8",
          parameters: { Mark: "MBD-1" }
        }
      ]
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "parameter_edit",
      request: {
        elementIds: [801],
        parameterName: "Mark",
        value: "MBD-1A",
        targetKind: "mep_accessory",
        targetGrounding: {
          expectedCategory: "Duct Accessories",
          expectedFamilyName: "Manual Balancing Damper",
          expectedTypeName: "8x8"
        },
        readbackRequired: true,
        revertAfterVerify: true,
        visualVerify: true,
        visualViewId: 4001
      }
    },
    dir,
    bridge
  );

  assert.equal(result.success, true);
  assert.equal(result.tool_calls, 8);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/export-image").length, 1);
  assert.equal(result.verification_results.some((entry) => entry.name === "parameter_target_identity_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "parameter_post_change_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "parameter_post_change_capture_view_id_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "parameter_post_change_capture_quality_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "revert_readback_matches_original_value" && entry.ok), true);
});

test("parameter workflow blocks existing MEP accessory edit when identity grounding mismatches", async () => {
  const dir = tempDir("parameter-mep-accessory-identity-block");
  const bridge = new MockBridgeTransport({
    "/revit/get-parameters:1": {
      items: [
        {
          id: 801,
          category: "OST_DuctCurves",
          familyName: "Rectangular Duct",
          typeName: "Default",
          parameters: { Mark: "D-1" }
        }
      ]
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "parameter_edit",
      request: {
        elementIds: [801],
        parameterName: "Mark",
        value: "MBD-1A",
        targetKind: "mep_accessory",
        targetGrounding: {
          expectedCategory: "OST_DuctAccessory",
          expectedFamilyName: "Manual Balancing Damper"
        },
        readbackRequired: true,
        revertAfterVerify: true,
        visualVerify: true,
        visualViewId: 4001
      }
    },
    dir,
    bridge
  );

  assert.equal(result.success, false);
  assert.equal(result.tool_calls, 1);
  assert.equal(result.revit_transactions, 0);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/set-parameter"), false);
  assert.equal(result.verification_results.some((entry) => entry.name === "parameter_target_identity_matches_request" && !entry.ok), true);
  assert.match(result.failure_reason ?? "", /identity/i);
});

test("parameter workflow fails when target count is below requested minimum", async () => {
  const dir = tempDir("parameter-min-target-count");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "parameter_edit",
      request: { elementIds: [10], parameterName: "Comments", value: "EXPECTED", minTargetCount: 2, revertAfterVerify: true }
    },
    dir,
    new MockBridgeTransport({
      "/revit/get-parameters:1": { items: [{ id: 10, parameters: { Comments: "ORIGINAL" } }] },
      "/revit/set-parameter:1": { status: "Dry Run", dryRun: true, changedCount: 1, diffs: [{ elementId: 10, ok: true, changed: true }] },
      "/revit/set-parameter:2": { status: "Applied", changedCount: 1, diffs: [{ elementId: 10, ok: true, changed: true }] },
      "/revit/get-parameters:2": { items: [{ id: 10, parameters: { Comments: "EXPECTED" } }] },
      "/revit/set-parameter:3": { status: "Dry Run", dryRun: true, changedCount: 1, diffs: [{ elementId: 10, ok: true, changed: true }] },
      "/revit/set-parameter:4": { status: "Applied", changedCount: 1, diffs: [{ elementId: 10, ok: true, changed: true }] },
      "/revit/get-parameters:3": { items: [{ id: 10, parameters: { Comments: "ORIGINAL" } }] }
    })
  );

  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "target_count" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "target_count_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "revert_readback_matches_original_value" && entry.ok), true);
});

test("parameter workflow fails when revert readback does not match original value", async () => {
  const dir = tempDir("parameter-revert-fail");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "parameter_edit",
      request: { elementIds: [10], parameterName: "Comments", value: "EXPECTED", revertAfterVerify: true }
    },
    dir,
    new MockBridgeTransport({
      "/revit/get-parameters:1": { items: [{ id: 10, parameters: { Comments: "ORIGINAL" } }] },
      "/revit/set-parameter:1": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 10, ok: true, changed: true }] },
      "/revit/set-parameter:2": { status: "Applied", changedCount: 1, diffs: [{ elementId: 10, ok: true, changed: true }] },
      "/revit/get-parameters:2": { items: [{ id: 10, parameters: { Comments: "EXPECTED" } }] },
      "/revit/set-parameter:3": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 10, ok: true, changed: true }] },
      "/revit/set-parameter:4": { status: "Applied", changedCount: 1, diffs: [{ elementId: 10, ok: true, changed: true }] },
      "/revit/get-parameters:3": { items: [{ id: 10, parameters: { Comments: "STILL EXPECTED" } }] }
    })
  );

  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "revert_readback_matches_original_value" && !entry.ok), true);
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
    "/revit/audit-hosted-instance-placement": {
      ok: true,
      items: [
        {
          elementId: 6001,
          placementContext: {
            placementHost: { id: 5001, category: "Walls", builtInCategory: "OST_Walls" }
          }
        }
      ]
    },
    "/revit/export-visible-elements:2": { elements: [{ id: 6001 }], capture_path: "artifacts/captures/receptacles-after.jpg" }
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
  assert.equal(result.output_artifacts.length, 3);
  assert.ok(fs.existsSync(result.output_artifacts[0]));
  assert.ok(fs.existsSync(result.output_artifacts[1]));
  assert.match(result.user_message, /\| index \| exemplarElementId \| hostElementId \| createdElementId \| roomSide \| mark \| panel \| circuit \|/);
  const createCall = bridge.calls.find((call) => call.pathname === "/revit/create-similar-from-instance");
  assert.ok(createCall);
  const createCalls = bridge.calls.filter((call) => call.pathname === "/revit/create-similar-from-instance");
  assert.equal(createCalls.length, 2);
  assert.equal((createCalls[0].body as any).dryRun, true);
  assert.equal((createCalls[1].body as any).dryRun, false);
  const body = createCall.body as any;
  assert.equal(body.targetChainageFt, 12.5);
  assert.equal(body.placements[0].targetChainageFt, 12.5);
  assert.deepEqual(body.parameterOverrides, { Mark: "R-DEM-01-R01" });
  const summary = JSON.parse(fs.readFileSync(result.output_artifacts[0], "utf8"));
  assert.deepEqual(summary.createdElementIds, [6001]);
  assert.equal(summary.placements[0].mark, "R-DEM-01-R01");
  const visualGate = JSON.parse(fs.readFileSync(result.output_artifacts[2], "utf8"));
  assert.equal(visualGate.status, "pass");
  assert.deepEqual(visualGate.evidence.visible_element_inventory.auditItemIds, [6001]);
  assert.match(visualGate.intended_location, /host 5001/);
  assert.match(visualGate.observed_location, /element 6001/);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && entry.ok), true);
});

test("redline receptacle workflow can clean up created elements for repeat live runs", async () => {
  const dir = tempDir("redline-cleanup");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": { elements: [] },
    "/revit/create-similar-from-instance": { elementIds: [6001] },
    "/revit/audit-hosted-instance-placement": {
      ok: true,
      items: [
        {
          elementId: 6001,
          placementContext: {
            placementHost: { id: 5001, category: "Walls", builtInCategory: "OST_Walls" }
          }
        }
      ]
    },
    "/revit/export-visible-elements:2": { elements: [{ id: 6001 }], capture_path: "artifacts/captures/receptacles-after.jpg" },
    "/revit/delete:1": { status: "Dry Run", ids: [6001] },
    "/revit/delete:2": { status: "Deleted", ids: [6001] }
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
  const deleteCalls = bridge.calls.filter((call) => call.pathname === "/revit/delete");
  assert.equal(deleteCalls.length, 2);
  assert.deepEqual((deleteCalls[0].body as any).ids, [6001]);
  assert.equal((deleteCalls[0].body as any).apply, false);
  assert.deepEqual((deleteCalls[1].body as any).ids, [6001]);
  assert.equal((deleteCalls[1].body as any).apply, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "cleanup_completed_when_requested" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "cleanup_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "cleanup_deleted_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(result.output_artifacts[0], "utf8"));
  assert.equal(summary.cleanupRequested, true);
  assert.deepEqual(summary.cleanupDryRunIds, [6001]);
  assert.deepEqual(summary.cleanupDeletedIds, [6001]);
});

test("redline receptacle workflow uses focused capture when broad inventory misses valid created device", async () => {
  const dir = tempDir("redline-focused-after-capture");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": { elements: [], capture_path: "artifacts/captures/receptacles-before.jpg" },
    "/revit/create-similar-from-instance": { elementIds: [6001] },
    "/revit/audit-hosted-instance-placement": {
      ok: true,
      items: [
        {
          elementId: 6001,
          actualRoomNumber: "506",
          placementContext: {
            room: { number: "506" },
            placementHost: { id: 5001, category: "RVT Links", builtInCategory: "OST_RvtLinks" }
          }
        }
      ]
    },
    "/revit/export-visible-elements:2": { elements: [], capture_path: "artifacts/captures/receptacles-after-broad.jpg" },
    "/revit/export-view-region": { path: "artifacts/captures/receptacles-after-focused.jpg" }
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
            roomNumber: "506",
            targetChainageFt: 12.5
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.success, true);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/export-view-region"), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "after_visible_count_increased" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(result.output_artifacts[0], "utf8"));
  assert.equal(summary.focusedAfterCapturePath, "artifacts/captures/receptacles-after-focused.jpg");
  const visualGate = JSON.parse(fs.readFileSync(result.output_artifacts[2], "utf8"));
  assert.equal(visualGate.evidence.after_capture_path, "artifacts/captures/receptacles-after-focused.jpg");
});

test("redline receptacle workflow stops before apply when create-similar dry-run is invalid", async () => {
  const dir = tempDir("redline-dryrun-invalid");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": { elements: [] },
    "/revit/create-similar-from-instance:1": {
      status: "InvalidPreview",
      dryRun: true,
      placementValidation: {
        valid: false,
        reason: "unsupportedIds=[7001]",
        unsupportedIds: [7001]
      }
    }
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
            pointXyz: [1, 2, 3],
            parameterOverrides: { Mark: "R-DEM-01" }
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.success, false);
  assert.match(result.failure_reason ?? "", /dry-run preview/i);
  assert.equal(result.revit_transactions, 0);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/create-similar-from-instance").length, 1);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/audit-hosted-instance-placement"), false);
  assert.equal(result.verification_results.some((entry) => entry.name === "create_similar_dry_run_ok" && !entry.ok), true);
});

test("redline receptacle workflow stops before apply when dry-run lacks placement evidence", async () => {
  const dir = tempDir("redline-dryrun-no-placement-evidence");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": { elements: [] },
    "/revit/create-similar-from-instance:1": {
      status: "Planned",
      dryRun: true,
      placementValidation: {
        valid: true
      }
    }
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

  assert.equal(result.success, false);
  assert.match(result.failure_reason ?? "", /planned placement evidence/i);
  assert.equal(result.revit_transactions, 0);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/create-similar-from-instance").length, 1);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/audit-hosted-instance-placement"), false);
  assert.equal(result.verification_results.some((entry) => entry.name === "create_similar_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "create_similar_dry_run_placement_evidence" && !entry.ok), true);
});

test("redline receptacle workflow records thrown create-similar dry-run failure before apply", async () => {
  const dir = tempDir("redline-dryrun-throws");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": { elements: [] }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_receptacles",
      request: {
        viewId: 4001,
        placements: [
          {
            exemplarElementId: 3001,
            targetChainageFt: 8,
            parameterOverrides: { Mark: "R-DEM-01" }
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.success, false);
  assert.match(result.failure_reason ?? "", /dry-run failed/i);
  assert.equal(result.revit_transactions, 0);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/create-similar-from-instance").length, 1);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/audit-hosted-instance-placement"), false);
  assert.equal(result.verification_results.some((entry) => entry.name === "create_similar_dry_run_ok" && !entry.ok), true);
});

test("redline receptacle workflow accepts native impacted cleanup evidence", async () => {
  const dir = tempDir("redline-native-cleanup");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": { elements: [] },
    "/revit/create-similar-from-instance": { elementIds: [6001] },
    "/revit/audit-hosted-instance-placement": {
      ok: true,
      items: [
        {
          elementId: 6001,
          placementContext: {
            placementHost: { id: 5001, category: "Walls", builtInCategory: "OST_Walls" }
          }
        }
      ]
    },
    "/revit/export-visible-elements:2": { elements: [{ id: 6001 }], capture_path: "artifacts/captures/receptacles-after.jpg" },
    "/revit/delete:1": { status: "Dry Run", requestedIds: [6001], impactedIds: [6001] },
    "/revit/delete:2": { status: "Deleted", requestedIds: [6001], impactedIds: [6001] }
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
  assert.equal(result.verification_results.some((entry) => entry.name === "cleanup_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "cleanup_deleted_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(result.output_artifacts[0], "utf8"));
  assert.deepEqual(summary.cleanupDryRunIds, [6001]);
  assert.deepEqual(summary.cleanupDeletedIds, [6001]);
});

test("delete-like redline workflow creates deletes and verifies target absence", async () => {
  const dir = tempDir("redline-delete-text-success");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_delete",
      request: {
        viewId: 101,
        textNote: { x: 1, y: 1, text: "OPERATOR DELETE REDLINE" }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-text": { status: "success", id: 7101, viewId: 101 },
      "/revit/export-visible-elements:1": {
        imagePath: "artifacts/captures/delete-before.png",
        items: [{ id: 7101, category: "Text Notes", visibleText: "OPERATOR DELETE REDLINE" }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [7101], impactedIds: [7101] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [7101], impactedIds: [7101] },
      "/revit/export-visible-elements:2": {
        imagePath: "artifacts/captures/delete-after.png",
        items: []
      }
    })
  );

  assert.equal(result.workflow, "redline_delete");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_applied_ids_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_visual_gate_passed" && entry.ok), true);
  assert.ok(fs.existsSync(path.join(dir, "artifacts", "redline_delete_summary.json")));
  assert.ok(fs.existsSync(path.join(dir, "artifacts", "redline_delete_visual_gate.json")));
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_delete_summary.json"), "utf8"));
  assert.equal(summary.createdId, 7101);
  assert.deepEqual(summary.dryRunIds, [7101]);
  assert.deepEqual(summary.deletedIds, [7101]);
  assert.equal(summary.visibleAfter, true);
});

test("delete-like redline workflow scopes disposable pipe route inventory categories", async () => {
  const dir = tempDir("redline-delete-pipe-route-success");
  const bridge = new MockBridgeTransport({
    "/revit/mep-route-workflow": {
      status: "AppliedVisualVerificationIncomplete",
      applyResult: {
        status: "CreatedWithOpenConnectors",
        kind: "pipe",
        createdElementIds: [1644929, 1644930],
        createdFittingIds: [1644931]
      }
    },
    "/revit/export-visible-elements:1": {
      imagePath: "artifacts/captures/delete-pipe-route-before.png",
      count: 500,
      truncated: true,
      items: []
    },
    "/revit/delete:1": {
      status: "Dry Run",
      requestedIds: [1644929, 1644930, 1644931],
      impactedIds: [1644929, 1644930, 1644931],
      requestedDetails: [
        { elementId: 1644929, exists: true, category: "Pipes", builtInCategory: "OST_PipeCurves" },
        { elementId: 1644930, exists: true, category: "Pipes", builtInCategory: "OST_PipeCurves" },
        { elementId: 1644931, exists: true, category: "Pipe Fittings", builtInCategory: "OST_PipeFitting" }
      ]
    },
    "/revit/delete:2": { status: "Deleted", requestedIds: [1644929, 1644930, 1644931], impactedIds: [1644929, 1644930, 1644931] },
    "/revit/export-visible-elements:2": {
      imagePath: "artifacts/captures/delete-pipe-route-after.png",
      items: []
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_delete",
      request: {
        viewId: 101,
        targetKind: "pipe_route",
        kind: "pipe",
        levelName: "L4",
        systemType: "Domestic Cold Water",
        pipeSize: "2\"",
        points: [{ x: 42, y: 24 }, { x: 55, y: 24 }]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_delete");
  assert.equal(result.success, true);
  const exportCalls = bridge.calls.filter((call) => call.pathname === "/revit/export-visible-elements");
  assert.deepEqual((exportCalls[0]?.body as Record<string, unknown>).categories, ["OST_PipeCurves", "OST_PipeFitting"]);
  assert.deepEqual((exportCalls[1]?.body as Record<string, unknown>).categories, ["OST_PipeCurves", "OST_PipeFitting"]);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_target_visible_before" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_visual_gate_passed" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_delete_summary.json"), "utf8"));
  assert.deepEqual(summary.createdMepRouteIds, [1644929, 1644930, 1644931]);
  assert.equal(summary.nativeDeleteDryRunProvesTargetExists, true);
  assert.equal(summary.visibleBefore, true);
  assert.equal(summary.visibleAfter, true);
});

test("delete-like redline workflow preflights existing TextNote and blocks before write", async () => {
  const dir = tempDir("redline-delete-existing-text-preflight");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": {
      imagePath: "artifacts/captures/delete-text-existing-before.png",
      items: [{ id: 7601, category: "OST_TextNotes", visibleText: "REMOVE THIS NOTE" }]
    },
    "/revit/delete:1": { status: "Dry Run", requestedIds: [7601], impactedIds: [7601], dryRun: true },
    "/revit/export-visible-elements:2": {
      imagePath: "artifacts/captures/delete-text-existing-after-dry-run.png",
      items: [{ id: 7601, category: "OST_TextNotes", visibleText: "REMOVE THIS NOTE" }]
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_delete",
      request: {
        viewId: 101,
        targetKind: "text_note",
        textNote: {
          textNoteId: 7601,
          expectedExistingText: "REMOVE THIS NOTE",
          readbackRequired: true
        },
        existingTarget: {
          deleteExisting: true,
          elementIds: [7601],
          expectedCategory: "OST_TextNotes",
          expectedText: "REMOVE THIS NOTE",
          readbackRequired: true
        },
        applyExistingDelete: false
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_delete");
  assert.equal(result.success, false);
  assert.equal(result.revit_transactions, 0);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/create-text"), false);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/delete").length, 1);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_existing_text_note_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_existing_text_note_identity_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_blocked_before_model_write" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_target_still_visible_after_dry_run" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_applied_ids_present" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_delete_summary.json"), "utf8"));
  assert.equal(summary.targetKind, "text_note");
  assert.equal(summary.deleteExistingTarget, true);
  assert.equal(summary.blockedBeforeModelWrite, true);
  assert.deepEqual(summary.existingTargetIds, [7601]);
  assert.equal(summary.existingTargetIdentityMatchesRequest, true);
  assert.deepEqual(summary.existingTextLabels, ["remove this note"]);
  assert.deepEqual(summary.dryRunIds, [7601]);
  assert.deepEqual(summary.deletedIds, []);
  assert.equal(summary.visibleAfterDryRun, true);
});

test("delete-like redline workflow rejects requestedIds-only delete evidence", async () => {
  const dir = tempDir("redline-delete-text-requested-only");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_delete",
      request: {
        viewId: 101,
        textNote: { x: 1, y: 1, text: "OPERATOR DELETE REDLINE" }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-text": { status: "success", id: 7101, viewId: 101 },
      "/revit/export-visible-elements:1": {
        imagePath: "artifacts/captures/delete-before.png",
        items: [{ id: 7101, category: "Text Notes", visibleText: "OPERATOR DELETE REDLINE" }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [7101] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [7101] },
      "/revit/export-visible-elements:2": {
        imagePath: "artifacts/captures/delete-after.png",
        items: []
      }
    })
  );

  assert.equal(result.workflow, "redline_delete");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_dry_run_ok" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_applied_ids_present" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_target_absent_after" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_delete_summary.json"), "utf8"));
  assert.deepEqual(summary.dryRunIds, []);
  assert.deepEqual(summary.deletedIds, []);
});

test("add-like redline workflow creates verifies and cleans up tag target", async () => {
  const dir = tempDir("redline-add-tag-success");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_add",
      request: {
        viewId: 101,
        targetKind: "tag",
        tag: { viewId: 101, elementIds: [9001, 9002], tagTypeName: "Keynote Tag", onlyUntagged: false, addLeader: false, readbackRequired: true },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/tag-elements": {
        status: "Success",
        viewId: 101,
        targetCount: 2,
        taggedCount: 2,
        errorCount: 0,
        tagIds: [8001, 8002],
        tags: [
          { tagId: 8001, targetElementId: 9001, tagTypeName: "Keynote Tag" },
          { tagId: 8002, targetElementId: 9002, tagTypeName: "Keynote Tag" }
        ]
      },
      "/revit/export-visible-elements": {
        imagePath: "artifacts/captures/add-tag-after.png",
        items: [
          { id: 8001, category: "Tags", hostElementId: 9001 },
          { id: 8002, category: "Tags", hostElementId: 9002 }
        ]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [8001, 8002], impactedIds: [8001, 8002] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [8001, 8002], impactedIds: [8001, 8002] }
    })
  );

  assert.equal(result.workflow, "redline_add");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_created_tag_id_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_tag_create_no_errors" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_tag_apply_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_tag_readback_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_target_visible_after" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_add_summary.json"), "utf8"));
  assert.equal(summary.targetKind, "tag");
  assert.equal(summary.createdId, 8001);
  assert.equal(summary.visibleAfter, true);
  assert.deepEqual(summary.targetIds, [8001, 8002]);
  assert.deepEqual(summary.cleanupDeletedIds, [8001, 8002]);
});

test("add-like redline workflow surfaces partial tag creation errors", async () => {
  const dir = tempDir("redline-add-tag-partial-error");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_add",
      request: {
        viewId: 32,
        targetKind: "tag",
        tag: { viewId: 32, elementIds: [1411195], tagTypeName: "Space Tag", readbackRequired: true },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/tag-elements": {
        status: "Success",
        viewId: 32,
        targetCount: 1,
        taggedCount: 0,
        errorCount: 1,
        tagIds: [],
        errors: [
          {
            elementId: 1411195,
            error: "There is no loaded tag type that can be used when tagging referenceToTag with tagMode."
          }
        ]
      },
      "/revit/export-visible-elements": {
        imagePath: "artifacts/captures/add-space-tag-after.png",
        items: []
      }
    })
  );

  assert.equal(result.workflow, "redline_add");
  assert.equal(result.success, false);
  assert.match(result.failure_reason ?? "", /no loaded tag type/i);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_tag_create_no_errors" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_created_tag_id_present" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_add_summary.json"), "utf8"));
  assert.deepEqual(summary.tagCreationErrors, [
    "errorCount:1",
    "no_tags_created",
    "element 1411195: There is no loaded tag type that can be used when tagging referenceToTag with tagMode."
  ]);
  assert.equal(summary.createdId, null);
  assert.deepEqual(summary.cleanupDeletedIds, []);
});

test("add-like redline workflow blocks tag apply when reviewed dry-run preflight fails", async () => {
  const dir = tempDir("redline-add-tag-dry-run-block");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_add",
      request: {
        viewId: 32,
        targetKind: "tag",
        dryRunPreflightReviewed: true,
        tag: { viewId: 32, elementIds: [1411195], tagTypeName: "Space Tag", readbackRequired: true },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/tag-elements": {
        status: "Dry Run",
        dryRun: true,
        viewId: 32,
        targetCount: 1,
        plannedToTag: 0,
        skippedAlreadyTagged: 0,
        errorCount: 1,
        targets: [{ elementId: 1411195 }],
        errors: [{ elementId: 1411195, error: "No compatible Space Tag type loaded for dry-run." }]
      },
      "/revit/export-visible-elements": {
        imagePath: "artifacts/captures/add-space-tag-after.png",
        items: []
      }
    })
  );

  assert.equal(result.workflow, "redline_add");
  assert.equal(result.success, false);
  assert.equal(result.revit_transactions, 0);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_tag_dry_run_preflight_ok" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_tag_create_no_errors" && !entry.ok), true);
  assert.equal(result.raw_results.filter((entry) => (entry as { dryRun?: boolean }).dryRun === true).length, 1);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_add_summary.json"), "utf8"));
  assert.equal(summary.tagDryRunPreflightOk, false);
  assert.equal(summary.rawCreateResult.dryRun, true);
  assert.deepEqual(summary.targetIds, []);
});

test("add-like redline workflow applies tag only after reviewed dry-run preflight passes", async () => {
  const dir = tempDir("redline-add-tag-dry-run-pass");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_add",
      request: {
        viewId: 32,
        targetKind: "tag",
        dryRunPreflightReviewed: true,
        tag: { viewId: 32, elementIds: [1411195], tagTypeName: "Space Tag", readbackRequired: true },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/tag-elements:1": {
        status: "Dry Run",
        dryRun: true,
        viewId: 32,
        targetCount: 1,
        plannedToTag: 1,
        skippedAlreadyTagged: 0,
        errorCount: 0,
        targets: [{ elementId: 1411195 }]
      },
      "/revit/tag-elements:2": {
        status: "Success",
        viewId: 32,
        targetCount: 1,
        taggedCount: 1,
        errorCount: 0,
        tagIds: [1544001],
        tags: [{ tagId: 1544001, targetElementId: 1411195, tagTypeName: "Space Tag" }]
      },
      "/revit/export-visible-elements": {
        imagePath: "artifacts/captures/add-space-tag-after.png",
        items: [{ id: 1544001, category: "Space Tags", taggedElementIds: [1411195] }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [1544001], impactedIds: [1544001] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [1544001], impactedIds: [1544001] }
    })
  );

  assert.equal(result.workflow, "redline_add");
  assert.equal(result.success, true);
  assert.equal(result.revit_transactions, 2);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_tag_dry_run_preflight_ok" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_add_summary.json"), "utf8"));
  assert.equal(summary.tagDryRunPreflightOk, true);
  assert.equal(summary.rawTagDryRunResult.dryRun, true);
  assert.equal(summary.createdId, 1544001);
});

test("add-like redline workflow rejects tag readback mismatch", async () => {
  const dir = tempDir("redline-add-tag-readback-mismatch");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_add",
      request: {
        viewId: 101,
        targetKind: "tag",
        tag: {
          viewId: 101,
          elementIds: [9001],
          onlyUntagged: false,
          addLeader: false,
          requestedNoteNumberHint: "13",
          readbackRequired: true
        },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/tag-elements": {
        status: "Success",
        viewId: 101,
        targetCount: 1,
        taggedCount: 1,
        errorCount: 0,
        tagIds: [8001],
        tags: [{ tagId: 8001, targetElementId: 9001, value: "12", tagTypeName: "Keynote Tag" }]
      },
      "/revit/export-visible-elements": {
        imagePath: "artifacts/captures/add-tag-after.png",
        items: [{ id: 8001, category: "Tags", hostElementId: 9001, visibleText: "12" }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [8001], impactedIds: [8001] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [8001], impactedIds: [8001] }
    })
  );

  assert.equal(result.workflow, "redline_add");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_created_tag_id_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_tag_apply_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_tag_readback_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_add_summary.json"), "utf8"));
  assert.equal(summary.tagReadbackMatches, false);
});

test("add-like redline workflow accepts spatial tag readback evidence", async () => {
  const dir = tempDir("redline-add-spatial-tag-success");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_add",
      request: {
        viewId: 32,
        targetKind: "tag",
        tag: {
          viewId: 32,
          elementIds: [1411195],
          onlyUntagged: false,
          addLeader: false,
          requestedTagKindHint: "space tag",
          readbackRequired: true
        },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/tag-elements": {
        status: "Success",
        viewId: 32,
        targetCount: 1,
        taggedCount: 1,
        errorCount: 0,
        tagIds: [1544001],
        tags: [
          {
            tagId: 1544001,
            targetElementId: 1411195,
            targetCategory: "Spaces",
            tagCategory: "Space Tags",
            tagTypeName: "Space Tag",
            tagFamilyName: "Space Tag",
            value: "EXIT LOBBY100"
          }
        ]
      },
      "/revit/export-visible-elements": {
        imagePath: "artifacts/captures/add-space-tag-after.png",
        items: [{ id: 1544001, category: "Space Tags", taggedElementIds: [1411195], visibleText: "EXIT LOBBY100" }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [1544001], impactedIds: [1544001] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [1544001], impactedIds: [1544001] }
    })
  );

  assert.equal(result.workflow, "redline_add");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_tag_readback_matches_request" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_add_summary.json"), "utf8"));
  assert.equal(summary.tagReadbackMatches, true);
  assert.equal(summary.rawCreateResult.tags[0].targetElementId, 1411195);
});

test("add-like redline workflow creates verifies and cleans up family instance target", async () => {
  const dir = tempDir("redline-add-family-instance-success");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_add",
      request: {
        viewId: 101,
        targetKind: "family_instance",
        familyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-family-instance": {
        id: 9101,
        name: "Generic Annotation",
        family: "Generic Annotation",
        familyName: "Generic Annotation",
        symbol: "Generic Annotation",
        symbolName: "Generic Annotation",
        typeName: "Generic Annotation"
      },
      "/revit/export-visible-elements": {
        imagePath: "artifacts/captures/add-family-instance-after.png",
        items: [{ id: 9101, category: "Generic Annotations", familyName: "Generic Annotation", symbolName: "Generic Annotation" }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [9101], impactedIds: [9101] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [9101], impactedIds: [9101] }
    })
  );

  assert.equal(result.workflow, "redline_add");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_created_family_instance_id_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_family_instance_type_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_target_visible_after" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_visual_gate_passed" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_add_summary.json"), "utf8"));
  assert.equal(summary.targetKind, "family_instance");
  assert.equal(summary.createdId, 9101);
  assert.equal(summary.requestedFamilyInstanceType, "Generic Annotation");
  assert.deepEqual(summary.createdFamilyInstanceLabels, ["generic annotation"]);
  assert.equal(summary.familyInstanceTypeMatchesRequest, true);
  assert.equal(summary.visibleAfter, true);
  assert.deepEqual(summary.cleanupDeletedIds, [9101]);
});

for (const target of [
  { kind: "receptacle", familyName: "Duplex Receptacle", symbolName: "Duplex Receptacle" },
  { kind: "light", familyName: "Downlight", symbolName: "Downlight" },
  { kind: "mep_accessory", familyName: "Manual Balancing Damper", symbolName: "Manual Balancing Damper" }
]) {
  test(`add-like redline workflow routes ${target.kind} target through family-instance primitive`, async () => {
    const dir = tempDir(`redline-add-${target.kind}-success`);
    const bridge = new MockBridgeTransport({
      "/revit/create-family-instance": {
        id: 9101,
        name: target.symbolName,
        family: target.familyName,
        familyName: target.familyName,
        symbol: target.symbolName,
        symbolName: target.symbolName,
        typeName: target.symbolName
      },
      "/revit/export-visible-elements": {
        imagePath: `artifacts/captures/add-${target.kind}-after.png`,
        items: [{ id: 9101, category: "Electrical Fixtures", familyName: target.familyName, symbolName: target.symbolName }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [9101], impactedIds: [9101] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [9101], impactedIds: [9101] }
    });
    const result = await runRevitDemoWorkflow(
      {
        workflow: "redline_add",
        request: {
          viewId: 101,
          targetKind: target.kind,
          familyInstance: { familyName: target.familyName, symbolName: target.symbolName, levelName: "L1", x: 2, y: 3, z: 0 },
          cleanupCreatedElements: true
        }
      },
      dir,
      bridge
    );

    assert.equal(result.workflow, "redline_add");
    assert.equal(result.success, true);
    assert.equal(bridge.calls.some((call) => call.pathname === "/revit/create-family-instance"), true);
    assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_created_family_instance_id_present" && entry.ok), true);
    assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_family_instance_type_matches_request" && entry.ok), true);
    const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_add_summary.json"), "utf8"));
    assert.equal(summary.targetKind, target.kind);
    assert.equal(summary.requestedFamilyInstanceType, target.symbolName);
    assert.equal(summary.familyInstanceTypeMatchesRequest, true);
    assert.deepEqual(summary.cleanupDeletedIds, [9101]);
  });
}

test("add-like redline workflow rejects family instance type mismatch", async () => {
  const dir = tempDir("redline-add-family-instance-type-mismatch");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_add",
      request: {
        viewId: 101,
        targetKind: "family_instance",
        familyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-family-instance": {
        id: 9101,
        name: "Air Terminal Supply",
        family: "Air Terminal",
        symbolName: "Air Terminal Supply"
      },
      "/revit/export-visible-elements": {
        imagePath: "artifacts/captures/add-family-instance-after.png",
        items: [{ id: 9101, category: "Mechanical Equipment", familyName: "Air Terminal", symbolName: "Air Terminal Supply" }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [9101], impactedIds: [9101] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [9101], impactedIds: [9101] }
    })
  );

  assert.equal(result.workflow, "redline_add");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_created_family_instance_id_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_family_instance_type_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "add_redline_visual_gate_passed" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_add_summary.json"), "utf8"));
  assert.equal(summary.familyInstanceTypeMatchesRequest, false);
});

test("delete-like redline workflow creates deletes and verifies tag target absence", async () => {
  const dir = tempDir("redline-delete-tag-success");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_delete",
      request: {
        viewId: 101,
        targetKind: "tag",
        tag: { viewId: 101, elementIds: [9001], onlyUntagged: false, addLeader: false }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/tag-elements": { status: "Success", viewId: 101, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8101] },
      "/revit/export-visible-elements:1": {
        imagePath: "artifacts/captures/delete-tag-before.png",
        items: [{ id: 8101, category: "Tags", hostElementId: 9001 }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [8101], impactedIds: [8101] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [8101], impactedIds: [8101] },
      "/revit/export-visible-elements:2": {
        imagePath: "artifacts/captures/delete-tag-after.png",
        items: []
      }
    })
  );

  assert.equal(result.workflow, "redline_delete");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_created_tag_id_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_applied_ids_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_visual_gate_passed" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_delete_summary.json"), "utf8"));
  assert.equal(summary.targetKind, "tag");
  assert.equal(summary.createdId, 8101);
  assert.deepEqual(summary.dryRunIds, [8101]);
  assert.deepEqual(summary.deletedIds, [8101]);
  assert.equal(summary.visibleAfter, true);
});

test("delete-like redline workflow preflights existing tag and blocks before write", async () => {
  const dir = tempDir("redline-delete-existing-tag-preflight");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": {
      imagePath: "artifacts/captures/delete-tag-existing-before.png",
      items: [{ id: 8101, category: "Tags", visibleText: "EF-1", hostElementId: 9001 }]
    },
    "/revit/delete:1": { status: "Dry Run", requestedIds: [8101], impactedIds: [8101], dryRun: true },
    "/revit/export-visible-elements:2": {
      imagePath: "artifacts/captures/delete-tag-existing-after-dry-run.png",
      items: [{ id: 8101, category: "Tags", visibleText: "EF-1", hostElementId: 9001 }]
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_delete",
      request: {
        viewId: 101,
        targetKind: "tag",
        tag: { existingTagIds: [8101], elementIds: [9001], readbackRequired: true },
        existingTarget: {
          deleteExisting: true,
          elementIds: [8101],
          expectedCategory: "Tags",
          expectedTagText: "EF-1",
          taggedElementIds: [9001],
          readbackRequired: true
        },
        applyExistingDelete: false
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_delete");
  assert.equal(result.success, false);
  assert.equal(result.revit_transactions, 0);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/tag-elements"), false);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/delete").length, 1);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_existing_tag_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_existing_tag_identity_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_blocked_before_model_write" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_target_still_visible_after_dry_run" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_applied_ids_present" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_delete_summary.json"), "utf8"));
  assert.equal(summary.targetKind, "tag");
  assert.equal(summary.deleteExistingTarget, true);
  assert.equal(summary.blockedBeforeModelWrite, true);
  assert.deepEqual(summary.existingTargetIds, [8101]);
  assert.equal(summary.existingTargetIdentityMatchesRequest, true);
  assert.deepEqual(summary.existingTagTextLabels, ["ef-1"]);
  assert.deepEqual(summary.existingTaggedElementIds, [9001]);
  assert.deepEqual(summary.dryRunIds, [8101]);
  assert.deepEqual(summary.deletedIds, []);
  assert.equal(summary.visibleAfterDryRun, true);
});

test("delete-like redline workflow creates deletes and verifies family instance target absence", async () => {
  const dir = tempDir("redline-delete-family-instance-success");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_delete",
      request: {
        viewId: 101,
        targetKind: "family_instance",
        familyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-family-instance": {
        id: 9101,
        name: "Generic Annotation",
        family: "Generic Annotation",
        familyName: "Generic Annotation",
        symbol: "Generic Annotation",
        symbolName: "Generic Annotation",
        typeName: "Generic Annotation"
      },
      "/revit/export-visible-elements:1": {
        imagePath: "artifacts/captures/delete-family-instance-before.png",
        items: [{ id: 9101, category: "Generic Annotations", familyName: "Generic Annotation", symbolName: "Generic Annotation" }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [9101], impactedIds: [9101] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [9101], impactedIds: [9101] },
      "/revit/export-visible-elements:2": {
        imagePath: "artifacts/captures/delete-family-instance-after.png",
        items: []
      }
    })
  );

  assert.equal(result.workflow, "redline_delete");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_created_family_instance_id_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_family_instance_type_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_target_visible_before" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_applied_ids_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_target_absent_after" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_visual_gate_passed" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_delete_summary.json"), "utf8"));
  assert.equal(summary.targetKind, "family_instance");
  assert.equal(summary.createdId, 9101);
  assert.equal(summary.requestedFamilyInstanceType, "Generic Annotation");
  assert.deepEqual(summary.createdFamilyInstanceLabels, ["generic annotation"]);
  assert.equal(summary.familyInstanceTypeMatchesRequest, true);
  assert.deepEqual(summary.deletedIds, [9101]);
  assert.equal(summary.visibleAfter, true);
});

test("delete-like redline workflow preflights existing MEP accessory and blocks before write", async () => {
  const dir = tempDir("redline-delete-existing-mep-accessory-preflight");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": {
      imagePath: "artifacts/captures/delete-accessory-before.png",
      items: [{ id: 8301, category: "Mechanical Equipment", familyName: "Manual Balancing Damper", typeName: "MBD-8", anchor: { model: { x: 10, y: 5, z: 0 } } }]
    },
    "/revit/delete:1": { status: "Dry Run", requestedIds: [8301], impactedIds: [8301], dryRun: true },
    "/revit/export-visible-elements:2": {
      imagePath: "artifacts/captures/delete-accessory-after-dry-run.png",
      items: [{ id: 8301, category: "Mechanical Equipment", familyName: "Manual Balancing Damper", typeName: "MBD-8", anchor: { model: { x: 10, y: 5, z: 0 } } }]
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_delete",
      request: {
        viewId: 101,
        targetKind: "mep_accessory",
        existingTarget: {
          deleteExisting: true,
          elementIds: [8301],
          expectedFamilyName: "Manual Balancing Damper",
          expectedTypeName: "MBD-8",
          expectedCategory: "Mechanical Equipment",
          readbackRequired: true
        },
        applyExistingDelete: false
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_delete");
  assert.equal(result.success, false);
  assert.equal(result.revit_transactions, 0);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/create-family-instance"), false);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/delete").length, 1);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_existing_target_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_existing_target_identity_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_blocked_before_model_write" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_target_still_visible_after_dry_run" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_applied_ids_present" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_delete_summary.json"), "utf8"));
  assert.equal(summary.deleteExistingTarget, true);
  assert.equal(summary.blockedBeforeModelWrite, true);
  assert.deepEqual(summary.existingTargetIds, [8301]);
  assert.equal(summary.existingTargetIdentityMatchesRequest, true);
  assert.deepEqual(summary.dryRunIds, [8301]);
  assert.deepEqual(summary.deletedIds, []);
  assert.equal(summary.visibleAfterDryRun, true);
});

test("delete-like redline workflow preflights existing pipe route and blocks before write", async () => {
  const dir = tempDir("redline-delete-existing-pipe-route-preflight");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": {
      imagePath: "artifacts/captures/delete-pipe-before.png",
      items: [
        {
          id: 1642001,
          category: "Pipes",
          builtInCategory: "OST_PipeCurves",
          systemName: "Domestic Cold Water",
          typeName: "Pipe Types: Standard",
          anchor: { model: { x: 30, y: 12, z: 0 } }
        }
      ]
    },
    "/revit/trace-connected-network": {
      status: "Ok",
      elementIds: [1642001, 1642002],
      systemName: "Domestic Cold Water",
      openConnectorCount: 0,
      connectedNetworkOk: true
    },
    "/revit/delete:1": { status: "Dry Run", requestedIds: [1642001], impactedIds: [1642001], dryRun: true },
    "/revit/export-visible-elements:2": {
      imagePath: "artifacts/captures/delete-pipe-after-dry-run.png",
      items: [
        {
          id: 1642001,
          category: "Pipes",
          builtInCategory: "OST_PipeCurves",
          systemName: "Domestic Cold Water",
          typeName: "Pipe Types: Standard",
          anchor: { model: { x: 30, y: 12, z: 0 } }
        }
      ]
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_delete",
      request: {
        viewId: 101,
        targetKind: "pipe_route",
        kind: "pipe",
        existingTarget: {
          deleteExisting: true,
          elementIds: [1642001],
          expectedKind: "pipe",
          expectedCategory: "OST_PipeCurves",
          expectedSystemName: "Domestic Cold Water",
          readbackRequired: true,
          connectedNetworkAuditRequired: true
        },
        applyExistingDelete: false
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_delete");
  assert.equal(result.success, false);
  assert.equal(result.revit_transactions, 0);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/mep-route-workflow"), false);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/trace-connected-network").length, 1);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/delete").length, 1);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_existing_target_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_existing_route_identity_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_existing_route_network_audit_covers_target" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_blocked_before_model_write" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_target_still_visible_after_dry_run" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_redline_applied_ids_present" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_delete_summary.json"), "utf8"));
  assert.equal(summary.targetKind, "mep_route");
  assert.equal(summary.deleteExistingTarget, true);
  assert.equal(summary.blockedBeforeModelWrite, true);
  assert.deepEqual(summary.existingTargetIds, [1642001]);
  assert.equal(summary.existingTargetIdentityMatchesRequest, true);
  assert.equal(summary.existingRouteNetworkAuditCoversTarget, true);
  assert.deepEqual(summary.dryRunIds, [1642001]);
  assert.deepEqual(summary.deletedIds, []);
  assert.equal(summary.visibleAfterDryRun, true);
});

test("move-like redline workflow creates moves verifies delta and cleans up", async () => {
  const dir = tempDir("redline-move-text-success");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_move",
      request: {
        viewId: 101,
        toleranceFt: 0.05,
        textNote: { x: 1, y: 1, text: "OPERATOR MOVE REDLINE" },
        move: { vectorX: 1, vectorY: 0, vectorZ: 0 }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-text": { status: "success", id: 7201, viewId: 101 },
      "/revit/export-visible-elements:1": {
        imagePath: "artifacts/captures/move-before.png",
        items: [{ id: 7201, category: "Text Notes", visibleText: "OPERATOR MOVE REDLINE", anchor: { model: { x: 1, y: 1, z: 0 } } }]
      },
      "/revit/move-elements:1": { status: "Dry Run", dryRun: true, movedIds: [7201], rolledBack: true },
      "/revit/move-elements:2": { status: "Moved", dryRun: false, movedIds: [7201], rolledBack: false },
      "/revit/export-visible-elements:2": {
        imagePath: "artifacts/captures/move-after.png",
        items: [{ id: 7201, category: "Text Notes", visibleText: "OPERATOR MOVE REDLINE", anchor: { model: { x: 2, y: 1, z: 0 } } }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [7201], impactedIds: [7201] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [7201], impactedIds: [7201] }
    })
  );

  assert.equal(result.workflow, "redline_move");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_vector_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_move_summary.json"), "utf8"));
  assert.equal(summary.createdId, 7201);
  assert.deepEqual(summary.dryMovedIds, [7201]);
  assert.deepEqual(summary.movedIds, [7201]);
  assert.deepEqual(summary.cleanupDeletedIds, [7201]);
  assert.equal(Math.round(summary.actualDelta.x * 1000) / 1000, 1);
});

test("move-like redline workflow rejects wrong movement vector", async () => {
  const dir = tempDir("redline-move-text-wrong-vector");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_move",
      request: {
        viewId: 101,
        toleranceFt: 0.05,
        textNote: { x: 1, y: 1, text: "OPERATOR MOVE REDLINE" },
        move: { vectorX: 1, vectorY: 0, vectorZ: 0 }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-text": { status: "success", id: 7201, viewId: 101 },
      "/revit/export-visible-elements:1": {
        imagePath: "artifacts/captures/move-before.png",
        items: [{ id: 7201, category: "Text Notes", visibleText: "OPERATOR MOVE REDLINE", anchor: { model: { x: 1, y: 1, z: 0 } } }]
      },
      "/revit/move-elements:1": { status: "Dry Run", dryRun: true, movedIds: [7201], rolledBack: true },
      "/revit/move-elements:2": { status: "Moved", dryRun: false, movedIds: [7201], rolledBack: false },
      "/revit/export-visible-elements:2": {
        imagePath: "artifacts/captures/move-after.png",
        items: [{ id: 7201, category: "Text Notes", visibleText: "OPERATOR MOVE REDLINE", anchor: { model: { x: 1.2, y: 1, z: 0 } } }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [7201], impactedIds: [7201] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [7201], impactedIds: [7201] }
    })
  );

  assert.equal(result.workflow, "redline_move");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_vector_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_visual_gate_passed" && !entry.ok), true);
});

test("move-like redline workflow creates moves verifies tag delta and cleans up", async () => {
  const dir = tempDir("redline-move-tag-success");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_move",
      request: {
        viewId: 101,
        targetKind: "tag",
        toleranceFt: 0.05,
        tag: { viewId: 101, elementIds: [9001], onlyUntagged: false, addLeader: false },
        move: { vectorX: 1, vectorY: 0, vectorZ: 0 }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/tag-elements": { status: "Success", viewId: 101, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8201] },
      "/revit/export-visible-elements:1": {
        imagePath: "artifacts/captures/move-tag-before.png",
        items: [{ id: 8201, category: "Tags", hostElementId: 9001, anchor: { model: { x: 1, y: 1, z: 0 } } }]
      },
      "/revit/move-elements:1": { status: "Dry Run", dryRun: true, movedIds: [8201], rolledBack: true },
      "/revit/move-elements:2": { status: "Moved", dryRun: false, movedIds: [8201], rolledBack: false },
      "/revit/export-visible-elements:2": {
        imagePath: "artifacts/captures/move-tag-after.png",
        items: [{ id: 8201, category: "Tags", hostElementId: 9001, anchor: { model: { x: 2, y: 1, z: 0 } } }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [8201], impactedIds: [8201] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [8201], impactedIds: [8201] }
    })
  );

  assert.equal(result.workflow, "redline_move");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_created_tag_id_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_vector_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_move_summary.json"), "utf8"));
  assert.equal(summary.targetKind, "tag");
  assert.equal(summary.createdId, 8201);
  assert.deepEqual(summary.movedIds, [8201]);
  assert.deepEqual(summary.cleanupDeletedIds, [8201]);
  assert.equal(Math.round(summary.actualDelta.x * 1000) / 1000, 1);
});

test("move-like redline workflow moves existing tag and reverts with readback", async () => {
  const dir = tempDir("redline-move-existing-tag-success");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": {
      imagePath: "artifacts/captures/move-existing-tag-before.png",
      items: [
        {
          id: 8501,
          category: "OST_DuctTags",
          visibleText: "EF-1",
          taggedElementIds: [9001],
          anchor: { model: { x: 4, y: 2, z: 0 } },
          tagAnnotation: {
            hasLeader: true,
            tagHeadPosition: { x: 4, y: 2, z: 0 },
            leaderElbow: { x: 6, y: 2, z: 0 },
            leaderEnd: { x: 4, y: 2, z: 0 }
          }
        }
      ]
    },
    "/revit/move-elements:1": { status: "Dry Run", dryRun: true, movedIds: [8501], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:2": { status: "Moved", dryRun: false, movedIds: [8501], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-visible-elements:2": {
      imagePath: "artifacts/captures/move-existing-tag-after.png",
      items: [
        {
          id: 8501,
          category: "OST_DuctTags",
          visibleText: "EF-1",
          taggedElementIds: [9001],
          anchor: { model: { x: 5, y: 2, z: 0 } },
          tagAnnotation: {
            hasLeader: true,
            tagHeadPosition: { x: 5, y: 2, z: 0 },
            leaderElbow: { x: 7.25, y: 2, z: 0 },
            leaderEnd: { x: 5, y: 2, z: 0 }
          }
        }
      ]
    },
    "/revit/move-elements:3": { status: "Dry Run", dryRun: true, movedIds: [8501], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:4": { status: "Moved", dryRun: false, movedIds: [8501], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-visible-elements:3": {
      imagePath: "artifacts/captures/move-existing-tag-reverted.png",
      items: [
        {
          id: 8501,
          category: "OST_DuctTags",
          visibleText: "EF-1",
          taggedElementIds: [9001],
          anchor: { model: { x: 4, y: 2, z: 0 } },
          tagAnnotation: {
            hasLeader: true,
            tagHeadPosition: { x: 4, y: 2, z: 0 },
            leaderElbow: { x: 6, y: 2, z: 0 },
            leaderEnd: { x: 4, y: 2, z: 0 }
          }
        }
      ]
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_move",
      request: {
        viewId: 101,
        targetKind: "tag",
        toleranceFt: 0.05,
        tag: {
          existingTagIds: [8501],
          elementIds: [9001],
          readbackRequired: true
        },
        existingTarget: {
          moveExisting: true,
          elementIds: [8501],
          expectedCategory: "OST_DuctTags",
          expectedTagText: "EF-1",
          taggedElementIds: [9001],
          readbackRequired: true
        },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        dryRunPreflightReviewed: true,
        visualVerify: true,
        revertAfterVerify: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_move");
  assert.equal(result.success, true);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/tag-elements"), false);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/delete"), false);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/move-elements").length, 4);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_existing_tag_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_existing_tag_identity_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_existing_tag_leader_preserved" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_revert_matches_original" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_move_summary.json"), "utf8"));
  assert.equal(summary.moveExistingTarget, true);
  assert.deepEqual(summary.existingTargetIds, [8501]);
  assert.equal(summary.existingTargetIdentityMatchesRequest, true);
  assert.equal(summary.existingTagTextMatchesRequest, true);
  assert.equal(summary.existingTagTaggedElementMatchesRequest, true);
  assert.deepEqual(summary.existingTargetCategoryLabels, ["ost_ducttags"]);
  assert.deepEqual(summary.existingTagTextLabels, ["ef-1"]);
  assert.deepEqual(summary.existingTaggedElementIds, [9001]);
  assert.equal(summary.leaderPreserved, true);
  assert.deepEqual(summary.movedIds, [8501]);
  assert.deepEqual(summary.revertedMovedIds, [8501]);
  assert.deepEqual(summary.actualDelta, { x: 1, y: 0, z: 0, distance: 1 });
  assert.deepEqual(summary.revertDelta, { x: -1, y: 0, z: 0, distance: 1 });
  assert.equal(summary.finalRestored, true);
});

test("move-like redline workflow accepts space tag taggedSpatial identity", async () => {
  const dir = tempDir("redline-move-existing-space-tag-spatial-success");
  const spaceTagItem = (x: number) => ({
    id: 8501,
    category: "Space Tags",
    visibleText: "Exit Lobby100",
    taggedSpatial: { id: 9001, number: "100", name: "Exit Lobby", type: "Space" },
    anchor: { model: { x, y: 2, z: 0 } },
    tagAnnotation: {
      hasLeader: false,
      tagHeadPosition: { x, y: 2, z: 0 },
      leaderElbow: null,
      leaderEnd: null
    }
  });
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": {
      imagePath: "artifacts/captures/move-existing-space-tag-before.png",
      items: [spaceTagItem(4)]
    },
    "/revit/move-elements:1": { status: "Dry Run", dryRun: true, movedIds: [8501], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:2": { status: "Moved", dryRun: false, movedIds: [8501], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-visible-elements:2": {
      imagePath: "artifacts/captures/move-existing-space-tag-after.png",
      items: [spaceTagItem(5)]
    },
    "/revit/move-elements:3": { status: "Dry Run", dryRun: true, movedIds: [8501], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:4": { status: "Moved", dryRun: false, movedIds: [8501], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-visible-elements:3": {
      imagePath: "artifacts/captures/move-existing-space-tag-reverted.png",
      items: [spaceTagItem(4)]
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_move",
      request: {
        viewId: 101,
        targetKind: "tag",
        toleranceFt: 0.05,
        tag: {
          existingTagIds: [8501],
          elementIds: [9001],
          readbackRequired: true
        },
        existingTarget: {
          moveExisting: true,
          elementIds: [8501],
          expectedCategory: "Space Tags",
          expectedTagText: "Exit Lobby100",
          taggedElementIds: [9001],
          readbackRequired: true
        },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        dryRunPreflightReviewed: true,
        visualVerify: true,
        revertAfterVerify: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_existing_tag_identity_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_existing_tag_leader_preserved" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_move_summary.json"), "utf8"));
  assert.equal(summary.existingTagTaggedElementMatchesRequest, true);
  assert.deepEqual(summary.existingTaggedElementIds, [9001]);
  assert.equal(summary.leaderPreserved, true);
});

test("move-like redline workflow creates moves verifies family instance delta and cleans up", async () => {
  const dir = tempDir("redline-move-family-instance-success");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_move",
      request: {
        viewId: 101,
        targetKind: "family_instance",
        familyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        toleranceFt: 0.05
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-family-instance": {
        id: 9101,
        name: "Generic Annotation",
        family: "Generic Annotation",
        familyName: "Generic Annotation",
        symbol: "Generic Annotation",
        symbolName: "Generic Annotation",
        typeName: "Generic Annotation"
      },
      "/revit/export-visible-elements:1": {
        imagePath: "artifacts/captures/move-family-instance-before.png",
        items: [{ id: 9101, category: "Generic Annotations", anchor: { model: { x: 0, y: 0, z: 0 } } }]
      },
      "/revit/move-elements:1": { status: "Dry Run", movedIds: [9101], skipped: [], warnings: [], rolledBack: true },
      "/revit/move-elements:2": { status: "Moved", movedIds: [9101], skipped: [], warnings: [], rolledBack: false },
      "/revit/export-visible-elements:2": {
        imagePath: "artifacts/captures/move-family-instance-after.png",
        items: [{ id: 9101, category: "Generic Annotations", anchor: { model: { x: 1, y: 0, z: 0 } } }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [9101], impactedIds: [9101] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [9101], impactedIds: [9101] }
    })
  );

  assert.equal(result.workflow, "redline_move");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_created_family_instance_id_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_family_instance_type_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_applied_ids_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_vector_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_visual_gate_passed" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_move_summary.json"), "utf8"));
  assert.equal(summary.targetKind, "family_instance");
  assert.equal(summary.createdId, 9101);
  assert.equal(summary.requestedFamilyInstanceType, "Generic Annotation");
  assert.deepEqual(summary.createdFamilyInstanceLabels, ["generic annotation"]);
  assert.equal(summary.familyInstanceTypeMatchesRequest, true);
  assert.deepEqual(summary.movedIds, [9101]);
  assert.deepEqual(summary.cleanupDeletedIds, [9101]);
  assert.deepEqual(summary.actualDelta, { x: 1, y: 0, z: 0, distance: 1 });
});

test("move-like redline workflow moves existing MEP accessory and reverts", async () => {
  const dir = tempDir("redline-move-existing-mep-accessory-success");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": {
      imagePath: "artifacts/captures/move-accessory-before.png",
      items: [{ id: 8301, category: "Mechanical Equipment", familyName: "Manual Balancing Damper", typeName: "MBD-8", anchor: { model: { x: 10, y: 5, z: 0 } } }]
    },
    "/revit/move-elements:1": { status: "Dry Run", dryRun: true, movedIds: [8301], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:2": { status: "Moved", dryRun: false, movedIds: [8301], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-visible-elements:2": {
      imagePath: "artifacts/captures/move-accessory-after.png",
      items: [{ id: 8301, category: "Mechanical Equipment", familyName: "Manual Balancing Damper", typeName: "MBD-8", anchor: { model: { x: 11, y: 5, z: 0 } } }]
    },
    "/revit/move-elements:3": { status: "Dry Run", dryRun: true, movedIds: [8301], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:4": { status: "Moved", dryRun: false, movedIds: [8301], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-visible-elements:3": {
      imagePath: "artifacts/captures/move-accessory-reverted.png",
      items: [{ id: 8301, category: "Mechanical Equipment", familyName: "Manual Balancing Damper", typeName: "MBD-8", anchor: { model: { x: 10, y: 5, z: 0 } } }]
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_move",
      request: {
        viewId: 101,
        targetKind: "mep_accessory",
        toleranceFt: 0.05,
        existingTarget: {
          moveExisting: true,
          elementIds: [8301],
          expectedFamilyName: "Manual Balancing Damper",
          expectedTypeName: "MBD-8",
          expectedCategory: "Mechanical Equipment",
          readbackRequired: true
        },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        dryRunPreflightReviewed: true,
        visualVerify: true,
        revertAfterVerify: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_move");
  assert.equal(result.success, true);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/create-family-instance"), false);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/delete"), false);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/move-elements").length, 4);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_existing_target_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_existing_target_identity_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_revert_matches_original" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_move_summary.json"), "utf8"));
  assert.equal(summary.moveExistingTarget, true);
  assert.deepEqual(summary.existingTargetIds, [8301]);
  assert.equal(summary.existingTargetIdentityMatchesRequest, true);
  assert.deepEqual(summary.existingTargetCategoryLabels, ["mechanical equipment"]);
  assert.deepEqual(summary.movedIds, [8301]);
  assert.deepEqual(summary.revertedMovedIds, [8301]);
  assert.deepEqual(summary.actualDelta, { x: 1, y: 0, z: 0, distance: 1 });
  assert.deepEqual(summary.revertDelta, { x: -1, y: 0, z: 0, distance: 1 });
  assert.equal(summary.finalRestored, true);
});

test("move-like redline workflow moves existing route and reverts with network readback", async () => {
  const dir = tempDir("redline-move-existing-route-success");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": {
      imagePath: "artifacts/captures/move-route-before.png",
      items: [{ id: 8401, category: "OST_PipeCurves", systemName: "Domestic Cold Water", anchor: { model: { x: 20, y: 10, z: 0 } } }]
    },
    "/revit/trace-connected-network:1": { status: "Success", networkElementIds: [8401, 8402], systemName: "Domestic Cold Water" },
    "/revit/move-elements:1": { status: "Dry Run", dryRun: true, movedIds: [8401], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:2": { status: "Moved", dryRun: false, movedIds: [8401], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-visible-elements:2": {
      imagePath: "artifacts/captures/move-route-after.png",
      items: [{ id: 8401, category: "OST_PipeCurves", systemName: "Domestic Cold Water", anchor: { model: { x: 20, y: 11, z: 0 } } }]
    },
    "/revit/move-elements:3": { status: "Dry Run", dryRun: true, movedIds: [8401], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:4": { status: "Moved", dryRun: false, movedIds: [8401], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-visible-elements:3": {
      imagePath: "artifacts/captures/move-route-reverted.png",
      items: [{ id: 8401, category: "OST_PipeCurves", systemName: "Domestic Cold Water", anchor: { model: { x: 20, y: 10, z: 0 } } }]
    },
    "/revit/trace-connected-network:2": { status: "Success", networkElementIds: [8401, 8402], systemName: "Domestic Cold Water" }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_move",
      request: {
        viewId: 101,
        targetKind: "pipe_route",
        toleranceFt: 0.05,
        existingTarget: {
          moveExisting: true,
          elementIds: [8401],
          expectedKind: "pipe",
          expectedCategory: "OST_PipeCurves",
          expectedSystemName: "Domestic Cold Water",
          readbackRequired: true,
          connectedNetworkAuditRequired: true
        },
        move: { mode: "vector", vectorX: 0, vectorY: 1, vectorZ: 0, behavior: "allOrNothing" },
        dryRunPreflightReviewed: true,
        visualVerify: true,
        revertAfterVerify: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_move");
  assert.equal(result.success, true);
  assert.equal(result.tool_calls, 9);
  assert.equal(result.revit_transactions, 2);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/mep-route-workflow"), false);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/delete"), false);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/trace-connected-network").length, 2);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_existing_route_identity_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_existing_route_system_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_existing_route_network_audit_covers_target" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_revert_matches_original" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_move_summary.json"), "utf8"));
  assert.equal(summary.moveExistingTarget, true);
  assert.deepEqual(summary.existingTargetIds, [8401]);
  assert.equal(summary.existingRouteNetworkAuditCoversTarget, true);
  assert.deepEqual(summary.existingTargetCategoryLabels, ["ost_pipecurves"]);
  assert.deepEqual(summary.existingTargetSystemLabels, ["domestic cold water"]);
  assert.deepEqual(summary.actualDelta, { x: 0, y: 1, z: 0, distance: 1 });
  assert.deepEqual(summary.revertDelta, { x: 0, y: -1, z: 0, distance: 1 });
  assert.equal(summary.finalRestored, true);
});

test("move-like redline workflow rejects existing route move when network audit reports disconnected continuity", async () => {
  const dir = tempDir("redline-move-existing-route-disconnected-audit");
  const bridge = new MockBridgeTransport({
    "/revit/export-visible-elements:1": {
      imagePath: "artifacts/captures/move-route-before.png",
      items: [{ id: 8401, category: "OST_PipeCurves", systemName: "Domestic Cold Water", anchor: { model: { x: 20, y: 10, z: 0 } } }]
    },
    "/revit/trace-connected-network:1": {
      status: "Success",
      networkElementIds: [8401, 8402],
      systemName: "Domestic Cold Water",
      systemAudit: { pass: true, connectedCount: 1, disconnectedCount: 1 }
    },
    "/revit/move-elements:1": { status: "Dry Run", dryRun: true, movedIds: [8401], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:2": { status: "Moved", dryRun: false, movedIds: [8401], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-visible-elements:2": {
      imagePath: "artifacts/captures/move-route-after.png",
      items: [{ id: 8401, category: "OST_PipeCurves", systemName: "Domestic Cold Water", anchor: { model: { x: 20, y: 11, z: 0 } } }]
    },
    "/revit/move-elements:3": { status: "Dry Run", dryRun: true, movedIds: [8401], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:4": { status: "Moved", dryRun: false, movedIds: [8401], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-visible-elements:3": {
      imagePath: "artifacts/captures/move-route-reverted.png",
      items: [{ id: 8401, category: "OST_PipeCurves", systemName: "Domestic Cold Water", anchor: { model: { x: 20, y: 10, z: 0 } } }]
    },
    "/revit/trace-connected-network:2": {
      status: "Success",
      networkElementIds: [8401, 8402],
      systemName: "Domestic Cold Water",
      systemAudit: { pass: true, connectedCount: 1, disconnectedCount: 1 }
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_move",
      request: {
        viewId: 101,
        targetKind: "pipe_route",
        toleranceFt: 0.05,
        existingTarget: {
          moveExisting: true,
          elementIds: [8401],
          expectedKind: "pipe",
          expectedCategory: "OST_PipeCurves",
          expectedSystemName: "Domestic Cold Water",
          readbackRequired: true,
          connectedNetworkAuditRequired: true
        },
        move: { mode: "vector", vectorX: 0, vectorY: 1, vectorZ: 0, behavior: "allOrNothing" },
        dryRunPreflightReviewed: true,
        visualVerify: true,
        revertAfterVerify: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_move");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_existing_route_network_audit_covers_target" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_existing_route_network_audit_connected" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_move_summary.json"), "utf8"));
  assert.equal(summary.existingRouteNetworkAuditCoversTarget, true);
  assert.equal(summary.existingRouteNetworkAuditConnected, false);
  assert.equal(summary.existingRouteNetworkAuditBeforeContinuity.detail.disconnectedCount, 1);
});

test("move-like redline workflow fails existing MEP accessory when reverse move is not proven", async () => {
  const dir = tempDir("redline-move-existing-mep-accessory-revert-fail");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_move",
      request: {
        viewId: 101,
        targetKind: "mep_accessory",
        toleranceFt: 0.05,
        existingTarget: { moveExisting: true, elementIds: [8301], expectedFamilyName: "Manual Balancing Damper", expectedCategory: "Mechanical Equipment", readbackRequired: true },
        move: { vectorX: 1, vectorY: 0, vectorZ: 0 },
        dryRunPreflightReviewed: true,
        visualVerify: true,
        revertAfterVerify: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/export-visible-elements:1": {
        imagePath: "artifacts/captures/move-accessory-before.png",
        items: [{ id: 8301, category: "Mechanical Equipment", anchor: { model: { x: 10, y: 5, z: 0 } } }]
      },
      "/revit/move-elements:1": { status: "Dry Run", movedIds: [8301], rolledBack: true },
      "/revit/move-elements:2": { status: "Moved", movedIds: [8301], rolledBack: false },
      "/revit/export-visible-elements:2": {
        imagePath: "artifacts/captures/move-accessory-after.png",
        items: [{ id: 8301, category: "Mechanical Equipment", anchor: { model: { x: 11, y: 5, z: 0 } } }]
      },
      "/revit/move-elements:3": { status: "Dry Run", movedIds: [8301], rolledBack: true },
      "/revit/move-elements:4": { status: "Moved", movedIds: [8301], rolledBack: false },
      "/revit/export-visible-elements:3": {
        imagePath: "artifacts/captures/move-accessory-reverted.png",
        items: [{ id: 8301, category: "Mechanical Equipment", anchor: { model: { x: 10.4, y: 5, z: 0 } } }]
      }
    })
  );

  assert.equal(result.workflow, "redline_move");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_revert_matches_original" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_redline_visual_gate_passed" && !entry.ok), true);
});

test("rotate-like redline workflow creates rotates and cleans up", async () => {
  const dir = tempDir("redline-rotate-text-success");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_rotate",
      request: {
        viewId: 101,
        textNote: { x: 1, y: 1, text: "OPERATOR ROTATE REDLINE" },
        rotate: { angleDegrees: 90, axis: { mode: "zThroughPoint", pointX: 1, pointY: 1, pointZ: 0 } }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-text": { status: "success", id: 7301, viewId: 101 },
      "/revit/export-visible-elements:1": {
        imagePath: "artifacts/captures/rotate-before.png",
        items: [{ id: 7301, category: "Text Notes", visibleText: "OPERATOR ROTATE REDLINE", anchor: { model: { x: 1, y: 1, z: 0 } } }]
      },
      "/revit/rotate-elements:1": { status: "Dry Run", dryRun: true, rotatedIds: [7301], rolledBack: true },
      "/revit/rotate-elements:2": { status: "Rotated", dryRun: false, rotatedIds: [7301], rolledBack: false },
      "/revit/export-visible-elements:2": {
        imagePath: "artifacts/captures/rotate-after.png",
        items: [{ id: 7301, category: "Text Notes", visibleText: "OPERATOR ROTATE REDLINE", anchor: { model: { x: 1, y: 1, z: 0 } } }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [7301], impactedIds: [7301] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [7301], impactedIds: [7301] }
    })
  );

  assert.equal(result.workflow, "redline_rotate");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "rotate_redline_applied_ids_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "rotate_redline_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_rotate_summary.json"), "utf8"));
  assert.equal(summary.createdId, 7301);
  assert.deepEqual(summary.dryRotatedIds, [7301]);
  assert.deepEqual(summary.rotatedIds, [7301]);
  assert.deepEqual(summary.cleanupDeletedIds, [7301]);
});

test("rotate-like redline workflow rejects missing rotated id", async () => {
  const dir = tempDir("redline-rotate-text-missing-id");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_rotate",
      request: {
        viewId: 101,
        textNote: { x: 1, y: 1, text: "OPERATOR ROTATE REDLINE" },
        rotate: { angleDegrees: 90, axis: { mode: "zThroughPoint", pointX: 1, pointY: 1, pointZ: 0 } }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-text": { status: "success", id: 7301, viewId: 101 },
      "/revit/export-visible-elements:1": {
        imagePath: "artifacts/captures/rotate-before.png",
        items: [{ id: 7301, category: "Text Notes", visibleText: "OPERATOR ROTATE REDLINE", anchor: { model: { x: 1, y: 1, z: 0 } } }]
      },
      "/revit/rotate-elements:1": { status: "Dry Run", dryRun: true, rotatedIds: [7301], rolledBack: true },
      "/revit/rotate-elements:2": { status: "Rotated", dryRun: false, rotatedIds: [], rolledBack: false },
      "/revit/export-visible-elements:2": {
        imagePath: "artifacts/captures/rotate-after.png",
        items: [{ id: 7301, category: "Text Notes", visibleText: "OPERATOR ROTATE REDLINE", anchor: { model: { x: 1, y: 1, z: 0 } } }]
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [7301], impactedIds: [7301] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [7301], impactedIds: [7301] }
    })
  );

  assert.equal(result.workflow, "redline_rotate");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "rotate_redline_applied_ids_present" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "rotate_redline_visual_gate_passed" && !entry.ok), true);
});

test("type-change redline workflow dry-runs applies captures and reverts", async () => {
  const dir = tempDir("redline-type-change-device-success");
  const bridge = new MockBridgeTransport({
      "/revit/change-element-type:1": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9401, newTypeId: 9402 }]
      },
      "/revit/change-element-type:2": {
        ok: true,
        committed: true,
        rolledBack: false,
        count: 1,
        newTypeId: 9402,
        newTypeName: "Target Device Type",
        changedElementIds: [9301],
        changes: [{ elementId: 9301, ok: true, oldTypeId: 9401, oldTypeName: "Original Device Type", newTypeId: 9402, newTypeName: "Target Device Type" }]
      },
      "/revit/change-element-type:3": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9402, newTypeId: 9402 }]
      },
      "/revit/export-image": {
        status: "Captured",
        viewId: 101,
        path: "artifacts/captures/type-change-after.png"
      },
      "/revit/change-element-type:4": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9402, newTypeId: 9401 }]
      },
      "/revit/change-element-type:5": {
        ok: true,
        committed: true,
        rolledBack: false,
        count: 1,
        newTypeId: 9401,
        newTypeName: "Original Device Type",
        changedElementIds: [9301],
        changes: [{ elementId: 9301, ok: true, oldTypeId: 9402, oldTypeName: "Target Device Type", newTypeId: 9401, newTypeName: "Original Device Type" }]
      },
      "/revit/change-element-type:6": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9401, newTypeId: 9401 }]
      }
    });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_type_change",
      request: {
        elementIds: [9301],
        category: "OST_ElectricalFixtures",
        targetTypeId: 9402,
        sourceTypeGrounding: { expectedCurrentTypeId: 9401 },
        dryRunPreflightReviewed: true,
        targetTypeCompatibilityReviewed: true,
        visualViewId: 101,
        visualVerify: true,
        revertAfterVerify: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_type_change");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_apply_ids_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_apply_committed" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_dry_run_target_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_source_type_grounding_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_readback_matches_target" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_revert_readback_matches_original" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_revert_apply_committed" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_type_change_summary.json"), "utf8"));
  assert.equal(summary.expectedNewTypeId, 9402);
  assert.deepEqual(summary.appliedIds, [9301]);
  assert.equal(summary.readbackMatches, true);
  assert.deepEqual(summary.revertedIds, [9301]);
  assert.equal(summary.revertReadbackMatches, true);
  const typeChangeCalls = bridge.calls.filter((call) => call.pathname === "/revit/change-element-type");
  assert.deepEqual((typeChangeCalls[1].body as any).expectedOldTypes, [{ elementId: 9301, typeId: 9401 }]);
  assert.deepEqual((typeChangeCalls[4].body as any).expectedOldTypes, [{ elementId: 9301, typeId: 9402 }]);
});

test("type-change redline stops after stale guarded apply instead of reverting another actor's change", async () => {
  const dir = tempDir("redline-type-change-stale-apply");
  const bridge = new MockBridgeTransport({
    "/revit/change-element-type:1": {
      ok: true,
      dryRun: true,
      changes: [{ elementId: 9301, ok: true, oldTypeId: 9401, newTypeId: 9402 }]
    },
    "/revit/change-element-type:2": {
      ok: false,
      count: 0,
      rolledBack: true,
      failureReason: "Current type no longer matches expectedOldTypes.",
      changedElementIds: [],
      changes: [{ elementId: 9301, ok: false, oldTypeId: 9402, expectedOldTypeId: 9401 }]
    }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_type_change",
      request: {
        elementIds: [9301],
        category: "OST_ElectricalFixtures",
        targetTypeId: 9402,
        sourceTypeGrounding: { expectedCurrentTypeId: 9401 },
        dryRunPreflightReviewed: true,
        targetTypeCompatibilityReviewed: true,
        visualVerify: false,
        revertAfterVerify: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.success, false);
  assert.match(result.failure_reason ?? "", /readback and revert were not attempted/i);
  const calls = bridge.calls.filter((call) => call.pathname === "/revit/change-element-type");
  assert.equal(calls.length, 2);
  assert.deepEqual((calls[1].body as any).expectedOldTypes, [{ elementId: 9301, typeId: 9401 }]);
});

test("type-change redline workflow blocks before writes when dry-run compatibility is incomplete", async () => {
  const dir = tempDir("redline-type-change-dry-run-block");
  const bridge = new MockBridgeTransport({
    "/revit/change-element-type:1": {
      ok: false,
      dryRun: true,
      changes: [{ elementId: 9301, ok: false, dryRun: true, oldTypeId: 9401, newTypeId: 9403, error: "Target type is incompatible with selected element." }]
    }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_type_change",
      request: {
        elementIds: [9301],
        category: "OST_ElectricalFixtures",
        targetTypeId: 9402,
        sourceTypeGrounding: { expectedCurrentTypeId: 9401 },
        dryRunPreflightReviewed: true,
        targetTypeCompatibilityReviewed: true,
        visualViewId: 101,
        visualVerify: true,
        revertAfterVerify: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_type_change");
  assert.equal(result.success, false);
  assert.equal(result.revit_transactions, 0);
  assert.equal(result.tool_calls, 1);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/change-element-type").length, 1);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_dry_run_ok" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_dry_run_target_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_apply_ids_present" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_type_change_summary.json"), "utf8"));
  assert.equal(summary.blockedBeforeModelWrite, true);
});

test("type-change redline workflow blocks MEP accessory when source family grounding mismatches", async () => {
  const dir = tempDir("redline-type-change-accessory-source-block");
  const bridge = new MockBridgeTransport({
    "/revit/change-element-type:1": {
      ok: true,
      dryRun: true,
      changes: [{
        elementId: 9701,
        ok: true,
        dryRun: true,
        category: "OST_DuctTerminal",
        familyName: "Supply Diffuser",
        oldTypeId: 9801,
        oldTypeName: "12x12 Supply Diffuser",
        newTypeId: 9802,
        newTypeName: "14x14 Manual Balancing Damper"
      }]
    }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_type_change",
      request: {
        elementIds: [9701],
        category: "OST_DuctAccessory",
        targetTypeId: 9802,
        sourceFamilyGrounding: {
          expectedFamilyName: "Manual Balancing Damper",
          expectedTypeName: "12x12 Manual Balancing Damper",
          expectedCategory: "OST_DuctAccessory"
        },
        sourceTypeGrounding: { expectedCurrentTypeId: 9801 },
        dryRunPreflightReviewed: true,
        targetTypeCompatibilityReviewed: true,
        visualViewId: 101,
        visualVerify: true,
        revertAfterVerify: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_type_change");
  assert.equal(result.success, false);
  assert.equal(result.revit_transactions, 0);
  assert.equal(result.tool_calls, 1);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/change-element-type").length, 1);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_source_type_grounding_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_source_family_grounding_ok" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_apply_ids_present" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_type_change_summary.json"), "utf8"));
  assert.equal(summary.blockedBeforeModelWrite, true);
  assert.equal(summary.sourceFamilyGroundingOk, false);
  assert.equal(summary.expectedSourceFamilyName, "Manual Balancing Damper");
});

test("type-change redline workflow resolves numeric guards from a target type name before writing", async () => {
  const dir = tempDir("redline-type-change-name-only-success");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_type_change",
      request: {
        elementIds: [9301],
        category: "OST_ElectricalFixtures",
        targetTypeName: "Target Device Type",
        sourceTypeGrounding: { expectedCurrentTypeName: "Original Device Type" },
        dryRunPreflightReviewed: true,
        targetTypeCompatibilityReviewed: true,
        visualViewId: 101,
        visualVerify: true,
        revertAfterVerify: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/change-element-type:1": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9401, oldTypeName: "Original Device Type", newTypeId: 9402, newTypeName: "Target Device Type" }]
      },
      "/revit/change-element-type:2": {
        ok: true,
        committed: true,
        rolledBack: false,
        count: 1,
        newTypeId: 9402,
        newTypeName: "Target Device Type",
        changedElementIds: [9301],
        changes: [{ elementId: 9301, ok: true, oldTypeId: 9401, oldTypeName: "Original Device Type", newTypeId: 9402, newTypeName: "Target Device Type" }]
      },
      "/revit/change-element-type:3": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9402, oldTypeName: "Target Device Type", newTypeId: 9402, newTypeName: "Target Device Type" }]
      },
      "/revit/export-image": {
        status: "Captured",
        viewId: 101,
        path: "artifacts/captures/type-change-name-only-after.png"
      },
      "/revit/change-element-type:4": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9402, oldTypeName: "Target Device Type", newTypeId: 9401 }]
      },
      "/revit/change-element-type:5": {
        ok: true,
        committed: true,
        rolledBack: false,
        count: 1,
        newTypeId: 9401,
        newTypeName: "Original Device Type",
        changedElementIds: [9301],
        changes: [{ elementId: 9301, ok: true, oldTypeId: 9402, oldTypeName: "Target Device Type", newTypeId: 9401, newTypeName: "Original Device Type" }]
      },
      "/revit/change-element-type:6": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9401, oldTypeName: "Original Device Type", newTypeId: 9401 }]
      }
    })
  );

  assert.equal(result.workflow, "redline_type_change");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_target_type_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_readback_matches_target" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_type_change_summary.json"), "utf8"));
  assert.equal(summary.expectedNewTypeId, 9402);
  assert.equal(summary.expectedNewTypeName, "target device type");
  assert.equal(summary.appliedTypeMatchesRequest, true);
  assert.equal(summary.readbackMatches, true);
});

test("type-change redline workflow rejects target type name readback mismatch", async () => {
  const dir = tempDir("redline-type-change-name-only-readback-mismatch");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_type_change",
      request: {
        elementIds: [9301],
        category: "OST_ElectricalFixtures",
        targetTypeName: "Target Device Type",
        sourceTypeGrounding: { expectedCurrentTypeName: "Original Device Type" },
        dryRunPreflightReviewed: true,
        targetTypeCompatibilityReviewed: true,
        visualViewId: 101,
        visualVerify: true,
        revertAfterVerify: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/change-element-type:1": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9401, oldTypeName: "Original Device Type", newTypeId: 9402, newTypeName: "Target Device Type" }]
      },
      "/revit/change-element-type:2": {
        ok: true,
        committed: true,
        rolledBack: false,
        count: 1,
        newTypeId: 9402,
        newTypeName: "Target Device Type",
        changedElementIds: [9301],
        changes: [{ elementId: 9301, ok: true, oldTypeId: 9401, oldTypeName: "Original Device Type", newTypeId: 9402, newTypeName: "Target Device Type" }]
      },
      "/revit/change-element-type:3": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9403, oldTypeName: "Wrong Device Type", newTypeId: 9402, newTypeName: "Target Device Type" }]
      },
      "/revit/export-image": {
        status: "Captured",
        viewId: 101,
        path: "artifacts/captures/type-change-name-only-wrong-readback.png"
      },
      "/revit/change-element-type:4": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9403, oldTypeName: "Wrong Device Type", newTypeId: 9401 }]
      },
      "/revit/change-element-type:5": {
        ok: true,
        committed: true,
        rolledBack: false,
        count: 1,
        newTypeId: 9401,
        newTypeName: "Original Device Type",
        changedElementIds: [9301],
        changes: [{ elementId: 9301, ok: true, oldTypeId: 9403, oldTypeName: "Wrong Device Type", newTypeId: 9401, newTypeName: "Original Device Type" }]
      },
      "/revit/change-element-type:6": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9401, oldTypeName: "Original Device Type", newTypeId: 9401 }]
      }
    })
  );

  assert.equal(result.workflow, "redline_type_change");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_target_type_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_readback_matches_target" && !entry.ok), true);
});

test("type-change redline workflow rejects post-change capture from the wrong requested view", async () => {
  const dir = tempDir("redline-type-change-device-wrong-capture-view");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_type_change",
      request: {
        elementIds: [9301],
        category: "OST_ElectricalFixtures",
        targetTypeId: 9402,
        sourceTypeGrounding: { expectedCurrentTypeId: 9401 },
        dryRunPreflightReviewed: true,
        targetTypeCompatibilityReviewed: true,
        visualViewId: 101,
        visualVerify: true,
        revertAfterVerify: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/change-element-type:1": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9401, newTypeId: 9402 }]
      },
      "/revit/change-element-type:2": {
        ok: true,
        committed: true,
        rolledBack: false,
        count: 1,
        newTypeId: 9402,
        newTypeName: "Target Device Type",
        changedElementIds: [9301],
        changes: [{ elementId: 9301, ok: true, oldTypeId: 9401, oldTypeName: "Original Device Type", newTypeId: 9402, newTypeName: "Target Device Type" }]
      },
      "/revit/change-element-type:3": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9402, newTypeId: 9402 }]
      },
      "/revit/export-image": {
        status: "Captured",
        viewId: 9999,
        path: "artifacts/captures/type-change-after-wrong-view.png"
      },
      "/revit/change-element-type:4": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9402, newTypeId: 9401 }]
      },
      "/revit/change-element-type:5": {
        ok: true,
        committed: true,
        rolledBack: false,
        count: 1,
        newTypeId: 9401,
        newTypeName: "Original Device Type",
        changedElementIds: [9301],
        changes: [{ elementId: 9301, ok: true, oldTypeId: 9402, oldTypeName: "Target Device Type", newTypeId: 9401, newTypeName: "Original Device Type" }]
      },
      "/revit/change-element-type:6": {
        ok: true,
        dryRun: true,
        changes: [{ elementId: 9301, ok: true, dryRun: true, oldTypeId: 9401, newTypeId: 9401 }]
      }
    })
  );

  assert.equal(result.workflow, "redline_type_change");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_post_change_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_post_change_capture_view_id_matches_request" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_type_change_summary.json"), "utf8"));
  assert.equal(summary.postChangeCaptureViewId, 9999);
});

test("type-change redline blocks name-only requests when dry run cannot resolve numeric guards", async () => {
  const dir = tempDir("redline-type-change-name-only-missing-guard");
  const bridge = new MockBridgeTransport({
    "/revit/change-element-type:1": {
      ok: true,
      dryRun: true,
      changes: [{ elementId: 9301, ok: true, oldTypeId: 9401, oldTypeName: "Original Device Type", newTypeName: "Target Device Type" }]
    }
  });
  const result = await runRevitDemoWorkflow({
    workflow: "redline_type_change",
    request: {
      elementIds: [9301],
      targetTypeName: "Target Device Type",
      sourceTypeGrounding: { expectedCurrentTypeName: "Original Device Type" },
      dryRunPreflightReviewed: true,
      targetTypeCompatibilityReviewed: true,
      visualVerify: false,
      revertAfterVerify: true
    }
  }, dir, bridge);

  assert.equal(result.success, false);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/change-element-type").length, 1);
  assert.equal(result.verification_results.some((entry) => entry.name === "type_change_numeric_guards_resolved" && !entry.ok), true);
});

test("documentation existing-value edits compare current state before any write", async () => {
  const cases: Array<{
    name: string;
    request: Record<string, unknown>;
    fixtures: Record<string, unknown>;
    expectedFailure: RegExp;
    expectedReadPaths: string[];
  }> = [
    {
      name: "schedule",
      request: {
        visualVerify: false,
        schedule: {
          editExistingValue: true,
          scheduleId: 100,
          elementId: 200,
          rowKey: "AHU-1",
          parameterName: "Supply Air",
          expectedExistingValue: "10000",
          replacementValue: "20000",
          readbackRequired: true,
          revertAfterVerify: true
        }
      },
      fixtures: {
        "/revit/get-parameters": { items: [{ id: 200, parameters: { "Supply Air": "15000" } }] }
      },
      expectedFailure: /schedule edit blocked before write/i,
      expectedReadPaths: ["/revit/get-parameters"]
    },
    {
      name: "text-note",
      request: {
        visualVerify: false,
        textNote: {
          editExisting: true,
          viewId: 300,
          textNoteId: 301,
          expectedExistingText: "EXISTING TO REMAIN",
          newText: "REMOVE",
          readbackRequired: true,
          revertAfterVerify: true
        }
      },
      fixtures: {
        "/revit/find-text-notes": { items: [{ id: 301, ownerViewId: 300, text: "FIELD CHANGED" }] }
      },
      expectedFailure: /text-note edit blocked before write/i,
      expectedReadPaths: ["/revit/find-text-notes"]
    },
    {
      name: "tag-value",
      request: {
        visualVerify: false,
        tag: {
          editExistingValue: true,
          viewId: 400,
          elementIds: [401],
          existingTagIds: [402],
          valueSourceParameterName: "Mark",
          expectedExistingValue: "AHU-1",
          requestedTagValueHint: "AHU-2",
          expectedExistingVisibleText: "AHU-1",
          requestedVisibleText: "AHU-2",
          readbackRequired: true,
          revertAfterVerify: true
        }
      },
      fixtures: {
        "/revit/get-parameters": { items: [{ id: 401, parameters: { Mark: "FIELD-EDITED" } }] },
        "/revit/export-visible-elements": { items: [{ id: 402, visibleText: "AHU-1" }] }
      },
      expectedFailure: /tag value edit blocked before write/i,
      expectedReadPaths: ["/revit/get-parameters", "/revit/export-visible-elements"]
    }
  ];

  for (const entry of cases) {
    const dir = tempDir(`documentation-cas-${entry.name}`);
    const bridge = new MockBridgeTransport(entry.fixtures);
    const result = await runRevitDemoWorkflow(
      { workflow: "documentation_primitives", request: entry.request },
      dir,
      bridge
    );

    assert.equal(result.success, false, entry.name);
    assert.match(result.failure_reason ?? "", entry.expectedFailure, entry.name);
    assert.deepEqual(bridge.calls.map((call) => call.pathname), entry.expectedReadPaths, entry.name);
    assert.equal(bridge.calls.some((call) =>
      call.pathname === "/revit/set-parameter" ||
      call.pathname === "/revit/replace-text-note"
    ), false, entry.name);
  }
});

test("documentation schedule edit accepts Revit-formatted numeric values and carries atomic old-value guards", async () => {
  const dir = tempDir("documentation-schedule-formatted-cas");
  const afterCsv = path.join(dir, "schedule-after.csv");
  const finalCsv = path.join(dir, "schedule-final.csv");
  fs.writeFileSync(afterCsv, "Equipment,Supply Air\nAHU-1,20,000 CFM\n");
  fs.writeFileSync(finalCsv, "Equipment,Supply Air\nAHU-1,10,000 CFM\n");
  const bridge = new MockBridgeTransport({
    "/revit/get-parameters:1": { items: [{ id: 200, parameters: { "Supply Air": "166.6666667" }, parameterDetails: [{ name: "Supply Air", value: "166.6666667", valueString: "10,000 CFM", storageType: "Double" }] }] },
    "/revit/set-parameter:1": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 200, parameterName: "Supply Air", ok: true, changed: true }] },
    "/revit/set-parameter:2": { status: "Applied and Verified", dryRun: false, changedCount: 1, diffs: [{ elementId: 200, parameterName: "Supply Air", ok: true, changed: true }] },
    "/revit/get-parameters:2": { items: [{ id: 200, parameters: { "Supply Air": "333.3333333" }, parameterDetails: [{ name: "Supply Air", value: "333.3333333", valueString: "20,000 CFM", storageType: "Double" }] }] },
    "/revit/export-schedule-csv:1": { status: "Success", scheduleId: 100, path: afterCsv },
    "/revit/set-parameter:3": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 200, parameterName: "Supply Air", ok: true, changed: true }] },
    "/revit/set-parameter:4": { status: "Applied and Verified", dryRun: false, changedCount: 1, diffs: [{ elementId: 200, parameterName: "Supply Air", ok: true, changed: true }] },
    "/revit/get-parameters:3": { items: [{ id: 200, parameters: { "Supply Air": "166.6666667" }, parameterDetails: [{ name: "Supply Air", value: "166.6666667", valueString: "10,000 CFM", storageType: "Double" }] }] },
    "/revit/export-schedule-csv:2": { status: "Success", scheduleId: 100, path: finalCsv }
  });

  const result = await runRevitDemoWorkflow({
    workflow: "documentation_primitives",
    request: {
      visualVerify: false,
      schedule: {
        editExistingValue: true,
        scheduleId: 100,
        scheduleName: "AHU Schedule",
        elementId: 200,
        rowKey: "AHU-1",
        parameterName: "Supply Air",
        expectedExistingValue: "10,000 CFM",
        replacementValue: "20,000 CFM",
        readbackRequired: true,
        revertAfterVerify: true
      }
    }
  }, dir, bridge);

  assert.equal(result.success, true);
  const setCalls = bridge.calls.filter((call) => call.pathname === "/revit/set-parameter");
  assert.equal(((setCalls[0].body as any).changes[0]).expectedOldValue, "10,000 CFM");
  assert.equal(((setCalls[1].body as any).changes[0]).expectedOldValue, "10,000 CFM");
  assert.equal(((setCalls[2].body as any).changes[0]).expectedOldValue, "20,000 CFM");
  assert.equal(((setCalls[3].body as any).changes[0]).expectedOldValue, "20,000 CFM");
});

test("documentation schedule edit performs guarded recovery when verification throws after apply", async () => {
  class ThrowAfterScheduleApplyTransport extends MockBridgeTransport {
    async post(pathname: string, body: unknown): Promise<unknown> {
      if (pathname === "/revit/export-schedule-csv") {
        this.calls.push({ pathname, body });
        throw new Error("simulated schedule export failure after parameter apply");
      }
      return super.post(pathname, body);
    }
  }
  const bridge = new ThrowAfterScheduleApplyTransport({
    "/revit/get-parameters:1": { items: [{ id: 200, parameters: { "Supply Air": "10,000 CFM" } }] },
    "/revit/set-parameter:1": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 200, parameterName: "Supply Air", ok: true, changed: true }] },
    "/revit/set-parameter:2": { status: "Applied and Verified", dryRun: false, changedCount: 1, diffs: [{ elementId: 200, parameterName: "Supply Air", ok: true, changed: true }] },
    "/revit/get-parameters:2": { items: [{ id: 200, parameters: { "Supply Air": "20,000 CFM" } }] },
    "/revit/set-parameter:3": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 200, parameterName: "Supply Air", ok: true, changed: true }] },
    "/revit/set-parameter:4": { status: "Applied and Verified", dryRun: false, changedCount: 1, diffs: [{ elementId: 200, parameterName: "Supply Air", ok: true, changed: true }] },
    "/revit/get-parameters:3": { items: [{ id: 200, parameters: { "Supply Air": "10,000 CFM" } }] }
  });

  const result = await runRevitDemoWorkflow({
    workflow: "documentation_primitives",
    request: {
      visualVerify: false,
      schedule: {
        editExistingValue: true,
        scheduleId: 100,
        elementId: 200,
        rowKey: "AHU-1",
        parameterName: "Supply Air",
        expectedExistingValue: "10,000 CFM",
        replacementValue: "20,000 CFM",
        readbackRequired: true,
        revertAfterVerify: true
      }
    }
  }, tempDir("documentation-schedule-failure-recovery"), bridge);

  assert.equal(result.success, false);
  assert.match(result.failure_reason ?? "", /simulated schedule export failure/i);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_failure_existing_parameter_revert_verified" && entry.ok), true);
  const setCalls = bridge.calls.filter((call) => call.pathname === "/revit/set-parameter");
  assert.equal(setCalls.length, 4);
  assert.equal(((setCalls[2].body as any).changes[0]).expectedOldValue, "20,000 CFM");
  assert.equal(((setCalls[3].body as any).changes[0]).expectedOldValue, "20,000 CFM");
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
    "/revit/export-visible-elements:2": { elements: [{ id: 6001 }], capture_path: "artifacts/captures/receptacles-after.jpg" }
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
      "/revit/export-visible-elements:2": { elements: [{ id: 6001 }], capture_path: "artifacts/captures/receptacles-after.jpg" }
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
      "/revit/export-visible-elements:2": { elements: [{ id: 6001 }], capture_path: "artifacts/captures/receptacles-after.jpg" }
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
    delete process.env.OPERATOR_REVIT_BRIDGE_FALLBACK_PORTS;

    const defaults = resolveRevitBridgeUrlCandidates();
    assert.equal(defaults.length, 22);
    assert.equal(defaults[0], "http://localhost:5000");
    assert.equal(defaults[1], "http://localhost:5010");
    assert.equal(defaults.at(-1), "http://localhost:5030");

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
      "/revit/export-visible-elements:2": { elements: [{ id: 3001 }], capture_path: "artifacts/captures/receptacles-after.jpg" }
    })
  );

  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "audit_passed" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "after_visible_count_increased" && !entry.ok), true);
  assert.ok(fs.existsSync(result.output_artifacts[0]));
});

test("redline MEP route workflow requires created ids, matching points, capture, and visual gate", async () => {
  const dir = tempDir("redline-mep-route-pass");
  const bridge = new MockBridgeTransport({
    "/revit/mep-route-workflow": {
      status: "AppliedVisualVerificationReady",
      applyResult: {
        status: "CreatedWithOpenConnectors",
        plannedPoints: [{ x: 40, y: 27, z: 38.833 }, { x: 58, y: 27, z: 38.833 }],
        segmentCount: 1,
        chosenSize: { requested: "12x10", applied: "12x10" },
        createdElementIds: [1542929],
        createdFittingIds: [],
        committedReadback: {
          elements: [{ elementId: 1542929, categoryName: "Ducts", size: "12x10", endpointErrorFt: 0.05 }],
          maxEndpointErrorFt: 0.05
        },
        openConnectorCount: 2
      },
      visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/mep-route-after.jpg" }
    },
    "/revit/delete:1": { status: "Dry Run", count: 1, ids: [1542929] },
    "/revit/delete:2": { status: "Deleted", count: 1, ids: [1542929] }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_route",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        roomNumber: "405",
        levelName: "L4",
        systemType: "Supply Air",
        ductSize: "12x10",
        apply: true,
        dryRunFirst: true,
        endpointGrounding: {
          allowOpenEndsForDisposableBenchmark: true,
          openEndPolicy: "disposable benchmark route is cleaned up after visual/readback verification"
        },
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1,
        points: [{ x: 40, y: 27 }, { x: 58, y: 27 }]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_mep_route");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_dry_run_planned_points_match_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_dry_run_size_preview_matches" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_endpoint_grounding_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_connector_system_audit_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "created_model_ids_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "planned_points_match_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_committed_readback_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_cleanup_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_cleanup_applied_ids_present" && entry.ok), true);
  assert.ok(fs.existsSync(path.join(dir, "artifacts", "redline_mep_route_summary.json")));
  assert.ok(fs.existsSync(path.join(dir, "artifacts", "redline_visual_gate.json")));
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_route_summary.json"), "utf8"));
  assert.equal(summary.committedReadbackAudit.present, true);
  assert.equal(summary.committedReadbackAudit.ok, true);
  assert.equal(summary.cleanupRequested, true);
  assert.deepEqual(summary.cleanupDryRunIds, [1542929]);
  assert.deepEqual(summary.cleanupDeletedIds, [1542929]);
  const routeCalls = bridge.calls.filter((call) => call.pathname === "/revit/mep-route-workflow");
  assert.equal(routeCalls.length, 2);
  assert.equal((routeCalls[0]?.body as Record<string, unknown>).apply, false);
  assert.equal((routeCalls[1]?.body as Record<string, unknown>).apply, true);
});

test("redline MEP route workflow rejects mismatched committed readback when native reports it", async () => {
  const dir = tempDir("redline-mep-route-committed-readback-mismatch");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_route",
      request: {
        kind: "pipe",
        viewId: 4001,
        visualViewId: 4001,
        roomNumber: "405",
        levelName: "L4",
        systemType: "Domestic Cold Water",
        pipeSize: "2\"",
        apply: true,
        dryRunFirst: true,
        endpointGrounding: {
          allowOpenEndsForDisposableBenchmark: true,
          openEndPolicy: "disposable benchmark route is cleaned up after visual/readback verification"
        },
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1,
        points: [{ x: 42, y: 24 }, { x: 55, y: 24 }]
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/mep-route-workflow": {
        status: "AppliedVisualVerificationReady",
        applyResult: {
          status: "CreatedWithOpenConnectors",
          plannedPoints: [{ x: 42, y: 24, z: 38.833 }, { x: 55, y: 24, z: 38.833 }],
          segmentCount: 1,
          chosenSize: { requested: "2\"", applied: "2\"" },
          createdElementIds: [1642929],
          createdFittingIds: [],
          committedReadback: {
            elements: [{ element_id: 999999, categoryName: "Ducts", size: "12 x 10", endpointErrorFt: 2.5 }],
            maxEndpointErrorFt: 2.5
          },
          openConnectorCount: 2
        },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/pipe-route-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 1, ids: [1642929] },
      "/revit/delete:2": { status: "Deleted", count: 1, ids: [1642929] }
    })
  );

  assert.equal(result.workflow, "redline_mep_route");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_committed_readback_ok" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_route_summary.json"), "utf8"));
  assert.equal(summary.committedReadbackAudit.present, true);
  assert.equal(summary.committedReadbackAudit.ok, false);
  assert.equal(summary.committedReadbackAudit.detail.idsCoverCreated, false);
  assert.equal(summary.committedReadbackAudit.detail.kindOk, false);
  assert.equal(summary.committedReadbackAudit.detail.sizeOk, false);
  assert.equal(summary.committedReadbackAudit.detail.endpointOk, false);
});

test("redline MEP route workflow audits array-shaped committed readback rows", async () => {
  const dir = tempDir("redline-mep-route-committed-readback-array");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_route",
      request: {
        kind: "pipe",
        viewId: 4001,
        visualViewId: 4001,
        roomNumber: "405",
        levelName: "L4",
        systemType: "Domestic Cold Water",
        pipeSize: "2 in",
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1,
        points: [{ x: 42, y: 24 }, { x: 55, y: 24 }]
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/mep-route-workflow": {
        status: "AppliedVisualVerificationReady",
        applyResult: {
          status: "CreatedWithOpenConnectors",
          plannedPoints: [{ x: 42, y: 24, z: 38.833 }, { x: 55, y: 24, z: 38.833 }],
          segmentCount: 1,
          chosenSize: { requested: "2 in", applied: "2\"" },
          createdElementIds: [1642929],
          createdFittingIds: [],
          committedReadback: [{ element_id: 1642929, categoryName: "Pipes", size: "2\"", endpointErrorFt: 0.1 }],
          openConnectorCount: 2
        },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/pipe-route-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 1, ids: [1642929] },
      "/revit/delete:2": { status: "Deleted", count: 1, ids: [1642929] }
    })
  );

  assert.equal(result.workflow, "redline_mep_route");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_committed_readback_ok" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_route_summary.json"), "utf8"));
  assert.equal(summary.committedReadbackAudit.present, true);
  assert.equal(summary.committedReadbackAudit.ok, true);
  assert.deepEqual(summary.committedReadbackAudit.detail.rowIds, [1642929]);
});

test("redline MEP route workflow rejects post-change capture from the wrong requested view", async () => {
  const dir = tempDir("redline-mep-route-capture-wrong-view");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_route",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        ductSize: "12x10",
        apply: true,
        dryRunFirst: true,
        endpointGrounding: {
          allowOpenEndsForDisposableBenchmark: true,
          openEndPolicy: "disposable benchmark route is cleaned up after visual/readback verification"
        },
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1,
        points: [{ x: 40, y: 27 }, { x: 58, y: 27 }]
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/mep-route-workflow": {
        status: "AppliedVisualVerificationReady",
        applyResult: {
          status: "CreatedWithOpenConnectors",
          plannedPoints: [{ x: 40, y: 27, z: 38.833 }, { x: 58, y: 27, z: 38.833 }],
          segmentCount: 1,
          chosenSize: { requested: "12x10", applied: "12x10" },
          createdElementIds: [1542929],
          createdFittingIds: [],
          committedReadback: {
            elements: [{ elementId: 1542929, categoryName: "Ducts", size: "12x10", endpointErrorFt: 0.05 }],
            maxEndpointErrorFt: 0.05
          },
          openConnectorCount: 2
        },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/mep-route-after.jpg", viewId: 9999 }
      },
      "/revit/delete:1": { status: "Dry Run", count: 1, ids: [1542929] },
      "/revit/delete:2": { status: "Deleted", count: 1, ids: [1542929] }
    })
  );

  assert.equal(result.workflow, "redline_mep_route");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "post_change_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "post_change_capture_view_id_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
});

test("redline MEP route workflow blocks before writes when dry-run route projection is incomplete", async () => {
  const dir = tempDir("redline-mep-route-dry-run-block");
  const bridge = new MockBridgeTransport({
    "/revit/mep-route-workflow": {
      status: "Dry Run",
      dryRun: {
        plannedPoints: [{ x: 90, y: 90, z: 38.833 }, { x: 95, y: 90, z: 38.833 }],
        chosenSize: { requested: "12x10", applied: "10x8" }
      }
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_route",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        ductSize: "12x10",
        apply: true,
        dryRunFirst: true,
        endpointGrounding: {
          allowOpenEndsForDisposableBenchmark: true,
          openEndPolicy: "disposable benchmark route is cleaned up after visual/readback verification"
        },
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1,
        points: [{ x: 40, y: 27 }, { x: 58, y: 27 }]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_mep_route");
  assert.equal(result.success, false);
  assert.equal(result.revit_transactions, 0);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/mep-route-workflow").length, 1);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/delete"), false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_dry_run_planned_points_match_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_dry_run_size_preview_matches" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_route_summary.json"), "utf8"));
  assert.equal(summary.blockedBeforeModelWrite, true);
});

test("redline MEP duct size transition workflow requires projection size connector capture and cleanup evidence", async () => {
  const dir = tempDir("redline-mep-duct-size-transition-pass");
  const bridge = new MockBridgeTransport({
    "/revit/reroute-mep-route-segment": {
      status: "Success",
      hostElementId: 1542001,
      modifiedElementIds: [1542001],
      createdElementIds: [1542929, 1542930],
      createdFittingIds: [1542931],
      projectedTransitionPoint: { x: 52.1, y: 27.05, z: 38.833 },
      sizeReadback: { upstreamDuctSize: "28x18", downstreamDuctSize: "16x14" },
      verification: {
        networkAudit: {
          status: "Ok",
          systemAudit: {
            pass: true,
            disconnectedCount: 0,
            disconnectedIds: []
          }
        }
      },
      visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/duct-size-transition-after.jpg" }
    },
    "/revit/delete:1": { status: "Dry Run", count: 3, ids: [1542929, 1542930, 1542931] },
    "/revit/delete:2": { status: "Deleted", count: 3, ids: [1542929, 1542930, 1542931] }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_size_transition",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        hostElementId: 1542001,
        levelName: "L4",
        systemType: "Supply Air",
        upstreamDuctSize: "28x18",
        downstreamDuctSize: "16x14",
        transitionPoint: { x: 52, y: 27 },
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_mep_size_transition");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_dry_run_projected_point_reported" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_dry_run_size_preview_matches" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_model_write_ids_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_projected_point_reported" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_size_readback_matches" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_fitting_or_connector_readback" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_size_transition_summary.json"), "utf8"));
  assert.equal(summary.kind, "duct");
  assert.deepEqual(summary.modifiedElementIds, [1542001]);
  assert.deepEqual(summary.createdElementIds, [1542929, 1542930]);
  assert.deepEqual(summary.createdFittingIds, [1542931]);
  assert.deepEqual(summary.cleanupDeletedIds, [1542929, 1542930, 1542931]);
  assert.equal(summary.cleanupAttemptPhase, "applied_after_model_write");
  assert.equal(summary.networkOk, true);
  assert.equal(summary.explicitConnectorAudit, true);
  const routeCalls = bridge.calls.filter((call) => call.pathname === "/revit/reroute-mep-route-segment");
  assert.equal(routeCalls.length, 2);
  assert.equal((routeCalls[0]?.body as Record<string, unknown>).apply, false);
  assert.equal((routeCalls[1]?.body as Record<string, unknown>).apply, true);
  const deleteCalls = bridge.calls.filter((call) => call.pathname === "/revit/delete");
  assert.deepEqual((deleteCalls[0]?.body as Record<string, unknown>).ids, [1542929, 1542930, 1542931]);
  assert.equal(((deleteCalls[0]?.body as Record<string, unknown>).ids as number[]).includes(1542001), false);
});

test("redline MEP size transition records cleanup failure with recovery ids", async () => {
  const dir = tempDir("redline-mep-size-transition-cleanup-throws");
  class CleanupThrowBridge extends MockBridgeTransport {
    async post(pathname: string, body: unknown): Promise<unknown> {
      if (pathname === "/revit/delete") {
        this.calls.push({ pathname, body });
        throw new Error("Project Not Saved Recently");
      }
      return super.post(pathname, body);
    }
  }
  const bridge = new CleanupThrowBridge({
    "/revit/reroute-mep-route-segment:1": {
      status: "Dry Run",
      projectedTransitionPoint: { x: 52.1, y: 27.05, z: 38.833 },
      upstreamSize: { requested: "1 inch", applied: "1 inch" },
      downstreamSize: { requested: "1.5 in", applied: "1.5 in" },
      plan: { applySupported: true, expectedFitting: "transition" },
      connectorAudit: { openConnectorCount: 0, connectedNetworkOk: true }
    },
    "/revit/reroute-mep-route-segment:2": {
      status: "ChangedSizeAtTransition",
      createdElementIds: [1542929, 1542930],
      createdFittingIds: [1542931],
      projectedTransitionPoint: { x: 52.1, y: 27.05, z: 38.833 },
      upstreamSize: { requested: "1 inch", applied: "1 inch" },
      downstreamSize: { requested: "1.5 in", applied: "1.5 in" },
      connectorAudit: { openConnectorCount: 0, connectedNetworkOk: true },
      visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/pipe-size-transition-after.jpg" }
    }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_size_transition",
      request: {
        kind: "pipe",
        viewId: 4001,
        visualViewId: 4001,
        hostElementId: 1642001,
        upstreamPipeSize: "1 inch",
        downstreamPipeSize: "1.5 in",
        transitionPoint: { x: 52, y: 27 },
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_mep_size_transition");
  assert.equal(result.success, false);
  assert.equal(result.failure_reason, "MEP size-transition redline workflow verification failed.");
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_applied" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_cleanup_applied_ids_present" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_size_transition_summary.json"), "utf8"));
  assert.equal(summary.cleanupAttemptPhase, "cleanup_dry_run_failed_after_model_write");
  assert.equal(summary.cleanupError, "Project Not Saved Recently");
  assert.deepEqual(summary.cleanupIds, [1542929, 1542930, 1542931]);
  const deleteCalls = bridge.calls.filter((call) => call.pathname === "/revit/delete");
  assert.equal(deleteCalls.length, 1);
  assert.deepEqual((deleteCalls[0]?.body as Record<string, unknown>).ids, [1542929, 1542930, 1542931]);
});

test("redline MEP duct size transition workflow rejects post-change capture from the wrong requested view", async () => {
  const dir = tempDir("redline-mep-duct-size-transition-capture-wrong-view");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_size_transition",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        hostElementId: 1542001,
        upstreamDuctSize: "28x18",
        downstreamDuctSize: "16x14",
        transitionPoint: { x: 52, y: 27 },
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/reroute-mep-route-segment": {
        status: "Success",
        hostElementId: 1542001,
        modifiedElementIds: [1542001],
        createdElementIds: [1542929, 1542930],
        createdFittingIds: [1542931],
        projectedTransitionPoint: { x: 52.1, y: 27.05, z: 38.833 },
        sizeReadback: { upstreamDuctSize: "28x18", downstreamDuctSize: "16x14" },
        connectorAudit: { openConnectorCount: 0, connectedNetworkOk: true },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/duct-size-transition-after.jpg", viewId: 9999 }
      },
      "/revit/delete:1": { status: "Dry Run", count: 3, ids: [1542929, 1542930, 1542931] },
      "/revit/delete:2": { status: "Deleted", count: 3, ids: [1542929, 1542930, 1542931] }
    })
  );

  assert.equal(result.workflow, "redline_mep_size_transition");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "post_change_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "post_change_capture_view_id_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
});

test("redline MEP size transition workflow blocks before writes when dry-run evidence is incomplete", async () => {
  const dir = tempDir("redline-mep-size-transition-dry-run-block");
  const bridge = new MockBridgeTransport({
    "/revit/reroute-mep-route-segment": {
      status: "Dry Run",
      projectedTransitionPoint: { x: 80, y: 80 },
      sizeReadback: { upstreamPipeSize: "2\"", downstreamPipeSize: "1\"" },
      connectorAudit: { openConnectorCount: 2, connectedNetworkOk: false }
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_size_transition",
      request: {
        kind: "pipe",
        viewId: 4001,
        visualViewId: 4001,
        hostElementId: 1642001,
        upstreamPipeSize: "2\"",
        downstreamPipeSize: "1\"",
        transitionPoint: { x: 55, y: 24 },
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_mep_size_transition");
  assert.equal(result.success, false);
  assert.equal(result.revit_transactions, 0);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/reroute-mep-route-segment").length, 1);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/delete"), false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_dry_run_projected_point_reported" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_dry_run_fitting_or_connector_readback" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_size_transition_summary.json"), "utf8"));
  assert.equal(summary.blockedBeforeModelWrite, true);
});

test("redline MEP scoped duct sizing requires per-segment size readback", async () => {
  const dir = tempDir("redline-mep-scoped-duct-sizing-pass");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_size_transition",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        hostElementId: 1542001,
        levelName: "L4",
        systemType: "Supply Air",
        upstreamDuctSize: "28x18",
        downstreamDuctSize: "16x14",
        transitionPoint: { x: 52, y: 27 },
        sizingScope: {
          elementIds: [1542001, 1542002],
          region: "marked room/space band on M2.12",
          engineeringSizingBasis: "schedule airflow totals in the redline",
          perSegmentReadbackRequired: true
        },
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/reroute-mep-route-segment": {
        status: "Success",
        hostElementId: 1542001,
        modifiedElementIds: [1542001, 1542002],
        createdElementIds: [1542929, 1542930],
        createdFittingIds: [1542931],
        projectedTransitionPoint: { x: 52.1, y: 27.05, z: 38.833 },
        sizeReadback: { upstreamDuctSize: "28x18", downstreamDuctSize: "16x14" },
        perSegmentSizeReadback: [
          { elementId: 1542001, appliedSize: "28x18" },
          { elementId: 1542002, appliedSize: "16x14" }
        ],
        connectorAudit: { openConnectorCount: 0, connectedNetworkOk: true },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/scoped-duct-sizing-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 3, ids: [1542929, 1542930, 1542931] },
      "/revit/delete:2": { status: "Deleted", count: 3, ids: [1542929, 1542930, 1542931] }
    })
  );

  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_scoped_sizing_readback" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_size_transition_summary.json"), "utf8"));
  assert.deepEqual(summary.scopedElementIds, [1542001, 1542002]);
  assert.equal(summary.scopedSizingRequested, true);
  assert.equal(summary.perSegmentSizeReadback.length, 2);
});

test("redline MEP scoped duct sizing blocks without per-segment size readback", async () => {
  const dir = tempDir("redline-mep-scoped-duct-sizing-missing-readback");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_size_transition",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        hostElementId: 1542001,
        upstreamDuctSize: "28x18",
        downstreamDuctSize: "16x14",
        transitionPoint: { x: 52, y: 27 },
        sizingScope: {
          elementIds: [1542001, 1542002],
          engineeringSizingBasis: "schedule airflow totals in the redline",
          perSegmentReadbackRequired: true
        },
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: false,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/reroute-mep-route-segment": {
        status: "Success",
        hostElementId: 1542001,
        modifiedElementIds: [1542001, 1542002],
        createdElementIds: [1542929, 1542930],
        createdFittingIds: [1542931],
        projectedTransitionPoint: { x: 52.1, y: 27.05, z: 38.833 },
        sizeReadback: { upstreamDuctSize: "28x18", downstreamDuctSize: "16x14" },
        connectorAudit: { openConnectorCount: 0, connectedNetworkOk: true },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/scoped-duct-sizing-after.jpg" }
      }
    })
  );

  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_scoped_sizing_readback" && !entry.ok), true);
});

test("redline MEP duct tap branch workflow requires projection fitting connection capture and cleanup evidence", async () => {
  const dir = tempDir("redline-mep-duct-tap-branch-pass");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_tap_branch",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        mainElementId: 1542001,
        levelName: "L4",
        systemType: "Supply Air",
        connectionMode: "tap",
        branchSize: "14x4",
        ductSize: "14x4",
        projectedTapPoint: { x: 52, y: 27 },
        branchPoints: [{ x: 52, y: 27 }, { x: 52, y: 35 }],
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/connect-mep-branch": {
        status: "CreatedWithTapTakeoff",
        dryRun: false,
        scaffoldOnly: false,
        kind: "duct",
        main: { id: 1542001 },
        branchPlan: {
          points: [{ x: 52.05, y: 27.02, z: 38.833 }, { x: 52.05, y: 35, z: 38.833 }],
          requestedSize: "14x4",
          connectionMode: "tap"
        },
        mainIntersection: { nearestPointOnMain: { x: 52.05, y: 27.02, z: 38.833 } },
        splitPlan: {
          projectedSplitPoint: { x: 52.05, y: 27.02, z: 38.833 },
          applySupported: true,
          expectedFitting: "takeoff"
        },
        selected: { type: "Rectangular Duct", system: "Supply Air", level: "L4", size: "14x4" },
        createdBranchElementIds: [1542917],
        createdFittingIds: [1542919],
        connectionAttempts: [{ connected: true, method: "new_takeoff_fitting", fittingId: 1542919 }],
        openConnectorCount: 1,
        connectedNetworkAudit: { status: "Ok", openConnectorCount: 1, systemName: "Supply Air" },
        focusedCapture: { capturePath: "artifacts/captures/duct-tap-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 2, ids: [1542917, 1542919] },
      "/revit/delete:2": { status: "Deleted", count: 2, ids: [1542917, 1542919] }
    })
  );

  assert.equal(result.workflow, "redline_mep_tap_branch");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_model_write_ids_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_projected_point_reported" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connection_attempt_verified" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_system_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connector_network_audit" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_tap_branch_summary.json"), "utf8"));
  assert.equal(summary.kind, "duct");
  assert.deepEqual(summary.createdBranchElementIds, [1542917]);
  assert.deepEqual(summary.createdFittingIds, [1542919]);
  assert.deepEqual(summary.cleanupDeletedIds, [1542917, 1542919]);
});

test("redline MEP pipe tap branch workflow can use disposable branch-network setup", async () => {
  const dir = tempDir("redline-mep-pipe-branch-network-pass");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_tap_branch",
      request: {
        kind: "pipe",
        branchNetworkWorkflow: true,
        viewId: 1363433,
        visualViewId: 1363433,
        levelName: "L4",
        systemType: "Domestic Cold Water",
        pipeType: "PVC - DWV",
        pipeSize: "1 inch",
        connectionMode: "tee",
        expectedFitting: "tee",
        projectedTapPoint: { x: 97.5, y: -70 },
        mainPoints: [{ x: 90, y: -70, z: 43 }, { x: 105, y: -70, z: 43 }],
        branches: [{
          name: "redline-hardening-live-branch",
          connectionMode: "tee",
          mainSegmentIndex: 0,
          points: [{ x: 97.5, y: -70, z: 43 }, { x: 97.5, y: -63, z: 43 }],
          pipeSize: "1 inch",
          branchSize: "1 inch",
          expectedFitting: "tee"
        }],
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/mep-branch-network-workflow:1": {
        status: "DryRunReady",
        networkPlan: {
          branches: [{
            splitPlan: {
              applySupported: true,
              expectedFitting: "tee",
              projectedSplitPoint: { x: 97.5, y: -70, z: 43 }
            }
          }]
        }
      },
      "/revit/mep-branch-network-workflow:2": {
        status: "AppliedNetworkVisualVerificationReady",
        networkPlan: {
          branches: [{
            points: [{ x: 97.5, y: -70, z: 43 }, { x: 97.5, y: -63, z: 43 }],
            branchSize: "1 inch",
            splitPlan: {
              applySupported: true,
              expectedFitting: "tee",
              projectedSplitPoint: { x: 97.5, y: -70, z: 43 }
            }
          }]
        },
        created: {
          mainElementIds: [1543037],
          splitMainSegmentIds: [1543037, 1543041],
          branchElementIds: [1543043],
          branchFittingIds: [1543046],
          allModelIds: [1543037, 1543041, 1543043, 1543046]
        },
        visualVerification: {
          status: "CaptureReadyForAIReview",
          capturePath: "artifacts/captures/pipe-branch-network-l4.jpg",
          capture: {
            path: "artifacts/captures/pipe-branch-network-l4.jpg",
            widthPx: 2200,
            heightPx: 1119,
            focusCrop: { requested: true, applied: true }
          }
        }
      },
      "/revit/delete:1": { status: "Dry Run", impactedIds: [1543037, 1543038, 1543041, 1543042, 1543043, 1543044, 1543046, 1543047] },
      "/revit/delete:2": { status: "Deleted", impactedIds: [1543037, 1543038, 1543041, 1543042, 1543043, 1543044, 1543046, 1543047] }
    })
  );

  assert.equal(result.workflow, "redline_mep_tap_branch");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_tap_branch_summary.json"), "utf8"));
  assert.equal(summary.branchNetworkWorkflow, true);
  assert.deepEqual(summary.splitMainSegmentIds, [1543037, 1543041]);
  assert.deepEqual(summary.createdBranchElementIds, [1543043]);
  assert.deepEqual(summary.createdFittingIds, [1543046]);
  assert.deepEqual(summary.cleanupDeletedIds, [1543037, 1543038, 1543041, 1543042, 1543043, 1543044, 1543046, 1543047]);
});

test("redline MEP duct tap branch workflow rejects post-change capture from the wrong requested view", async () => {
  const dir = tempDir("redline-mep-duct-tap-branch-capture-wrong-view");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_tap_branch",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        mainElementId: 1542001,
        connectionMode: "tap",
        branchSize: "14x4",
        ductSize: "14x4",
        projectedTapPoint: { x: 52, y: 27 },
        branchPoints: [{ x: 52, y: 27 }, { x: 52, y: 35 }],
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/connect-mep-branch": {
        status: "CreatedWithTapTakeoff",
        dryRun: false,
        scaffoldOnly: false,
        kind: "duct",
        main: { id: 1542001 },
        branchPlan: {
          points: [{ x: 52.05, y: 27.02, z: 38.833 }, { x: 52.05, y: 35, z: 38.833 }],
          requestedSize: "14x4",
          connectionMode: "tap"
        },
        mainIntersection: { nearestPointOnMain: { x: 52.05, y: 27.02, z: 38.833 } },
        splitPlan: {
          projectedSplitPoint: { x: 52.05, y: 27.02, z: 38.833 },
          applySupported: true,
          expectedFitting: "takeoff"
        },
        selected: { size: "14x4" },
        createdBranchElementIds: [1542917],
        createdFittingIds: [1542919],
        connectionAttempts: [{ connected: true, method: "new_takeoff_fitting", fittingId: 1542919 }],
        openConnectorCount: 1,
        connectedNetworkAudit: { status: "Ok", openConnectorCount: 1, systemName: "Supply Air" },
        focusedCapture: { capturePath: "artifacts/captures/duct-tap-after.jpg", viewId: 9999 }
      },
      "/revit/delete:1": { status: "Dry Run", count: 2, ids: [1542917, 1542919] },
      "/revit/delete:2": { status: "Deleted", count: 2, ids: [1542917, 1542919] }
    })
  );

  assert.equal(result.workflow, "redline_mep_tap_branch");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "post_change_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "post_change_capture_view_id_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
});

test("redline MEP pipe tap branch workflow requires projection fitting connection capture and cleanup evidence", async () => {
  const dir = tempDir("redline-mep-pipe-tap-branch-pass");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_tap_branch",
      request: {
        kind: "pipe",
        viewId: 4001,
        visualViewId: 4001,
        mainElementId: 1642001,
        levelName: "L4",
        systemType: "Domestic Cold Water",
        connectionMode: "tap",
        branchSize: "1\"",
        pipeSize: "1\"",
        projectedTapPoint: { x: 58, y: 22 },
        branchPoints: [{ x: 58, y: 22 }, { x: 58, y: 30 }],
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/connect-mep-branch": {
        status: "CreatedWithTapTakeoff",
        dryRun: false,
        scaffoldOnly: false,
        kind: "pipe",
        main: { id: 1642001 },
        branchPlan: {
          points: [{ x: 58.04, y: 22.03, z: 38.833 }, { x: 58.04, y: 30, z: 38.833 }],
          requestedSize: "1\"",
          connectionMode: "tap"
        },
        mainIntersection: { nearestPointOnMain: { x: 58.04, y: 22.03, z: 38.833 } },
        splitPlan: {
          projectedSplitPoint: { x: 58.04, y: 22.03, z: 38.833 },
          applySupported: true,
          expectedFitting: "takeoff"
        },
        selected: { type: "Standard Pipe", system: "Domestic Cold Water", level: "L4", size: "1\"" },
        createdBranchElementIds: [1642917],
        createdFittingIds: [1642919],
        connectionAttempts: [{ connected: true, method: "new_takeoff_fitting", fittingId: 1642919 }],
        openConnectorCount: 1,
        connectedNetworkAudit: { status: "Ok", openConnectorCount: 1, systemName: "Domestic Cold Water" },
        focusedCapture: { capturePath: "artifacts/captures/pipe-tap-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 2, ids: [1642917, 1642919] },
      "/revit/delete:2": { status: "Deleted", count: 2, ids: [1642917, 1642919] }
    })
  );

  assert.equal(result.workflow, "redline_mep_tap_branch");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_model_write_ids_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_projected_point_reported" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connection_attempt_verified" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_system_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connector_network_audit" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_tap_branch_summary.json"), "utf8"));
  assert.equal(summary.kind, "pipe");
  assert.deepEqual(summary.createdBranchElementIds, [1642917]);
  assert.deepEqual(summary.createdFittingIds, [1642919]);
  assert.deepEqual(summary.cleanupDeletedIds, [1642917, 1642919]);
});

test("redline MEP duct tap branch workflow fails disconnected geometry without fitting evidence", async () => {
  const dir = tempDir("redline-mep-duct-tap-branch-disconnected");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_tap_branch",
      request: {
        kind: "duct",
        viewId: 4001,
        mainElementId: 1542001,
        branchSize: "14x4",
        projectedTapPoint: { x: 52, y: 27 },
        branchPoints: [{ x: 52, y: 27 }, { x: 52, y: 35 }],
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/connect-mep-branch": {
        status: "CreatedWithOpenConnectors",
        scaffoldOnly: false,
        branchPlan: {
          points: [{ x: 52.05, y: 27.02, z: 38.833 }, { x: 52.05, y: 35, z: 38.833 }],
          requestedSize: "14x4",
          connectionMode: "tap"
        },
        splitPlan: { projectedSplitPoint: { x: 52.05, y: 27.02, z: 38.833 }, expectedFitting: "takeoff" },
        selected: { size: "14x4" },
        createdBranchElementIds: [1542917],
        createdFittingIds: [],
        connectionAttempts: [{ connected: false, method: "new_takeoff_fitting" }],
        openConnectorCount: 2,
        connectedNetworkAudit: { status: "Disconnected", openConnectorCount: 2 },
        focusedCapture: { capturePath: "artifacts/captures/duct-tap-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 1, ids: [1542917] },
      "/revit/delete:2": { status: "Deleted", count: 1, ids: [1542917] }
    })
  );

  assert.equal(result.workflow, "redline_mep_tap_branch");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_model_write_ids_present" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connection_attempt_verified" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connector_network_audit" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
});

test("redline MEP tap branch workflow rejects connected audit on wrong requested system", async () => {
  const dir = tempDir("redline-mep-tap-branch-wrong-system");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_tap_branch",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        mainElementId: 1542001,
        levelName: "L4",
        systemType: "Supply Air",
        branchSize: "14x4",
        projectedTapPoint: { x: 52, y: 27 },
        branchPoints: [{ x: 52, y: 27 }, { x: 52, y: 35 }],
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/connect-mep-branch": {
        status: "CreatedWithTapTakeoff",
        scaffoldOnly: false,
        branchPlan: {
          points: [{ x: 52.05, y: 27.02, z: 38.833 }, { x: 52.05, y: 35, z: 38.833 }],
          requestedSize: "14x4",
          connectionMode: "tap"
        },
        splitPlan: { projectedSplitPoint: { x: 52.05, y: 27.02, z: 38.833 }, expectedFitting: "takeoff" },
        selected: { size: "14x4", system: "Return Air", level: "L4" },
        createdBranchElementIds: [1542917],
        createdFittingIds: [1542919],
        connectionAttempts: [{ connected: true, method: "new_takeoff_fitting", fittingId: 1542919 }],
        connectedNetworkAudit: { status: "Ok", openConnectorCount: 1, systemName: "Return Air" },
        focusedCapture: { capturePath: "artifacts/captures/duct-tap-after.jpg", viewId: 4001 }
      },
      "/revit/delete:1": { status: "Dry Run", count: 2, ids: [1542917, 1542919] },
      "/revit/delete:2": { status: "Deleted", count: 2, ids: [1542917, 1542919] }
    })
  );

  assert.equal(result.workflow, "redline_mep_tap_branch");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connection_attempt_verified" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connector_network_audit" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_system_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_tap_branch_summary.json"), "utf8"));
  assert.equal(summary.requestedSystem, "Supply Air");
  assert.deepEqual(summary.appliedSystemLabels, ["return air"]);
  assert.equal(summary.systemMatchesRequest, false);
});

test("redline MEP duct tap branch workflow rejects unbounded open connectors without explicit audit", async () => {
  const dir = tempDir("redline-mep-duct-tap-branch-open-connectors-no-audit");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_tap_branch",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        mainElementId: 1542001,
        branchSize: "14x4",
        projectedTapPoint: { x: 52, y: 27 },
        branchPoints: [{ x: 52, y: 27 }, { x: 52, y: 35 }],
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/connect-mep-branch": {
        status: "CreatedWithOpenConnectors",
        scaffoldOnly: false,
        branchPlan: {
          points: [{ x: 52.05, y: 27.02, z: 38.833 }, { x: 52.05, y: 35, z: 38.833 }],
          requestedSize: "14x4",
          connectionMode: "tap"
        },
        splitPlan: { projectedSplitPoint: { x: 52.05, y: 27.02, z: 38.833 }, expectedFitting: "takeoff" },
        selected: { size: "14x4" },
        createdBranchElementIds: [1542917],
        createdFittingIds: [1542919],
        connectionAttempts: [{ connected: true, method: "new_takeoff_fitting", fittingId: 1542919 }],
        openConnectorCount: 2,
        focusedCapture: { capturePath: "artifacts/captures/duct-tap-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 2, ids: [1542917, 1542919] },
      "/revit/delete:2": { status: "Deleted", count: 2, ids: [1542917, 1542919] }
    })
  );

  assert.equal(result.workflow, "redline_mep_tap_branch");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connection_attempt_verified" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connector_network_audit" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
});

test("redline MEP tap branch workflow rejects bounded open connector without explicit audit", async () => {
  const dir = tempDir("redline-mep-tap-branch-open-connector-no-audit");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_tap_branch",
      request: {
        kind: "pipe",
        viewId: 4001,
        visualViewId: 4001,
        mainElementId: 1642001,
        branchSize: "1\"",
        projectedTapPoint: { x: 58, y: 22 },
        branchPoints: [{ x: 58, y: 22 }, { x: 58, y: 30 }],
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/connect-mep-branch": {
        status: "CreatedWithTapTakeoff",
        scaffoldOnly: false,
        branchPlan: {
          points: [{ x: 58.04, y: 22.03, z: 38.833 }, { x: 58.04, y: 30, z: 38.833 }],
          requestedSize: "1\"",
          connectionMode: "tap"
        },
        splitPlan: { projectedSplitPoint: { x: 58.04, y: 22.03, z: 38.833 }, expectedFitting: "takeoff" },
        selected: { size: "1\"" },
        createdBranchElementIds: [1642917],
        createdFittingIds: [1642919],
        connectionAttempts: [{ connected: true, method: "new_takeoff_fitting", fittingId: 1642919 }],
        openConnectorCount: 1,
        focusedCapture: { capturePath: "artifacts/captures/pipe-tap-after.jpg", viewId: 4001 }
      },
      "/revit/delete:1": { status: "Dry Run", count: 2, ids: [1642917, 1642919] },
      "/revit/delete:2": { status: "Deleted", count: 2, ids: [1642917, 1642919] }
    })
  );

  assert.equal(result.workflow, "redline_mep_tap_branch");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connection_attempt_verified" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connector_network_audit" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_tap_branch_summary.json"), "utf8"));
  assert.equal(summary.explicitConnectorAudit, false);
  assert.equal(summary.networkContinuityAudit.detail.allowedOpenConnectorCount, 1);
});

test("redline MEP tap branch workflow rejects ok audit with disconnected count", async () => {
  const dir = tempDir("redline-mep-tap-branch-disconnected-count");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_tap_branch",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        mainElementId: 1542001,
        branchSize: "14x4",
        projectedTapPoint: { x: 52, y: 27 },
        branchPoints: [{ x: 52, y: 27 }, { x: 52, y: 35 }],
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/connect-mep-branch": {
        status: "CreatedWithTapTakeoff",
        scaffoldOnly: false,
        branchPlan: {
          points: [{ x: 52.05, y: 27.02, z: 38.833 }, { x: 52.05, y: 35, z: 38.833 }],
          requestedSize: "14x4",
          connectionMode: "tap"
        },
        splitPlan: { projectedSplitPoint: { x: 52.05, y: 27.02, z: 38.833 }, expectedFitting: "takeoff" },
        selected: { size: "14x4" },
        createdBranchElementIds: [1542917],
        createdFittingIds: [1542919],
        connectionAttempts: [{ connected: true, method: "new_takeoff_fitting", fittingId: 1542919 }],
        connectedNetworkAudit: {
          status: "Ok",
          openConnectorCount: 1,
          systemAudit: { pass: true, connectedCount: 1, disconnectedCount: 1 }
        },
        focusedCapture: { capturePath: "artifacts/captures/duct-tap-after.jpg", viewId: 4001 }
      },
      "/revit/delete:1": { status: "Dry Run", count: 2, ids: [1542917, 1542919] },
      "/revit/delete:2": { status: "Deleted", count: 2, ids: [1542917, 1542919] }
    })
  );

  assert.equal(result.workflow, "redline_mep_tap_branch");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connection_attempt_verified" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_tap_branch_connector_network_audit" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_tap_branch_summary.json"), "utf8"));
  assert.equal(summary.explicitConnectorAudit, true);
  assert.equal(summary.networkContinuityAudit.detail.disconnectedCount, 1);
});

test("redline MEP duct reroute workflow requires split offset fitting network capture and cleanup evidence", async () => {
  const dir = tempDir("redline-mep-duct-reroute-pass");
  const bridge = new MockBridgeTransport({
    "/revit/create-mep-route": {
      status: "CreatedWithOpenConnectors",
      createdElementIds: [1542919]
    },
    "/revit/reroute-mep-route-segment": {
      status: "Rerouted",
      dryRun: false,
      kind: "duct",
      operation: "reroute_offset",
      host: { id: 1542919, category: "Ducts" },
      plan: {
        ApplySupported: true,
        Split1: { X: 76, Y: -35, Z: 43 },
        Split2: { X: 88, Y: -35, Z: 43 },
        OffsetSplit1: { X: 76, Y: -35, Z: 42 },
        OffsetSplit2: { X: 88, Y: -35, Z: 42 },
        Segments: [
          { Role: "main_a" },
          { Role: "offset_leg_a" },
          { Role: "offset_middle" },
          { Role: "offset_leg_b" },
          { Role: "main_b" }
        ],
        ExpectedFittings: [
          { ExpectedFitting: "elbow", At: "split1_to_offset_leg" },
          { ExpectedFitting: "elbow", At: "offset_leg_to_middle_a" },
          { ExpectedFitting: "elbow", At: "middle_to_offset_leg_b" },
          { ExpectedFitting: "elbow", At: "offset_leg_to_split2" }
        ]
      },
      createdElementIds: [1542921, 1542923, 1542925, 1542927, 1542929],
      createdFittingIds: [1542931, 1542933, 1542936, 1542937],
      deletedOriginalIds: [1542919],
      connectionAttempts: [
        { connected: true, fittingId: 1542931 },
        { connected: true, fittingId: 1542933 },
        { connected: true, fittingId: 1542936 },
        { connected: true, fittingId: 1542937 }
      ],
      verification: {
        networkAudit: {
          status: "Ok",
          systemAudit: { pass: true, connectedCount: 9, disconnectedCount: 0 }
        }
      },
      visualVerification: { path: "artifacts/captures/duct-reroute-after.jpg" }
    },
    "/revit/delete:1": { status: "Dry Run", count: 9, ids: [1542921, 1542923, 1542925, 1542927, 1542929, 1542931, 1542933, 1542936, 1542937] },
    "/revit/delete:2": { status: "Deleted", count: 9, ids: [1542921, 1542923, 1542925, 1542927, 1542929, 1542931, 1542933, 1542936, 1542937] }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_reroute",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        operation: "reroute_offset",
        split1Point: { x: 76, y: -35 },
        split2Point: { x: 88, y: -35 },
        dropFt: 1,
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1,
        dropToleranceFt: 0.25,
        createHostRoute: {
          ductType: "Rectangular Duct",
          ductSize: "12x10",
          points: [{ x: 70, y: -35, z: 43 }, { x: 94, y: -35, z: 43 }]
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_mep_reroute");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_model_write_ids_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_split_points_reported" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_offset_drop_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_connection_attempts_verified" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_connector_network_audit" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_cleanup_applied_ids_present" && entry.ok), true);
  const rerouteBridgeCall = bridge.calls.find((call) => call.pathname === "/revit/reroute-mep-route-segment");
  assert.deepEqual((rerouteBridgeCall?.body as Record<string, unknown>).offsetVector, { x: 0, y: 0, z: -1 });
  assert.equal((rerouteBridgeCall?.body as Record<string, unknown>).apply, true);
  assert.equal((rerouteBridgeCall?.body as Record<string, unknown>).dryRun, false);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_reroute_summary.json"), "utf8"));
  assert.equal(summary.kind, "duct");
  assert.equal(summary.hostElementId, 1542919);
  assert.deepEqual(summary.setupCreatedElementIds, [1542919]);
  assert.equal(summary.segmentCount, 5);
  assert.equal(summary.expectedFittingCount, 4);
  assert.equal(summary.actualDropFt, 1);
  assert.deepEqual(summary.cleanupDeletedIds, [1542921, 1542923, 1542925, 1542927, 1542929, 1542931, 1542933, 1542936, 1542937]);
});

test("redline MEP duct reroute cleans disposable setup route when native reroute blocks", async () => {
  const dir = tempDir("redline-mep-duct-reroute-blocked-cleanup");
  const bridge = new MockBridgeTransport({
    "/revit/create-mep-route": {
      status: "CreatedWithOpenConnectors",
      createdElementIds: [1543662]
    },
    "/revit/reroute-mep-route-segment": {
      status: "Blocked",
      blockCode: "offset_too_small",
      reason: "Offset vector must be at least 0.25 ft long.",
      dryRun: false,
      host: { id: 1543662, category: "Ducts" },
      plan: {}
    },
    "/revit/delete:1": { status: "Dry Run", count: 1, ids: [1543662], impactedIds: [1543662] },
    "/revit/delete:2": { status: "Deleted", count: 1, ids: [1543662], impactedIds: [1543662] }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_reroute",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        operation: "reroute_offset",
        split1Point: { x: 76, y: -35 },
        split2Point: { x: 88, y: -35 },
        dropFt: 1,
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        createHostRoute: {
          ductType: "Rectangular Duct",
          ductSize: "12x10",
          points: [{ x: 70, y: -35, z: 43 }, { x: 94, y: -35, z: 43 }]
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_mep_reroute");
  assert.equal(result.success, false);
  const rerouteBridgeCall = bridge.calls.find((call) => call.pathname === "/revit/reroute-mep-route-segment");
  assert.deepEqual((rerouteBridgeCall?.body as Record<string, unknown>).offsetVector, { x: 0, y: 0, z: -1 });
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_reroute_summary.json"), "utf8"));
  assert.deepEqual(summary.setupCreatedElementIds, [1543662]);
  assert.deepEqual(summary.cleanupDeletedIds, [1543662]);
});

test("redline MEP duct reroute treats already-missing cleanup ids as cleanup evidence", async () => {
  const dir = tempDir("redline-mep-duct-reroute-missing-cleanup-ids");
  class MissingCleanupBridgeTransport extends MockBridgeTransport {
    async post(pathname: string, body: unknown): Promise<unknown> {
      if (pathname === "/revit/delete") {
        this.calls.push({ pathname, body });
        throw new Error("Bridge /revit/delete failed with 500: One or more elements in elementIds do not exist in the document.\r\nParameter name: elementIds");
      }
      return super.post(pathname, body);
    }
  }
  const bridge = new MissingCleanupBridgeTransport({
    "/revit/create-mep-route": {
      status: "CreatedWithOpenConnectors",
      createdElementIds: [1543662]
    },
    "/revit/reroute-mep-route-segment": {
      status: "Blocked",
      blockCode: "native_revit_failure",
      reason: "Revit rejected the reroute transaction; the transaction was rolled back before committing.",
      dryRun: false,
      host: { id: 1543662, category: "Ducts" },
      plan: {}
    }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_reroute",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        operation: "reroute_offset",
        split1Point: { x: 76, y: -35 },
        split2Point: { x: 88, y: -35 },
        dropFt: 1,
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        createHostRoute: {
          ductType: "Rectangular Duct",
          ductSize: "12x10",
          points: [{ x: 70, y: -35, z: 43 }, { x: 94, y: -35, z: 43 }]
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_mep_reroute");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_cleanup_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_reroute_summary.json"), "utf8"));
  assert.deepEqual(summary.cleanupDryRunIds, [1543662]);
  assert.deepEqual(summary.cleanupDeletedIds, [1543662]);
  assert.equal(summary.cleanupApplied.status, "AlreadyDeleted");
});

test("redline MEP duct reroute workflow rejects post-change capture from the wrong requested view", async () => {
  const dir = tempDir("redline-mep-duct-reroute-capture-wrong-view");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_reroute",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        hostElementId: 1542919,
        operation: "reroute_offset",
        split1Point: { x: 76, y: -35 },
        split2Point: { x: 88, y: -35 },
        dropFt: 1,
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1,
        dropToleranceFt: 0.25
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/reroute-mep-route-segment": {
        status: "Rerouted",
        dryRun: false,
        kind: "duct",
        operation: "reroute_offset",
        host: { id: 1542919, category: "Ducts" },
        plan: {
          ApplySupported: true,
          Split1: { X: 76, Y: -35, Z: 43 },
          Split2: { X: 88, Y: -35, Z: 43 },
          OffsetSplit1: { X: 76, Y: -35, Z: 42 },
          OffsetSplit2: { X: 88, Y: -35, Z: 42 },
          Segments: [
            { Role: "main_a" },
            { Role: "offset_leg_a" },
            { Role: "offset_middle" },
            { Role: "offset_leg_b" },
            { Role: "main_b" }
          ],
          ExpectedFittings: [
            { ExpectedFitting: "elbow", At: "split1_to_offset_leg" },
            { ExpectedFitting: "elbow", At: "offset_leg_to_middle_a" },
            { ExpectedFitting: "elbow", At: "middle_to_offset_leg_b" },
            { ExpectedFitting: "elbow", At: "offset_leg_to_split2" }
          ]
        },
        createdElementIds: [1542921, 1542923, 1542925, 1542927, 1542929],
        createdFittingIds: [1542931, 1542933, 1542936, 1542937],
        deletedOriginalIds: [1542919],
        connectionAttempts: [
          { connected: true, fittingId: 1542931 },
          { connected: true, fittingId: 1542933 },
          { connected: true, fittingId: 1542936 },
          { connected: true, fittingId: 1542937 }
        ],
        verification: {
          networkAudit: {
            status: "Ok",
            systemAudit: { pass: true, connectedCount: 9, disconnectedCount: 0 }
          }
        },
        visualVerification: { path: "artifacts/captures/duct-reroute-after.jpg", viewId: 9999 }
      },
      "/revit/delete:1": { status: "Dry Run", count: 9, ids: [1542921, 1542923, 1542925, 1542927, 1542929, 1542931, 1542933, 1542936, 1542937] },
      "/revit/delete:2": { status: "Deleted", count: 9, ids: [1542921, 1542923, 1542925, 1542927, 1542929, 1542931, 1542933, 1542936, 1542937] }
    })
  );

  assert.equal(result.workflow, "redline_mep_reroute");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "post_change_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "post_change_capture_view_id_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
});

test("redline MEP pipe reroute workflow requires split offset fitting network capture and cleanup evidence", async () => {
  const dir = tempDir("redline-mep-pipe-reroute-pass");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_reroute",
      request: {
        kind: "pipe",
        viewId: 4001,
        visualViewId: 4001,
        hostElementId: 1642919,
        operation: "reroute_offset",
        split1Point: { x: 64, y: 18 },
        split2Point: { x: 72, y: 18 },
        dropFt: 1,
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1,
        dropToleranceFt: 0.25
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/reroute-mep-route-segment": {
        status: "Rerouted",
        dryRun: false,
        kind: "pipe",
        operation: "reroute_offset",
        host: { id: 1642919, category: "Pipes" },
        plan: {
          ApplySupported: true,
          Split1: { X: 64, Y: 18, Z: 38 },
          Split2: { X: 72, Y: 18, Z: 38 },
          OffsetSplit1: { X: 64, Y: 18, Z: 37 },
          OffsetSplit2: { X: 72, Y: 18, Z: 37 },
          Segments: [
            { Role: "main_a" },
            { Role: "offset_leg_a" },
            { Role: "offset_middle" },
            { Role: "offset_leg_b" },
            { Role: "main_b" }
          ],
          ExpectedFittings: [
            { ExpectedFitting: "elbow", At: "split1_to_offset_leg" },
            { ExpectedFitting: "elbow", At: "offset_leg_to_middle_a" },
            { ExpectedFitting: "elbow", At: "middle_to_offset_leg_b" },
            { ExpectedFitting: "elbow", At: "offset_leg_to_split2" }
          ]
        },
        createdElementIds: [1642921, 1642923, 1642925, 1642927, 1642929],
        createdFittingIds: [1642931, 1642933, 1642936, 1642937],
        deletedOriginalIds: [1642919],
        connectionAttempts: [
          { connected: true, fittingId: 1642931 },
          { connected: true, fittingId: 1642933 },
          { connected: true, fittingId: 1642936 },
          { connected: true, fittingId: 1642937 }
        ],
        verification: {
          networkAudit: {
            status: "Ok",
            systemName: "Domestic Cold Water",
            systemAudit: { pass: true, connectedCount: 9, disconnectedCount: 0 }
          }
        },
        visualVerification: { path: "artifacts/captures/pipe-reroute-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 9, ids: [1642921, 1642923, 1642925, 1642927, 1642929, 1642931, 1642933, 1642936, 1642937] },
      "/revit/delete:2": { status: "Deleted", count: 9, ids: [1642921, 1642923, 1642925, 1642927, 1642929, 1642931, 1642933, 1642936, 1642937] }
    })
  );

  assert.equal(result.workflow, "redline_mep_reroute");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_model_write_ids_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_connector_network_audit" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_reroute_summary.json"), "utf8"));
  assert.equal(summary.kind, "pipe");
  assert.equal(summary.segmentCount, 5);
  assert.equal(summary.expectedFittingCount, 4);
  assert.equal(summary.actualDropFt, 1);
});

test("redline MEP duct reroute workflow fails disconnected fitting attempts", async () => {
  const dir = tempDir("redline-mep-duct-reroute-disconnected");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_reroute",
      request: {
        kind: "duct",
        viewId: 4001,
        hostElementId: 1542919,
        operation: "reroute_offset",
        split1Point: { x: 76, y: -35 },
        split2Point: { x: 88, y: -35 },
        dropFt: 1,
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/reroute-mep-route-segment": {
        status: "Rerouted",
        dryRun: false,
        kind: "duct",
        plan: {
          Split1: { X: 76, Y: -35, Z: 43 },
          Split2: { X: 88, Y: -35, Z: 43 },
          OffsetSplit1: { X: 76, Y: -35, Z: 42 },
          OffsetSplit2: { X: 88, Y: -35, Z: 42 },
          Segments: [{ Role: "main_a" }, { Role: "offset_middle" }],
          ExpectedFittings: [{ ExpectedFitting: "elbow" }, { ExpectedFitting: "elbow" }]
        },
        createdElementIds: [1542921, 1542923],
        createdFittingIds: [1542931],
        connectionAttempts: [
          { connected: true, fittingId: 1542931 },
          { connected: false, error: "failed to place elbow" }
        ],
        verification: { networkAudit: { status: "Disconnected", systemAudit: { pass: false } } },
        visualVerification: { path: "artifacts/captures/duct-reroute-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 3, ids: [1542921, 1542923, 1542931] },
      "/revit/delete:2": { status: "Deleted", count: 3, ids: [1542921, 1542923, 1542931] }
    })
  );

  assert.equal(result.workflow, "redline_mep_reroute");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_model_write_ids_present" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_connection_attempts_verified" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_connector_network_audit" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
});

test("redline MEP reroute workflow rejects successful status with disconnected system count", async () => {
  const dir = tempDir("redline-mep-reroute-disconnected-count");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_reroute",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        hostElementId: 1542919,
        operation: "reroute_offset",
        split1Point: { x: 76, y: -35 },
        split2Point: { x: 88, y: -35 },
        dropFt: 1,
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/reroute-mep-route-segment": {
        status: "Rerouted",
        dryRun: false,
        kind: "duct",
        plan: {
          Split1: { X: 76, Y: -35, Z: 43 },
          Split2: { X: 88, Y: -35, Z: 43 },
          OffsetSplit1: { X: 76, Y: -35, Z: 42 },
          OffsetSplit2: { X: 88, Y: -35, Z: 42 },
          Segments: [
            { Role: "main_a" },
            { Role: "offset_leg_a" },
            { Role: "offset_middle" },
            { Role: "offset_leg_b" },
            { Role: "main_b" }
          ],
          ExpectedFittings: [
            { ExpectedFitting: "elbow" },
            { ExpectedFitting: "elbow" },
            { ExpectedFitting: "elbow" },
            { ExpectedFitting: "elbow" }
          ]
        },
        createdElementIds: [1542921, 1542923, 1542925, 1542927, 1542929],
        createdFittingIds: [1542931, 1542933, 1542936, 1542937],
        connectionAttempts: [
          { connected: true, fittingId: 1542931 },
          { connected: true, fittingId: 1542933 },
          { connected: true, fittingId: 1542936 },
          { connected: true, fittingId: 1542937 }
        ],
        verification: {
          networkAudit: {
            status: "Ok",
            systemAudit: { pass: true, connectedCount: 8, disconnectedCount: 1 }
          }
        },
        visualVerification: { path: "artifacts/captures/duct-reroute-after.jpg", viewId: 4001 }
      },
      "/revit/delete:1": { status: "Dry Run", count: 9, ids: [1542921, 1542923, 1542925, 1542927, 1542929, 1542931, 1542933, 1542936, 1542937] },
      "/revit/delete:2": { status: "Deleted", count: 9, ids: [1542921, 1542923, 1542925, 1542927, 1542929, 1542931, 1542933, 1542936, 1542937] }
    })
  );

  assert.equal(result.workflow, "redline_mep_reroute");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_model_write_ids_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_connection_attempts_verified" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_reroute_connector_network_audit" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_reroute_summary.json"), "utf8"));
  assert.equal(summary.networkOk, false);
  assert.equal(summary.networkContinuityAudit.detail.disconnectedCount, 1);
});

test("redline MEP duct size transition workflow fails when size readback is missing", async () => {
  const dir = tempDir("redline-mep-duct-size-transition-no-readback");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_size_transition",
      request: {
        kind: "duct",
        viewId: 4001,
        hostElementId: 1542001,
        upstreamDuctSize: "28x18",
        downstreamDuctSize: "16x14",
        transitionPoint: { x: 52, y: 27 },
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/reroute-mep-route-segment:1": {
        status: "Dry Run",
        projectedTransitionPoint: { x: 52.1, y: 27.05, z: 38.833 },
        sizeReadback: { upstreamDuctSize: "28x18", downstreamDuctSize: "16x14" },
        connectorAudit: { openConnectorCount: 0, connectedNetworkOk: true }
      },
      "/revit/reroute-mep-route-segment:2": {
        status: "Success",
        modifiedElementIds: [1542001],
        createdElementIds: [1542929, 1542930],
        createdFittingIds: [1542931],
        projectedTransitionPoint: { x: 52.1, y: 27.05, z: 38.833 },
        connectorAudit: { openConnectorCount: 0, connectedNetworkOk: true },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/duct-size-transition-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 3, ids: [1542929, 1542930, 1542931] },
      "/revit/delete:2": { status: "Deleted", count: 3, ids: [1542929, 1542930, 1542931] }
    })
  );

  assert.equal(result.workflow, "redline_mep_size_transition");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_size_readback_matches" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
});

test("redline MEP size transition workflow rejects disconnected connector audit without fitting evidence", async () => {
  const dir = tempDir("redline-mep-size-transition-disconnected-audit");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_size_transition",
      request: {
        kind: "pipe",
        viewId: 4001,
        hostElementId: 1642001,
        upstreamPipeSize: "2\"",
        downstreamPipeSize: "1\"",
        transitionPoint: { x: 55, y: 24 },
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/reroute-mep-route-segment:1": {
        status: "Dry Run",
        projectedTransitionPoint: { x: 55.05, y: 24.1, z: 38.833 },
        sizeReadback: { upstreamPipeSize: "2\"", downstreamPipeSize: "1\"" },
        connectorAudit: { openConnectorCount: 0, connectedNetworkOk: true }
      },
      "/revit/reroute-mep-route-segment:2": {
        status: "Success",
        hostElementId: 1642001,
        modifiedElementIds: [1642001],
        createdElementIds: [],
        createdFittingIds: [],
        projectedTransitionPoint: { x: 55.05, y: 24.1, z: 38.833 },
        sizeReadback: { upstreamPipeSize: "2\"", downstreamPipeSize: "1\"" },
        connectorAudit: { status: "Disconnected", openConnectorCount: 2, connectedNetworkOk: false },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/pipe-size-transition-after.jpg" }
      }
    })
  );

  assert.equal(result.workflow, "redline_mep_size_transition");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_fitting_or_connector_readback" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
});

test("redline MEP size transition workflow rejects open connector count without explicit audit or fitting readback", async () => {
  const dir = tempDir("redline-mep-size-transition-open-count-only");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_size_transition",
      request: {
        kind: "pipe",
        viewId: 4001,
        visualViewId: 4001,
        hostElementId: 1642001,
        upstreamPipeSize: "2\"",
        downstreamPipeSize: "1\"",
        expectedFitting: "reducer",
        transitionPoint: { x: 55, y: 24 },
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/reroute-mep-route-segment:1": {
        status: "Dry Run",
        projectedTransitionPoint: { x: 55.05, y: 24.1, z: 38.833 },
        sizeReadback: { upstreamPipeSize: "2\"", downstreamPipeSize: "1\"" },
        expectedFitting: "reducer"
      },
      "/revit/reroute-mep-route-segment:2": {
        status: "Success",
        hostElementId: 1642001,
        modifiedElementIds: [1642001],
        createdElementIds: [1642929, 1642930],
        createdFittingIds: [],
        projectedTransitionPoint: { x: 55.05, y: 24.1, z: 38.833 },
        sizeReadback: { upstreamPipeSize: "2\"", downstreamPipeSize: "1\"" },
        openConnectorCount: 0,
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/pipe-size-transition-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 2, ids: [1642929, 1642930] },
      "/revit/delete:2": { status: "Deleted", count: 2, ids: [1642929, 1642930] }
    })
  );

  assert.equal(result.workflow, "redline_mep_size_transition");
  assert.equal(result.success, false);
  assert.equal(result.revit_transactions, 0);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_dry_run_fitting_or_connector_readback" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_fitting_or_connector_readback"), false);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_size_transition_summary.json"), "utf8"));
  assert.equal(summary.blockedBeforeModelWrite, true);
  assert.equal(summary.dryRun.networkContinuityAudit.explicit, false);
});

test("redline MEP size transition workflow requires explicit connector audit beyond fitting ids", async () => {
  const dir = tempDir("redline-mep-size-transition-fitting-no-audit");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_size_transition",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        hostElementId: 1542001,
        upstreamDuctSize: "28x18",
        downstreamDuctSize: "16x14",
        transitionPoint: { x: 52, y: 27 },
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/reroute-mep-route-segment:1": {
        status: "Dry Run",
        projectedTransitionPoint: { x: 52.05, y: 27.1, z: 38.833 },
        sizeReadback: { upstreamDuctSize: "28x18", downstreamDuctSize: "16x14" },
        proposedFittingIds: [1542931],
        expectedFitting: "reducer"
      }
    })
  );

  assert.equal(result.workflow, "redline_mep_size_transition");
  assert.equal(result.success, false);
  assert.equal(result.revit_transactions, 0);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_dry_run_fitting_or_connector_readback" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_size_transition_summary.json"), "utf8"));
  assert.equal(summary.blockedBeforeModelWrite, true);
  assert.equal(summary.dryRun.networkContinuityAudit.explicit, false);
});

test("redline MEP size transition workflow rejects disconnected connector audit even with fitting evidence", async () => {
  const dir = tempDir("redline-mep-size-transition-disconnected-with-fitting");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_size_transition",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        hostElementId: 1542001,
        upstreamDuctSize: "28x18",
        downstreamDuctSize: "16x14",
        transitionPoint: { x: 52, y: 27 },
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/reroute-mep-route-segment:1": {
        status: "Dry Run",
        projectedTransitionPoint: { x: 52.05, y: 27.1, z: 38.833 },
        sizeReadback: { upstreamDuctSize: "28x18", downstreamDuctSize: "16x14" },
        connectorAudit: { openConnectorCount: 0, connectedNetworkOk: true }
      },
      "/revit/reroute-mep-route-segment:2": {
        status: "Success",
        hostElementId: 1542001,
        modifiedElementIds: [1542001],
        createdElementIds: [1542929, 1542930],
        createdFittingIds: [1542931],
        projectedTransitionPoint: { x: 52.05, y: 27.1, z: 38.833 },
        sizeReadback: { upstreamDuctSize: "28x18", downstreamDuctSize: "16x14" },
        connectorAudit: { status: "Disconnected", openConnectorCount: 2, connectedNetworkOk: false },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/duct-size-transition-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 3, ids: [1542929, 1542930, 1542931] },
      "/revit/delete:2": { status: "Deleted", count: 3, ids: [1542929, 1542930, 1542931] }
    })
  );

  assert.equal(result.workflow, "redline_mep_size_transition");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_fitting_or_connector_readback" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_size_readback_matches" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
});

test("redline MEP pipe size transition workflow reads pipe sizes and cleans up fittings", async () => {
  const dir = tempDir("redline-mep-pipe-size-transition-pass");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_size_transition",
      request: {
        kind: "pipe",
        viewId: 4001,
        visualViewId: 4001,
        hostElementId: 1642001,
        levelName: "L4",
        systemType: "Domestic Cold Water",
        upstreamPipeSize: "2\"",
        downstreamPipeSize: "1\"",
        transitionPoint: { x: 55, y: 24 },
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/reroute-mep-route-segment": {
        status: "Success",
        hostElementId: 1642001,
        modifiedElementIds: [1642001],
        createdElementIds: [1642929, 1642930],
        createdFittingIds: [1642931],
        projectedTransitionPoint: { x: 55.05, y: 24.1, z: 38.833 },
        sizeReadback: { upstreamPipeSize: "2\"", downstreamPipeSize: "1\"" },
        connectorAudit: { openConnectorCount: 0, connectedNetworkOk: true },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/pipe-size-transition-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 3, ids: [1642929, 1642930, 1642931] },
      "/revit/delete:2": { status: "Deleted", count: 3, ids: [1642929, 1642930, 1642931] }
    })
  );

  assert.equal(result.workflow, "redline_mep_size_transition");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_size_transition_size_readback_matches" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_size_transition_summary.json"), "utf8"));
  assert.equal(summary.kind, "pipe");
  assert.equal(summary.requestedUpstreamSize, "2\"");
  assert.equal(summary.requestedDownstreamSize, "1\"");
  assert.equal(summary.appliedUpstreamSize, "2\"");
  assert.equal(summary.appliedDownstreamSize, "1\"");
  assert.deepEqual(summary.cleanupDeletedIds, [1642929, 1642930, 1642931]);
});

test("redline MEP pipe size transition workflow can create a disposable host route before apply", async () => {
  const dir = tempDir("redline-mep-pipe-size-transition-disposable-host");
  const bridge = new MockBridgeTransport({
    "/revit/create-mep-route": {
      status: "CreatedWithOpenConnectors",
      createdElementIds: [1543016]
    },
    "/revit/reroute-mep-route-segment:1": {
      status: "Dry Run",
      projectedTransitionPoint: { x: 82, y: -70, z: 43 },
      upstreamSize: { requested: "1 inch", applied: "1 inch" },
      downstreamSize: { requested: "1.5 in", applied: "1.5 in" },
      connectorAudit: { openConnectorCount: 0, connectedNetworkOk: true }
    },
    "/revit/reroute-mep-route-segment:2": {
      status: "ChangedSizeAtTransition",
      createdElementIds: [1543020, 1543023],
      createdFittingIds: [1543026],
      projectedTransitionPoint: { x: 82, y: -70, z: 43 },
      upstreamSize: { requested: "1 inch", applied: "1 inch" },
      downstreamSize: { requested: "1.5 in", applied: "1.5 in" },
      connectorAudit: { openConnectorCount: 0, connectedNetworkOk: true },
      visualVerification: {
        path: "artifacts/captures/pipe-size-transition-l4.jpg",
        widthPx: 2200,
        heightPx: 1140,
        focusCrop: { requested: true, applied: true }
      }
    },
    "/revit/delete:1": { status: "Dry Run", impactedIds: [1543020, 1543021, 1543023, 1543024, 1543026, 1543027] },
    "/revit/delete:2": { status: "Deleted", impactedIds: [1543020, 1543021, 1543023, 1543024, 1543026, 1543027] }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_size_transition",
      request: {
        kind: "pipe",
        viewId: 1363433,
        visualViewId: 1363433,
        levelName: "L4",
        systemType: "Domestic Cold Water",
        upstreamPipeSize: "1 inch",
        downstreamPipeSize: "1.5 in",
        transitionPoint: { x: 82, y: -70 },
        transitionNormalized: 0.5,
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1,
        createHostRoute: {
          pipeType: "PVC - DWV",
          pipeSize: "1 inch",
          points: [{ x: 70, y: -70, z: 43 }, { x: 94, y: -70, z: 43 }]
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "redline_mep_size_transition");
  assert.equal(result.success, true);
  const rerouteCalls = bridge.calls.filter((call) => call.pathname === "/revit/reroute-mep-route-segment");
  assert.equal((rerouteCalls[0]?.body as Record<string, unknown>).apply, false);
  assert.equal((rerouteCalls[0]?.body as Record<string, unknown>).dryRun, true);
  assert.equal((rerouteCalls[1]?.body as Record<string, unknown>).apply, true);
  assert.equal((rerouteCalls[1]?.body as Record<string, unknown>).dryRun, false);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_size_transition_summary.json"), "utf8"));
  assert.equal(summary.hostElementId, 1543016);
  assert.deepEqual(summary.setupCreatedElementIds, [1543016]);
  assert.equal(summary.capturePath, "artifacts/captures/pipe-size-transition-l4.jpg");
  assert.deepEqual(summary.cleanupDeletedIds, [1543020, 1543021, 1543023, 1543024, 1543026, 1543027]);
});

test("redline MEP route workflow fails when ready result omits model write ids", async () => {
  const dir = tempDir("redline-mep-route-no-ids");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_route",
      request: {
        kind: "pipe",
        viewId: 4001,
        visualViewId: 4001,
        roomNumber: "405",
        levelName: "L4",
        pipeSize: "6\"",
        apply: true,
        visualVerify: true,
        toleranceFt: 1,
        points: [{ x: 40, y: 27 }, { x: 58, y: 27 }]
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/mep-route-workflow": {
        status: "AppliedVisualVerificationReady",
        applyResult: {
          status: "CreatedWithOpenConnectors",
          plannedPoints: [{ x: 40, y: 27, z: 38.833 }, { x: 58, y: 27, z: 38.833 }],
          segmentCount: 1,
          chosenSize: { requested: "6\"", applied: "6\"" },
          createdElementIds: [],
          createdFittingIds: [],
          openConnectorCount: 2
        },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/mep-route-after.jpg" }
      }
    })
  );

  assert.equal(result.workflow, "redline_mep_route");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "created_model_ids_present" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
  assert.match(result.user_message, /created model element\/fitting IDs/i);
});

test("redline MEP pipe route workflow cleans up segments and fittings after visual evidence", async () => {
  const dir = tempDir("redline-mep-pipe-route-cleanup");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_route",
      request: {
        kind: "pipe",
        viewId: 4001,
        visualViewId: 4001,
        roomNumber: "405",
        levelName: "L4",
        systemType: "Domestic Cold Water",
        pipeSize: "2\"",
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1,
        points: [{ x: 42, y: 24 }, { x: 55, y: 24 }, { x: 55, y: 31 }]
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/mep-route-workflow": {
        status: "AppliedVisualVerificationReady",
        applyResult: {
          status: "CreatedWithOpenConnectors",
          plannedPoints: [{ x: 42, y: 24, z: 38.833 }, { x: 55, y: 24, z: 38.833 }, { x: 55, y: 31, z: 38.833 }],
          segmentCount: 2,
          chosenSize: { requested: "2\"", applied: "2\"" },
          createdElementIds: [1642929, 1642930],
          createdFittingIds: [1642931],
          openConnectorCount: 2
        },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/pipe-route-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 3, ids: [1642929, 1642930, 1642931] },
      "/revit/delete:2": { status: "Deleted", count: 3, ids: [1642929, 1642930, 1642931] }
    })
  );

  assert.equal(result.workflow, "redline_mep_route");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_cleanup_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_route_summary.json"), "utf8"));
  assert.equal(summary.kind, "pipe");
  assert.deepEqual(summary.createdElementIds, [1642929, 1642930]);
  assert.deepEqual(summary.createdFittingIds, [1642931]);
  assert.deepEqual(summary.cleanupDryRunIds, [1642929, 1642930, 1642931]);
  assert.deepEqual(summary.cleanupDeletedIds, [1642929, 1642930, 1642931]);
});

test("redline MEP route workflow rejects tiny reported post-change captures", async () => {
  const dir = tempDir("redline-mep-route-tiny-capture");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_route",
      request: {
        kind: "pipe",
        viewId: 4001,
        visualViewId: 4001,
        roomNumber: "405",
        levelName: "L4",
        pipeSize: "2\"",
        apply: true,
        visualVerify: true,
        toleranceFt: 1,
        points: [{ x: 42, y: 24 }, { x: 55, y: 24 }]
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/mep-route-workflow": {
        status: "AppliedVisualVerificationReady",
        applyResult: {
          status: "CreatedWithOpenConnectors",
          plannedPoints: [{ x: 42, y: 24, z: 38.833 }, { x: 55, y: 24, z: 38.833 }],
          segmentCount: 1,
          chosenSize: { requested: "2\"", applied: "2\"" },
          createdElementIds: [1642929],
          createdFittingIds: [],
          openConnectorCount: 2
        },
        visualVerification: {
          status: "CaptureReadyForAIReview",
          capturePath: "artifacts/captures/pipe-route-after.jpg",
          widthPx: 320,
          heightPx: 240
        }
      }
    })
  );

  assert.equal(result.workflow, "redline_mep_route");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "post_change_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "post_change_capture_quality_ok" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
});

test("redline MEP route workflow rejects failed requested focus crops", async () => {
  const dir = tempDir("redline-mep-route-focus-crop-failed");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_route",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        levelName: "L4",
        systemType: "Supply Air",
        ductSize: "12x10",
        apply: true,
        visualVerify: true,
        toleranceFt: 1,
        points: [{ x: 40, y: 27 }, { x: 58, y: 27 }]
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/mep-route-workflow": {
        status: "AppliedVisualVerificationReady",
        applyResult: {
          status: "CreatedWithOpenConnectors",
          plannedPoints: [{ x: 40, y: 27, z: 38.833 }, { x: 58, y: 27, z: 38.833 }],
          segmentCount: 1,
          chosenSize: { requested: "12x10", applied: "12x10" },
          createdElementIds: [1642929],
          createdFittingIds: [],
          openConnectorCount: 2
        },
        visualVerification: {
          status: "CaptureReadyForAIReview",
          capturePath: "artifacts/captures/mep-route-after.jpg",
          capture: {
            widthPx: 1024,
            heightPx: 768,
            focusCrop: { requested: true, applied: false }
          }
        }
      }
    })
  );

  assert.equal(result.workflow, "redline_mep_route");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "post_change_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "post_change_capture_quality_ok" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
});

test("redline MEP pipe route workflow fails when route segment ids do not cover requested route", async () => {
  const dir = tempDir("redline-mep-pipe-route-missing-segment-id");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_route",
      request: {
        kind: "pipe",
        viewId: 4001,
        visualViewId: 4001,
        roomNumber: "405",
        levelName: "L4",
        systemType: "Domestic Cold Water",
        pipeSize: "2\"",
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1,
        points: [{ x: 42, y: 24 }, { x: 55, y: 24 }, { x: 55, y: 31 }]
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/mep-route-workflow": {
        status: "AppliedVisualVerificationReady",
        applyResult: {
          status: "CreatedWithOpenConnectors",
          plannedPoints: [{ x: 42, y: 24, z: 38.833 }, { x: 55, y: 24, z: 38.833 }, { x: 55, y: 31, z: 38.833 }],
          segmentCount: 2,
          chosenSize: { requested: "2\"", applied: "2\"" },
          createdElementIds: [1642929],
          createdFittingIds: [1642931],
          openConnectorCount: 2
        },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/pipe-route-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 2, ids: [1642929, 1642931] },
      "/revit/delete:2": { status: "Deleted", count: 2, ids: [1642929, 1642931] }
    })
  );

  assert.equal(result.workflow, "redline_mep_route");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "redline_visual_gate_passed" && !entry.ok), true);
  assert.match(result.user_message, /created route element ID for each requested route segment/i);
  const gate = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_visual_gate.json"), "utf8"));
  assert.equal(gate.assertions.some((entry: any) => entry.name === "route_segment_write_evidence_matches" && entry.status === "fail"), true);
});

test("redline MEP route workflow accepts native impacted cleanup ids", async () => {
  const dir = tempDir("redline-mep-route-native-cleanup-ids");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_route",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        levelName: "L4",
        systemType: "Supply Air",
        ductSize: "12x10",
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1,
        points: [{ x: 40, y: 27 }, { x: 58, y: 27 }]
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/mep-route-workflow": {
        status: "AppliedVisualVerificationReady",
        applyResult: {
          status: "CreatedWithOpenConnectors",
          plannedPoints: [{ x: 40, y: 27, z: 38.833 }, { x: 58, y: 27, z: 38.833 }],
          segmentCount: 1,
          chosenSize: { requested: "12x10", applied: "12x10" },
          createdElementIds: [1542929],
          createdFittingIds: [],
          openConnectorCount: 2
        },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/mep-route-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", requestedIds: [1542929], impactedIds: [1542929] },
      "/revit/delete:2": { status: "Deleted", requestedIds: [1542929], impactedIds: [1542929] }
    })
  );

  assert.equal(result.workflow, "redline_mep_route");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_cleanup_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_route_summary.json"), "utf8"));
  assert.deepEqual(summary.cleanupDryRunIds, [1542929]);
  assert.deepEqual(summary.cleanupDeletedIds, [1542929]);
});

test("redline MEP route workflow fails cleanup when dry run omits a created id", async () => {
  const dir = tempDir("redline-mep-route-cleanup-dry-run-missing-id");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "redline_mep_route",
      request: {
        kind: "duct",
        viewId: 4001,
        visualViewId: 4001,
        roomNumber: "405",
        levelName: "L4",
        systemType: "Supply Air",
        ductSize: "12x10",
        apply: true,
        visualVerify: true,
        cleanupCreatedElements: true,
        toleranceFt: 1,
        points: [{ x: 40, y: 27 }, { x: 58, y: 27 }]
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/mep-route-workflow": {
        status: "AppliedVisualVerificationReady",
        applyResult: {
          status: "CreatedWithOpenConnectors",
          plannedPoints: [{ x: 40, y: 27, z: 38.833 }, { x: 58, y: 27, z: 38.833 }],
          segmentCount: 1,
          chosenSize: { requested: "12x10", applied: "12x10" },
          createdElementIds: [1542929, 1542930],
          createdFittingIds: [],
          openConnectorCount: 2
        },
        visualVerification: { status: "CaptureReadyForAIReview", capturePath: "artifacts/captures/mep-route-after.jpg" }
      },
      "/revit/delete:1": { status: "Dry Run", count: 1, ids: [1542929] },
      "/revit/delete:2": { status: "Deleted", count: 2, ids: [1542929, 1542930] }
    })
  );

  assert.equal(result.workflow, "redline_mep_route");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_cleanup_dry_run_ok" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "mep_route_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "redline_mep_route_summary.json"), "utf8"));
  assert.deepEqual(summary.cleanupDryRunIds, [1542929]);
  assert.deepEqual(summary.cleanupDeletedIds, [1542929, 1542930]);
});

test("documentation primitives workflow creates schedule sheet visibility text and tags", async () => {
  const dir = tempDir("documentation-primitives-pass");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 1 } },
    "/revit/schedules:1": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 1 }, fields: [{ name: "Family and Type" }] },
    "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
    "/revit/configure-schedule:2": {
      status: "Success",
      scheduleId: 8101,
      applied: {
        addFields: [{ field: "Count", status: "Added" }],
        filters: [{ field: "Family and Type", status: "Applied", op: "begins_with", value: "OPERATOR-BENCHMARK-NO-MATCH" }],
        sortGroup: [{ field: "Family and Type", status: "Applied", ascending: true, showHeader: true }, { setting: "showGrandTotals", value: false }],
        columnWidths: [{ field: "Family and Type", status: "Applied", widthFeet: 0.85, appliedTo: { grid: true, sheet: true } }]
      }
    },
    "/revit/schedules:2": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 2 }, fields: [{ name: "Family and Type" }, { name: "Count" }] },
    "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
    "/revit/create-view:1": { status: "Dry Run", dryRun: true, action: "create_drafting" },
    "/revit/create-view:2": { status: "Success", action: "create_drafting", view: { id: 8251, name: "Operator Demo Drafting View-R01" } },
    "/revit/create-view:3": { status: "Dry Run", dryRun: true, action: "create_view_template" },
    "/revit/create-view:4": { status: "Success", action: "create_view_template", view: { id: 8252, name: "Operator Demo View Template-R01" } },
    "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
    "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
    "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
    "/revit/visibility:1": { status: "Dry Run", dryRun: true },
    "/revit/visibility:2": { status: "Success", action: "set_scale", viewId: 8251, view: { id: 8251, scale: 50 } },
    "/revit/visibility:3": { status: "Dry Run", dryRun: true, action: "set_category_override", input: { viewId: 8251, categoryName: "Lines", lineWeight: 5 } },
    "/revit/visibility:4": { status: "Success", action: "set_category_override", viewId: 8251, view: { id: 8251, categoryOverride: { categoryName: "Lines", lineWeight: 5 } } },
    "/revit/visibility:5": { status: "Dry Run", dryRun: true, action: "set_category_override", input: { viewId: 8251, linkedModelName: "Snowdon Towers Sample Architectural.rvt", categoryName: "Plumbing Fixtures", lineWeight: 5 } },
    "/revit/visibility:6": { status: "Success", action: "set_category_override", viewId: 8251, view: { id: 8251, categoryOverride: { linkedModelName: "Snowdon Towers Sample Architectural.rvt", categoryName: "Plumbing Fixtures", lineWeight: 5 } } },
    "/revit/visibility:7": { status: "Dry Run", dryRun: true, action: "set_phase", input: { viewId: 8251, phaseName: "New Construction" } },
    "/revit/visibility:8": { status: "Success", action: "set_phase", viewId: 8251, view: { id: 8251, phaseName: "New Construction" } },
    "/revit/visibility:9": { status: "Dry Run", dryRun: true, action: "set_phase_filter", input: { viewId: 8251, phaseFilterName: "Show Complete" } },
    "/revit/visibility:10": { status: "Success", action: "set_phase_filter", viewId: 8251, view: { id: 8251, phaseFilterName: "Show Complete" } },
    "/revit/visibility:11": { status: "Dry Run", dryRun: true, action: "create_view_filter", input: { viewId: 8251, filterName: "Operator Demo Future Work-R01", categoryName: "OST_Doors", ruleParameterName: "Family and Type", ruleOperator: "begins_with", ruleValue: "OPERATOR-BENCHMARK-NO-MATCH", lineWeight: 5 } },
    "/revit/visibility:12": { status: "Success", action: "create_view_filter", viewId: 8251, view: { id: 8251, viewFilters: [{ id: 8501, name: "Operator Demo Future Work-R01", visible: true, override: { lineWeight: 5 } }] } },
    "/revit/visibility:13": { status: "Dry Run", dryRun: true, action: "apply_view_filter", input: { viewId: 8251, filterName: "Operator Demo Future Work-R01", filterId: 8501, filterVisible: true, lineWeight: 5 } },
    "/revit/visibility:14": { status: "Success", action: "apply_view_filter", viewId: 8251, view: { id: 8251, viewFilters: [{ id: 8501, name: "Operator Demo Future Work-R01", visible: true, override: { lineWeight: 5 } }] } },
    "/revit/visibility:15": { status: "Dry Run", dryRun: true },
    "/revit/visibility:16": { status: "Success", action: "set_scale", viewId: 8252, view: { id: 8252, scale: 50 } },
    "/revit/visibility:17": { status: "Dry Run", dryRun: true, action: "set_category_override", input: { viewId: 8252, categoryName: "Lines", lineWeight: 5 } },
    "/revit/visibility:18": { status: "Success", action: "set_category_override", viewId: 8252, view: { id: 8252, categoryOverride: { categoryName: "Lines", lineWeight: 5 } } },
    "/revit/visibility:19": { status: "Dry Run", dryRun: true, action: "set_template", input: { viewId: 8251, templateName: "Operator Demo View Template-R01" } },
    "/revit/visibility:20": { status: "Success", action: "set_template", viewId: 8251, view: { id: 8251, viewTemplate: "Operator Demo View Template-R01", viewTemplateId: 8252 } },
    "/revit/tag-elements:1": {
      status: "Dry Run",
      dryRun: true,
      viewId: 401,
      targetCount: 2,
      plannedToTag: 2,
      targets: [
        { elementId: 301, category: "Mechanical Equipment", alreadyTagged: false },
        { elementId: 302, category: "Mechanical Equipment", alreadyTagged: false }
      ]
    },
    "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 2, taggedCount: 2, errorCount: 0, tagIds: [8401, 8402] },
    "/revit/link-cad:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg", targetMode: "view_then_sheet", viewId: 8600, viewName: "CAD operator-demo-keyplan for OP-DEMO-R01", sheetViewId: 8201, sheetNumber: "OP-DEMO-R01", placeOnSheet: true, existingViewportId: null, canPlaceViewport: true, placement: "center", link: true } },
    "/revit/link-cad:2": {
      status: "Success",
      mode: "link",
      targetMode: "view_then_sheet",
      viewId: 8600,
      ownerViewId: 8600,
      viewName: "CAD operator-demo-keyplan for OP-DEMO-R01",
      viewType: "DraftingView",
      viewCreated: true,
      viewScale: 1,
      sheetViewId: 8201,
      sheetNumber: "OP-DEMO-R01",
      viewportId: 8603,
      viewportBox: { minU: -1.2, minV: -0.6, maxU: 1.2, maxV: 0.6 },
      elementBoundingBoxInOwnerView: { min: { x: -0.5, y: -0.25, z: 0 }, max: { x: 0.5, y: 0.25, z: 0 } },
      elementId: 8601,
      sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg",
      cadCategories: [
        { categoryId: 8601, categoryName: "operator-demo-keyplan.dwg", depth: 0 },
        { categoryId: 8602, categoryName: "M104-FUTURE", depth: 1 }
      ]
    },
    "/revit/visibility:21": { status: "Dry Run", dryRun: true, action: "set_category_override", input: { viewId: 8600, categoryName: "M104-FUTURE", lineWeight: 5 } },
    "/revit/visibility:22": { status: "Success", action: "set_category_override", viewId: 8600, view: { id: 8600, categoryOverride: { categoryName: "M104-FUTURE", lineWeight: 5 } } },
    "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
    "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
    "/revit/visibility:23": { status: "Dry Run", dryRun: true, action: "clear_category_override", input: { viewId: 8251, categoryName: "Lines" } },
    "/revit/visibility:24": { status: "Success", action: "clear_category_override", viewId: 8251, view: { id: 8251, categoryOverrides: [] } },
    "/revit/visibility:25": { status: "Dry Run", dryRun: true, action: "clear_category_override", input: { viewId: 8251, linkedModelName: "Snowdon Towers Sample Architectural.rvt", categoryName: "Plumbing Fixtures" } },
    "/revit/visibility:26": { status: "Success", action: "clear_category_override", viewId: 8251, view: { id: 8251, categoryOverrides: [{ categoryName: "Lines", lineWeight: 5 }] } },
    "/revit/visibility:27": { status: "Dry Run", dryRun: true, action: "set_phase_filter", input: { viewId: 8251, phaseFilterName: "Show All" } },
    "/revit/visibility:28": { status: "Success", action: "set_phase_filter", viewId: 8251, view: { id: 8251, phaseFilterName: "Show All" } },
    "/revit/visibility:29": { status: "Dry Run", dryRun: true, action: "set_phase", input: { viewId: 8251, phaseName: "Existing" } },
    "/revit/visibility:30": { status: "Success", action: "set_phase", viewId: 8251, view: { id: 8251, phaseName: "Existing" } },
    "/revit/visibility:31": { status: "Dry Run", dryRun: true, action: "clear_filter_override", input: { viewId: 8251, filterName: "Operator Demo Future Work-R01", filterId: 8501 } },
    "/revit/visibility:32": { status: "Success", action: "clear_filter_override", viewId: 8251, view: { id: 8251, viewFilters: [{ id: 8501, name: "Operator Demo Future Work-R01", visible: true, override: { lineWeight: null, linePatternId: null, linePatternName: null, color: null } }] } },
    "/revit/delete:1": { status: "Dry Run", count: 13, ids: [8401, 8402, 8381, 8351, 8601, 8301, 8603, 8101, 8201, 8251, 8252, 8600, 8501] },
    "/revit/delete:2": { status: "Deleted", count: 13, ids: [8401, 8402, 8381, 8351, 8601, 8301, 8603, 8101, 8201, 8251, 8252, 8600, 8501] }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: {
          name: "Operator Demo Door Schedule",
          category: "OST_Doors",
          fields: ["Family and Type"]
        },
        configureSchedule: {
          addFields: ["Count"],
          filters: [{ field: "Family and Type", op: "begins_with", value: "OPERATOR-BENCHMARK-NO-MATCH" }],
          sortGroup: [{ field: "Family and Type", ascending: true, showHeader: true }],
          columnWidths: [{ field: "Family and Type", widthFeet: 0.85 }],
          showGrandTotals: false
        },
        sheet: {
          number: "OP-DEMO",
          name: "Operator Demo Documentation",
          titleBlockId: -1
        },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View", scale: 100 },
        viewTemplate: { name: "Operator Demo View Template" },
        placeView: { x: 1.5, y: 1.0 },
        visibility: { action: "set_scale", scale: 50 },
        categoryVisibility: { action: "set_category_override", categoryName: "Lines", lineWeight: 5, readbackRequired: true, revertAfterVerify: true },
        linkedModelCategoryVisibility: { action: "set_category_override", linkedModelName: "Snowdon Towers Sample Architectural.rvt", categoryName: "Plumbing Fixtures", lineWeight: 5, readbackRequired: true, revertAfterVerify: true },
        phaseVisibility: { phaseName: "New Construction", phaseFilterName: "Show Complete", originalPhaseName: "Existing", originalPhaseFilterName: "Show All", readbackRequired: true, revertAfterVerify: true },
        filterVisibility: {
          action: "apply_view_filter",
          filterName: "Operator Demo Future Work",
          filterVisible: true,
          lineWeight: 5,
          readbackRequired: true,
          revertAfterVerify: true,
          createFilter: {
            categoryName: "OST_Doors",
            ruleParameterName: "Family and Type",
            ruleOperator: "begins_with",
            ruleValue: "OPERATOR-BENCHMARK-NO-MATCH"
          }
        },
        templateVisibility: { action: "set_scale", scale: 50 },
        templateCategoryVisibility: { action: "set_category_override", categoryName: "Lines", lineWeight: 5 },
        applyViewTemplate: {},
        detailCurves: {
          curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }]
        },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301, 302], onlyUntagged: false },
        cadLink: { sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg", placement: "center", customScale: 1, link: true },
        cadGraphicsOverride: { layerOrSubcategoryName: "M104-FUTURE", lineWeight: 5 },
        cleanupCreatedElements: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_dry_run_ok",
    "schedule_created_id_present",
    "schedule_created_field_count_matches_request",
    "schedule_created_fields_match_request",
    "schedule_config_dry_run_ok",
    "schedule_config_applied_success",
    "schedule_config_target_matches_created_schedule",
    "schedule_config_applied_operations_match_request",
    "schedule_config_fields_match_request",
    "schedule_config_text_value_readback_matches_request",
    "sheet_created_id_present",
    "view_create_dry_run_ok",
    "view_created_id_present",
    "view_template_create_dry_run_ok",
    "view_template_created_id_present",
    "view_placed_on_sheet",
    "view_placed_targets_match_request",
    "detail_curves_dry_run_ok",
    "detail_curves_target_matches_request",
    "detail_curve_ids_created",
    "visibility_dry_run_ok",
    "visibility_applied_success",
    "visibility_target_matches_created_view",
    "visibility_applied_setting_matches_request",
    "category_visibility_dry_run_ok",
    "category_visibility_applied_success",
    "category_visibility_target_matches_request",
    "category_visibility_applied_override_matches_request",
    "linked_model_category_visibility_dry_run_ok",
    "linked_model_category_visibility_applied_success",
    "linked_model_category_visibility_target_matches_request",
    "linked_model_category_visibility_applied_override_matches_request",
    "phase_visibility_dry_run_ok",
    "phase_visibility_applied_success",
    "phase_visibility_target_matches_request",
    "phase_visibility_applied_setting_matches_request",
    "phase_filter_visibility_dry_run_ok",
    "phase_filter_visibility_applied_success",
    "phase_filter_visibility_target_matches_request",
    "phase_filter_visibility_applied_setting_matches_request",
    "filter_visibility_create_dry_run_ok",
    "filter_visibility_create_applied_success",
    "filter_visibility_create_target_matches_request",
    "filter_visibility_created_filter_id_present",
    "filter_visibility_dry_run_ok",
    "filter_visibility_applied_success",
    "filter_visibility_target_matches_request",
    "filter_visibility_applied_override_matches_request",
    "view_template_visibility_dry_run_ok",
    "view_template_visibility_applied_success",
    "view_template_visibility_target_matches_template",
    "view_template_visibility_applied_setting_matches_request",
    "view_template_category_visibility_dry_run_ok",
    "view_template_category_visibility_applied_success",
    "view_template_category_visibility_target_matches_template",
    "view_template_category_visibility_applied_override_matches_request",
    "view_template_assignment_dry_run_ok",
    "view_template_assignment_applied_success",
    "view_template_assignment_target_matches_created_view",
    "view_template_assignment_setting_matches_request",
    "text_note_created",
    "text_note_target_matches_request",
    "tag_request_present",
    "tag_dry_run_ok",
    "tag_dry_run_targets_match_request",
    "tag_applied_targets_match_request",
    "tag_readback_matches_request",
    "tag_created_count_matches_request",
    "tag_ids_created",
    "cad_link_request_present",
    "cad_link_dry_run_ok",
    "cad_link_applied_id_present",
    "cad_link_source_matches_request",
    "cad_link_sheet_matches_request",
    "cad_link_owner_view_reported",
    "cad_link_viewport_placed_on_sheet",
    "cad_link_viewport_box_sheet_sized",
    "cad_link_owner_view_bbox_reported",
    "cad_link_layer_categories_reported",
    "cad_graphics_override_layer_selected",
    "cad_graphics_override_dry_run_ok",
    "cad_graphics_override_applied_success",
    "cad_graphics_override_target_matches_owner_view",
    "cad_graphics_override_lineweight_matches_request",
    "documentation_post_change_capture_returned",
    "documentation_post_change_capture_targets_created_context",
    "documentation_post_change_capture_view_id_matches_request",
    "cad_link_post_change_capture_targets_sheet",
    "category_visibility_revert_dry_run_ok",
    "category_visibility_revert_applied_success",
    "category_visibility_revert_target_matches_request",
    "category_visibility_revert_cleared_override",
    "linked_model_category_visibility_revert_dry_run_ok",
    "linked_model_category_visibility_revert_applied_success",
    "linked_model_category_visibility_revert_target_matches_request",
    "linked_model_category_visibility_revert_cleared_override",
    "phase_filter_visibility_revert_dry_run_ok",
    "phase_filter_visibility_revert_applied_success",
    "phase_filter_visibility_revert_target_matches_request",
    "phase_filter_visibility_revert_setting_matches_original",
    "phase_visibility_revert_dry_run_ok",
    "phase_visibility_revert_applied_success",
    "phase_visibility_revert_target_matches_request",
    "phase_visibility_revert_setting_matches_original",
    "filter_visibility_revert_dry_run_ok",
    "filter_visibility_revert_applied_success",
    "filter_visibility_revert_target_matches_request",
    "filter_visibility_revert_cleared_override",
    "documentation_cleanup_dry_run_ok",
    "documentation_cleanup_applied_ids_present",
    "documentation_summary_written"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  const filterCreateCall = bridge.calls.filter((call) => call.pathname === "/revit/visibility")[10];
  assert.equal((filterCreateCall?.body as Record<string, unknown> | undefined)?.action, "create_view_filter");
  assert.equal((filterCreateCall?.body as Record<string, unknown> | undefined)?.filterName, "Operator Demo Future Work-R01");
  const scheduleRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "schedule");
  const configureScheduleRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "configure_schedule");
  const placeViewRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "place_view");
  const detailCurveRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "detail_curves");
  const visibilityRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "visibility");
  const categoryVisibilityRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "category_visibility");
  const categoryVisibilityRevertRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "category_visibility_revert");
  const linkedModelCategoryVisibilityRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "linked_model_category_visibility");
  const linkedModelCategoryVisibilityRevertRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "linked_model_category_visibility_revert");
  const phaseVisibilityRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "phase_visibility");
  const phaseFilterVisibilityRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "phase_filter_visibility");
  const phaseVisibilityRevertRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "phase_visibility_revert");
  const phaseFilterVisibilityRevertRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "phase_filter_visibility_revert");
  const filterVisibilityRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "filter_visibility");
  const filterVisibilityRevertRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "filter_visibility_revert");
  const templateVisibilityRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "view_template_visibility");
  const templateCategoryVisibilityRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "view_template_category_visibility");
  const templateAssignmentRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "view_template_assignment");
  const textNoteRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "text_note");
  const tagRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "tag");
  const cadLinkRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "cad_link");
  const cadGraphicsOverrideRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "cad_graphics_override");
  assert.equal(summary.scheduleId, 8101);
  assert.deepEqual(summary.createdScheduleFieldNames, ["family and type"]);
  assert.equal(scheduleRow?.requestedFieldCount, 1);
  assert.equal(scheduleRow?.fieldCount, 1);
  assert.equal(scheduleRow?.requestedFields, "Family and Type");
  assert.equal(scheduleRow?.reportedFields, "family and type");
  assert.equal(summary.configuredScheduleId, 8101);
  assert.deepEqual(summary.configuredScheduleFieldNames, ["family and type", "count"]);
  assert.equal(configureScheduleRow?.requestedFields, "Family and Type;Count");
  assert.equal(configureScheduleRow?.reportedFields, "family and type;count");
  assert.equal(visibilityRow?.requestedScale, 50);
  assert.equal(visibilityRow?.appliedScale, 50);
  assert.equal(categoryVisibilityRow?.requestedCategoryName, "Lines");
  assert.equal(categoryVisibilityRow?.appliedCategoryName, "Lines");
  assert.equal(categoryVisibilityRow?.requestedLineWeight, 5);
  assert.equal(categoryVisibilityRow?.appliedLineWeight, 5);
  assert.equal(categoryVisibilityRevertRow?.requestedCategoryName, "Lines");
  assert.equal(summary.categoryVisibilityRevertTargetId, 8251);
  assert.equal(summary.categoryVisibilityRevertStatus, "Success");
  assert.equal(linkedModelCategoryVisibilityRow?.requestedLinkedModelName, "Snowdon Towers Sample Architectural.rvt");
  assert.equal(linkedModelCategoryVisibilityRow?.appliedLinkedModelName, "Snowdon Towers Sample Architectural.rvt");
  assert.equal(linkedModelCategoryVisibilityRow?.requestedCategoryName, "Plumbing Fixtures");
  assert.equal(linkedModelCategoryVisibilityRow?.appliedCategoryName, "Plumbing Fixtures");
  assert.equal(linkedModelCategoryVisibilityRow?.requestedLineWeight, 5);
  assert.equal(linkedModelCategoryVisibilityRow?.appliedLineWeight, 5);
  assert.equal(summary.linkedModelCategoryVisibilityTargetId, 8251);
  assert.equal(summary.requestedLinkedModelCategoryName, "Plumbing Fixtures");
  assert.equal(summary.appliedLinkedModelCategoryName, "Plumbing Fixtures");
  assert.equal(summary.requestedLinkedModelLineWeight, 5);
  assert.equal(summary.appliedLinkedModelLineWeight, 5);
  assert.equal(linkedModelCategoryVisibilityRevertRow?.requestedLinkedModelName, "Snowdon Towers Sample Architectural.rvt");
  assert.equal(linkedModelCategoryVisibilityRevertRow?.requestedCategoryName, "Plumbing Fixtures");
  assert.equal(summary.linkedModelCategoryVisibilityRevertTargetId, 8251);
  assert.equal(summary.linkedModelCategoryVisibilityRevertStatus, "Success");
  assert.equal(phaseVisibilityRow?.requestedPhaseName, "New Construction");
  assert.equal(phaseVisibilityRow?.appliedPhaseName, "New Construction");
  assert.equal(phaseFilterVisibilityRow?.requestedPhaseFilterName, "Show Complete");
  assert.equal(phaseFilterVisibilityRow?.appliedPhaseFilterName, "Show Complete");
  assert.equal(summary.phaseVisibilityTargetId, 8251);
  assert.equal(summary.requestedPhaseName, "New Construction");
  assert.equal(summary.appliedPhaseName, "New Construction");
  assert.equal(phaseVisibilityRevertRow?.requestedPhaseName, "Existing");
  assert.equal(phaseVisibilityRevertRow?.appliedPhaseName, "Existing");
  assert.equal(summary.phaseVisibilityRevertTargetId, 8251);
  assert.equal(summary.revertedPhaseName, "Existing");
  assert.equal(summary.phaseFilterVisibilityTargetId, 8251);
  assert.equal(summary.requestedPhaseFilterName, "Show Complete");
  assert.equal(summary.appliedPhaseFilterName, "Show Complete");
  assert.equal(phaseFilterVisibilityRevertRow?.requestedPhaseFilterName, "Show All");
  assert.equal(phaseFilterVisibilityRevertRow?.appliedPhaseFilterName, "Show All");
  assert.equal(summary.phaseFilterVisibilityRevertTargetId, 8251);
  assert.equal(summary.revertedPhaseFilterName, "Show All");
  const filterCreateRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "filter_visibility_create");
  assert.equal(filterCreateRow?.requestedFilterName, "Operator Demo Future Work-R01");
  assert.equal(filterCreateRow?.appliedFilterName, "Operator Demo Future Work-R01");
  assert.equal(filterCreateRow?.appliedFilterId, 8501);
  assert.equal(filterVisibilityRow?.requestedFilterName, "Operator Demo Future Work-R01");
  assert.equal(filterVisibilityRow?.appliedFilterName, "Operator Demo Future Work-R01");
  assert.equal(filterVisibilityRow?.requestedLineWeight, 5);
  assert.equal(filterVisibilityRow?.appliedFilterLineWeight, 5);
  assert.equal(summary.createdFilterId, 8501);
  assert.equal(summary.requestedFilterName, "Operator Demo Future Work-R01");
  assert.equal(summary.appliedFilterName, "Operator Demo Future Work-R01");
  assert.equal(summary.requestedFilterLineWeight, 5);
  assert.equal(summary.appliedFilterLineWeight, 5);
  assert.equal(filterVisibilityRevertRow?.requestedFilterName, "Operator Demo Future Work-R01");
  assert.equal(summary.filterVisibilityRevertTargetId, 8251);
  assert.equal(summary.filterVisibilityRevertStatus, "Success");
  assert.equal(cadLinkRow?.id, 8601);
  assert.equal(cadLinkRow?.expectedSheetId, 8201);
  assert.equal(cadLinkRow?.reportedSheetId, 8201);
  assert.equal(cadLinkRow?.ownerViewId, 8600);
  assert.equal(cadLinkRow?.viewportId, 8603);
  assert.equal(cadLinkRow?.requestedSourcePath, "benchmark/fixtures/cad/operator-demo-keyplan.dwg");
  assert.equal(cadLinkRow?.reportedSourcePath, "benchmark/fixtures/cad/operator-demo-keyplan.dwg");
  assert.equal(cadLinkRow?.cadCategoryCount, 2);
  assert.equal(cadLinkRow?.targetMode, "view_then_sheet");
  assert.equal(summary.cadLinkId, 8601);
  assert.equal(summary.cadLinkTargetId, 8601);
  assert.equal(summary.cadLinkSourcePath, "benchmark/fixtures/cad/operator-demo-keyplan.dwg");
  assert.equal(cadGraphicsOverrideRow?.expectedViewId, 8600);
  assert.equal(cadGraphicsOverrideRow?.requestedCadCategoryName, "M104-FUTURE");
  assert.equal(cadGraphicsOverrideRow?.appliedCategoryName, "M104-FUTURE");
  assert.equal(cadGraphicsOverrideRow?.requestedLineWeight, 5);
  assert.equal(cadGraphicsOverrideRow?.appliedLineWeight, 5);
  assert.equal(summary.cadGraphicsOverrideTargetId, 8600);
  assert.equal(summary.requestedCadCategoryName, "M104-FUTURE");
  assert.equal(summary.appliedCadCategoryName, "M104-FUTURE");
  assert.equal(summary.requestedCadLineWeight, 5);
  assert.equal(summary.appliedCadLineWeight, 5);
  assert.equal(templateVisibilityRow?.requestedScale, 50);
  assert.equal(templateVisibilityRow?.appliedScale, 50);
  assert.equal(templateCategoryVisibilityRow?.expectedViewId, 8252);
  assert.equal(templateCategoryVisibilityRow?.requestedCategoryName, "Lines");
  assert.equal(templateCategoryVisibilityRow?.appliedCategoryName, "Lines");
  assert.equal(templateCategoryVisibilityRow?.requestedLineWeight, 5);
  assert.equal(templateCategoryVisibilityRow?.appliedLineWeight, 5);
  assert.equal(summary.templateCategoryVisibilityTargetId, 8252);
  assert.equal(summary.requestedTemplateCategoryName, "Lines");
  assert.equal(summary.appliedTemplateCategoryName, "Lines");
  assert.equal(summary.requestedTemplateCategoryLineWeight, 5);
  assert.equal(summary.appliedTemplateCategoryLineWeight, 5);
  assert.equal(templateAssignmentRow?.expectedViewId, 8251);
  assert.equal(templateAssignmentRow?.expectedTemplateId, 8252);
  assert.equal(templateAssignmentRow?.requestedTemplateName, "Operator Demo View Template-R01");
  assert.equal(templateAssignmentRow?.appliedTemplateName, "Operator Demo View Template-R01");
  assert.equal(templateAssignmentRow?.appliedTemplateId, 8252);
  assert.equal(summary.sheetId, 8201);
  assert.equal(summary.createdViewId, 8251);
  assert.equal(summary.templateViewId, 8252);
  assert.equal(summary.placedViewportId, 8301);
  assert.equal(placeViewRow?.expectedSheetId, 8201);
  assert.equal(placeViewRow?.expectedViewId, 8251);
  assert.equal(placeViewRow?.reportedSheetId, 8201);
  assert.equal(placeViewRow?.reportedViewId, 8251);
  assert.deepEqual(summary.detailCurveIds, [8351]);
  assert.equal(detailCurveRow?.expectedViewId, 8251);
  assert.equal(detailCurveRow?.dryRunViewId, 8251);
  assert.equal(detailCurveRow?.reportedViewId, 8251);
  assert.equal(detailCurveRow?.requestedCurveCount, 1);
  assert.equal(detailCurveRow?.dryRunSegments, 1);
  assert.equal(detailCurveRow?.appliedSegments, 1);
  assert.equal(summary.textNoteId, 8381);
  assert.equal(textNoteRow?.expectedViewId, 8201);
  assert.equal(textNoteRow?.reportedViewId, 8201);
  assert.deepEqual(summary.tagIds, [8401, 8402]);
  assert.equal(tagRow?.expectedViewId, 401);
  assert.equal(tagRow?.reportedViewId, 401);
  assert.equal(tagRow?.requestedTargetIds, "301;302");
  assert.equal(tagRow?.dryRunTargetIds, "301;302");
  assert.equal(tagRow?.appliedTagIds, "8401;8402");
  assert.equal(tagRow?.requestedTargetCount, 2);
  assert.equal(tagRow?.dryRunTargetCount, 2);
  assert.equal(tagRow?.appliedTargetCount, 2);
  assert.equal(tagRow?.taggedCount, 2);
  assert.equal(tagRow?.count, 2);
  assert.equal(summary.postChangeCaptureTargetId, 8201);
  assert.equal(summary.postChangeCaptureViewId, 8201);
  assert.equal(summary.postChangeCapturePath, "artifacts/captures/documentation-after.png");
  assert.equal(summary.cleanupRequested, true);
  assert.deepEqual(summary.cleanupDryRunIds, [8401, 8402, 8381, 8351, 8601, 8301, 8603, 8101, 8201, 8251, 8252, 8600, 8501]);
  assert.deepEqual(summary.cleanupDeletedIds, [8401, 8402, 8381, 8351, 8601, 8301, 8603, 8101, 8201, 8251, 8252, 8600, 8501]);
  assert.match(result.user_message, /schedule 8101, sheet 8201/);
});

test("documentation primitives workflow places CAD on an existing sheet without deleting the sheet", async () => {
  const dir = tempDir("documentation-primitives-existing-sheet-cad");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 1 } },
    "/revit/schedules:1": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 1 }, fields: [{ name: "Family and Type" }] },
    "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
    "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { addFields: [{ field: "Count", status: "Added" }] } },
    "/revit/schedules:2": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 2 }, fields: [{ name: "Family and Type" }, { name: "Count" }] },
    "/revit/sheets": {
      status: "Ok",
      action: "detail",
      sheetId: 1543141,
      viewId: 1543141,
      sheetNumber: "M107",
      sheetName: "Plan HVAC L4 CAD",
      viewportCount: 0,
      placedViewCount: 0
    },
    "/revit/create-view:1": { status: "Dry Run", dryRun: true, action: "create_drafting" },
    "/revit/create-view:2": { status: "Success", action: "create_drafting", view: { id: 8251, name: "Operator Demo Drafting View-R01" } },
    "/revit/create-view:3": { status: "Dry Run", dryRun: true, action: "create_view_template" },
    "/revit/create-view:4": { status: "Success", action: "create_view_template", view: { id: 8252, name: "Operator Demo View Template-R01" } },
    "/revit/place-view": { id: 8301, status: "Placed", sheetId: 1543141, viewId: 8251 },
    "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
    "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
    "/revit/visibility:1": { status: "Dry Run", dryRun: true },
    "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
    "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 8251, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
    "/revit/tag-elements:2": { status: "Success", viewId: 8251, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
    "/revit/link-cad:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "artifacts/cad/Snowdon-M104-Plan-HVAC-L4.dwg", targetMode: "view_then_sheet", viewId: 1545001, sheetViewId: 1543141, sheetNumber: "M107", placeOnSheet: true, canPlaceViewport: true } },
    "/revit/link-cad:2": {
      status: "Success",
      mode: "link",
      targetMode: "view_then_sheet",
      viewId: 1545001,
      ownerViewId: 1545001,
      viewName: "CAD Snowdon-M104-Plan-HVAC-L4 for M107",
      viewType: "DraftingView",
      viewCreated: true,
      viewScale: 1,
      sheetViewId: 1543141,
      sheetNumber: "M107",
      viewportId: 1545003,
      viewportBox: { minU: -1.2, minV: -0.6, maxU: 1.2, maxV: 0.6 },
      elementBoundingBoxInOwnerView: { min: { x: -0.5, y: -0.25, z: 0 }, max: { x: 0.5, y: 0.25, z: 0 } },
      elementId: 1545002,
      sourcePath: "artifacts/cad/Snowdon-M104-Plan-HVAC-L4.dwg",
      cadCategories: [
        { categoryId: 1545002, categoryName: "Snowdon-M104-Plan-HVAC-L4.dwg", depth: 0 },
        { categoryId: 1545004, categoryName: "M104-FUTURE", depth: 1 }
      ]
    },
    "/revit/visibility:3": { status: "Dry Run", dryRun: true, action: "set_detail_level", input: { viewId: 8252, detailLevel: "Fine" } },
    "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
    "/revit/visibility:5": { status: "Dry Run", dryRun: true, action: "set_category_override", input: { viewId: 1545001, categoryName: "M104-FUTURE", lineWeight: 5 } },
    "/revit/visibility:6": { status: "Success", action: "set_category_override", viewId: 1545001, view: { id: 1545001, categoryOverrides: [{ categoryName: "M104-FUTURE", lineWeight: 5 }] } },
    "/revit/create-text": { status: "success", id: 8381, viewId: 1543141 },
    "/revit/export-image": { status: "Captured", viewId: 1543141, path: "artifacts/captures/m107-cad-after.png" },
    "/revit/delete:1": { status: "Dry Run", count: 10, ids: [8401, 8381, 8351, 1545002, 8301, 1545003, 8101, 8251, 8252, 1545001] },
    "/revit/delete:2": { status: "Deleted", count: 10, ids: [8401, 8381, 8351, 1545002, 8301, 1545003, 8101, 8251, 8252, 1545001] }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors", fields: ["Family and Type"] },
        configureSchedule: { addFields: ["Count"] },
        existingSheet: { sheetNumber: "M107" },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View", scale: 100 },
        viewTemplate: { name: "Operator Demo View Template" },
        placeView: { x: 1.5, y: 1.0 },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 8251, elementIds: [301], onlyUntagged: false },
        cadLink: { sourcePath: "artifacts/cad/Snowdon-M104-Plan-HVAC-L4.dwg", placement: "center", customScale: 1, link: true },
        cadGraphicsOverride: { layerOrSubcategoryName: "M104-FUTURE", lineWeight: 5 },
        cleanupCreatedElements: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  const sheetRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "sheet");
  const cadLinkRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "cad_link");
  const cadGraphicsOverrideRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "cad_graphics_override");
  assert.equal(summary.sheetId, 1543141);
  assert.equal(sheetRow?.existing, true);
  assert.equal(cadLinkRow?.ownerViewId, 1545001);
  assert.equal(cadLinkRow?.viewportId, 1545003);
  assert.equal(cadLinkRow?.expectedSheetId, 1543141);
  assert.equal(cadGraphicsOverrideRow?.expectedViewId, 1545001);
  assert.equal(cadGraphicsOverrideRow?.requestedCategoryName, "M104-FUTURE");
  assert.equal(cadGraphicsOverrideRow?.appliedCategoryName, "M104-FUTURE");
  assert.equal(cadGraphicsOverrideRow?.requestedLineWeight, 5);
  assert.equal(cadGraphicsOverrideRow?.appliedLineWeight, 5);
  assert.equal(summary.appliedCadCategoryName, "M104-FUTURE");
  assert.equal(summary.appliedCadLineWeight, 5);
  assert.equal(summary.postChangeCaptureTargetId, 1543141);
  assert.deepEqual(summary.cleanupDryRunIds, [8401, 8381, 8351, 1545002, 8301, 1545003, 8101, 8251, 8252, 1545001]);
  assert.equal(summary.cleanupDryRunIds.includes(1543141), false);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/create-sheet"), false);
});

test("documentation primitives workflow falls back to a reported CAD HVAC layer when the requested layer is absent", async () => {
  const dir = tempDir("documentation-primitives-cad-layer-fallback");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 1 } },
    "/revit/schedules:1": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 1 }, fields: [{ name: "Family and Type" }] },
    "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
    "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { addFields: [{ field: "Count", status: "Added" }] } },
    "/revit/schedules:2": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 2 }, fields: [{ name: "Family and Type" }, { name: "Count" }] },
    "/revit/sheets": {
      status: "Ok",
      action: "detail",
      sheetId: 1543141,
      viewId: 1543141,
      sheetNumber: "M107",
      sheetName: "Plan HVAC L4 CAD",
      viewportCount: 0,
      placedViewCount: 0
    },
    "/revit/create-view:1": { status: "Dry Run", dryRun: true, action: "create_drafting" },
    "/revit/create-view:2": { status: "Success", action: "create_drafting", view: { id: 8251, name: "Operator Demo Drafting View-R01" } },
    "/revit/create-view:3": { status: "Dry Run", dryRun: true, action: "create_view_template" },
    "/revit/create-view:4": { status: "Success", action: "create_view_template", view: { id: 8252, name: "Operator Demo View Template-R01" } },
    "/revit/place-view": { id: 8301, status: "Placed", sheetId: 1543141, viewId: 8251 },
    "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
    "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
    "/revit/visibility:1": { status: "Dry Run", dryRun: true },
    "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
    "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 8251, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
    "/revit/tag-elements:2": { status: "Success", viewId: 8251, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
    "/revit/link-cad:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "artifacts/cad/Snowdon-M104-Plan-HVAC-L4.dwg", targetMode: "view_then_sheet", viewId: 1545001, sheetViewId: 1543141, sheetNumber: "M107", placeOnSheet: true, canPlaceViewport: true } },
    "/revit/link-cad:2": {
      status: "Success",
      mode: "link",
      targetMode: "view_then_sheet",
      viewId: 1545001,
      ownerViewId: 1545001,
      viewType: "DraftingView",
      viewCreated: true,
      viewScale: 1,
      sheetViewId: 1543141,
      sheetNumber: "M107",
      viewportId: 1545003,
      viewportBox: { minU: -1.2, minV: -0.6, maxU: 1.2, maxV: 0.6 },
      elementBoundingBoxInOwnerView: { min: { x: -0.5, y: -0.25, z: 0 }, max: { x: 0.5, y: 0.25, z: 0 } },
      elementId: 1545002,
      sourcePath: "artifacts/cad/Snowdon-M104-Plan-HVAC-L4.dwg",
      cadCategories: [
        { categoryId: 1544935, categoryName: "Snowdon-M104-Plan-HVAC-L4", depth: 0 },
        { categoryId: 1544938, categoryName: "0", depth: 1 },
        { categoryId: 1545175, categoryName: "Snowdon Towers Sample Electrical_rvt-1-L4|E-LITE-EQPM", depth: 1 },
        { categoryId: 1544964, categoryName: "X1|M-HVAC-DUCT", depth: 1 },
        { categoryId: 1544968, categoryName: "X1|M-HVAC-DUCT-ANNO", depth: 1 }
      ]
    },
    "/revit/visibility:3": { status: "Dry Run", dryRun: true, action: "set_detail_level", input: { viewId: 8252, detailLevel: "Fine" } },
    "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
    "/revit/visibility:5": { status: "Dry Run", dryRun: true, action: "set_category_override", input: { viewId: 1545001, categoryName: "X1|M-HVAC-DUCT", lineWeight: 5 } },
    "/revit/visibility:6": { status: "Success", action: "set_category_override", viewId: 1545001, view: { id: 1545001, categoryOverrides: [{ categoryName: "X1|M-HVAC-DUCT", lineWeight: 5 }] } },
    "/revit/create-text": { status: "success", id: 8381, viewId: 1543141 },
    "/revit/export-image": { status: "Captured", viewId: 1543141, path: "artifacts/captures/m107-cad-after.png" },
    "/revit/delete:1": { status: "Dry Run", count: 10, ids: [8401, 8381, 8351, 1545002, 8301, 1545003, 8101, 8251, 8252, 1545001] },
    "/revit/delete:2": { status: "Deleted", count: 10, ids: [8401, 8381, 8351, 1545002, 8301, 1545003, 8101, 8251, 8252, 1545001] }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors", fields: ["Family and Type"] },
        configureSchedule: { addFields: ["Count"] },
        existingSheet: { sheetNumber: "M107" },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View", scale: 100 },
        viewTemplate: { name: "Operator Demo View Template" },
        placeView: { x: 1.5, y: 1.0 },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 8251, elementIds: [301], onlyUntagged: false },
        cadLink: { sourcePath: "artifacts/cad/Snowdon-M104-Plan-HVAC-L4.dwg", placement: "origin", customScale: 1, link: true },
        cadGraphicsOverride: { layerOrSubcategoryName: "M104-FUTURE", lineWeight: 5 },
        cleanupCreatedElements: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  const visibilityApplyCall = bridge.calls.filter((call) => call.pathname === "/revit/visibility")[5];
  assert.equal((visibilityApplyCall?.body as Record<string, unknown> | undefined)?.categoryName, "X1|M-HVAC-DUCT");
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  const cadGraphicsOverrideRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "cad_graphics_override");
  assert.equal(cadGraphicsOverrideRow?.requestedCadCategoryName, "M104-FUTURE");
  assert.equal(cadGraphicsOverrideRow?.requestedCategoryName, "X1|M-HVAC-DUCT");
  assert.equal(cadGraphicsOverrideRow?.appliedCategoryName, "X1|M-HVAC-DUCT");
  assert.equal(cadGraphicsOverrideRow?.cadCategoryMatchKind, "context");
  assert.equal(cadGraphicsOverrideRow?.cadCategoryMatchedRequested, false);
  assert.equal(summary.requestedCadCategoryName, "M104-FUTURE");
  assert.equal(summary.appliedCadCategoryName, "X1|M-HVAC-DUCT");
  assert.equal(summary.appliedCadLineWeight, 5);
});

test("documentation primitives workflow can create a missing target sheet before CAD placement when explicitly allowed", async () => {
  const dir = tempDir("documentation-primitives-existing-sheet-create-missing-cad");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 1 } },
    "/revit/schedules:1": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 1 }, fields: [{ name: "Family and Type" }] },
    "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
    "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { addFields: [{ field: "Count", status: "Added" }] } },
    "/revit/schedules:2": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 2 }, fields: [{ name: "Family and Type" }, { name: "Count" }] },
    "/revit/sheets": { status: "NotFound", action: "detail", message: "Sheet not found.", selector: { sheetNumber: "M107" } },
    "/revit/create-sheet": { status: "Success", id: 1543141, sheetId: 1543141, viewId: 1543141, number: "M107", name: "Plan HVAC L4 CAD" },
    "/revit/create-view:1": { status: "Dry Run", dryRun: true, action: "create_drafting" },
    "/revit/create-view:2": { status: "Success", action: "create_drafting", view: { id: 8251, name: "Operator Demo Drafting View-R01" } },
    "/revit/create-view:3": { status: "Dry Run", dryRun: true, action: "create_view_template" },
    "/revit/create-view:4": { status: "Success", action: "create_view_template", view: { id: 8252, name: "Operator Demo View Template-R01" } },
    "/revit/place-view": { id: 8301, status: "Placed", sheetId: 1543141, viewId: 8251 },
    "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
    "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
    "/revit/visibility:1": { status: "Dry Run", dryRun: true },
    "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
    "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 8251, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
    "/revit/tag-elements:2": { status: "Success", viewId: 8251, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
    "/revit/link-cad:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "artifacts/cad/Snowdon-M104-Plan-HVAC-L4.dwg", targetMode: "view_then_sheet", viewId: 1545001, sheetViewId: 1543141, sheetNumber: "M107", placeOnSheet: true, canPlaceViewport: true } },
    "/revit/link-cad:2": {
      status: "Success",
      mode: "link",
      targetMode: "view_then_sheet",
      viewId: 1545001,
      ownerViewId: 1545001,
      viewType: "DraftingView",
      sheetViewId: 1543141,
      sheetNumber: "M107",
      viewportId: 1545003,
      viewportBox: { minU: -1.2, minV: -0.6, maxU: 1.2, maxV: 0.6 },
      elementBoundingBoxInOwnerView: { min: { x: -0.5, y: -0.25, z: 0 }, max: { x: 0.5, y: 0.25, z: 0 } },
      elementId: 1545002,
      sourcePath: "artifacts/cad/Snowdon-M104-Plan-HVAC-L4.dwg",
      cadCategories: [{ categoryId: 1545004, categoryName: "M104-FUTURE", depth: 1 }]
    },
    "/revit/visibility:3": { status: "Dry Run", dryRun: true, action: "set_detail_level", input: { viewId: 8252, detailLevel: "Fine" } },
    "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
    "/revit/visibility:5": { status: "Dry Run", dryRun: true, action: "set_category_override", input: { viewId: 1545001, categoryName: "M104-FUTURE", lineWeight: 5 } },
    "/revit/visibility:6": { status: "Success", action: "set_category_override", viewId: 1545001, view: { id: 1545001, categoryOverrides: [{ categoryName: "M104-FUTURE", lineWeight: 5 }] } },
    "/revit/create-text": { status: "success", id: 8381, viewId: 1543141 },
    "/revit/export-image": { status: "Captured", viewId: 1543141, path: "artifacts/captures/m107-cad-after.png" },
    "/revit/delete:1": { status: "Dry Run", count: 10, ids: [8401, 8381, 8351, 1545002, 8301, 1545003, 8101, 8251, 8252, 1545001] },
    "/revit/delete:2": { status: "Deleted", count: 10, ids: [8401, 8381, 8351, 1545002, 8301, 1545003, 8101, 8251, 8252, 1545001] }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors", fields: ["Family and Type"] },
        configureSchedule: { addFields: ["Count"] },
        existingSheet: { sheetNumber: "M107", sheetName: "Plan HVAC L4 CAD", createIfMissing: true },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View", scale: 100 },
        viewTemplate: { name: "Operator Demo View Template" },
        placeView: { x: 1.5, y: 1.0 },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 8251, elementIds: [301], onlyUntagged: false },
        cadLink: { sourcePath: "artifacts/cad/Snowdon-M104-Plan-HVAC-L4.dwg", placement: "center", customScale: 1, link: true },
        cadGraphicsOverride: { layerOrSubcategoryName: "M104-FUTURE", lineWeight: 5 },
        cleanupCreatedElements: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  const sheetRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "sheet");
  assert.equal(sheetRow?.existing, true);
  assert.equal(sheetRow?.createdIfMissing, true);
  assert.equal(summary.sheetId, 1543141);
  assert.equal(summary.cadLinkTargetId, 1545002);
  assert.equal(summary.cadLinkViewportId, 1545003);
  assert.equal(summary.appliedCadCategoryName, "M104-FUTURE");
  assert.equal(summary.appliedCadLineWeight, 5);
  assert.equal(summary.cleanupDryRunIds.includes(1543141), false);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/sheets"), true);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/create-sheet"), true);
});

test("documentation primitives workflow fails when schedule apply returns no id", async () => {
  const dir = tempDir("documentation-primitives-no-schedule-id");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", created: true },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/configure-schedule:2": { status: "Success" },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251 },
      "/revit/draw-detail-curves:2": { status: "Success", detailCurveIds: [8351] },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", viewId: 8201 },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_created_id_present" && !entry.ok), true);
  assert.match(result.failure_reason ?? "", /Documentation primitives/i);
});

test("documentation primitives workflow rejects schedule configuration applied to the wrong schedule", async () => {
  const dir = tempDir("documentation-primitives-config-wrong-schedule");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 9999, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_target_matches_created_schedule" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.scheduleId, 8101);
  assert.equal(summary.configuredScheduleId, 9999);
});

test("documentation primitives workflow rejects generic schedule configuration success without operation proof", async () => {
  const dir = tempDir("documentation-primitives-config-no-operation-proof");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: {
          name: "Operator Demo Door Schedule",
          category: "OST_Doors",
          fields: ["Family and Type", "Count"]
        },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: {
          curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }]
        },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, changed: true },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_created_field_count_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_target_matches_created_schedule" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_operations_match_request" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.scheduleId, 8101);
  assert.equal(summary.configuredScheduleId, 8101);
});

test("documentation primitives workflow rejects schedule field count without requested field names", async () => {
  const dir = tempDir("documentation-primitives-wrong-schedule-fields");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: {
          name: "Operator Demo Door Schedule",
          category: "OST_Doors",
          fields: ["Family and Type", "Count"]
        },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: {
          curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }]
        },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/schedules": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 2 }, fields: [{ name: "Type Mark" }, { name: "Level" }] },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_created_field_count_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_created_fields_match_request" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.deepEqual(summary.createdScheduleFieldNames, ["type mark", "level"]);
});

test("documentation primitives workflow rejects configured schedule add field proof for the wrong field", async () => {
  const dir = tempDir("documentation-primitives-config-wrong-add-field");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors", fields: ["Family and Type"] },
        configureSchedule: { addFields: ["Count"], showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 1 } },
      "/revit/schedules:1": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 1 }, fields: [{ name: "Family and Type" }] },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { addFields: [{ field: "Type Mark", status: "Added" }], sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/schedules:2": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 2 }, fields: [{ name: "Family and Type" }, { name: "Type Mark" }] },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_created_fields_match_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_operations_match_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_fields_match_request" && !entry.ok), true);
});

test("documentation primitives workflow rejects schedule sort proof for the wrong field", async () => {
  const dir = tempDir("documentation-primitives-config-wrong-sort-field");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: {
          name: "Operator Demo Door Schedule",
          category: "OST_Doors",
          fields: ["Family and Type", "Count"]
        },
        configureSchedule: {
          sortGroup: [{ field: "Family and Type", ascending: true, showHeader: true }],
          showGrandTotals: false
        },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: {
          curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }]
        },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ field: "Count", status: "Applied", ascending: true, showHeader: true }, { setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_target_matches_created_schedule" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_operations_match_request" && !entry.ok), true);
});

test("documentation primitives workflow rejects schedule filter proof for the wrong value", async () => {
  const dir = tempDir("documentation-primitives-config-wrong-filter-value");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: {
          name: "Operator Demo Door Schedule",
          category: "OST_Doors",
          fields: ["Family and Type"]
        },
        configureSchedule: {
          filters: [{ field: "Family and Type", op: "begins_with", value: "OPERATOR-BENCHMARK-NO-MATCH" }],
          showGrandTotals: false
        },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: {
          curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }]
        },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 1 } },
      "/revit/schedules:1": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 1 }, fields: [{ name: "Family and Type" }] },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": {
        status: "Success",
        scheduleId: 8101,
        applied: {
          filters: [{ field: "Family and Type", status: "Applied", op: "begins_with", value: "SOME-OTHER-VALUE" }],
          sortGroup: [{ setting: "showGrandTotals", value: false }]
        }
      },
      "/revit/schedules:2": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 1 }, fields: [{ name: "Family and Type" }] },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_target_matches_created_schedule" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_operations_match_request" && !entry.ok), true);
});

test("documentation primitives workflow rejects schedule column width proof for the wrong width", async () => {
  const dir = tempDir("documentation-primitives-config-wrong-column-width");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: {
          name: "Operator Demo Door Schedule",
          category: "OST_Doors",
          fields: ["Family and Type"]
        },
        configureSchedule: {
          columnWidths: [{ field: "Family and Type", widthFeet: 0.85 }],
          showGrandTotals: false
        },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: {
          curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }]
        },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 1 } },
      "/revit/schedules:1": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 1 }, fields: [{ name: "Family and Type" }] },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": {
        status: "Success",
        scheduleId: 8101,
        applied: {
          columnWidths: [{ field: "Family and Type", status: "Applied", widthFeet: 0.25, appliedTo: { grid: true, sheet: true } }],
          sortGroup: [{ setting: "showGrandTotals", value: false }]
        }
      },
      "/revit/schedules:2": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 1 }, fields: [{ name: "Family and Type" }] },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_target_matches_created_schedule" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_operations_match_request" && !entry.ok), true);
});

test("documentation primitives workflow rejects placed viewport evidence for the wrong sheet or view", async () => {
  const dir = tempDir("documentation-primitives-place-view-wrong-target");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: {
          name: "Operator Demo Door Schedule",
          category: "OST_Doors",
          fields: ["Family and Type", "Count"]
        },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        placeView: { x: 1.5, y: 1.0 },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 9991, viewId: 9992 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "view_placed_on_sheet" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "view_placed_targets_match_request" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  const placeViewRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "place_view");
  assert.equal(placeViewRow?.expectedSheetId, 8201);
  assert.equal(placeViewRow?.expectedViewId, 8251);
  assert.equal(placeViewRow?.reportedSheetId, 9991);
  assert.equal(placeViewRow?.reportedViewId, 9992);
});

test("documentation primitives workflow rejects annotation evidence for the wrong target views", async () => {
  const dir = tempDir("documentation-primitives-annotation-wrong-targets");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: {
          name: "Operator Demo Door Schedule",
          category: "OST_Doors",
          fields: ["Family and Type", "Count"]
        },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        placeView: { x: 1.5, y: 1.0 },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 9991, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 9992 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "detail_curve_ids_created" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "detail_curves_target_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_created" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_target_matches_request" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  const detailCurveRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "detail_curves");
  const textNoteRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "text_note");
  assert.equal(detailCurveRow?.expectedViewId, 8251);
  assert.equal(detailCurveRow?.reportedViewId, 9991);
  assert.equal(textNoteRow?.expectedViewId, 8201);
  assert.equal(textNoteRow?.reportedViewId, 9992);
});

test("documentation primitives workflow rejects visibility applied to wrong view targets", async () => {
  const dir = tempDir("documentation-primitives-visibility-wrong-target");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        placeView: { x: 1.5, y: 1.0 },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 9991, view: { id: 9991, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 9992, view: { id: 9992, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "visibility_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "view_template_visibility_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "visibility_target_matches_created_view" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "view_template_visibility_target_matches_template" && !entry.ok), true);
});

test("documentation primitives workflow rejects text note readback with wrong text", async () => {
  const dir = tempDir("documentation-primitives-text-note-wrong-text");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "Success", id: 8381, viewId: 8201, text: "Wrong annotation text" },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_created" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_target_matches_request" && !entry.ok), true);
});

test("documentation primitives workflow rejects text note readback with wrong type", async () => {
  const dir = tempDir("documentation-primitives-text-note-wrong-type");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation", typeId: 7001 },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "Success", id: 8381, viewId: 8201, text: "Operator demo annotation", textType: { id: 7002, name: "Wrong Type" } },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_created" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_target_matches_request" && !entry.ok), true);
});

test("documentation primitives workflow rejects required text note readback without returned text", async () => {
  const dir = tempDir("documentation-primitives-text-note-required-readback-missing-text");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation", readbackRequired: true },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "Success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_created" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_target_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_readback_matches_request" && !entry.ok), true);
});

test("documentation primitives workflow rejects generic visibility success without applied setting proof", async () => {
  const dir = tempDir("documentation-primitives-visibility-no-setting-proof");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251 },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252 },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "visibility_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "visibility_target_matches_created_view" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "visibility_applied_setting_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "view_template_visibility_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "view_template_visibility_target_matches_template" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "view_template_visibility_applied_setting_matches_request" && !entry.ok), true);
});

test("documentation primitives workflow rejects category override success without requested lineweight proof", async () => {
  const dir = tempDir("documentation-primitives-category-override-wrong-lineweight");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        categoryVisibility: { action: "set_category_override", categoryName: "Lines", lineWeight: 5, readbackRequired: true, revertAfterVerify: true },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true, action: "set_category_override", input: { viewId: 8251, categoryName: "Lines", lineWeight: 5 } },
      "/revit/visibility:4": { status: "Success", action: "set_category_override", viewId: 8251, view: { id: 8251, categoryOverride: { categoryName: "Lines", lineWeight: 3 } } },
      "/revit/visibility:5": { status: "Dry Run", dryRun: true },
      "/revit/visibility:6": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "category_visibility_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "category_visibility_target_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "category_visibility_applied_override_matches_request" && !entry.ok), true);
});

test("documentation primitives workflow supports graphics-only category override with revert", async () => {
  const dir = tempDir("documentation-primitives-graphics-only-category");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        graphicsOnly: true,
        viewId: 8251,
        visualViewId: 8251,
        visualVerify: true,
        cleanupCreatedElements: true,
        categoryVisibility: {
          action: "set_category_override",
          viewId: 8251,
          categoryName: "Lines",
          lineWeight: 5,
          readbackRequired: true,
          revertAfterVerify: true
        }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/visibility:1": { status: "Dry Run", dryRun: true, action: "set_category_override", input: { viewId: 8251, categoryName: "Lines", lineWeight: 5 } },
      "/revit/visibility:2": { status: "Success", action: "set_category_override", viewId: 8251, view: { id: 8251, categoryOverride: { categoryName: "Lines", lineWeight: 5 } } },
      "/revit/export-image": { status: "Captured", viewId: 8251, path: "artifacts/captures/graphics-only-after.png", width: 1600, height: 900 },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true, action: "clear_category_override", input: { viewId: 8251, categoryName: "Lines" } },
      "/revit/visibility:4": { status: "Success", action: "clear_category_override", viewId: 8251, view: { id: 8251, categoryOverrideCleared: { categoryName: "Lines" } } }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "category_visibility_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "category_visibility_post_apply_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "category_visibility_revert_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_final_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_post_change_capture_targets_created_context" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_request_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_dry_run_ok"), false);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_cleanup_dry_run_ok" && entry.ok), true);
});

test("documentation primitives workflow supports graphics-only view filter creation override and cleanup", async () => {
  const dir = tempDir("documentation-primitives-graphics-only-filter");
  const bridge = new MockBridgeTransport({
    "/revit/visibility:1": { status: "Dry Run", dryRun: true, action: "create_view_filter", input: { viewId: 8251, filterName: "Operator Demo Future Work-R01", categoryName: "OST_DuctCurves", ruleParameterName: "Comments", ruleOperator: "contains", ruleValue: "OPERATOR-REDLINE-NO-MATCH", lineWeight: 5 } },
    "/revit/visibility:2": { status: "Success", action: "create_view_filter", viewId: 8251, view: { id: 8251, viewFilters: [{ id: 8501, name: "Operator Demo Future Work-R01", visible: true, override: { lineWeight: 5 } }] } },
    "/revit/visibility:3": { status: "Dry Run", dryRun: true, action: "apply_view_filter", input: { viewId: 8251, filterName: "Operator Demo Future Work-R01", filterId: 8501, filterVisible: true, lineWeight: 5 } },
    "/revit/visibility:4": { status: "Success", action: "apply_view_filter", viewId: 8251, view: { id: 8251, viewFilters: [{ id: 8501, name: "Operator Demo Future Work-R01", visible: true, override: { lineWeight: 5 } }] } },
    "/revit/export-image:1": { status: "Captured", viewId: 8251, path: "artifacts/captures/graphics-only-filter-applied.png", width: 1600, height: 900 },
    "/revit/visibility:5": { status: "Dry Run", dryRun: true, action: "clear_filter_override", input: { viewId: 8251, filterName: "Operator Demo Future Work-R01", filterId: 8501 } },
    "/revit/visibility:6": { status: "Success", action: "clear_filter_override", viewId: 8251, view: { id: 8251, viewFilters: [{ id: 8501, name: "Operator Demo Future Work-R01", visible: true, override: { lineWeight: null, linePatternId: null, linePatternName: null, color: null } }] } },
    "/revit/export-image:2": { status: "Captured", viewId: 8251, path: "artifacts/captures/graphics-only-filter-post.png", width: 1600, height: 900 },
    "/revit/export-image:3": { status: "Captured", viewId: 8251, path: "artifacts/captures/graphics-only-filter-final.png", width: 1600, height: 900 },
    "/revit/delete:1": { status: "Dry Run", count: 1, ids: [8501] },
    "/revit/delete:2": { status: "Deleted", count: 1, ids: [8501] }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        graphicsOnly: true,
        viewId: 8251,
        visualViewId: 8251,
        visualVerify: true,
        cleanupCreatedElements: true,
        filterVisibility: {
          action: "apply_view_filter",
          viewId: 8251,
          filterName: "Operator Demo Future Work",
          filterVisible: true,
          lineWeight: 5,
          readbackRequired: true,
          revertAfterVerify: true,
          createFilter: {
            categoryName: "OST_DuctCurves",
            ruleParameterName: "Comments",
            ruleOperator: "contains",
            ruleValue: "OPERATOR-REDLINE-NO-MATCH"
          }
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "filter_visibility_create_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "filter_visibility_created_filter_id_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "filter_visibility_applied_override_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "filter_visibility_revert_cleared_override" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_cleanup_applied_ids_present" && entry.ok), true);
  const applyCall = bridge.calls.find((call) => call.pathname === "/revit/visibility" && (call.body as Record<string, unknown>).action === "apply_view_filter" && (call.body as Record<string, unknown>).dryRun === false);
  assert.equal((applyCall?.body as Record<string, unknown> | undefined)?.filterId, 8501);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.createdFilterId, 8501);
  assert.equal(summary.requestedFilterName, "Operator Demo Future Work-R01");
  assert.equal(summary.appliedFilterName, "Operator Demo Future Work-R01");
  assert.equal(summary.filterVisibilityRevertStatus, "Success");
});

test("documentation primitives workflow rejects view template category override success without requested lineweight proof", async () => {
  const dir = tempDir("documentation-primitives-template-category-override-wrong-lineweight");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateCategoryVisibility: { action: "set_category_override", categoryName: "Lines", lineWeight: 5 },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/visibility:5": { status: "Dry Run", dryRun: true, action: "set_category_override", input: { viewId: 8252, categoryName: "Lines", lineWeight: 5 } },
      "/revit/visibility:6": { status: "Success", action: "set_category_override", viewId: 8252, view: { id: 8252, categoryOverride: { categoryName: "Lines", lineWeight: 3 } } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "view_template_category_visibility_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "view_template_category_visibility_target_matches_template" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "view_template_category_visibility_applied_override_matches_request" && !entry.ok), true);
});

test("documentation primitives workflow rejects filter override success without requested lineweight proof", async () => {
  const dir = tempDir("documentation-primitives-filter-override-wrong-lineweight");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        filterVisibility: { action: "apply_view_filter", filterId: 8501, filterName: "Operator Demo Future Work", filterVisible: true, lineWeight: 5, readbackRequired: true, revertAfterVerify: true },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true, action: "apply_view_filter", input: { viewId: 8251, filterName: "Operator Demo Future Work", filterVisible: true, lineWeight: 5 } },
      "/revit/visibility:4": { status: "Success", action: "apply_view_filter", viewId: 8251, view: { id: 8251, viewFilters: [{ id: 8501, name: "Operator Demo Future Work", visible: true, override: { lineWeight: 3 } }] } },
      "/revit/visibility:5": { status: "Dry Run", dryRun: true },
      "/revit/visibility:6": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "filter_visibility_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "filter_visibility_target_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "filter_visibility_applied_override_matches_request" && !entry.ok), true);
});

test("documentation primitives workflow rejects tag success without applied target proof", async () => {
  const dir = tempDir("documentation-primitives-tag-no-target-proof");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors", fields: ["Family and Type", "Count"] },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 0, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_dry_run_targets_match_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_ids_created" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_applied_targets_match_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_created_count_matches_request" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  const tagRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "tag");
  assert.equal(tagRow?.requestedTargetCount, 1);
  assert.equal(tagRow?.appliedTargetCount, 0);
});

test("documentation primitives workflow rejects tag readback for wrong target and value", async () => {
  const dir = tempDir("documentation-primitives-tag-bad-readback");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors", fields: ["Family and Type", "Count"] },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: {
          viewId: 401,
          elementIds: [301, 302],
          onlyUntagged: false,
          readbackRequired: true,
          tagTypeId: 7001,
          requestedTagValueHint: "EF-2"
        },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": {
        status: "Dry Run",
        dryRun: true,
        viewId: 401,
        targetCount: 2,
        plannedToTag: 2,
        targets: [
          { elementId: 301, category: "Mechanical Equipment", alreadyTagged: false },
          { elementId: 302, category: "Mechanical Equipment", alreadyTagged: false }
        ]
      },
      "/revit/tag-elements:2": {
        status: "Success",
        viewId: 401,
        targetCount: 2,
        taggedCount: 2,
        errorCount: 0,
        tagIds: [8401, 8402],
        tagReadback: [
          { tagId: 8401, targetElementId: 301, tagTypeId: 7001, value: "EF-2" },
          { tagId: 8402, targetElementId: 9999, tagTypeId: 7001, value: "EF-1" }
        ]
      },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 9, ids: [8401, 8402, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 9, ids: [8401, 8402, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_dry_run_targets_match_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_applied_targets_match_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_created_count_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_readback_matches_request" && !entry.ok), true);
});

test("documentation primitives workflow edits existing tag value through tagged element parameter with readback capture and revert", async () => {
  const dir = tempDir("documentation-primitives-tag-value-edit");
  const bridge = new MockBridgeTransport({
    "/revit/get-parameters:1": { items: [{ id: 301, parameters: { Mark: "EF-1" } }] },
    "/revit/export-visible-elements:1": { elements: [{ id: 9001, category: "Tags", visibleText: "EF-1" }] },
    "/revit/set-parameter:1": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 301, parameterName: "Mark", ok: true, changed: true, before: "EF-1", after: "EF-2" }] },
    "/revit/set-parameter:2": { status: "Applied", dryRun: false, changedCount: 1, changedElementIds: [301], diffs: [{ elementId: 301, parameterName: "Mark", ok: true, changed: true, before: "EF-1", after: "EF-2" }] },
    "/revit/get-parameters:2": { items: [{ id: 301, parameters: { Mark: "EF-2" } }] },
    "/revit/export-visible-elements:2": { elements: [{ id: 9001, category: "Tags", visibleText: "EF-2" }] },
    "/revit/export-image": { status: "Captured", viewId: 401, path: "artifacts/captures/tag-value-after.png", width: 1200, height: 800 },
    "/revit/set-parameter:3": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 301, parameterName: "Mark", ok: true, changed: true, before: "EF-2", after: "EF-1" }] },
    "/revit/set-parameter:4": { status: "Applied", dryRun: false, changedCount: 1, changedElementIds: [301], diffs: [{ elementId: 301, parameterName: "Mark", ok: true, changed: true, before: "EF-2", after: "EF-1" }] },
    "/revit/get-parameters:3": { items: [{ id: 301, parameters: { Mark: "EF-1" } }] },
    "/revit/export-visible-elements:3": { elements: [{ id: 9001, category: "Tags", visibleText: "EF-1" }] }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 401,
        visualViewId: 401,
        visualVerify: true,
        cleanupCreatedElements: true,
        tag: {
          editExistingValue: true,
          viewId: 401,
          existingTagIds: [9001],
          elementIds: [301],
          valueSourceParameterName: "Mark",
          expectedExistingValue: "EF-1",
          requestedTagValueHint: "EF-2",
          readbackRequired: true,
          revertAfterVerify: true
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/tag-elements"), false);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/set-parameter").length, 4);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_value_visible_readback_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_value_revert_visible_readback_matches_original" && entry.ok), true);
  const tagSetCalls = bridge.calls.filter((call) => call.pathname === "/revit/set-parameter");
  assert.deepEqual(tagSetCalls.map((call) => ((call.body as any).changes[0]).expectedOldValue), ["EF-1", "EF-1", "EF-2", "EF-2"]);
});

test("documentation primitives workflow edits composite visible tag text through one source parameter", async () => {
  const dir = tempDir("documentation-primitives-composite-tag-value-edit");
  const bridge = new MockBridgeTransport({
    "/revit/get-parameters:1": { items: [{ id: 301, parameters: { Name: "Exit Lobby" } }] },
    "/revit/export-visible-elements:1": { elements: [{ id: 9001, category: "Space Tags", visibleText: "Exit Lobby100" }] },
    "/revit/set-parameter:1": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 301, parameterName: "Name", ok: true, changed: true, before: "Exit Lobby", after: "Exit Lobby QA" }] },
    "/revit/set-parameter:2": { status: "Applied", dryRun: false, changedCount: 1, changedElementIds: [301], diffs: [{ elementId: 301, parameterName: "Name", ok: true, changed: true, before: "Exit Lobby", after: "Exit Lobby QA" }] },
    "/revit/get-parameters:2": { items: [{ id: 301, parameters: { Name: "Exit Lobby QA" } }] },
    "/revit/export-visible-elements:2": { elements: [{ id: 9001, category: "Space Tags", visibleText: "Exit Lobby QA100" }] },
    "/revit/export-image": { status: "Captured", viewId: 401, path: "artifacts/captures/composite-tag-value-after.png", width: 1200, height: 800 },
    "/revit/set-parameter:3": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 301, parameterName: "Name", ok: true, changed: true, before: "Exit Lobby QA", after: "Exit Lobby" }] },
    "/revit/set-parameter:4": { status: "Applied", dryRun: false, changedCount: 1, changedElementIds: [301], diffs: [{ elementId: 301, parameterName: "Name", ok: true, changed: true, before: "Exit Lobby QA", after: "Exit Lobby" }] },
    "/revit/get-parameters:3": { items: [{ id: 301, parameters: { Name: "Exit Lobby" } }] },
    "/revit/export-visible-elements:3": { elements: [{ id: 9001, category: "Space Tags", visibleText: "Exit Lobby100" }] }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 401,
        visualViewId: 401,
        visualVerify: true,
        cleanupCreatedElements: true,
        tag: {
          editExistingValue: true,
          viewId: 401,
          existingTagIds: [9001],
          elementIds: [301],
          valueSourceParameterName: "Name",
          expectedExistingValue: "Exit Lobby",
          expectedExistingVisibleText: "Exit Lobby100",
          requestedTagValueHint: "Exit Lobby QA",
          requestedVisibleText: "Exit Lobby QA100",
          readbackRequired: true,
          revertAfterVerify: true
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_value_parameter_readback_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_value_visible_readback_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_value_revert_visible_readback_matches_original" && entry.ok), true);
});

test("documentation primitives workflow rejects existing tag value edit without visible tag readback on same tag id", async () => {
  const dir = tempDir("documentation-primitives-tag-value-edit-bad-readback");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 401,
        visualViewId: 401,
        visualVerify: true,
        cleanupCreatedElements: true,
        tag: {
          editExistingValue: true,
          viewId: 401,
          existingTagIds: [9001],
          elementIds: [301],
          valueSourceParameterName: "Mark",
          expectedExistingValue: "EF-1",
          requestedTagValueHint: "EF-2",
          readbackRequired: true,
          revertAfterVerify: true
        }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/get-parameters:1": { items: [{ id: 301, parameters: { Mark: "EF-1" } }] },
      "/revit/export-visible-elements:1": { elements: [{ id: 9001, category: "Tags", visibleText: "EF-1" }] },
      "/revit/set-parameter:1": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 301, parameterName: "Mark", ok: true, changed: true }] },
      "/revit/set-parameter:2": { status: "Applied", dryRun: false, changedCount: 1, diffs: [{ elementId: 301, parameterName: "Mark", ok: true, changed: true }] },
      "/revit/get-parameters:2": { items: [{ id: 301, parameters: { Mark: "EF-2" } }] },
      "/revit/export-visible-elements:2": { elements: [{ id: 9999, category: "Tags", visibleText: "EF-2" }] },
      "/revit/export-image": { status: "Captured", viewId: 401, path: "artifacts/captures/tag-value-after.png", width: 1200, height: 800 },
      "/revit/set-parameter:3": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 301, parameterName: "Mark", ok: true, changed: true }] },
      "/revit/set-parameter:4": { status: "Applied", dryRun: false, changedCount: 1, diffs: [{ elementId: 301, parameterName: "Mark", ok: true, changed: true }] },
      "/revit/get-parameters:3": { items: [{ id: 301, parameters: { Mark: "EF-1" } }] },
      "/revit/export-visible-elements:3": { elements: [{ id: 9001, category: "Tags", visibleText: "EF-1" }] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_value_visible_readback_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_value_revert_visible_readback_matches_original" && entry.ok), true);
});

test("documentation primitives workflow rejects partial multi-target tag creation", async () => {
  const dir = tempDir("documentation-primitives-tag-partial-created-count");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors", fields: ["Family and Type", "Count"] },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301, 302], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": {
        status: "Dry Run",
        dryRun: true,
        viewId: 401,
        targetCount: 2,
        plannedToTag: 2,
        targets: [
          { elementId: 301, category: "Mechanical Equipment", alreadyTagged: false },
          { elementId: 302, category: "Mechanical Equipment", alreadyTagged: false }
        ]
      },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 2, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_dry_run_targets_match_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_created_count_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_ids_created" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  const tagRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "tag");
  assert.equal(tagRow?.requestedTargetIds, "301;302");
  assert.equal(tagRow?.dryRunTargetIds, "301;302");
  assert.equal(tagRow?.appliedTagIds, "8401");
});

test("documentation primitives workflow accepts native nested ids and delete impacted ids", async () => {
  const dir = tempDir("documentation-primitives-native-shaped-ids");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors", fields: ["Family and Type", "Count"] },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        placeView: { x: 1.5, y: 1.0 },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/schedules": { status: "Ok", action: "detail", schedule: { id: 8101, fieldCount: 2 }, fields: [{ name: "Family and Type" }, { name: "Count" }] },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, schedule: { id: 8101 } },
      "/revit/configure-schedule:2": { status: "Success", schedule: { id: 8101, fieldCount: 2 }, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", requestedCount: 8, requestedIds: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252], impactedIds: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", requestedCount: 8, requestedIds: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252], impactedIds: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_config_target_matches_created_schedule",
    "visibility_target_matches_created_view",
    "visibility_applied_setting_matches_request",
    "view_template_visibility_target_matches_template",
    "view_template_visibility_applied_setting_matches_request",
    "documentation_cleanup_dry_run_ok",
    "documentation_cleanup_applied_ids_present"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
});

test("documentation primitives workflow rejects requestedIds-only cleanup proof", async () => {
  const dir = tempDir("documentation-primitives-requested-only-cleanup");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors", fields: ["Family and Type", "Count"] },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        placeView: { x: 1.5, y: 1.0 },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", requestedCount: 8, requestedIds: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", requestedCount: 8, requestedIds: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_cleanup_dry_run_ok" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_cleanup_applied_ids_present" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.deepEqual(summary.cleanupDryRunIds, []);
  assert.deepEqual(summary.cleanupDeletedIds, []);
});

test("documentation primitives workflow rejects missing annotation and tag ids", async () => {
  const dir = tempDir("documentation-primitives-missing-annotation-ids");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301, 302], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 2, plannedToTag: 2, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }, { elementId: 302, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 2, taggedCount: 2, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 5, ids: [8401, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 5, ids: [8401, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "detail_curve_ids_created" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_created" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "tag_ids_created" && !entry.ok), true);
});

test("documentation primitives workflow blocks linked model graphics without readback and revert flags before writes", async () => {
  const dir = tempDir("documentation-primitives-linked-graphics-prewrite-block");
  const bridge = new MockBridgeTransport({});
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        linkedModelCategoryVisibility: {
          viewId: 8251,
          linkedModelName: "Snowdon Towers Sample Architectural.rvt",
          categoryName: "Plumbing Fixtures",
          lineWeight: 5
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.match(result.failure_reason ?? "", /blocked before Revit writes/);
  assert.match(result.failure_reason ?? "", /linkedModelCategoryVisibility requires readbackRequired:true/);
  assert.match(result.failure_reason ?? "", /linkedModelCategoryVisibility requires revertAfterVerify:true/);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_workflow_exception_caught" && !entry.ok), true);
  assert.equal(bridge.calls.length, 0);
});

test("documentation primitives workflow fails linked model graphics when native visibility blocks override", async () => {
  const dir = tempDir("documentation-primitives-linked-graphics-native-blocked");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        linkedModelCategoryVisibility: {
          action: "set_category_override",
          viewId: 8251,
          linkedModelName: "Snowdon Towers Sample Architectural.rvt",
          categoryName: "Plumbing Fixtures",
          lineWeight: 5,
          readbackRequired: true,
          revertAfterVerify: true
        }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, schedule: { fields: [{ name: "Family and Type" }, { name: "Count" }] } },
      "/revit/schedules": { status: "Success", scheduleId: 8101, fields: [{ name: "Family and Type" }, { name: "Count" }] },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { addFields: [], filters: [], sortGroup: [] }, schedule: { fields: [{ name: "Family and Type" }, { name: "Count" }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true, viewId: 8251 },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true, viewId: 8251 },
      "/revit/visibility:4": {
        status: "Blocked",
        blockCode: "linked_model_category_override_not_supported",
        viewId: 8251,
        message: "Linked model category override is not supported by this bridge."
      },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/visibility:5": { status: "Dry Run", dryRun: true, viewId: 8251 },
      "/revit/visibility:6": {
        status: "Blocked",
        blockCode: "linked_model_category_override_not_supported",
        viewId: 8251
      }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "linked_model_category_visibility_applied_success" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "linked_model_category_visibility_applied_override_matches_request" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  const linkedRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "linked_model_category_visibility");
  assert.equal(linkedRow?.id, 8251);
  assert.equal(linkedRow?.status, "Blocked");
  assert.equal(linkedRow?.requestedLinkedModelName, "Snowdon Towers Sample Architectural.rvt");
  assert.equal(linkedRow?.appliedLinkedModelName, "");
  assert.equal(linkedRow?.requestedCategoryName, "Plumbing Fixtures");
  assert.equal(linkedRow?.appliedCategoryName, "");
  assert.equal(linkedRow?.requestedLineWeight, 5);
  assert.equal(linkedRow?.appliedLineWeight, "");
});

test("documentation primitives workflow blocks phase graphics without original revert values before writes", async () => {
  const dir = tempDir("documentation-primitives-phase-graphics-prewrite-block");
  const bridge = new MockBridgeTransport({});
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        phaseVisibility: {
          viewId: 8251,
          phaseName: "New Construction",
          phaseFilterName: "Show Complete",
          readbackRequired: true,
          revertAfterVerify: true
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.match(result.failure_reason ?? "", /blocked before Revit writes/);
  assert.match(result.failure_reason ?? "", /originalPhaseName or originalPhaseId/);
  assert.match(result.failure_reason ?? "", /originalPhaseFilterName or originalPhaseFilterId/);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_workflow_exception_caught" && !entry.ok), true);
  assert.equal(bridge.calls.length, 0);
});

test("documentation primitives workflow blocks category and filter graphics without revert flags before writes", async () => {
  const dir = tempDir("documentation-primitives-filter-graphics-prewrite-block");
  const bridge = new MockBridgeTransport({});
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        categoryVisibility: {
          viewId: 8251,
          categoryName: "Lines",
          lineWeight: 5
        },
        filterVisibility: {
          viewId: 8251,
          filterName: "Operator Demo Future Work",
          filterVisible: true,
          lineWeight: 5
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.match(result.failure_reason ?? "", /blocked before Revit writes/);
  assert.match(result.failure_reason ?? "", /categoryVisibility requires readbackRequired:true/);
  assert.match(result.failure_reason ?? "", /categoryVisibility requires revertAfterVerify:true/);
  assert.match(result.failure_reason ?? "", /filterVisibility requires existing filterId or createFilter/);
  assert.match(result.failure_reason ?? "", /filterVisibility requires readbackRequired:true/);
  assert.match(result.failure_reason ?? "", /filterVisibility requires revertAfterVerify:true/);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_workflow_exception_caught" && !entry.ok), true);
  assert.equal(bridge.calls.length, 0);
});

test("documentation primitives workflow blocks existing schedule text edits without target proof before writes", async () => {
  const dir = tempDir("documentation-primitives-schedule-edit-prewrite-block");
  const bridge = new MockBridgeTransport({});
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 8101,
        visualViewId: 8101,
        visualVerify: true,
        cleanupCreatedElements: true,
        schedule: {
          useExisting: true,
          scheduleId: 8101,
          name: "RAT Schedule",
          category: "Mechanical Equipment",
          fields: ["Flow"]
        },
        configureSchedule: {
          requireExistingScheduleTarget: true,
          requestedTextOrValue: "400 CFM",
          readbackRequired: true
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.match(result.failure_reason ?? "", /blocked before Revit writes/);
  assert.match(result.failure_reason ?? "", /targetFieldName/);
  assert.match(result.failure_reason ?? "", /targetRowKey, targetRowIndex, or targetCellId/);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_workflow_exception_caught" && !entry.ok), true);
  assert.equal(bridge.calls.length, 0);
});

test("documentation primitives workflow synchronizes schedule remark marker with explanatory note", async () => {
  const dir = tempDir("documentation-primitives-schedule-remark-note");
  const afterCsv = path.join(dir, "schedule-after-note-marker.csv");
  const finalCsv = path.join(dir, "schedule-final-note-marker.csv");
  fs.writeFileSync(afterCsv, "Family and Type,Comments\nHeat Recovery Unit,NOTE 1\n");
  fs.writeFileSync(finalCsv, "Family and Type,Comments\nHeat Recovery Unit,\n");
  const bridge = new MockBridgeTransport({
    "/revit/get-parameters:1": { items: [{ id: 301, parameters: { Comments: "" } }] },
    "/revit/set-parameter:1": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 301, parameterName: "Comments", ok: true, changed: true, before: "", after: "NOTE 1" }] },
    "/revit/set-parameter:2": { status: "Applied", dryRun: false, changedCount: 1, changedElementIds: [301], diffs: [{ elementId: 301, parameterName: "Comments", ok: true, changed: true, before: "", after: "NOTE 1" }] },
    "/revit/get-parameters:2": { items: [{ id: 301, parameters: { Comments: "NOTE 1" } }] },
    "/revit/export-schedule-csv:1": { status: "Success", scheduleId: 8101, path: afterCsv },
    "/revit/create-text": { status: "Success", id: 8381, viewId: 8201, text: "NOTE 1: PROVIDE ACCESS CLEARANCE." },
    "/revit/set-parameter:3": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 301, parameterName: "Comments", ok: true, changed: true, before: "NOTE 1", after: "" }] },
    "/revit/set-parameter:4": { status: "Applied", dryRun: false, changedCount: 1, changedElementIds: [301], diffs: [{ elementId: 301, parameterName: "Comments", ok: true, changed: true, before: "NOTE 1", after: "" }] },
    "/revit/get-parameters:3": { items: [{ id: 301, parameters: { Comments: "" } }] },
    "/revit/export-schedule-csv:2": { status: "Success", scheduleId: 8101, path: finalCsv },
    "/revit/delete:1": { status: "Dry Run", ids: [8381], count: 1 },
    "/revit/delete:2": { status: "Deleted", ids: [8381], count: 1 }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 8201,
        visualViewId: 8201,
        cleanupCreatedElements: true,
        schedule: {
          editExistingValue: true,
          scheduleId: 8101,
          scheduleName: "Heat Recovery Unit Summary",
          elementId: 301,
          parameterName: "Comments",
          rowKey: "Heat Recovery Unit",
          expectedExistingValue: "",
          replacementValue: "NOTE 1",
          afterFileName: "schedule-after-note-marker.csv",
          finalFileName: "schedule-final-note-marker.csv"
        },
        textNote: {
          scheduleRemarkNote: true,
          viewId: 8201,
          x: 1.25,
          y: 4.5,
          remarkMarker: "NOTE 1",
          text: "NOTE 1: PROVIDE ACCESS CLEARANCE."
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_parameter_readback_matches_request",
    "schedule_csv_readback_matches_request",
    "schedule_remark_note_created",
    "schedule_remark_note_target_matches_request",
    "schedule_remark_marker_matches_note_reference",
    "schedule_revert_parameter_matches_original",
    "schedule_revert_csv_matches_original",
    "documentation_cleanup_dry_run_ok",
    "documentation_cleanup_applied_ids_present"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/set-parameter").length, 4);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/create-text").length, 1);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.scheduleRemarkNoteId, 8381);
  assert.deepEqual(summary.scheduleRemarkNoteCleanupDeletedIds, [8381]);
  assert.equal(summary.rows.some((row: { primitive?: string; markerValue?: string }) => row.primitive === "schedule_remark_note" && row.markerValue === "NOTE 1"), true);
});

test("documentation primitives workflow rejects schedule remark note that does not reference marker", async () => {
  const dir = tempDir("documentation-primitives-schedule-remark-note-bad-marker");
  const afterCsv = path.join(dir, "schedule-after-note-marker.csv");
  const finalCsv = path.join(dir, "schedule-final-note-marker.csv");
  fs.writeFileSync(afterCsv, "Family and Type,Comments\nHeat Recovery Unit,NOTE 1\n");
  fs.writeFileSync(finalCsv, "Family and Type,Comments\nHeat Recovery Unit,\n");

  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 8201,
        visualViewId: 8201,
        cleanupCreatedElements: true,
        schedule: {
          editExistingValue: true,
          scheduleId: 8101,
          scheduleName: "Heat Recovery Unit Summary",
          elementId: 301,
          parameterName: "Comments",
          rowKey: "Heat Recovery Unit",
          expectedExistingValue: "",
          replacementValue: "NOTE 1"
        },
        textNote: {
          scheduleRemarkNote: true,
          viewId: 8201,
          x: 1.25,
          y: 4.5,
          remarkMarker: "NOTE 1",
          text: "SEE GENERAL NOTES."
        }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/get-parameters:1": { items: [{ id: 301, parameters: { Comments: "" } }] },
      "/revit/set-parameter:1": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 301, parameterName: "Comments", ok: true, changed: true }] },
      "/revit/set-parameter:2": { status: "Applied", dryRun: false, changedCount: 1, changedElementIds: [301] },
      "/revit/get-parameters:2": { items: [{ id: 301, parameters: { Comments: "NOTE 1" } }] },
      "/revit/export-schedule-csv:1": { status: "Success", scheduleId: 8101, path: afterCsv },
      "/revit/create-text": { status: "Success", id: 8381, viewId: 8201, text: "SEE GENERAL NOTES." },
      "/revit/set-parameter:3": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 301, parameterName: "Comments", ok: true, changed: true }] },
      "/revit/set-parameter:4": { status: "Applied", dryRun: false, changedCount: 1, changedElementIds: [301] },
      "/revit/get-parameters:3": { items: [{ id: 301, parameters: { Comments: "" } }] },
      "/revit/export-schedule-csv:2": { status: "Success", scheduleId: 8101, path: finalCsv },
      "/revit/delete:1": { status: "Dry Run", ids: [8381], count: 1 },
      "/revit/delete:2": { status: "Deleted", ids: [8381], count: 1 }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_remark_marker_matches_note_reference" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_revert_parameter_matches_original" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_cleanup_applied_ids_present" && entry.ok), true);
});

test("documentation primitives workflow verifies schedule-only column width configure without unrelated checks", async () => {
  const dir = tempDir("documentation-primitives-schedule-column-width-only");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleName: "Operator Redline Column Width Schedule-R01"
    },
    "/revit/create-schedule:2": {
      status: "Created",
      viewId: 8101,
      scheduleId: 8101,
      scheduleName: "Operator Redline Column Width Schedule-R01",
      fieldCount: 1,
      fields: [{ name: "Family and Type" }]
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }]
    },
    "/revit/configure-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleId: 8101
    },
    "/revit/configure-schedule:2": {
      status: "Success",
      scheduleId: 8101,
      applied: {
        addFields: [],
        columnWidths: [{ status: "Applied", field: "Family and Type", widthFeet: 0.85, appliedTo: { grid: true, sheet: false } }]
      },
      schedule: {
        id: 8101,
        fields: [{ name: "Family and Type", widthFeet: 0.85 }]
      }
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type", widthFeet: 0.85 }]
    },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "schedule-column-width-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101], count: 1 },
    "/revit/delete:2": { status: "Deleted", ids: [8101], count: 1 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 1420963,
        visualViewId: 1420963,
        visualVerify: true,
        cleanupCreatedElements: true,
        schedule: {
          name: "Operator Redline Column Width Schedule",
          category: "OST_Doors",
          fields: ["Family and Type"]
        },
        configureSchedule: {
          addFields: [],
          replaceFilters: false,
          replaceSortGroup: false,
          columnWidths: [{ field: "Family and Type", widthFeet: 0.85 }]
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_dry_run_ok",
    "schedule_created_id_present",
    "schedule_created_fields_match_request",
    "schedule_config_dry_run_ok",
    "schedule_config_applied_success",
    "schedule_config_target_matches_created_schedule",
    "schedule_config_applied_operations_match_request",
    "schedule_config_fields_match_request",
    "documentation_post_change_capture_returned",
    "documentation_cleanup_dry_run_ok",
    "documentation_cleanup_applied_ids_present",
    "documentation_summary_written"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  for (const name of [
    "sheet_created_id_present",
    "tag_request_present",
    "cad_link_request_present",
    "category_visibility_dry_run_ok",
    "filter_visibility_dry_run_ok"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name), false, name);
  }
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.scheduleId, 8101);
  assert.equal(summary.configuredScheduleId, 8101);
  assert.deepEqual(summary.cleanupDeletedIds, [8101]);
  assert.equal(summary.rows.some((row: { primitive?: string }) => row.primitive === "configure_schedule"), true);
  assert.equal(summary.rows.some((row: { primitive?: string }) => row.primitive === "cleanup_documentation_primitives"), true);
});

test("documentation primitives workflow can seed and replace schedule filters", async () => {
  const dir = tempDir("documentation-primitives-schedule-replace-filter");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleName: "Operator Redline Replace Filter Schedule-R01"
    },
    "/revit/create-schedule:2": {
      status: "Created",
      viewId: 8101,
      scheduleId: 8101,
      scheduleName: "Operator Redline Replace Filter Schedule-R01",
      fieldCount: 2,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/configure-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleId: 8101,
      plan: { filters: [{ field: "Mark", op: "begins_with", value: "VAV-0-" }] }
    },
    "/revit/configure-schedule:2": {
      status: "Success",
      scheduleId: 8101,
      applied: {
        filters: [{ field: "Mark", status: "Applied", op: "begins_with", value: "VAV-0-" }]
      },
      schedule: { id: 8101, fields: [{ name: "Family and Type" }, { name: "Mark" }] }
    },
    "/revit/configure-schedule:3": {
      status: "Dry Run",
      dryRun: true,
      scheduleId: 8101,
      plan: { replaceFilters: true, filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }] }
    },
    "/revit/configure-schedule:4": {
      status: "Success",
      scheduleId: 8101,
      applied: {
        filters: [{ field: "Mark", status: "Applied", op: "begins_with", value: "VAV-1-" }]
      },
      schedule: { id: 8101, fields: [{ name: "Family and Type" }, { name: "Mark" }] }
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }],
      filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }]
    },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "schedule-replace-filter-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101], count: 1 },
    "/revit/delete:2": { status: "Deleted", ids: [8101], count: 1 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 1420963,
        visualViewId: 1420963,
        visualVerify: true,
        cleanupCreatedElements: true,
        schedule: {
          name: "Operator Redline Replace Filter Schedule",
          category: "OST_MechanicalEquipment",
          fields: ["Family and Type", "Mark"]
        },
        seedConfigureSchedule: {
          filters: [{ field: "Mark", op: "begins_with", value: "VAV-0-" }],
          replaceFilters: true
        },
        configureSchedule: {
          filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }],
          replaceFilters: true,
          replaceSortGroup: false
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_seed_config_dry_run_ok",
    "schedule_seed_config_applied_success",
    "schedule_seed_config_target_matches_created_schedule",
    "schedule_seed_config_applied_operations_match_request",
    "schedule_config_applied_operations_match_request",
    "documentation_post_change_capture_returned",
    "documentation_cleanup_applied_ids_present"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.rows.some((row: { primitive?: string }) => row.primitive === "seed_configure_schedule"), true);
});

test("documentation primitives workflow can place a schedule note below a placed schedule", async () => {
  const dir = tempDir("documentation-primitives-schedule-note-below");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleName: "Operator Redline Schedule Note-R01",
      placeOnSheet: { requested: true, target: { sheetId: 1420963, sheetNumber: "M000" }, x: 1, y: 8 }
    },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      scheduleId: 8101,
      scheduleName: "Operator Redline Schedule Note-R01",
      fieldCount: 2,
      fields: [{ name: "Family and Type" }, { name: "Count" }],
      placedOnSheet: {
        status: "Placed",
        scheduleSheetInstanceId: 8108,
        sheetId: 1420963,
        sheetNumber: "M000",
        x: 1,
        y: 8,
        boundingBox: { min: { x: 1, y: 7.25, z: 0 }, max: { x: 4, y: 8, z: 0 }, width: 3, height: 0.75 }
      }
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/configure-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleId: 8101,
      plan: { appearance: { showTitle: true } }
    },
    "/revit/configure-schedule:2": {
      status: "Success",
      scheduleId: 8101,
      applied: { appearance: [{ setting: "showTitle", status: "Applied", value: true, readback: true }] },
      schedule: { id: 8101, fields: [{ name: "Family and Type" }, { name: "Count" }] }
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/create-text": {
      status: "Success",
      id: 8381,
      textNoteId: 8381,
      viewId: 1420963,
      x: 1,
      y: 7,
      text: "NOTE 1: PROVIDE ACCESS CLEARANCE-R01"
    },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "schedule-note-below-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101, 8381], count: 2 },
    "/revit/delete:2": { status: "Deleted", ids: [8101, 8381], count: 2 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        visualVerify: true,
        cleanupCreatedElements: true,
        schedule: {
          name: "Operator Redline Schedule Note",
          category: "OST_Doors",
          fields: ["Family and Type", "Count"],
          placeOnSheet: { sheetId: 1420963, x: 1, y: 8 }
        },
        configureSchedule: {
          appearance: { showTitle: true }
        },
        textNote: {
          placeBelowSchedule: true,
          belowOffsetFeet: 0.25,
          text: "NOTE 1: PROVIDE ACCESS CLEARANCE"
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_created_placement_matches_request",
    "schedule_note_sheet_context_present",
    "schedule_note_created",
    "schedule_note_target_matches_request",
    "schedule_note_below_schedule_anchor",
    "documentation_post_change_capture_view_id_matches_request",
    "documentation_cleanup_applied_ids_present"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.scheduleNoteId, 8381);
  assert.equal(summary.rows.some((row: { primitive?: string }) => row.primitive === "schedule_note"), true);
});

test("documentation primitives workflow can reflow a schedule note with the schedule", async () => {
  const dir = tempDir("documentation-primitives-schedule-note-reflow");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleName: "Operator Redline Schedule Note-R01",
      placeOnSheet: { requested: true, target: { sheetId: 1420963, sheetNumber: "M000" }, x: 1, y: 8 }
    },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      scheduleId: 8101,
      scheduleName: "Operator Redline Schedule Note-R01",
      fieldCount: 2,
      fields: [{ name: "Family and Type" }, { name: "Count" }],
      placedOnSheet: {
        status: "Placed",
        scheduleSheetInstanceId: 8108,
        sheetId: 1420963,
        sheetNumber: "M000",
        x: 1,
        y: 8,
        boundingBox: { min: { x: 1, y: 7.25, z: 0 }, max: { x: 4, y: 8, z: 0 }, width: 3, height: 0.75 }
      }
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
    "/revit/configure-schedule:2": {
      status: "Success",
      scheduleId: 8101,
      applied: { appearance: [{ setting: "showTitle", status: "Applied", value: true, readback: true }] },
      schedule: { id: 8101, fields: [{ name: "Family and Type" }, { name: "Count" }] }
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/create-text": {
      status: "Success",
      id: 8381,
      textNoteId: 8381,
      viewId: 1420963,
      x: 1,
      y: 7,
      text: "NOTE 1: PROVIDE ACCESS CLEARANCE-R01"
    },
    "/revit/place-views:1": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8108, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 1, y: 6.5, placement: { strategy: "requested" } }
      ]
    },
    "/revit/place-views:2": {
      status: "Success",
      dryRun: false,
      requestedCount: 1,
      placedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8108, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 1, y: 6.5, placement: { strategy: "requested" } }
      ]
    },
    "/revit/move-elements:1": { status: "Dry Run", dryRun: true, movedIds: [8381], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:2": { status: "Moved", dryRun: false, movedIds: [8381], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "schedule-note-reflow-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101, 8381, 8108], count: 3 },
    "/revit/delete:2": { status: "Deleted", ids: [8101, 8381, 8108], count: 3 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        visualVerify: true,
        cleanupCreatedElements: true,
        schedule: {
          name: "Operator Redline Schedule Note",
          category: "OST_Doors",
          fields: ["Family and Type", "Count"],
          placeOnSheet: { sheetId: 1420963, x: 1, y: 8 }
        },
        configureSchedule: {
          appearance: { showTitle: true }
        },
        scheduleReflow: { x: 1, y: 6.5 },
        textNote: {
          placeBelowSchedule: true,
          reflowWithSchedule: true,
          belowOffsetFeet: 0.25,
          text: "NOTE 1: PROVIDE ACCESS CLEARANCE"
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_note_reflow_dry_run_ok",
    "schedule_note_reflow_move_existing_verified",
    "schedule_note_move_dry_run_ok",
    "schedule_note_move_applied_ids_present",
    "schedule_note_reflow_keeps_note_below_schedule",
    "documentation_cleanup_applied_ids_present"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.deepEqual(summary.scheduleNoteMovedIds, [8381]);
  assert.equal(summary.rows.some((row: { primitive?: string; action?: string }) => row.primitive === "schedule_note_reflow" && row.action === "MoveTextNoteWithSchedule"), true);
});

test("documentation primitives workflow can filter a schedule before reflowing its note", async () => {
  const dir = tempDir("documentation-primitives-filtered-schedule-note-reflow");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      placeOnSheet: { requested: true, target: { sheetId: 1420963 }, x: 1, y: 8 }
    },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      schedule: { id: 8101, name: "Operator Filtered Schedule Note-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Mark" }],
      placedOnSheet: {
        status: "Placed",
        scheduleSheetInstanceId: 8108,
        sheetId: 1420963,
        sheetNumber: "M000",
        x: 1,
        y: 8,
        boundingBox: { min: { x: 1, y: 7.2, z: 0 }, max: { x: 4, y: 8, z: 0 }, width: 3, height: 0.8 }
      }
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/configure-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleId: 8101,
      plan: { filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }] }
    },
    "/revit/configure-schedule:2": {
      status: "Success",
      scheduleId: 8101,
      applied: { filters: [{ field: "Mark", status: "Applied", op: "begins_with", value: "VAV-1-" }] },
      schedule: { id: 8101, fields: [{ name: "Family and Type" }, { name: "Mark" }] }
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }],
      filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }]
    },
    "/revit/create-text": {
      status: "Success",
      id: 8381,
      textNoteId: 8381,
      viewId: 1420963,
      x: 1,
      y: 6.95,
      text: "NOTE 1: LEVEL 1 VAV SCHEDULE ONLY-R01"
    },
    "/revit/find-text-notes:1": {
      ok: true,
      items: [
        {
          textNoteId: 8381,
          elementId: 8381,
          ownerViewId: 1420963,
          text: "NOTE 1: LEVEL 1 VAV SCHEDULE ONLY-R01",
          center: { x: 1.5, y: 6.95, z: 0 }
        }
      ]
    },
    "/revit/place-views:1": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8108, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 1, y: 6.5, placement: { strategy: "requested" } }
      ]
    },
    "/revit/place-views:2": {
      status: "Success",
      dryRun: false,
      requestedCount: 1,
      placedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8108, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 1, y: 6.5, placement: { strategy: "requested" } }
      ]
    },
    "/revit/move-elements:1": { status: "Dry Run", dryRun: true, movedIds: [8381], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:2": { status: "Moved", dryRun: false, movedIds: [8381], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "filtered-schedule-note-reflow-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101, 8381, 8108], count: 3 },
    "/revit/delete:2": { status: "Deleted", ids: [8101, 8381, 8108], count: 3 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        visualVerify: true,
        cleanupCreatedElements: true,
        schedule: {
          name: "Operator Filtered Schedule Note",
          category: "OST_MechanicalEquipment",
          fields: ["Family and Type", "Mark"],
          placeOnSheet: { sheetId: 1420963, x: 1, y: 8 }
        },
        configureSchedule: {
          replaceFilters: true,
          filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }]
        },
        scheduleReflow: { x: 1, y: 6.5 },
        textNote: {
          placeBelowSchedule: true,
          associateByText: true,
          reflowWithSchedule: true,
          belowOffsetFeet: 0.25,
          text: "NOTE 1: LEVEL 1 VAV SCHEDULE ONLY"
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_config_applied_operations_match_request",
    "schedule_note_association_find_by_text",
    "schedule_note_association_unique",
    "schedule_note_association_below_schedule",
    "schedule_note_reflow_dry_run_ok",
    "schedule_note_reflow_move_existing_verified",
    "schedule_note_move_applied_ids_present",
    "schedule_note_reflow_keeps_note_below_schedule",
    "documentation_cleanup_applied_ids_present"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const configureCalls = bridge.calls.filter((call) => call.pathname === "/revit/configure-schedule");
  assert.equal(configureCalls.length, 2);
  assert.deepEqual((configureCalls[1].body as { filters?: unknown }).filters, [{ field: "Mark", op: "begins_with", value: "VAV-1-" }]);
  const findCalls = bridge.calls.filter((call) => call.pathname === "/revit/find-text-notes");
  assert.equal(findCalls.length, 1);
  assert.deepEqual(findCalls[0]?.body, { viewId: 1420963, contains: "NOTE 1: LEVEL 1 VAV SCHEDULE ONLY-R01", max: 10 });
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  const configureRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "configure_schedule");
  assert.equal(configureRow.filters, "Mark begins_with VAV-1-");
  const noteRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "schedule_note");
  assert.equal(noteRow.association, "find-text-notes");
  assert.equal(noteRow.associatedId, 8381);
  assert.equal(summary.rows.some((row: { primitive?: string; action?: string }) => row.primitive === "schedule_note_reflow" && row.action === "MoveTextNoteWithSchedule"), true);
});

test("documentation primitives workflow can reflow an existing schedule note found by text", async () => {
  const dir = tempDir("documentation-primitives-existing-schedule-note-reflow");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      placeOnSheet: { requested: true, target: { sheetId: 1420963 }, x: 1, y: 8 }
    },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      schedule: { id: 8101, name: "Operator Existing Note Schedule-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Mark" }],
      placedOnSheet: {
        status: "Placed",
        scheduleSheetInstanceId: 8108,
        sheetId: 1420963,
        sheetNumber: "M000",
        x: 1,
        y: 8,
        boundingBox: { min: { x: 1, y: 7.2, z: 0 }, max: { x: 4, y: 8, z: 0 }, width: 3, height: 0.8 }
      }
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/configure-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleId: 8101,
      plan: { filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }] }
    },
    "/revit/configure-schedule:2": {
      status: "Success",
      scheduleId: 8101,
      applied: { filters: [{ field: "Mark", status: "Applied", op: "begins_with", value: "VAV-1-" }] },
      schedule: { id: 8101, fields: [{ name: "Family and Type" }, { name: "Mark" }] }
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }],
      filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }]
    },
    "/revit/find-text-notes:1": {
      ok: true,
      items: [
        {
          textNoteId: 8381,
          elementId: 8381,
          ownerViewId: 1420963,
          text: "NOTE 1: EXISTING LEVEL 1 VAV NOTE-R01",
          center: { x: 1.5, y: 6.95, z: 0 }
        }
      ]
    },
    "/revit/place-views:1": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8108, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 1, y: 6.5, placement: { strategy: "requested" } }
      ]
    },
    "/revit/place-views:2": {
      status: "Success",
      dryRun: false,
      requestedCount: 1,
      placedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8108, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 1, y: 6.5, placement: { strategy: "requested" } }
      ]
    },
    "/revit/move-elements:1": { status: "Dry Run", dryRun: true, movedIds: [8381], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:2": { status: "Moved", dryRun: false, movedIds: [8381], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "existing-schedule-note-reflow-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101, 8108], count: 2 },
    "/revit/delete:2": { status: "Deleted", ids: [8101, 8108], count: 2 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        visualVerify: true,
        cleanupCreatedElements: true,
        schedule: {
          name: "Operator Existing Note Schedule",
          category: "OST_MechanicalEquipment",
          fields: ["Family and Type", "Mark"],
          placeOnSheet: { sheetId: 1420963, x: 1, y: 8 }
        },
        configureSchedule: {
          replaceFilters: true,
          filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }]
        },
        scheduleReflow: { x: 1, y: 6.5 },
        textNote: {
          placeBelowSchedule: true,
          useExistingTextNote: true,
          reflowWithSchedule: true,
          belowOffsetFeet: 0.25,
          text: "NOTE 1: EXISTING LEVEL 1 VAV NOTE"
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_note_existing_found",
    "schedule_note_association_find_by_text",
    "schedule_note_association_unique",
    "schedule_note_reflow_dry_run_ok",
    "schedule_note_move_applied_ids_present",
    "schedule_note_reflow_keeps_note_below_schedule",
    "documentation_cleanup_applied_ids_present"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/create-text"), false);
  const findCalls = bridge.calls.filter((call) => call.pathname === "/revit/find-text-notes");
  assert.equal(findCalls.length, 1);
  assert.deepEqual(findCalls[0]?.body, { viewId: 1420963, contains: "NOTE 1: EXISTING LEVEL 1 VAV NOTE-R01", max: 10 });
  const deleteApply = bridge.calls.find((call) => call.pathname === "/revit/delete" && (call.body as { apply?: boolean }).apply === true);
  assert.ok(deleteApply);
  assert.deepEqual((deleteApply.body as { ids?: number[] }).ids, [8101, 8108]);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.deepEqual(summary.scheduleNoteMovedIds, [8381]);
  const noteRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "schedule_note");
  assert.equal(noteRow.existing, true);
  assert.equal(noteRow.association, "find-text-notes");
  assert.equal(noteRow.associatedId, 8381);
});

test("documentation primitives workflow can snap a drifting existing schedule note below measured schedule bounds", async () => {
  const dir = tempDir("documentation-primitives-existing-schedule-note-snap-below");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      placeOnSheet: { requested: true, target: { sheetId: 1420963 }, x: 1, y: 8 }
    },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      schedule: { id: 8101, name: "Operator Drifting Note Schedule-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Mark" }],
      placedOnSheet: {
        status: "Placed",
        scheduleSheetInstanceId: 8108,
        sheetId: 1420963,
        sheetNumber: "M000",
        x: 1,
        y: 8,
        boundingBox: { min: { x: 1, y: 7.2, z: 0 }, max: { x: 4, y: 8, z: 0 }, width: 3, height: 0.8 }
      }
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/configure-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleId: 8101,
      plan: { filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }] }
    },
    "/revit/configure-schedule:2": {
      status: "Success",
      scheduleId: 8101,
      applied: { filters: [{ field: "Mark", status: "Applied", op: "begins_with", value: "VAV-1-" }] },
      schedule: { id: 8101, fields: [{ name: "Family and Type" }, { name: "Mark" }] }
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }],
      filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }]
    },
    "/revit/find-text-notes:1": {
      ok: true,
      items: [
        {
          textNoteId: 8381,
          elementId: 8381,
          ownerViewId: 1420963,
          text: "NOTE 1: DRIFTING LEVEL 1 VAV NOTE-R01",
          center: { x: 1.5, y: 7.6, z: 0 }
        }
      ]
    },
    "/revit/place-views:1": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8108, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 1, y: 6.5, placement: { strategy: "requested" } }
      ]
    },
    "/revit/place-views:2": {
      status: "Success",
      dryRun: false,
      requestedCount: 1,
      placedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8108, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 1, y: 6.5, placement: { strategy: "requested" } }
      ]
    },
    "/revit/move-elements:1": { status: "Dry Run", dryRun: true, movedIds: [8381], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:2": { status: "Moved", dryRun: false, movedIds: [8381], skipped: [], warnings: [], rolledBack: false },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "existing-schedule-note-snap-below-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101, 8108], count: 2 },
    "/revit/delete:2": { status: "Deleted", ids: [8101, 8108], count: 2 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        visualVerify: true,
        cleanupCreatedElements: true,
        schedule: {
          name: "Operator Drifting Note Schedule",
          category: "OST_MechanicalEquipment",
          fields: ["Family and Type", "Mark"],
          placeOnSheet: { sheetId: 1420963, x: 1, y: 8 }
        },
        configureSchedule: {
          replaceFilters: true,
          filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }]
        },
        scheduleReflow: { x: 1, y: 6.5 },
        textNote: {
          placeBelowSchedule: true,
          useExistingTextNote: true,
          snapBelowSchedule: true,
          reflowWithSchedule: true,
          belowOffsetFeet: 0.25,
          x: 1.5,
          y: 7.6,
          text: "NOTE 1: DRIFTING LEVEL 1 VAV NOTE"
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_note_existing_found",
    "schedule_note_association_below_schedule",
    "schedule_note_below_schedule_anchor",
    "schedule_note_reflow_keeps_note_below_schedule",
    "schedule_note_reflow_snap_below_schedule"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const moveCalls = bridge.calls.filter((call) => call.pathname === "/revit/move-elements");
  assert.equal(moveCalls.length, 2);
  assert.equal((moveCalls[1]?.body as { vectorX?: number }).vectorX, 0);
  assert.equal(Math.abs(Number((moveCalls[1]?.body as { vectorY?: number }).vectorY) - -2.15) < 0.0001, true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  const reflowRow = summary.rows.find((row: { primitive?: string }) => row.primitive === "schedule_note_reflow");
  assert.equal(reflowRow.snapBelowSchedule, true);
  assert.equal(Math.abs(Number(reflowRow.targetNoteY) - 5.45) < 0.0001, true);
});

test("documentation primitives workflow can batch place schedules on a sheet", async () => {
  const dir = tempDir("documentation-primitives-schedule-batch-layout");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      schedule: { id: 8101, name: "Operator Layout Schedule 1-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/create-schedule:3": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:4": {
      status: "Success",
      viewId: 8102,
      schedule: { id: 8102, name: "Operator Layout Schedule 2-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8102,
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/place-views:1": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, placementType: "ScheduleSheetInstance", x: 1, y: 8, placement: { avoidOverlap: true, strategy: "requested" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, placementType: "ScheduleSheetInstance", x: 1, y: 7, placement: { avoidOverlap: true, strategy: "below-existing" } }
      ]
    },
    "/revit/place-views:2": {
      status: "Success",
      dryRun: false,
      requestedCount: 2,
      placedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8301, placementType: "ScheduleSheetInstance", action: "Create", x: 1, y: 8, placement: { avoidOverlap: true, strategy: "requested" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, scheduleSheetInstanceId: 8302, placementType: "ScheduleSheetInstance", action: "Create", x: 1, y: 7, placement: { avoidOverlap: true, strategy: "below-existing" } }
      ]
    },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "schedule-batch-layout-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101, 8102], count: 2 },
    "/revit/delete:2": { status: "Deleted", ids: [8101, 8102, 8301, 8302], count: 4 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 1420963,
        visualViewId: 1420963,
        visualVerify: true,
        cleanupCreatedElements: true,
        scheduleSheetLayout: {
          sheetId: 1420963,
          avoidOverlap: true
        },
        schedules: [
          {
            name: "Operator Layout Schedule 1",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Mark"],
            placement: { x: 1, y: 8 }
          },
          {
            name: "Operator Layout Schedule 2",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Count"]
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_batch_created_count_matches_request",
    "schedule_batch_place_dry_run_ok",
    "schedule_batch_place_applied_success",
    "schedule_batch_place_targets_match_request",
    "schedule_batch_avoid_overlap_plan_present",
    "documentation_post_change_capture_view_id_matches_request",
    "documentation_cleanup_applied_ids_present"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.scheduleBatchCount, 2);
  assert.equal(summary.rows.filter((row: { primitive?: string }) => row.primitive === "layout_schedule_placement").length, 2);
});

test("documentation primitives workflow can generate a right-anchored schedule stack plan", async () => {
  const dir = tempDir("documentation-primitives-schedule-stack-layout");
  const secondY = 8 - 0.5 - (1 / 12);
  const insertionX = 7.2 - 1.35;
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      schedule: { id: 8101, name: "Operator Stack Schedule 1-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/create-schedule:3": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:4": {
      status: "Success",
      viewId: 8102,
      schedule: { id: 8102, name: "Operator Stack Schedule 2-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8102,
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/place-views:1": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, placementType: "ScheduleSheetInstance", x: insertionX, y: 8, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, placementType: "ScheduleSheetInstance", x: insertionX, y: secondY, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } }
      ]
    },
    "/revit/place-views:2": {
      status: "Success",
      dryRun: false,
      requestedCount: 2,
      placedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8301, placementType: "ScheduleSheetInstance", action: "Create", x: insertionX, y: 8, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, scheduleSheetInstanceId: 8302, placementType: "ScheduleSheetInstance", action: "Create", x: insertionX, y: secondY, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } }
      ]
    },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "schedule-stack-layout-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101, 8102], count: 2 },
    "/revit/delete:2": { status: "Deleted", ids: [8101, 8102, 8301, 8302], count: 4 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 1420963,
        visualViewId: 1420963,
        visualVerify: true,
        cleanupCreatedElements: true,
        scheduleSheetLayout: {
          sheetId: 1420963,
          layoutPolicy: "right_justified_vertical_stack",
          rightX: 7.2,
          topY: 8,
          spacingFeet: 1 / 12,
          defaultScheduleHeightFeet: 0.5,
          defaultScheduleWidthFeet: 1.35
        },
        schedules: [
          {
            name: "Operator Stack Schedule 1",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Mark"]
          },
          {
            name: "Operator Stack Schedule 2",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Count"]
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_batch_stack_layout_policy_applied",
    "schedule_batch_stack_layout_spacing_verified",
    "schedule_batch_stack_layout_right_anchor_verified",
    "schedule_batch_stack_layout_applied_anchors_match_plan",
    "schedule_batch_avoid_overlap_plan_present",
    "documentation_cleanup_applied_ids_present"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const placeCalls = bridge.calls.filter((call) => call.pathname === "/revit/place-views");
  const requestedPlacements = placeCalls[0]?.body && Array.isArray((placeCalls[0].body as { placements?: unknown }).placements)
    ? (placeCalls[0].body as { placements: Array<Record<string, unknown>> }).placements
    : [];
  assert.equal(requestedPlacements.length, 2);
  assert.equal(requestedPlacements[0].x, insertionX);
  assert.equal(requestedPlacements[0].y, 8);
  assert.equal(requestedPlacements[1].x, insertionX);
  assert.equal(Math.abs(Number(requestedPlacements[1].y) - secondY) < 0.001, true);
  assert.equal(requestedPlacements.every((placement) => placement.avoidOverlap === true), true);
  assert.equal(requestedPlacements.every((placement) => Math.abs(Number(placement.x) + Number(placement.estimatedWidthFeet) - 7.2) < 0.001), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.stackLayoutPlan.layoutPolicy, "right_justified_vertical_stack");
  assert.equal(summary.stackLayoutPlan.spacingFeet, 1 / 12);
});

test("documentation primitives workflow can plan a blank schedule sheet pack", async () => {
  const dir = tempDir("documentation-primitives-schedule-blank-sheet-pack");
  const secondY = 7.5 - 0.45 - (1 / 12);
  const insertionX = 7.25 - 1.25;
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8121,
      schedule: { id: 8121, name: "Operator Blank Sheet Pack Schedule 1-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8121,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/create-schedule:3": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:4": {
      status: "Success",
      viewId: 8122,
      schedule: { id: 8122, name: "Operator Blank Sheet Pack Schedule 2-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8122,
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/place-views:1": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8121, placementType: "ScheduleSheetInstance", x: insertionX, y: 7.5, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8122, placementType: "ScheduleSheetInstance", x: insertionX, y: secondY, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } }
      ]
    },
    "/revit/place-views:2": {
      status: "Success",
      dryRun: false,
      requestedCount: 2,
      placedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8121, scheduleSheetInstanceId: 8321, placementType: "ScheduleSheetInstance", action: "Create", x: insertionX, y: 7.5, actualBox: { minU: insertionX, maxU: insertionX + 0.8, minV: 7.05, maxV: 7.5 }, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8122, scheduleSheetInstanceId: 8322, placementType: "ScheduleSheetInstance", action: "Create", x: insertionX, y: secondY, actualBox: { minU: insertionX, maxU: insertionX + 0.8, minV: secondY - 0.35, maxV: secondY }, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } }
      ]
    },
    "/revit/place-views:3": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8121, scheduleSheetInstanceId: 8321, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 6.45, y: 7.5, placement: { strategy: "requested" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8122, scheduleSheetInstanceId: 8322, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 6.45, y: 6.966666666666667, placement: { strategy: "requested" } }
      ]
    },
    "/revit/place-views:4": {
      status: "Success",
      dryRun: false,
      requestedCount: 2,
      placedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8121, scheduleSheetInstanceId: 8321, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 6.45, y: 7.5, actualBox: { minU: 6.45, maxU: 7.25, minV: 7.05, maxV: 7.5 }, placement: { strategy: "requested" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8122, scheduleSheetInstanceId: 8322, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 6.45, y: 6.966666666666667, actualBox: { minU: 6.45, maxU: 7.25, minV: 6.616666666666667, maxV: 6.966666666666667 }, placement: { strategy: "requested" } }
      ]
    },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "schedule-blank-sheet-pack-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8121, 8122], count: 2 },
    "/revit/delete:2": { status: "Deleted", ids: [8121, 8122, 8321, 8322], count: 4 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 1420963,
        visualViewId: 1420963,
        visualVerify: true,
        cleanupCreatedElements: true,
        scheduleSheetLayout: {
          sheetId: 1420963,
          layoutPolicy: "blank_schedule_sheet_pack",
          rightX: 7.25,
          topY: 7.5,
          spacingFeet: 1 / 12,
          defaultScheduleHeightFeet: 0.45,
          defaultScheduleWidthFeet: 1.25,
          measuredRepackAfterPlace: true,
          usableBounds: { minX: 0.5, maxX: 7.5, minY: 0.5, maxY: 8.0 }
        },
        schedules: [
          {
            name: "Operator Blank Sheet Pack Schedule 1",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Mark"]
          },
          {
            name: "Operator Blank Sheet Pack Schedule 2",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Count"]
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_batch_blank_sheet_pack_plan_present",
    "schedule_batch_blank_sheet_pack_within_usable_bounds",
    "schedule_batch_blank_sheet_pack_final_within_usable_bounds",
    "schedule_batch_measured_repack_final_boxes_present",
    "schedule_batch_measured_repack_final_no_overlap",
    "schedule_batch_stack_layout_spacing_verified",
    "schedule_batch_stack_layout_right_anchor_verified",
    "documentation_cleanup_applied_ids_present"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const placeCalls = bridge.calls.filter((call) => call.pathname === "/revit/place-views");
  const requestedPlacements = (placeCalls[0]?.body as { placements?: Array<Record<string, unknown>> }).placements ?? [];
  assert.equal(requestedPlacements.length, 2);
  assert.equal(requestedPlacements[0].x, insertionX);
  assert.equal(requestedPlacements[1].y, secondY);
  assert.equal(requestedPlacements.every((placement) => placement.layoutPolicy === "blank_schedule_sheet_pack"), true);
  assert.equal(placeCalls.length, 4);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.stackLayoutPlan.layoutPolicy, "blank_schedule_sheet_pack");
  assert.equal(summary.stackLayoutPlan.sheetContentPolicy, "blank_schedule_sheet");
  assert.equal(summary.stackLayoutPlan.usableBounds.maxX, 7.5);
});

test("documentation primitives workflow can repack schedule stack from measured bounds", async () => {
  const dir = tempDir("documentation-primitives-schedule-measured-repack");
  const estimatedSecondY = 8 - 0.5 - (1 / 12);
  const measuredSecondY = 8 - 1.2 - (1 / 12);
  const estimatedInsertionX = 7.2 - 1.35;
  const measuredInsertionX = 7.2 - 1.5;
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      schedule: { id: 8101, name: "Operator Measured Repack Schedule 1-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/create-schedule:3": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:4": {
      status: "Success",
      viewId: 8102,
      schedule: { id: 8102, name: "Operator Measured Repack Schedule 2-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8102,
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/place-views:1": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, placementType: "ScheduleSheetInstance", x: estimatedInsertionX, y: 8, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, placementType: "ScheduleSheetInstance", x: estimatedInsertionX, y: estimatedSecondY, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } }
      ]
    },
    "/revit/place-views:2": {
      status: "Success",
      dryRun: false,
      requestedCount: 2,
      placedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8301, placementType: "ScheduleSheetInstance", action: "Create", x: estimatedInsertionX, y: 8, actualBox: { minU: measuredInsertionX, maxU: 7.2, minV: 6.8, maxV: 8 }, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, scheduleSheetInstanceId: 8302, placementType: "ScheduleSheetInstance", action: "Create", x: estimatedInsertionX, y: estimatedSecondY, actualBox: { minU: measuredInsertionX, maxU: 7.2, minV: estimatedSecondY - 0.4, maxV: estimatedSecondY }, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } }
      ]
    },
    "/revit/place-views:3": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8301, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: measuredInsertionX, y: 8, placement: { strategy: "requested" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, scheduleSheetInstanceId: 8302, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: measuredInsertionX, y: measuredSecondY, placement: { strategy: "requested" } }
      ]
    },
    "/revit/place-views:4": {
      status: "Success",
      dryRun: false,
      requestedCount: 2,
      placedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8301, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: measuredInsertionX, y: 8, actualBox: { minU: measuredInsertionX, maxU: 7.2, minV: 6.8, maxV: 8 }, placement: { strategy: "requested" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, scheduleSheetInstanceId: 8302, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: measuredInsertionX, y: measuredSecondY, actualBox: { minU: measuredInsertionX, maxU: 7.2, minV: measuredSecondY - 0.4, maxV: measuredSecondY }, placement: { strategy: "requested" } }
      ]
    },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "schedule-measured-repack-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101, 8102], count: 2 },
    "/revit/delete:2": { status: "Deleted", ids: [8101, 8102, 8301, 8302], count: 4 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 1420963,
        visualViewId: 1420963,
        visualVerify: true,
        cleanupCreatedElements: true,
        scheduleSheetLayout: {
          sheetId: 1420963,
          layoutPolicy: "right_justified_vertical_stack",
          rightX: 7.2,
          topY: 8,
          spacingFeet: 1 / 12,
          defaultScheduleHeightFeet: 0.5,
          defaultScheduleWidthFeet: 1.35,
          measuredRepackAfterPlace: true
        },
        schedules: [
          {
            name: "Operator Measured Repack Schedule 1",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Mark"]
          },
          {
            name: "Operator Measured Repack Schedule 2",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Count"]
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_batch_measured_repack_plan_present",
    "schedule_batch_measured_repack_spacing_verified",
    "schedule_batch_measured_repack_final_boxes_present",
    "schedule_batch_measured_repack_final_no_overlap",
    "schedule_batch_reflow_dry_run_ok",
    "schedule_batch_reflow_applied_success",
    "schedule_batch_reflow_move_existing_verified"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const placeCalls = bridge.calls.filter((call) => call.pathname === "/revit/place-views");
  assert.equal(placeCalls.length, 4);
  const repackPlacements = (placeCalls[2]?.body as { placements?: Array<Record<string, unknown>> }).placements ?? [];
  assert.equal(repackPlacements.length, 2);
  assert.equal(Math.abs(Number(repackPlacements[0].x) - measuredInsertionX) < 0.001, true);
  assert.equal(Math.abs(Number(repackPlacements[1].y) - measuredSecondY) < 0.001, true);
  assert.equal(repackPlacements.every((placement) => placement.measuredRepack === true), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.measuredRepackPlan.scheduleCount, 2);
  assert.equal(Math.abs(Number(summary.measuredRepackPlan.generatedPlacements[1].y) - measuredSecondY) < 0.001, true);
});

test("documentation primitives workflow can carry schedule notes through measured repack", async () => {
  const dir = tempDir("documentation-primitives-schedule-note-measured-repack");
  const estimatedSecondY = 8 - 0.5 - (1 / 12);
  const measuredSecondY = 8 - 1.2 - (1 / 12);
  const estimatedInsertionX = 7.2 - 1.35;
  const measuredInsertionX = 7.2 - 1.5;
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      schedule: { id: 8101, name: "Operator Note Repack Schedule 1-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/create-schedule:3": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:4": {
      status: "Success",
      viewId: 8102,
      schedule: { id: 8102, name: "Operator Note Repack Schedule 2-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8102,
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/place-views:1": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, placementType: "ScheduleSheetInstance", x: estimatedInsertionX, y: 8, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, placementType: "ScheduleSheetInstance", x: estimatedInsertionX, y: estimatedSecondY, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } }
      ]
    },
    "/revit/place-views:2": {
      status: "Success",
      dryRun: false,
      requestedCount: 2,
      placedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8301, placementType: "ScheduleSheetInstance", action: "Create", x: estimatedInsertionX, y: 8, actualBox: { minU: measuredInsertionX, maxU: 7.2, minV: 6.8, maxV: 8 }, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, scheduleSheetInstanceId: 8302, placementType: "ScheduleSheetInstance", action: "Create", x: estimatedInsertionX, y: estimatedSecondY, actualBox: { minU: measuredInsertionX, maxU: 7.2, minV: estimatedSecondY - 0.4, maxV: estimatedSecondY }, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } }
      ]
    },
    "/revit/create-text:1": { status: "Success", id: 8401, textNoteId: 8401, viewId: 1420963, text: "NOTE 1: FIRST SCHEDULE REMARK-R01", x: measuredInsertionX, y: 6.55 },
    "/revit/create-text:2": { status: "Success", id: 8402, textNoteId: 8402, viewId: 1420963, text: "NOTE 2: SECOND SCHEDULE REMARK-R01", x: measuredInsertionX, y: estimatedSecondY - 0.65 },
    "/revit/place-views:3": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8301, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: measuredInsertionX, y: 8, placement: { strategy: "requested" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, scheduleSheetInstanceId: 8302, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: measuredInsertionX, y: measuredSecondY, placement: { strategy: "requested" } }
      ]
    },
    "/revit/place-views:4": {
      status: "Success",
      dryRun: false,
      requestedCount: 2,
      placedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8301, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: measuredInsertionX, y: 8, actualBox: { minU: measuredInsertionX, maxU: 7.2, minV: 6.8, maxV: 8 }, placement: { strategy: "requested" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, scheduleSheetInstanceId: 8302, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: measuredInsertionX, y: measuredSecondY, actualBox: { minU: measuredInsertionX, maxU: 7.2, minV: measuredSecondY - 0.4, maxV: measuredSecondY }, placement: { strategy: "requested" } }
      ]
    },
    "/revit/move-elements:1": { status: "Dry Run", dryRun: true, movedIds: [8401], skipped: [], rolledBack: true },
    "/revit/move-elements:2": { status: "Moved", dryRun: false, movedIds: [8401], skipped: [], rolledBack: false },
    "/revit/move-elements:3": { status: "Dry Run", dryRun: true, movedIds: [8402], skipped: [], rolledBack: true },
    "/revit/move-elements:4": { status: "Moved", dryRun: false, movedIds: [8402], skipped: [], rolledBack: false },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "schedule-note-measured-repack-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101, 8102, 8401, 8402], count: 4 },
    "/revit/delete:2": { status: "Deleted", ids: [8101, 8102, 8301, 8302, 8401, 8402], count: 6 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 1420963,
        visualViewId: 1420963,
        visualVerify: true,
        cleanupCreatedElements: true,
        scheduleSheetLayout: {
          sheetId: 1420963,
          layoutPolicy: "right_justified_vertical_stack",
          rightX: 7.2,
          topY: 8,
          spacingFeet: 1 / 12,
          defaultScheduleHeightFeet: 0.5,
          defaultScheduleWidthFeet: 1.35,
          measuredRepackAfterPlace: true
        },
        schedules: [
          {
            name: "Operator Note Repack Schedule 1",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Mark"],
            textNote: {
              placeBelowSchedule: true,
              belowOffsetFeet: 0.25,
              text: "NOTE 1: FIRST SCHEDULE REMARK"
            }
          },
          {
            name: "Operator Note Repack Schedule 2",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Count"],
            textNote: {
              placeBelowSchedule: true,
              belowOffsetFeet: 0.25,
              text: "NOTE 2: SECOND SCHEDULE REMARK"
            }
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_batch_1_note_created",
    "schedule_batch_2_note_created",
    "schedule_batch_measured_repack_final_boxes_present",
    "schedule_batch_measured_repack_final_no_overlap",
    "schedule_batch_note_repack_plan_present",
    "schedule_batch_note_move_dry_run_ok",
    "schedule_batch_note_move_applied_ids_present",
    "schedule_batch_note_repack_keeps_notes_below_schedules"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const moveCalls = bridge.calls.filter((call) => call.pathname === "/revit/move-elements");
  assert.equal(moveCalls.length, 4);
  assert.equal(Math.abs(Number((moveCalls[3]?.body as { vectorY?: number }).vectorY) - -0.7) < 0.001, true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.scheduleBatchNotes.length, 2);
  assert.equal(summary.rows.filter((row: { primitive?: string }) => row.primitive === "layout_schedule_note_repack").length, 2);
});

test("documentation primitives workflow can configure filtered schedules before stacking them", async () => {
  const dir = tempDir("documentation-primitives-filtered-schedule-stack-layout");
  const secondY = 8 - 0.5 - (1 / 12);
  const insertionX = 7.2 - 1.35;
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      schedule: { id: 8101, name: "Operator VAV Level 1 Schedule-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/configure-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleId: 8101,
      plan: { filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }] }
    },
    "/revit/configure-schedule:2": {
      status: "Success",
      scheduleId: 8101,
      applied: { filters: [{ field: "Mark", status: "Applied", op: "begins_with", value: "VAV-1-" }] },
      schedule: { id: 8101, fields: [{ name: "Family and Type" }, { name: "Mark" }] }
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }],
      filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }]
    },
    "/revit/create-schedule:3": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:4": {
      status: "Success",
      viewId: 8102,
      schedule: { id: 8102, name: "Operator VAV Level 2 Schedule-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/schedules:3": {
      status: "Success",
      scheduleId: 8102,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/configure-schedule:3": {
      status: "Dry Run",
      dryRun: true,
      scheduleId: 8102,
      plan: { filters: [{ field: "Mark", op: "begins_with", value: "VAV-2-" }] }
    },
    "/revit/configure-schedule:4": {
      status: "Success",
      scheduleId: 8102,
      applied: { filters: [{ field: "Mark", status: "Applied", op: "begins_with", value: "VAV-2-" }] },
      schedule: { id: 8102, fields: [{ name: "Family and Type" }, { name: "Mark" }] }
    },
    "/revit/schedules:4": {
      status: "Success",
      scheduleId: 8102,
      fields: [{ name: "Family and Type" }, { name: "Mark" }],
      filters: [{ field: "Mark", op: "begins_with", value: "VAV-2-" }]
    },
    "/revit/place-views:1": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, placementType: "ScheduleSheetInstance", x: insertionX, y: 8, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, placementType: "ScheduleSheetInstance", x: insertionX, y: secondY, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } }
      ]
    },
    "/revit/place-views:2": {
      status: "Success",
      dryRun: false,
      requestedCount: 2,
      placedCount: 2,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8301, placementType: "ScheduleSheetInstance", action: "Create", x: insertionX, y: 8, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } },
        { index: 1, ok: true, sheetId: 1420963, viewId: 8102, scheduleSheetInstanceId: 8302, placementType: "ScheduleSheetInstance", action: "Create", x: insertionX, y: secondY, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } }
      ]
    },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "filtered-schedule-stack-layout-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101, 8102], count: 2 },
    "/revit/delete:2": { status: "Deleted", ids: [8101, 8102, 8301, 8302], count: 4 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 1420963,
        visualViewId: 1420963,
        visualVerify: true,
        cleanupCreatedElements: true,
        scheduleSheetLayout: {
          sheetId: 1420963,
          layoutPolicy: "right_justified_vertical_stack",
          rightX: 7.2,
          topY: 8,
          spacingFeet: 1 / 12,
          defaultScheduleHeightFeet: 0.5,
          defaultScheduleWidthFeet: 1.35
        },
        schedules: [
          {
            name: "Operator VAV Level 1 Schedule",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Mark"],
            filters: [{ field: "Mark", op: "begins_with", value: "VAV-1-" }]
          },
          {
            name: "Operator VAV Level 2 Schedule",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Mark"],
            filters: [{ field: "Mark", op: "begins_with", value: "VAV-2-" }]
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_batch_1_config_dry_run_ok",
    "schedule_batch_1_config_applied_success",
    "schedule_batch_1_config_operations_match_request",
    "schedule_batch_2_config_dry_run_ok",
    "schedule_batch_2_config_applied_success",
    "schedule_batch_2_config_operations_match_request",
    "schedule_batch_stack_layout_applied_anchors_match_plan",
    "documentation_cleanup_applied_ids_present"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const configureCalls = bridge.calls.filter((call) => call.pathname === "/revit/configure-schedule");
  assert.equal(configureCalls.length, 4);
  assert.deepEqual((configureCalls[1].body as { filters?: unknown }).filters, [{ field: "Mark", op: "begins_with", value: "VAV-1-" }]);
  assert.deepEqual((configureCalls[3].body as { filters?: unknown }).filters, [{ field: "Mark", op: "begins_with", value: "VAV-2-" }]);
  const placeCalls = bridge.calls.filter((call) => call.pathname === "/revit/place-views");
  assert.equal(placeCalls.length, 2);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.rows.filter((row: { primitive?: string }) => row.primitive === "layout_schedule_configure").length, 2);
  assert.deepEqual(
    summary.rows.filter((row: { primitive?: string }) => row.primitive === "layout_schedule_configure").map((row: { filters?: string }) => row.filters),
    ["Mark begins_with VAV-1-", "Mark begins_with VAV-2-"]
  );
});

test("documentation primitives workflow can reflow an existing schedule sheet instance", async () => {
  const dir = tempDir("documentation-primitives-schedule-existing-reflow");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      schedule: { id: 8101, name: "Operator Reflow Schedule-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/place-views:1": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, placementType: "ScheduleSheetInstance", x: 1, y: 8, placement: { avoidOverlap: true, strategy: "requested" } }
      ]
    },
    "/revit/place-views:2": {
      status: "Success",
      dryRun: false,
      requestedCount: 1,
      placedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8301, placementType: "ScheduleSheetInstance", action: "Create", x: 1, y: 8, placement: { avoidOverlap: true, strategy: "requested" } }
      ]
    },
    "/revit/place-views:3": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8301, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 1, y: 6.5, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } }
      ]
    },
    "/revit/place-views:4": {
      status: "Success",
      dryRun: false,
      requestedCount: 1,
      placedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8301, placementType: "ScheduleSheetInstance", action: "MoveExisting", x: 1, y: 6.5, placement: { avoidOverlap: true, strategy: "requested-non-overlap" } }
      ]
    },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "schedule-reflow-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101], count: 1 },
    "/revit/delete:2": { status: "Deleted", ids: [8101, 8301], count: 2 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 1420963,
        visualViewId: 1420963,
        visualVerify: true,
        cleanupCreatedElements: true,
        scheduleSheetLayout: {
          sheetId: 1420963,
          avoidOverlap: true,
          reflowExisting: true,
          reflowPlacements: [{ x: 1, y: 6.5 }]
        },
        schedules: [
          {
            name: "Operator Reflow Schedule",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Mark"],
            placement: { x: 1, y: 8 }
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_batch_reflow_dry_run_ok",
    "schedule_batch_reflow_applied_success",
    "schedule_batch_reflow_move_existing_verified",
    "documentation_cleanup_applied_ids_present"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.reflowExisting, true);
  assert.equal(summary.rows.filter((row: { primitive?: string }) => row.primitive === "layout_schedule_reflow").length, 1);
  assert.equal(summary.rows.some((row: { primitive?: string; action?: string }) => row.primitive === "layout_schedule_reflow" && row.action === "MoveExisting"), true);
});

test("documentation primitives workflow can remove a schedule from a sheet without deleting the schedule view", async () => {
  const dir = tempDir("documentation-primitives-schedule-remove-from-sheet");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      schedule: { id: 8101, name: "Operator Remove Schedule-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/place-views:1": {
      status: "Dry Run",
      dryRun: true,
      requestedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, placementType: "ScheduleSheetInstance", x: 1, y: 8, placement: { avoidOverlap: true, strategy: "requested" } }
      ]
    },
    "/revit/place-views:2": {
      status: "Success",
      dryRun: false,
      requestedCount: 1,
      placedCount: 1,
      results: [
        { index: 0, ok: true, sheetId: 1420963, viewId: 8101, scheduleSheetInstanceId: 8301, placementType: "ScheduleSheetInstance", action: "Create", x: 1, y: 8, placement: { avoidOverlap: true, strategy: "requested" } }
      ]
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8301], count: 1 },
    "/revit/delete:2": { status: "Deleted", ids: [8301], count: 1 },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Mark" }]
    },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "schedule-remove-from-sheet-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:3": { status: "Dry Run", ids: [8101], count: 1 },
    "/revit/delete:4": { status: "Deleted", ids: [8101], count: 1 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 1420963,
        visualViewId: 1420963,
        visualVerify: true,
        cleanupCreatedElements: true,
        scheduleSheetLayout: {
          sheetId: 1420963,
          avoidOverlap: true,
          removeFromSheetAfterPlace: true
        },
        schedules: [
          {
            name: "Operator Remove Schedule",
            category: "OST_MechanicalEquipment",
            fields: ["Family and Type", "Mark"],
            placement: { x: 1, y: 8 }
          }
        ]
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "schedule_sheet_instance_remove_dry_run_ok",
    "schedule_sheet_instance_remove_applied_ids_present",
    "schedule_sheet_instance_remove_preserved_schedule_view",
    "documentation_cleanup_applied_ids_present"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const deleteCalls = bridge.calls.filter((call) => call.pathname === "/revit/delete");
  assert.deepEqual(deleteCalls[0]?.body, { ids: [8301], apply: false, reason: "benchmark remove schedule sheet instances without deleting schedule views" });
  assert.deepEqual(deleteCalls[1]?.body, { ids: [8301], apply: true, reason: "benchmark remove schedule sheet instances without deleting schedule views" });
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.removeFromSheetAfterPlace, true);
  assert.equal(summary.rows.some((row: { primitive?: string; action?: string }) => row.primitive === "layout_schedule_remove_from_sheet" && row.action === "DeleteScheduleSheetInstance"), true);
});

test("documentation primitives workflow verifies schedule-only active sheet placement proof", async () => {
  const dir = tempDir("documentation-primitives-schedule-placement-only");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      requested: { name: "Operator Redline Schedule Placement-R01" },
      placeOnSheet: { requested: true, placeOnActiveSheet: true, target: { sheetId: 1420963, sheetNumber: "M000" }, x: 1, y: 1 }
    },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      created: true,
      schedule: { id: 8101, name: "Operator Redline Schedule Placement-R01", fieldCount: 2 },
      fields: [{ name: "Family and Type" }, { name: "Count" }],
      placedOnSheet: { status: "Placed", scheduleSheetInstanceId: 8301, sheetId: 1420963, sheetNumber: "M000", x: 1, y: 1 }
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/configure-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleId: 8101
    },
    "/revit/configure-schedule:2": {
      status: "Success",
      scheduleId: 8101,
      applied: { addFields: [] },
      schedule: { id: 8101, fields: [{ name: "Family and Type" }, { name: "Count" }] }
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }, { name: "Count" }]
    },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "schedule-placement-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101, 8301], count: 2 },
    "/revit/delete:2": { status: "Deleted", ids: [8101, 8301], count: 2 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 1420963,
        visualViewId: 1420963,
        visualVerify: true,
        cleanupCreatedElements: true,
        schedule: {
          name: "Operator Redline Schedule Placement",
          category: "OST_Doors",
          fields: ["Family and Type", "Count"],
          placeOnActiveSheet: true,
          placeOnActiveSheetX: 1,
          placeOnActiveSheetY: 1
        },
        configureSchedule: {
          addFields: [],
          replaceFilters: false,
          replaceSortGroup: false
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_created_placement_matches_request" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.scheduleId, 8101);
  assert.deepEqual(summary.cleanupDeletedIds, [8101, 8301]);
});

test("documentation primitives workflow verifies schedule-only title and header appearance readback", async () => {
  const dir = tempDir("documentation-primitives-schedule-title-header-appearance");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      schedule: { id: 8101, fieldCount: 1 },
      fields: [{ name: "Family and Type" }]
    },
    "/revit/schedules:1": { status: "Success", scheduleId: 8101, fields: [{ name: "Family and Type" }] },
    "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
    "/revit/configure-schedule:2": {
      status: "Success",
      scheduleId: 8101,
      applied: {
        appearance: [
          { setting: "showTitle", status: "Applied", value: true, readback: true },
          { setting: "showHeaders", status: "Applied", value: true, readback: true }
        ]
      },
      schedule: { id: 8101, fields: [{ name: "Family and Type" }] }
    },
    "/revit/schedules:2": { status: "Success", scheduleId: 8101, fields: [{ name: "Family and Type" }] },
    "/revit/export-image": {
      status: "Captured",
      viewId: 8101,
      path: path.join(dir, "schedule-title-header-after.png"),
      width: 1200,
      height: 900
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101], count: 1 },
    "/revit/delete:2": { status: "Deleted", ids: [8101], count: 1 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        cleanupCreatedElements: true,
        schedule: { name: "Operator Redline Appearance Schedule", category: "OST_Doors", fields: ["Family and Type"] },
        configureSchedule: { appearance: { showTitle: true, showHeaders: true } }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_operations_match_request" && entry.ok), true);
});

test("documentation primitives workflow rejects schedule title and header appearance without readback proof", async () => {
  const dir = tempDir("documentation-primitives-schedule-title-header-no-readback");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
    "/revit/create-schedule:2": {
      status: "Success",
      viewId: 8101,
      schedule: { id: 8101, fieldCount: 1 },
      fields: [{ name: "Family and Type" }]
    },
    "/revit/schedules:1": { status: "Success", scheduleId: 8101, fields: [{ name: "Family and Type" }] },
    "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
    "/revit/configure-schedule:2": {
      status: "Success",
      scheduleId: 8101,
      applied: {
        appearance: [
          { setting: "showTitle", status: "Skipped", value: true },
          { setting: "showHeaders", status: "Applied", value: true }
        ]
      },
      schedule: { id: 8101, fields: [{ name: "Family and Type" }] }
    },
    "/revit/schedules:2": { status: "Success", scheduleId: 8101, fields: [{ name: "Family and Type" }] },
    "/revit/delete:1": { status: "Dry Run", ids: [8101], count: 1 },
    "/revit/delete:2": { status: "Deleted", ids: [8101], count: 1 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        cleanupCreatedElements: true,
        schedule: { name: "Operator Redline Appearance Schedule", category: "OST_Doors", fields: ["Family and Type"] },
        configureSchedule: { appearance: { showTitle: true, showHeaders: true } }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_success" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_operations_match_request" && !entry.ok), true);
});

test("documentation primitives workflow verifies schedule-only row height configure without unrelated checks", async () => {
  const dir = tempDir("documentation-primitives-schedule-row-height-only");
  const bridge = new MockBridgeTransport({
    "/revit/create-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleName: "Operator Redline Row Height Schedule-R01"
    },
    "/revit/create-schedule:2": {
      status: "Created",
      viewId: 8101,
      scheduleId: 8101,
      scheduleName: "Operator Redline Row Height Schedule-R01",
      fieldCount: 1,
      fields: [{ name: "Family and Type" }]
    },
    "/revit/schedules:1": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }]
    },
    "/revit/configure-schedule:1": {
      status: "Dry Run",
      dryRun: true,
      scheduleId: 8101,
      plan: {
        rowHeights: {
          requestedCount: 1,
          items: [{ section: "body", rowNumber: 2, heightFeet: 0.25, targetRows: [2] }]
        }
      }
    },
    "/revit/configure-schedule:2": {
      status: "Success",
      scheduleId: 8101,
      applied: {
        addFields: [],
        rowHeights: [{ status: "Applied", section: "body", rowNumber: 2, beforeHeightFeet: 0.125, heightFeet: 0.25, afterHeightFeet: 0.25 }]
      },
      schedule: {
        id: 8101,
        fields: [{ name: "Family and Type" }]
      }
    },
    "/revit/schedules:2": {
      status: "Success",
      scheduleId: 8101,
      fields: [{ name: "Family and Type" }]
    },
    "/revit/export-image": {
      status: "Captured",
      viewId: 1420963,
      path: path.join(dir, "schedule-row-height-after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/delete:1": { status: "Dry Run", ids: [8101], count: 1 },
    "/revit/delete:2": { status: "Deleted", ids: [8101], count: 1 }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 1420963,
        visualViewId: 1420963,
        visualVerify: true,
        cleanupCreatedElements: true,
        schedule: {
          name: "Operator Redline Row Height Schedule",
          category: "OST_Doors",
          fields: ["Family and Type"]
        },
        configureSchedule: {
          addFields: [],
          replaceFilters: false,
          replaceSortGroup: false,
          rowHeights: [{ section: "body", rowNumber: 2, heightFeet: 0.25 }]
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "schedule_config_applied_operations_match_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_post_change_capture_returned" && entry.ok), true);
  for (const name of [
    "sheet_created_id_present",
    "tag_request_present",
    "cad_link_request_present",
    "category_visibility_dry_run_ok",
    "filter_visibility_dry_run_ok"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name), false, name);
  }
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.configuredScheduleId, 8101);
  assert.equal(summary.rows.some((row: { primitive?: string }) => row.primitive === "configure_schedule"), true);
  assert.deepEqual(summary.cleanupDeletedIds, [8101]);
});

test("documentation primitives workflow edits existing text note with readback capture and revert", async () => {
  const dir = tempDir("documentation-primitives-existing-text-note-edit");
  const bridge = new MockBridgeTransport({
    "/revit/find-text-notes:1": {
      status: "Success",
      items: [{ textNoteId: 4401, ownerViewId: 8101, text: "COUNTERBALANCED" }]
    },
    "/revit/replace-text-note:1": {
      status: "Dry Run",
      dryRun: true,
      textNoteId: 4401,
      ownerViewId: 8101,
      before: "COUNTERBALANCED",
      after: "COUNTERBALANCED"
    },
    "/revit/replace-text-note:2": {
      status: "Applied",
      textNoteId: 4401,
      ownerViewId: 8101,
      before: "COUNTERBALANCED",
      after: "MOTORIZED",
      text: "MOTORIZED"
    },
    "/revit/find-text-notes:2": {
      status: "Success",
      items: [{ textNoteId: 4401, ownerViewId: 8101, text: "MOTORIZED" }]
    },
    "/revit/export-image": {
      status: "Success",
      viewId: 8101,
      path: path.join(dir, "after.png"),
      width: 1200,
      height: 900,
      focusCropApplied: true
    },
    "/revit/replace-text-note:3": {
      status: "Dry Run",
      dryRun: true,
      textNoteId: 4401,
      ownerViewId: 8101,
      before: "MOTORIZED",
      after: "MOTORIZED"
    },
    "/revit/replace-text-note:4": {
      status: "Applied",
      textNoteId: 4401,
      ownerViewId: 8101,
      before: "MOTORIZED",
      after: "COUNTERBALANCED",
      text: "COUNTERBALANCED"
    },
    "/revit/find-text-notes:3": {
      status: "Success",
      items: [{ textNoteId: 4401, ownerViewId: 8101, text: "COUNTERBALANCED" }]
    }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 8101,
        visualViewId: 8101,
        visualVerify: true,
        cleanupCreatedElements: true,
        textNote: {
          editExisting: true,
          viewId: 8101,
          textNoteId: 4401,
          expectedExistingText: "COUNTERBALANCED",
          text: "MOTORIZED",
          readbackRequired: true,
          revertAfterVerify: true
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_existing_target_found" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_edit_readback_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_post_change_capture_targets_created_context" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_edit_revert_readback_matches_original" && entry.ok), true);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/create-text"), false);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/replace-text-note").length, 4);
  const textReplaceCalls = bridge.calls.filter((call) => call.pathname === "/revit/replace-text-note");
  assert.deepEqual(textReplaceCalls.map((call) => (call.body as any).expectedOldText), ["COUNTERBALANCED", "COUNTERBALANCED", "MOTORIZED", "MOTORIZED"]);
});

test("documentation primitives workflow rejects existing text note edit without same-id readback", async () => {
  const dir = tempDir("documentation-primitives-existing-text-note-edit-wrong-readback");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 8101,
        visualViewId: 8101,
        visualVerify: true,
        cleanupCreatedElements: true,
        textNote: {
          editExisting: true,
          viewId: 8101,
          textNoteId: 4401,
          expectedExistingText: "COUNTERBALANCED",
          text: "MOTORIZED",
          readbackRequired: true,
          revertAfterVerify: true
        }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/find-text-notes:1": { status: "Success", items: [{ textNoteId: 4401, ownerViewId: 8101, text: "COUNTERBALANCED" }] },
      "/revit/replace-text-note:1": { status: "Dry Run", dryRun: true, textNoteId: 4401, ownerViewId: 8101, before: "COUNTERBALANCED", after: "COUNTERBALANCED" },
      "/revit/replace-text-note:2": { status: "Applied", textNoteId: 4401, ownerViewId: 8101, before: "COUNTERBALANCED", after: "MOTORIZED", text: "MOTORIZED" },
      "/revit/find-text-notes:2": { status: "Success", items: [{ textNoteId: 9999, ownerViewId: 8101, text: "MOTORIZED" }] },
      "/revit/export-image": { status: "Success", viewId: 8101, path: path.join(dir, "after.png"), width: 1200, height: 900, focusCropApplied: true },
      "/revit/replace-text-note:3": { status: "Dry Run", dryRun: true, textNoteId: 4401, ownerViewId: 8101, before: "MOTORIZED", after: "MOTORIZED" },
      "/revit/replace-text-note:4": { status: "Applied", textNoteId: 4401, ownerViewId: 8101, before: "MOTORIZED", after: "COUNTERBALANCED", text: "COUNTERBALANCED" },
      "/revit/find-text-notes:3": { status: "Success", items: [{ textNoteId: 4401, ownerViewId: 8101, text: "COUNTERBALANCED" }] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_edit_readback_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "text_note_edit_revert_readback_matches_original" && entry.ok), true);
});

test("documentation primitives workflow blocks template graphics without cleanup before writes", async () => {
  const dir = tempDir("documentation-primitives-template-graphics-prewrite-block");
  const bridge = new MockBridgeTransport({});
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        templateCategoryVisibility: {
          categoryName: "Lines",
          lineWeight: 5
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.match(result.failure_reason ?? "", /blocked before Revit writes/);
  assert.match(result.failure_reason ?? "", /templateCategoryVisibility requires cleanupCreatedElements:true/);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_workflow_exception_caught" && !entry.ok), true);
  assert.equal(bridge.calls.length, 0);
});

test("documentation primitives workflow blocks CAD graphics without cleanup before writes", async () => {
  const dir = tempDir("documentation-primitives-cad-graphics-prewrite-block");
  const bridge = new MockBridgeTransport({});
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        cadLink: {
          sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg",
          placement: "center",
          link: true
        },
        cadGraphicsOverride: {
          layerOrSubcategoryName: "M104-FUTURE",
          lineWeight: 5
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.match(result.failure_reason ?? "", /blocked before Revit writes/);
  assert.match(result.failure_reason ?? "", /cadLink requires cleanupCreatedElements:true/);
  assert.match(result.failure_reason ?? "", /cadGraphicsOverride requires cleanupCreatedElements:true/);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_workflow_exception_caught" && !entry.ok), true);
  assert.equal(bridge.calls.length, 0);
});

test("documentation primitives workflow preflights CAD reload context and blocks before writes", async () => {
  const dir = tempDir("documentation-primitives-cad-reload-preflight");
  const bridge = new MockBridgeTransport({
    "/revit/model-health": {
      links: {
        cad: {
          items: [
            { elementId: 7001, name: "Snowdon-M104-Plan-HVAC-L4.dwg", ownerViewId: 5001, path: "P:/refs/Snowdon-M104-Plan-HVAC-L4.dwg" }
          ]
        }
      }
    },
    "/revit/export-image": {
      status: "Captured",
      viewId: 4001,
      path: "artifacts/captures/cad-reload-preflight.png",
      widthPx: 1600,
      heightPx: 1200,
      focusCropApplied: true
    }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        viewId: 4001,
        visualViewId: 4001,
        visualVerify: true,
        cleanupCreatedElements: true,
        cadReload: {
          preflightOnly: true,
          existingCadLinkIds: [7001],
          expectedCadLinkName: "Snowdon-M104-Plan-HVAC-L4.dwg",
          expectedSourcePath: "Snowdon-M104-Plan-HVAC-L4.dwg",
          ownerViewId: 5001,
          readbackRequired: true,
          applyReload: false
        }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.revit_transactions, 0);
  assert.match(result.failure_reason ?? "", /blocked before model writes/i);
  assert.equal(result.verification_results.some((entry) => entry.name === "cad_reload_existing_link_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "cad_reload_apply_blocked_before_model_write" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "cad_reload_native_reload_endpoint_available" && !entry.ok), true);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/model-health").length, 1);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/export-image").length, 1);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/link-cad"), false);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/visibility"), false);
  assert.equal(bridge.calls.some((call) => call.pathname === "/revit/delete"), false);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.blockedBeforeModelWrite, true);
  assert.equal(summary.rows.some((row: { primitive?: string }) => row.primitive === "cad_reload_preflight"), true);
});

test("documentation primitives workflow rejects missing post-change capture path", async () => {
  const dir = tempDir("documentation-primitives-missing-capture");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201 },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_post_change_capture_returned" && !entry.ok), true);
});

test("documentation primitives workflow rejects post-change capture from the wrong view", async () => {
  const dir = tempDir("documentation-primitives-wrong-capture-view");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 9999, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_post_change_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_post_change_capture_targets_created_context" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_post_change_capture_view_id_matches_request" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.postChangeCaptureTargetId, 8201);
  assert.equal(summary.postChangeCaptureViewId, 9999);
});

test("documentation primitives workflow rejects low-quality post-change captures", async () => {
  const dir = tempDir("documentation-primitives-low-quality-capture");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png", widthPx: 320, heightPx: 480 },
      "/revit/delete:1": { status: "Dry Run", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_post_change_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_post_change_capture_view_id_matches_request" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_post_change_capture_quality_ok" && !entry.ok), true);
});

test("documentation primitives workflow rejects CAD sheet placement when post-change capture targets a non-sheet view", async () => {
  const dir = tempDir("documentation-primitives-cad-capture-not-sheet");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cadLink: { sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg", placement: "center", customScale: 1, link: true },
        visualViewId: 8251,
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/link-cad:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg", targetMode: "view_then_sheet", viewId: 8600, sheetViewId: 8201, sheetNumber: "OP-DEMO-R01", placeOnSheet: true, canPlaceViewport: true } },
      "/revit/link-cad:2": { status: "Success", mode: "link", targetMode: "view_then_sheet", viewId: 8600, ownerViewId: 8600, viewName: "CAD operator-demo-keyplan for OP-DEMO-R01", viewType: "DraftingView", viewCreated: true, sheetViewId: 8201, sheetNumber: "OP-DEMO-R01", viewportId: 8603, viewportBox: { minU: -1.2, minV: -0.6, maxU: 1.2, maxV: 0.6 }, elementBoundingBoxInOwnerView: { min: { x: -0.5, y: -0.25, z: 0 }, max: { x: 0.5, y: 0.25, z: 0 } }, elementId: 8601, sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg", cadCategories: [{ categoryId: 8601, categoryName: "operator-demo-keyplan.dwg", depth: 0 }] },
      "/revit/export-image": { status: "Captured", viewId: 8251, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 11, ids: [8401, 8381, 8351, 8601, 8301, 8603, 8101, 8201, 8251, 8252, 8600] },
      "/revit/delete:2": { status: "Deleted", count: 11, ids: [8401, 8381, 8351, 8601, 8301, 8603, 8101, 8201, 8251, 8252, 8600] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "cad_link_viewport_placed_on_sheet" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_post_change_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_post_change_capture_targets_created_context" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "cad_link_post_change_capture_targets_sheet" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.equal(summary.postChangeCaptureTargetId, 8251);
  assert.equal(summary.postChangeCaptureViewId, 8251);
  assert.equal(summary.cadLinkViewportId, 8603);
});

test("documentation primitives workflow rejects CAD placement without owner-view bounding box proof", async () => {
  const dir = tempDir("documentation-primitives-cad-missing-owner-bbox");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors" },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cadLink: { sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg", placement: "center", customScale: 1, link: true },
        visualViewId: 8201,
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/link-cad:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg", targetMode: "view_then_sheet", viewId: 8600, sheetViewId: 8201, sheetNumber: "OP-DEMO-R01", placeOnSheet: true, canPlaceViewport: true } },
      "/revit/link-cad:2": { status: "Success", mode: "link", targetMode: "view_then_sheet", viewId: 8600, ownerViewId: 8600, viewName: "CAD operator-demo-keyplan for OP-DEMO-R01", viewType: "DraftingView", viewCreated: true, sheetViewId: 8201, sheetNumber: "OP-DEMO-R01", viewportId: 8603, viewportBox: { minU: -1.2, minV: -0.6, maxU: 1.2, maxV: 0.6 }, elementId: 8601, sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg", cadCategories: [{ categoryId: 8601, categoryName: "operator-demo-keyplan.dwg", depth: 0 }] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 11, ids: [8401, 8381, 8351, 8601, 8301, 8603, 8101, 8201, 8251, 8252, 8600] },
      "/revit/delete:2": { status: "Deleted", count: 11, ids: [8401, 8381, 8351, 8601, 8301, 8603, 8101, 8201, 8251, 8252, 8600] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "cad_link_viewport_placed_on_sheet" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "cad_link_viewport_box_sheet_sized" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "cad_link_owner_view_bbox_reported" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "cad_link_post_change_capture_targets_sheet" && entry.ok), true);
});

test("documentation primitives workflow cleans up tracked ids after a thrown bridge failure", async () => {
  const dir = tempDir("documentation-primitives-failure-cleanup");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors", fields: ["Family and Type", "Count"] },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        placeView: { x: 1.5, y: 1.0 },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/delete:1": { status: "Dry Run", count: 7, ids: [8381, 8351, 8301, 8101, 8201, 8251, 8252] },
      "/revit/delete:2": { status: "Deleted", count: 7, ids: [8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.match(result.failure_reason ?? "", /tag-elements/);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_workflow_exception_caught" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_failure_cleanup_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_failure_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.deepEqual(summary.cleanupIds, [8381, 8351, 8301, 8101, 8201, 8251, 8252]);
  assert.deepEqual(summary.cleanupDeletedIds, [8381, 8351, 8301, 8101, 8201, 8251, 8252]);
  assert.deepEqual(summary.tracked.textNoteIds, [8381]);
  assert.deepEqual(summary.tracked.detailCurveIds, [8351]);
});

test("documentation primitives workflow fails cleanup when dry run omits a created id", async () => {
  const dir = tempDir("documentation-primitives-cleanup-dry-run-missing-id");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "documentation_primitives",
      request: {
        schedule: { name: "Operator Demo Door Schedule", category: "OST_Doors", fields: ["Family and Type", "Count"] },
        configureSchedule: { showGrandTotals: false },
        sheet: { number: "OP-DEMO", name: "Operator Demo Documentation", titleBlockId: -1 },
        createView: { action: "create_drafting", name: "Operator Demo Drafting View" },
        viewTemplate: { name: "Operator Demo View Template" },
        placeView: { x: 1.5, y: 1.0 },
        visibility: { action: "set_detail_level", detailLevel: "Fine" },
        templateVisibility: { action: "set_detail_level", detailLevel: "Fine" },
        detailCurves: { curves: [{ kind: "line", a: { x: 0, y: 0, z: 0 }, b: { x: 3, y: 0, z: 0 } }] },
        textNote: { x: 1, y: 1, text: "Operator demo annotation" },
        tag: { viewId: 401, elementIds: [301], onlyUntagged: false },
        cleanupCreatedElements: true
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-schedule:1": { status: "Dry Run", dryRun: true },
      "/revit/create-schedule:2": { status: "Success", viewId: 8101, created: true, schedule: { fieldCount: 2 } },
      "/revit/configure-schedule:1": { status: "Dry Run", dryRun: true, scheduleId: 8101 },
      "/revit/configure-schedule:2": { status: "Success", scheduleId: 8101, applied: { sortGroup: [{ setting: "showGrandTotals", value: false }] } },
      "/revit/create-sheet": { id: 8201, name: "Operator Demo Documentation-R01", number: "OP-DEMO-R01" },
      "/revit/create-view:1": { status: "Dry Run", dryRun: true },
      "/revit/create-view:2": { status: "Success", view: { id: 8251 } },
      "/revit/create-view:3": { status: "Dry Run", dryRun: true },
      "/revit/create-view:4": { status: "Success", view: { id: 8252 } },
      "/revit/place-view": { id: 8301, status: "Placed", sheetId: 8201, viewId: 8251 },
      "/revit/draw-detail-curves:1": { status: "Dry Run", dryRun: true, viewId: 8251, createdCount: 1, segmentsCreated: 1 },
      "/revit/draw-detail-curves:2": { status: "Success", dryRun: false, viewId: 8251, detailCurveIds: [8351], createdCount: 1, segmentsCreated: 1 },
      "/revit/visibility:1": { status: "Dry Run", dryRun: true },
      "/revit/visibility:2": { status: "Success", action: "set_detail_level", viewId: 8251, view: { id: 8251, detailLevel: "Fine" } },
      "/revit/visibility:3": { status: "Dry Run", dryRun: true },
      "/revit/visibility:4": { status: "Success", action: "set_detail_level", viewId: 8252, view: { id: 8252, detailLevel: "Fine" } },
      "/revit/create-text": { status: "success", id: 8381, viewId: 8201 },
      "/revit/tag-elements:1": { status: "Dry Run", dryRun: true, viewId: 401, targetCount: 1, plannedToTag: 1, targets: [{ elementId: 301, category: "Mechanical Equipment", alreadyTagged: false }] },
      "/revit/tag-elements:2": { status: "Success", viewId: 401, targetCount: 1, taggedCount: 1, errorCount: 0, tagIds: [8401] },
      "/revit/export-image": { status: "Captured", viewId: 8201, path: "artifacts/captures/documentation-after.png" },
      "/revit/delete:1": { status: "Dry Run", count: 7, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251] },
      "/revit/delete:2": { status: "Deleted", count: 8, ids: [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252] }
    })
  );

  assert.equal(result.workflow, "documentation_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_cleanup_dry_run_ok" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "documentation_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "documentation_primitives_summary.json"), "utf8"));
  assert.deepEqual(summary.cleanupDryRunIds, [8401, 8381, 8351, 8301, 8101, 8201, 8251]);
  assert.deepEqual(summary.cleanupDeletedIds, [8401, 8381, 8351, 8301, 8101, 8201, 8251, 8252]);
});

test("model edit primitives workflow creates moves and deletes benchmark element", async () => {
  const dir = tempDir("model-edit-primitives-pass");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "model_edit_primitives",
      request: {
        createFamilyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        visualViewId: 401,
        linkRevit: { sourcePath: "benchmark/fixtures/revit/link-source.rvt", pin: true }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-family-instance": { id: 9101, familyName: "Generic Annotation", symbol: "Generic Annotation" },
      "/revit/move-elements:1": { status: "Dry Run", movedIds: [9101], skipped: [], warnings: [], rolledBack: true },
      "/revit/move-elements:2": { status: "Moved", movedIds: [9101], skipped: [], warnings: [], rolledBack: false },
      "/revit/delete:1": { status: "Dry Run", count: 1, ids: [9101] },
      "/revit/delete:2": { status: "Deleted", count: 1, ids: [9101] },
      "/revit/link-revit:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/revit/link-source.rvt" } },
      "/revit/link-revit:2": { status: "Success", sourcePath: "benchmark/fixtures/revit/link-source.rvt", linkTypeId: 9201, linkInstanceId: 9202, pinned: true },
      "/revit/export-image": { status: "Captured", viewId: 401, path: "artifacts/captures/model-edit-after.png" },
      "/revit/delete:3": { status: "Dry Run", count: 1, ids: [9202] },
      "/revit/delete:4": { status: "Deleted", count: 1, ids: [9202] },
      "/revit/delete:5": { status: "Dry Run", count: 1, ids: [9201] },
      "/revit/delete:6": { status: "Deleted", count: 1, ids: [9201] }
    })
  );

  assert.equal(result.workflow, "model_edit_primitives");
  assert.equal(result.success, true);
  for (const name of [
    "family_instance_created_id_present",
    "family_instance_type_matches_request",
    "move_dry_run_ok",
    "move_applied_ids_present",
    "delete_dry_run_ok",
    "delete_applied_ids_present",
    "revit_link_request_present",
    "revit_link_dry_run_ok",
    "revit_link_instance_created_id_present",
    "revit_link_type_created_id_present",
    "revit_link_source_matches_request",
    "revit_link_pin_matches_request",
    "model_edit_post_change_capture_returned",
    "model_edit_post_change_capture_view_id_matches_request",
    "revit_link_cleanup_dry_run_ok",
    "revit_link_cleanup_applied_ids_present",
    "revit_link_type_cleanup_dry_run_ok",
    "revit_link_type_cleanup_applied_ids_present",
    "model_edit_summary_written"
  ]) {
    assert.equal(result.verification_results.some((entry) => entry.name === name && entry.ok), true, name);
  }
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "model_edit_primitives_summary.json"), "utf8"));
  assert.equal(summary.createdId, 9101);
  assert.equal(summary.requestedFamilyInstanceType, "Generic Annotation");
  assert.deepEqual(summary.createdFamilyInstanceLabels, ["generic annotation"]);
  assert.deepEqual(summary.movedIds, [9101]);
  assert.deepEqual(summary.deletedIds, [9101]);
  assert.equal(summary.linkTypeId, 9201);
  assert.equal(summary.linkInstanceId, 9202);
  assert.equal(summary.postChangeCapturePath, "artifacts/captures/model-edit-after.png");
  assert.equal(summary.postChangeCaptureTargetId, 401);
  assert.equal(summary.postChangeCaptureViewId, 401);
  assert.deepEqual(summary.linkCleanupDeletedIds, [9202]);
  assert.deepEqual(summary.linkTypeCleanupDeletedIds, [9201]);
  assert.equal(summary.revitLinkStatus, "linked_then_cleaned_up");
});

test("model edit primitives workflow preflights link and accepts native impacted cleanup ids", async () => {
  const dir = tempDir("model-edit-primitives-preflight-native-cleanup");
  const bridge = new MockBridgeTransport({
    "/revit/link-revit:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/revit/link-source.rvt" } },
    "/revit/create-family-instance": { id: 9101, familyName: "Generic Annotation", symbol: "Generic Annotation" },
    "/revit/move-elements:1": { status: "Dry Run", movedIds: [9101], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:2": { status: "Moved", movedIds: [9101], skipped: [], warnings: [], rolledBack: false },
    "/revit/delete:1": { status: "Dry Run", count: 1, requestedIds: [9101], impactedIds: [9101] },
    "/revit/delete:2": { status: "Deleted", count: 1, requestedIds: [9101], impactedIds: [9101] },
    "/revit/link-revit:2": { status: "Success", sourcePath: "benchmark/fixtures/revit/link-source.rvt", linkTypeId: 9201, linkInstanceId: 9202, pinned: true },
    "/revit/export-image": { status: "Captured", path: "artifacts/captures/model-edit-after.png" },
    "/revit/delete:3": { status: "Dry Run", count: 1, requestedIds: [9202], impactedIds: [9202] },
    "/revit/delete:4": { status: "Deleted", count: 1, requestedIds: [9202], impactedIds: [9202] },
    "/revit/delete:5": { status: "Dry Run", count: 1, requestedIds: [9201], impactedIds: [9201] },
    "/revit/delete:6": { status: "Deleted", count: 1, requestedIds: [9201], impactedIds: [9201] }
  });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "model_edit_primitives",
      request: {
        createFamilyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        linkRevit: { sourcePath: "benchmark/fixtures/revit/link-source.rvt", pin: true }
      }
    },
    dir,
    bridge
  );

  assert.equal(result.workflow, "model_edit_primitives");
  assert.equal(result.success, true);
  assert.equal(bridge.calls[0]?.pathname, "/revit/link-revit");
  assert.equal(bridge.calls[1]?.pathname, "/revit/create-family-instance");
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "model_edit_primitives_summary.json"), "utf8"));
  assert.deepEqual(summary.deletedIds, [9101]);
  assert.deepEqual(summary.linkCleanupDeletedIds, [9202]);
  assert.deepEqual(summary.linkTypeCleanupDeletedIds, [9201]);
});

test("model edit primitives workflow rejects requestedIds-only delete proof", async () => {
  const dir = tempDir("model-edit-primitives-requested-only-delete");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "model_edit_primitives",
      request: {
        createFamilyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        linkRevit: { sourcePath: "benchmark/fixtures/revit/link-source.rvt", pin: true }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/link-revit:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/revit/link-source.rvt" } },
      "/revit/create-family-instance": { id: 9101, familyName: "Generic Annotation", symbol: "Generic Annotation" },
      "/revit/move-elements:1": { status: "Dry Run", movedIds: [9101], skipped: [], warnings: [], rolledBack: true },
      "/revit/move-elements:2": { status: "Moved", movedIds: [9101], skipped: [], warnings: [], rolledBack: false },
      "/revit/delete:1": { status: "Dry Run", count: 1, requestedIds: [9101] },
      "/revit/delete:2": { status: "Deleted", count: 1, requestedIds: [9101] },
      "/revit/link-revit:2": { status: "Success", sourcePath: "benchmark/fixtures/revit/link-source.rvt", linkTypeId: 9201, linkInstanceId: 9202, pinned: true },
      "/revit/export-image": { status: "Captured", path: "artifacts/captures/model-edit-after.png" },
      "/revit/delete:3": { status: "Dry Run", count: 1, impactedIds: [9202] },
      "/revit/delete:4": { status: "Deleted", count: 1, impactedIds: [9202] },
      "/revit/delete:5": { status: "Dry Run", count: 1, impactedIds: [9201] },
      "/revit/delete:6": { status: "Deleted", count: 1, impactedIds: [9201] }
    })
  );

  assert.equal(result.workflow, "model_edit_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_dry_run_ok" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_applied_ids_present" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "model_edit_primitives_summary.json"), "utf8"));
  assert.deepEqual(summary.deletedIds, []);
});

test("model edit primitives workflow rejects Revit link source and pin mismatch", async () => {
  const dir = tempDir("model-edit-primitives-link-proof-mismatch");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "model_edit_primitives",
      request: {
        createFamilyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        visualViewId: 401,
        linkRevit: { sourcePath: "benchmark/fixtures/revit/link-source.rvt", pin: true }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-family-instance": { id: 9101, familyName: "Generic Annotation", symbol: "Generic Annotation" },
      "/revit/move-elements:1": { status: "Dry Run", movedIds: [9101], skipped: [], warnings: [], rolledBack: true },
      "/revit/move-elements:2": { status: "Moved", movedIds: [9101], skipped: [], warnings: [], rolledBack: false },
      "/revit/delete:1": { status: "Dry Run", count: 1, ids: [9101] },
      "/revit/delete:2": { status: "Deleted", count: 1, ids: [9101] },
      "/revit/link-revit:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/revit/link-source.rvt" } },
      "/revit/link-revit:2": { status: "Success", sourcePath: "benchmark/fixtures/revit/other-source.rvt", linkTypeId: 9201, linkInstanceId: 9202, pinned: false },
      "/revit/export-image": { status: "Captured", viewId: 401, path: "artifacts/captures/model-edit-after.png" },
      "/revit/delete:3": { status: "Dry Run", count: 1, ids: [9202] },
      "/revit/delete:4": { status: "Deleted", count: 1, ids: [9202] },
      "/revit/delete:5": { status: "Dry Run", count: 1, ids: [9201] },
      "/revit/delete:6": { status: "Deleted", count: 1, ids: [9201] }
    })
  );

  assert.equal(result.workflow, "model_edit_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "revit_link_instance_created_id_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "revit_link_type_created_id_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "revit_link_source_matches_request" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "revit_link_pin_matches_request" && !entry.ok), true);
});

test("model edit primitives workflow can unload link type before strict cleanup", async () => {
  const dir = tempDir("model-edit-primitives-unload-type-cleanup");
  const bridge = new MockBridgeTransport({
    "/revit/link-revit:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/revit/link-source.rvt" } },
    "/revit/create-family-instance": { id: 9101, familyName: "Generic Annotation", symbol: "Generic Annotation" },
    "/revit/move-elements:1": { status: "Dry Run", movedIds: [9101], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:2": { status: "Moved", movedIds: [9101], skipped: [], warnings: [], rolledBack: false },
    "/revit/delete:1": { status: "Dry Run", count: 1, requestedIds: [9101], impactedIds: [9101] },
    "/revit/delete:2": { status: "Deleted", count: 1, requestedIds: [9101], impactedIds: [9101] },
    "/revit/link-revit:2": { status: "Success", sourcePath: "benchmark/fixtures/revit/link-source.rvt", linkTypeId: 9201, linkInstanceId: 9202, pinned: true },
    "/revit/export-image": { status: "Captured", path: "artifacts/captures/model-edit-after.png" },
    "/revit/delete:3": { status: "Dry Run", count: 1, requestedIds: [9202], impactedIds: [9202] },
    "/revit/delete:4": { status: "Deleted", count: 1, requestedIds: [9202], impactedIds: [9202] },
    "/revit/link-revit:3": { status: "Dry Run", dryRun: true, plan: { action: "unload", linkTypeId: 9201 } },
    "/revit/link-revit:4": { status: "Unloaded", action: "unload", linkTypeId: 9201 },
    "/revit/delete:5": { status: "Dry Run", count: 1, requestedIds: [9201], impactedIds: [9201] },
    "/revit/delete:6": { status: "Deleted", count: 1, requestedIds: [9201], impactedIds: [9201] }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "model_edit_primitives",
      request: {
        createFamilyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        linkRevit: { sourcePath: "benchmark/fixtures/revit/link-source.rvt", pin: true },
        unloadLinkTypeBeforeCleanup: true
      }
    },
    dir,
    bridge
  );

  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "revit_link_type_unload_dry_run_ok" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "revit_link_type_unload_applied_ok" && entry.ok), true);
  const linkCalls = bridge.calls.filter((call) => call.pathname === "/revit/link-revit");
  assert.equal((linkCalls[2].body as any).action, "unload");
  assert.equal((linkCalls[2].body as any).dryRun, true);
  assert.equal((linkCalls[3].body as any).action, "unload");
  assert.equal((linkCalls[3].body as any).dryRun, false);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "model_edit_primitives_summary.json"), "utf8"));
  assert.equal(summary.unloadLinkTypeBeforeCleanup, true);
  assert.equal(summary.linkTypeUnloadApplied.status, "Unloaded");
  assert.deepEqual(summary.linkTypeCleanupDeletedIds, [9201]);
});

test("model edit primitives workflow accepts link type already deleted with instance cleanup", async () => {
  const dir = tempDir("model-edit-primitives-link-type-dependent-cleanup");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "model_edit_primitives",
      request: {
        createFamilyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        linkRevit: { sourcePath: "benchmark/fixtures/revit/link-source.rvt", pin: true }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/link-revit:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/revit/link-source.rvt" } },
      "/revit/create-family-instance": { id: 9101, familyName: "Generic Annotation", symbol: "Generic Annotation" },
      "/revit/move-elements:1": { status: "Dry Run", movedIds: [9101], skipped: [], warnings: [], rolledBack: true },
      "/revit/move-elements:2": { status: "Moved", movedIds: [9101], skipped: [], warnings: [], rolledBack: false },
      "/revit/delete:1": { status: "Dry Run", count: 1, requestedIds: [9101], impactedIds: [9101] },
      "/revit/delete:2": { status: "Deleted", count: 1, requestedIds: [9101], impactedIds: [9101] },
      "/revit/link-revit:2": { status: "Success", sourcePath: "benchmark/fixtures/revit/link-source.rvt", linkTypeId: 9201, linkInstanceId: 9202, pinned: true },
      "/revit/export-image": { status: "Captured", path: "artifacts/captures/model-edit-after.png" },
      "/revit/delete:3": { status: "Dry Run", count: 2, requestedIds: [9202], impactedIds: [9201, 9202] },
      "/revit/delete:4": { status: "Deleted", count: 2, requestedIds: [9202], impactedIds: [9201, 9202] }
    })
  );

  assert.equal(result.success, true);
  assert.equal(result.verification_results.some((entry) => entry.name === "revit_link_type_cleanup_applied_ids_present" && entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "model_edit_primitives_summary.json"), "utf8"));
  assert.deepEqual(summary.linkCleanupImpactedIds, [9201, 9202]);
  assert.deepEqual(summary.linkTypeCleanupDeletedIds, [9201]);
});

test("model edit primitives workflow can skip link type cleanup for live repeat reuse", async () => {
  const dir = tempDir("model-edit-primitives-skip-type-cleanup");
  const bridge = new MockBridgeTransport({
    "/revit/link-revit:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/revit/link-source.rvt" } },
    "/revit/create-family-instance": { id: 9101, familyName: "Generic Annotation", symbol: "Generic Annotation" },
    "/revit/move-elements:1": { status: "Dry Run", movedIds: [9101], skipped: [], warnings: [], rolledBack: true },
    "/revit/move-elements:2": { status: "Moved", movedIds: [9101], skipped: [], warnings: [], rolledBack: false },
    "/revit/delete:1": { status: "Dry Run", count: 1, requestedIds: [9101], impactedIds: [9101] },
    "/revit/delete:2": { status: "Deleted", count: 1, requestedIds: [9101], impactedIds: [9101] },
    "/revit/link-revit:2": { status: "Success", sourcePath: "benchmark/fixtures/revit/link-source.rvt", linkTypeId: 9201, linkInstanceId: 9202, pinned: true },
    "/revit/export-image": { status: "Captured", path: "artifacts/captures/model-edit-after.png" },
    "/revit/delete:3": { status: "Dry Run", count: 1, requestedIds: [9202], impactedIds: [9202] },
    "/revit/delete:4": { status: "Deleted", count: 1, requestedIds: [9202], impactedIds: [9202] }
  });

  const result = await runRevitDemoWorkflow(
    {
      workflow: "model_edit_primitives",
      request: {
        createFamilyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        linkRevit: { sourcePath: "benchmark/fixtures/revit/link-source.rvt", pin: true },
        cleanupLinkType: false
      }
    },
    dir,
    bridge
  );

  assert.equal(result.success, true);
  assert.equal(bridge.calls.filter((call) => call.pathname === "/revit/delete").length, 4);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "model_edit_primitives_summary.json"), "utf8"));
  assert.equal(summary.cleanupLinkType, false);
  assert.deepEqual(summary.linkTypeCleanupDeletedIds, []);
});

test("model edit primitives workflow rejects created family instance type mismatch", async () => {
  const dir = tempDir("model-edit-primitives-create-type-fail");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "model_edit_primitives",
      request: {
        createFamilyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        linkRevit: { sourcePath: "benchmark/fixtures/revit/link-source.rvt", pin: true }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-family-instance": { id: 9101, name: "Air Terminal Supply", family: "Air Terminal" },
      "/revit/move-elements:1": { status: "Dry Run", movedIds: [9101], skipped: [], warnings: [], rolledBack: true },
      "/revit/move-elements:2": { status: "Moved", movedIds: [9101], skipped: [], warnings: [], rolledBack: false },
      "/revit/delete:1": { status: "Dry Run", count: 1, ids: [9101] },
      "/revit/delete:2": { status: "Deleted", count: 1, ids: [9101] },
      "/revit/link-revit:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/revit/link-source.rvt" } },
      "/revit/link-revit:2": { status: "Success", linkTypeId: 9201, linkInstanceId: 9202, pinned: true },
      "/revit/export-image": { status: "Captured", path: "artifacts/captures/model-edit-after.png" },
      "/revit/delete:3": { status: "Dry Run", count: 1, ids: [9202] },
      "/revit/delete:4": { status: "Deleted", count: 1, ids: [9202] },
      "/revit/delete:5": { status: "Dry Run", count: 1, ids: [9201] },
      "/revit/delete:6": { status: "Deleted", count: 1, ids: [9201] }
    })
  );

  assert.equal(result.workflow, "model_edit_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "family_instance_created_id_present" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "family_instance_type_matches_request" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "model_edit_primitives_summary.json"), "utf8"));
  assert.equal(summary.requestedFamilyInstanceType, "Generic Annotation");
  assert.deepEqual(summary.createdFamilyInstanceLabels, ["air terminal supply", "air terminal"]);
});

test("model edit primitives workflow fails when move apply omits created id", async () => {
  const dir = tempDir("model-edit-primitives-move-fail");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "model_edit_primitives",
      request: {
        createFamilyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        linkRevit: { sourcePath: "benchmark/fixtures/revit/link-source.rvt", pin: true }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-family-instance": { id: 9101, name: "Generic Annotation", family: "Generic Annotation" },
      "/revit/move-elements:1": { status: "Dry Run", movedIds: [9101], skipped: [], warnings: [], rolledBack: true },
      "/revit/move-elements:2": { status: "Failed", movedIds: [], skipped: [{ id: 9101, reason: "Pinned" }], rolledBack: true },
      "/revit/delete:1": { status: "Dry Run", count: 1, ids: [9101] },
      "/revit/delete:2": { status: "Deleted", count: 1, ids: [9101] },
      "/revit/link-revit:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/revit/link-source.rvt" } },
      "/revit/link-revit:2": { status: "Success", linkTypeId: 9201, linkInstanceId: 9202, pinned: true },
      "/revit/export-image": { status: "Captured", path: "artifacts/captures/model-edit-after.png" },
      "/revit/delete:3": { status: "Dry Run", count: 1, ids: [9202] },
      "/revit/delete:4": { status: "Deleted", count: 1, ids: [9202] },
      "/revit/delete:5": { status: "Dry Run", count: 1, ids: [9201] },
      "/revit/delete:6": { status: "Deleted", count: 1, ids: [9201] }
    })
  );

  assert.equal(result.workflow, "model_edit_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_applied_ids_present" && !entry.ok), true);
  assert.match(result.failure_reason ?? "", /Model edit primitives/i);
});

test("model edit primitives workflow rejects wrong-id move and delete evidence", async () => {
  const dir = tempDir("model-edit-primitives-wrong-ids");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "model_edit_primitives",
      request: {
        createFamilyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        linkRevit: { sourcePath: "benchmark/fixtures/revit/link-source.rvt", pin: true }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-family-instance": { id: 9101, name: "Generic Annotation", family: "Generic Annotation" },
      "/revit/move-elements:1": { status: "Dry Run", movedIds: [9999], skipped: [], warnings: [], rolledBack: true },
      "/revit/move-elements:2": { status: "Moved", movedIds: [9999], skipped: [], warnings: [], rolledBack: false },
      "/revit/delete:1": { status: "Dry Run", count: 1, ids: [9999] },
      "/revit/delete:2": { status: "Deleted", count: 1, ids: [9999] },
      "/revit/link-revit:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/revit/link-source.rvt" } },
      "/revit/link-revit:2": { status: "Success", linkTypeId: 9201, linkInstanceId: 9202, pinned: true },
      "/revit/export-image": { status: "Captured", path: "artifacts/captures/model-edit-after.png" },
      "/revit/delete:3": { status: "Dry Run", count: 1, ids: [9202] },
      "/revit/delete:4": { status: "Deleted", count: 1, ids: [9202] },
      "/revit/delete:5": { status: "Dry Run", count: 1, ids: [9201] },
      "/revit/delete:6": { status: "Deleted", count: 1, ids: [9201] }
    })
  );

  assert.equal(result.workflow, "model_edit_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_dry_run_ok" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "move_applied_ids_present" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_dry_run_ok" && !entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "delete_applied_ids_present" && !entry.ok), true);
});

test("model edit primitives workflow rejects missing post-change capture path", async () => {
  const dir = tempDir("model-edit-primitives-missing-capture");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "model_edit_primitives",
      request: {
        createFamilyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        linkRevit: { sourcePath: "benchmark/fixtures/revit/link-source.rvt", pin: true }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-family-instance": { id: 9101, name: "Generic Annotation", family: "Generic Annotation" },
      "/revit/move-elements:1": { status: "Dry Run", movedIds: [9101], skipped: [], warnings: [], rolledBack: true },
      "/revit/move-elements:2": { status: "Moved", movedIds: [9101], skipped: [], warnings: [], rolledBack: false },
      "/revit/delete:1": { status: "Dry Run", count: 1, ids: [9101] },
      "/revit/delete:2": { status: "Deleted", count: 1, ids: [9101] },
      "/revit/link-revit:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/revit/link-source.rvt" } },
      "/revit/link-revit:2": { status: "Success", linkTypeId: 9201, linkInstanceId: 9202, pinned: true },
      "/revit/export-image": { status: "Captured" },
      "/revit/delete:3": { status: "Dry Run", count: 1, ids: [9202] },
      "/revit/delete:4": { status: "Deleted", count: 1, ids: [9202] },
      "/revit/delete:5": { status: "Dry Run", count: 1, ids: [9201] },
      "/revit/delete:6": { status: "Deleted", count: 1, ids: [9201] }
    })
  );

  assert.equal(result.workflow, "model_edit_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "model_edit_post_change_capture_returned" && !entry.ok), true);
});

test("model edit primitives workflow rejects post-change capture from the wrong view", async () => {
  const dir = tempDir("model-edit-primitives-wrong-capture-view");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "model_edit_primitives",
      request: {
        createFamilyInstance: { familyName: "", symbolName: "Generic Annotation", levelName: "", x: 0, y: 0, z: 0 },
        move: { mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0, behavior: "allOrNothing" },
        visualViewId: 401,
        linkRevit: { sourcePath: "benchmark/fixtures/revit/link-source.rvt", pin: true }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/create-family-instance": { id: 9101, name: "Generic Annotation", family: "Generic Annotation" },
      "/revit/move-elements:1": { status: "Dry Run", movedIds: [9101], skipped: [], warnings: [], rolledBack: true },
      "/revit/move-elements:2": { status: "Moved", movedIds: [9101], skipped: [], warnings: [], rolledBack: false },
      "/revit/delete:1": { status: "Dry Run", count: 1, ids: [9101] },
      "/revit/delete:2": { status: "Deleted", count: 1, ids: [9101] },
      "/revit/link-revit:1": { status: "Dry Run", dryRun: true, plan: { sourcePath: "benchmark/fixtures/revit/link-source.rvt" } },
      "/revit/link-revit:2": { status: "Success", linkTypeId: 9201, linkInstanceId: 9202, pinned: true },
      "/revit/export-image": { status: "Captured", viewId: 9999, path: "artifacts/captures/model-edit-after.png" },
      "/revit/delete:3": { status: "Dry Run", count: 1, ids: [9202] },
      "/revit/delete:4": { status: "Deleted", count: 1, ids: [9202] },
      "/revit/delete:5": { status: "Dry Run", count: 1, ids: [9201] },
      "/revit/delete:6": { status: "Deleted", count: 1, ids: [9201] }
    })
  );

  assert.equal(result.workflow, "model_edit_primitives");
  assert.equal(result.success, false);
  assert.equal(result.verification_results.some((entry) => entry.name === "model_edit_post_change_capture_returned" && entry.ok), true);
  assert.equal(result.verification_results.some((entry) => entry.name === "model_edit_post_change_capture_view_id_matches_request" && !entry.ok), true);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, "artifacts", "model_edit_primitives_summary.json"), "utf8"));
  assert.equal(summary.postChangeCaptureTargetId, 401);
  assert.equal(summary.postChangeCaptureViewId, 9999);
});
