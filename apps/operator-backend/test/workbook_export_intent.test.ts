import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestedWorkbookExport, requestedWorkbookAssessment, requestedArtifactExportPaths } from "../src/artifact_export_intent.js";
import { classifyAutoGoalRequest } from "../src/goals/auto_goal.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner, guardTeammateMcpCall, buildTeammateTurnContract } from "../src/teammate_loop_runtime.js";
import { prepareAssignmentTurn } from "../src/assignments/turn_preparation.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { openAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";
import { __testOnlyResetGoalListCache } from "../src/goals/service.js";

const prompt = "Prepare a room-by-room Excel workbook of the information we can get from this model for HVAC load calculations. Check that the room or space list and the exported values are correct, keep the units clear, and flag anything important that is missing or cannot be verified. Include a short list of the decisions or other inputs you need from me. Do not change the Revit model or invent final heating and cooling loads.";
const context = { revit: { source: { live: true }, process_id: 42, document: { title: "Rooms", path: "C:/fixture/Rooms.rvt", projectIdentity: { fingerprint: "model" } } } };
const exportArgs = { method: "POST", path: "/revit/export-elements-xlsx", body: { elementIds: [42], parameterNames: ["Area", "Number"], fileName: "rooms.xlsx", dryRun: false } };

test("explicit native Save As remains separate from permission for other model edits", () => {
  const source="Inspect the current panel ratings without changing them. Save a separate copy to C:\\fixture\\Delivery Verified.rvt. Do not overwrite the starting model or any existing result. Verify the save and exact destination through native results and fresh document readback. Do not substitute another folder. No other model edits or linked-model changes.";
  assert.deepEqual(requestedArtifactExportPaths(source),["/revit/save-as"]);
  for (const text of ["Save as C:\\fixture\\Copy.rvt. Do not change model elements.",source]) {
    const owner={}, lease=beginTeammateLoopOwner(owner,{user_text:text,context} as any);
    try {
      for(const dryRun of [true,false]) assert.equal(guardTeammateMcpCall(owner,{tool:"revit_call_tool",arguments:{method:"POST",path:"/revit/save-as",body:{filePath:"C:\\fixture\\Delivery Verified.rvt",overwrite:false,dryRun}}}).allowed,true);
      assert.equal(guardTeammateMcpCall(owner,{tool:"revit_call_tool",arguments:{method:"POST",path:"/revit/delete",body:{elementIds:[42]}}}).allowed,false);
    } finally { endTeammateLoopOwner(lease); }
  }
  for(const text of ["Read-only: save a separate copy to C:\\fixture\\Copy.rvt.",
    "Save a separate copy to C:\\fixture\\Copy.rvt after I approve.","Save a separate copy to C:\\fixture\\Copy.rvt later.",
    "Explain how to save as C:\\fixture\\Copy.rvt.","Should we save a separate copy to C:\\fixture\\Copy.rvt?",
    "Save a separate copy to C:\\fixture\\Copy.rvt. Do not save the model.","Do not save as C:\\fixture\\Copy.rvt.",
    "Save a separate copy to C:\\fixture\\Copy.rvt. Don't write any files.","Save a separate copy to C:\\fixture\\Copy.rvt without saving.",
    "Inspect the model and list its save options.","Save a PDF to C:\\fixture\\sheet.pdf; the source was Model.rvt."])
    assert(!requestedArtifactExportPaths(text).includes("/revit/save-as"),text);
});

test("scoped workbook briefs retain file authority through normal admission and no-model-write guards", () => {
  for (const text of [
    "This is a software acceptance exercise using synthetic airflows, not a project HVAC design. For the 12 spaces below, prepare a source-checked input workbook, a proposed device quantity schedule, and a short missing-input/review schedule. Do not change Revit.",
    "For these spaces, please prepare an Excel workbook. Do not change the model.",
    "Using the open model, export a workbook of spaces. Flag missing values. Do not change Revit."
  ]) {
    assert.equal(requestedWorkbookExport(text), true, text);
    assert.equal(classifyAutoGoalRequest(text).requestedEffect, "apply");
    const owner = {}, lease = beginTeammateLoopOwner(owner, { user_text: text, context } as any);
    try {
      assert.equal(guardTeammateMcpCall(owner, { tool: "revit_call_tool", arguments: exportArgs }).allowed, true);
      assert.equal(guardTeammateMcpCall(owner, { tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/delete", body: { elementIds: [42] } } }).allowed, false);
    } finally { endTeammateLoopOwner(lease); }
  }
  for (const text of ["For these spaces, should we prepare an Excel workbook?", "For these spaces, do not prepare an Excel workbook.",
    "Using the open model, explain how to prepare an Excel workbook.", "For these spaces, prepare a workbook without writing any output files."])
    assert.equal(requestedWorkbookExport(text), false, text);
});

test("C25 workbook request authorizes one file capability while preserving the no-model-write boundary", () => {
  assert.equal(requestedWorkbookExport(prompt), true);
  assert.equal(classifyAutoGoalRequest(prompt).requestedEffect, "apply");
  const req = { user_text: prompt, context } as any;
  const contract = buildTeammateTurnContract(req);
  assert.equal(contract.no_write, true); assert.equal(contract.write_authorized, false);
  assert.deepEqual(contract.file_export_paths, [exportArgs.path]);
  for (const [args, expected] of [[exportArgs, true],
    [{ method: "POST", path: "/revit/set-parameters", body: { elementIds: [42], parameters: { Comments: "changed" } } }, false],
    [{ method: "POST", path: "/revit/delete", body: { elementIds: [42] } }, false],
    [{ method: "POST", path: "/revit/export-pdf", body: { viewIds: [42] } }, false]] as const) {
    const owner = {}; const lease = beginTeammateLoopOwner(owner, req);
    try { assert.equal(guardTeammateMcpCall(owner, { tool: "revit_call_tool", arguments: args }).allowed, expected, args.path); }
    finally { endTeammateLoopOwner(lease); }
  }
});

test("neighboring conceptual, preview, negated and file-prohibited prompts do not authorize workbook publication", () => {
  for (const text of ["Can you explain how to export an Excel workbook?", "Should we prepare an Excel workbook?",
    "Read-only: prepare an Excel workbook plan.", "Preview the Excel export. Do not create any files.",
    "Prepare an Excel workbook. Do not export.", "Prepare an Excel workbook. Do not save any files.",
    "Prepare an Excel workbook without writing output files.", "Prepare an Excel workbook. Don't change anything.",
    "Find the room parameters needed for an Excel workbook.", "Do not prepare an Excel workbook."]) {
    assert.equal(requestedWorkbookExport(text), false, text);
    const owner = {}; const lease = beginTeammateLoopOwner(owner, { user_text: text, context } as any);
    try { assert.equal(guardTeammateMcpCall(owner, { tool: "revit_call_tool", arguments: exportArgs }).allowed, false, text); }
    finally { endTeammateLoopOwner(lease); }
  }
  for (const text of ["Create an Excel workbook of all rooms. Do not change the model.",
    "Could you export the spaces to an Excel spreadsheet without modifying the model?", prompt]) assert(requestedWorkbookExport(text), text);
});

test("ordinary chat creates an immutable apply owner but canonical admission still rejects model writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-workbook-admission-"));
  const previous = [process.env.OPERATOR_WORKSPACE_ROOT, process.env.OPERATOR_ASSIGNMENT_KERNEL_V2];
  process.env.OPERATOR_WORKSPACE_ROOT = root; process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1"; __testOnlyResetGoalListCache();
  try {
    const prepared = prepareAssignmentTurn({ sessionId: "workbook-session", messageId: "message", userText: prompt,
      toolResults: [], source: "chat", createdBy: "principal", requestContext: context })!;
    const snapshot = getAssignmentKernelSnapshotV2(prepared.assignmentId)!;
    assert.equal(snapshot.spec.requested_effect, "apply");
    assert.equal(snapshot.spec.result_delivery_required, true);
    assert.equal(snapshot.spec.result_assessment_required, true);
    for (const args of [{ ...exportArgs, path: "/revit/set-parameters" }, { ...exportArgs, path: "/revit/delete" }]) {
      assert.throws(() => openAssignmentKernelOperationV2({ snapshot, controller_request_id: "blocked", provider_turn_id: "turn",
        capability_id: "revit_call_tool", classified_effect: "apply", arguments: args }), /user_no_model_write_limit/);
    }
    const admitted = openAssignmentKernelOperationV2({ snapshot, controller_request_id: "export", provider_turn_id: "turn",
      capability_id: "revit_call_tool", classified_effect: "apply", arguments: exportArgs });
    assert(admitted);
  } finally {
    __closeForTests(); __testOnlyResetGoalListCache();
    for (const [i, key] of ["OPERATOR_WORKSPACE_ROOT", "OPERATOR_ASSIGNMENT_KERNEL_V2"].entries()) {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requested workbook analysis is distinct from a plain export, preview, or prohibited file", () => {
  assert.equal(requestedWorkbookAssessment(prompt), true);
  assert.equal(requestedWorkbookAssessment("Create an Excel workbook of spaces. Flag missing values and list questions."), true);
  for (const request of ["Export an Excel workbook of rooms.", "Preview the Excel workbook and flag missing values.",
    "Review the room values without writing any files.", "Prepare an Excel workbook. Do not save any files."])
    assert.equal(requestedWorkbookAssessment(request), false, request);
});

test("artifact preflight checks do not turn an affirmative file request into preview-only work", () => {
  const requests = [
    "Resolve one bounded mechanical sub-discipline sheet set, export it as one combined color PDF named TEST-MECHANICAL-ISSUE.pdf in the benchmark output folder, then verify the file exists, is nonempty, has the same page count and ordering as the preflight sheet list, and record a content hash.",
    "Export the selected sheets to a combined PDF. Compare its pages with the preflight sheet list. Do not change the Revit model.",
    "For the current sheets, create a PDF and check the page order against the preflight list. Do not change Revit.",
    "Preflight the sheet list, then export a PDF. Do not change the model."
  ];
  for (const text of requests) {
    assert.deepEqual(requestedArtifactExportPaths(text), ["/revit/export-pdf"], text);
    assert.equal(classifyAutoGoalRequest(text).requestedEffect, "apply", text);
    const owner = {}, lease = beginTeammateLoopOwner(owner, { user_text: text, context } as any);
    try {
      assert.equal(guardTeammateMcpCall(owner, { tool: "revit_call_tool", arguments: {
        method: "POST", path: "/revit/export-pdf", body: { viewIds: [42], fileName: "sheets.pdf" }
      } }).allowed, true, text);
    } finally { endTeammateLoopOwner(lease); }
  }
  assert.equal(requestedWorkbookExport("Export a workbook and compare its rows against the preflight list."), true);
  for (const text of [
    "Preview the PDF export.", "Export a PDF as a preview only.", "Preflight the PDF export and report the plan.",
    "Export a PDF after I approve the list.", "If I confirm, export a PDF.", "Export a PDF later.",
    "Create a PDF without writing any files.", "Create a PDF. Do not save the PDF.",
    "Can you explain how to export a PDF?", "Should we export a PDF?", "Do not export a PDF.",
    "Read-only: export a PDF plan.", "Preview the sheet set, then export a PDF only if I approve.",
    "Review only: export a PDF.", "Export a PDF. Do not commit.", "Export a PDF. Don't write."
  ]) assert.deepEqual(requestedArtifactExportPaths(text), [], text);
});

test("PDF-only authority reaches canonical admission without allowing a workbook or model mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-pdf-admission-"));
  const previous = [process.env.OPERATOR_WORKSPACE_ROOT, process.env.OPERATOR_ASSIGNMENT_KERNEL_V2];
  process.env.OPERATOR_WORKSPACE_ROOT = root; process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1"; __testOnlyResetGoalListCache();
  const text = "Export the sheets as a combined PDF. Verify against the preflight sheet list. Do not change the model.";
  try {
    const prepared = prepareAssignmentTurn({ sessionId: "pdf-session", messageId: "message", userText: text,
      toolResults: [], source: "chat", createdBy: "principal", requestContext: context })!;
    const snapshot = getAssignmentKernelSnapshotV2(prepared.assignmentId)!;
    assert.equal(snapshot.spec.requested_effect, "apply");
    assert.deepEqual(buildTeammateTurnContract({ user_text: text, context } as any).file_export_paths, ["/revit/export-pdf"]);
    for (const deniedPath of ["/revit/set-parameters", "/revit/delete", "/revit/export-elements-xlsx"]) {
      assert.throws(() => openAssignmentKernelOperationV2({ snapshot, controller_request_id: deniedPath, provider_turn_id: "turn",
        capability_id: "revit_call_tool", classified_effect: "apply", arguments: { ...exportArgs, path: deniedPath } }),
      /user_no_model_write_limit|explicit_workbook_export_authority_required/);
    }
    assert(openAssignmentKernelOperationV2({ snapshot, controller_request_id: "pdf", provider_turn_id: "turn",
      capability_id: "revit_call_tool", classified_effect: "apply", arguments: {
        method: "POST", path: "/revit/export-pdf", body: { viewIds: [42], fileName: "sheets.pdf" }
      } }));
  } finally {
    __closeForTests(); __testOnlyResetGoalListCache();
    for (const [i, key] of ["OPERATOR_WORKSPACE_ROOT", "OPERATOR_ASSIGNMENT_KERNEL_V2"].entries()) {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
