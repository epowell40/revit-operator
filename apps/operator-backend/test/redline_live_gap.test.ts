import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testOnlyBuildInitialRedlinePreflightAction, __testOnlyIsFastElectricalPlacementRedline, __testOnlyRunInitialRedlineDecisionLane, __testOnlyShouldPrioritizeInitialRedlinePreflight } from "../src/brains/openai_brain.js";
import { __testOnlyMaybeRunTopLevelMepRouteRedline } from "../src/brain.js";
import { executeWorkbenchActions } from "../src/workbench/workbench_runner.js";
import { buildCommentedPdf } from "./fixtures/commented_pdf.js";

const attachment = [{ id: "duct-redline", filename: "duct.pdf", relative_path: "artifacts/uploads/duct.pdf", mime: "application/pdf" }] as any;
const readOnlyPrompt = "Analyze the attached duct redline for deterministic intent evidence only; do not create/edit/delete/write.";
const failedLivePrompt = "analyze `marked-unit405-12x10-duct.pdf` through the deterministic redline-analysis lane and return its AEC intent/evidence record. Do not plan, return, or execute `/revit/*`, dry-run, apply, create, edit, delete, or write actions.\n\nAttachments:\n- [1] marked-unit405-12x10-duct.pdf (id=9b6f83e1-fd28-40ab-bc86-3036451fb67f, path=artifacts/uploads/20260711063335_marked-unit405-12x10-duct.pdf, sha256=74b03227b1e9…, bytes=863274)";
const failedLiveAttachment = [{ id: "9b6f83e1-fd28-40ab-bc86-3036451fb67f", filename: "marked-unit405-12x10-duct.pdf", relative_path: "artifacts/uploads/20260711063335_marked-unit405-12x10-duct.pdf", mime: "application/pdf" }] as any;

test("explicit read-only duct-redline analysis preflight wins over fast bridge classification", () => {
  const action = __testOnlyBuildInitialRedlinePreflightAction({ userText: readOnlyPrompt, userAttachments: attachment });
  assert.equal(__testOnlyShouldPrioritizeInitialRedlinePreflight({ userText: readOnlyPrompt, userAttachments: attachment }), true);
  assert.equal(__testOnlyIsFastElectricalPlacementRedline({ userText: readOnlyPrompt, userAttachments: attachment }), false);
  assert.equal(action?.type, "analyze_redline"); assert.equal(action?.file_path, "artifacts/uploads/duct.pdf");
  assert.equal(__testOnlyShouldPrioritizeInitialRedlinePreflight({ userText: "delete this duct", userAttachments: attachment }), false);
  assert.equal(__testOnlyShouldPrioritizeInitialRedlinePreflight({ userText: failedLivePrompt, userAttachments: failedLiveAttachment }), true);
  const failedLiveAction = __testOnlyBuildInitialRedlinePreflightAction({ userText: failedLivePrompt, userAttachments: failedLiveAttachment });
  assert.equal(failedLiveAction?.type, "analyze_redline");
  if (failedLiveAction?.type === "analyze_redline") assert.equal(failedLiveAction.file_path, failedLiveAttachment[0].relative_path);
  assert.equal(__testOnlyShouldPrioritizeInitialRedlinePreflight({ userText: "Analyze this redline, then add a receptacle.", userAttachments: attachment }), false);
  assert.equal(__testOnlyShouldPrioritizeInitialRedlinePreflight({ userText: "Analyze this redline and delete the marked duct.", userAttachments: attachment }), false);
  for (const prompt of ["Analyze this redline and replace the marked duct.", "Analyze this redline and remove the marked duct.", "Analyze this redline and make the marked changes.", "Analyze this redline; do not merely summarize, create the marked duct.", "Analyze this redline without changing the model, then reroute the marked duct.", "Analyze this redline without changing the model, replace the marked duct.", "Analyze this redline; do not delete the old duct, replace it.", "Analyze this redline; do not delete, replace actions.", "Analyze this redline and relocate, swap, adjust, or revise the marked duct."]) assert.equal(__testOnlyShouldPrioritizeInitialRedlinePreflight({ userText: prompt, userAttachments: attachment }), false, prompt);
  for (const prompt of ["Analyze this redline and install the marked diffuser.", "Analyze this redline and provide the marked receptacle.", "Analyze this redline and extend the duct run.", "Analyze this redline and branch or tap the main.", "Analyze this redline and rotate or shift the tag.", "Analyze this redline and demolish or erase the note.", "Analyze this redline and tag or label the duct.", "Analyze this redline and set the parameter.", "Analyze this redline and hide or show the link.", "Analyze this redline and correct the schedule text.", "Analyze this redline and implement the markup.", "Analyze this redline and duplicate or copy the view."]) assert.equal(__testOnlyShouldPrioritizeInitialRedlinePreflight({ userText: prompt, userAttachments: attachment }), false, prompt);
  for (const prompt of ["Analyze this redline and demo the old duct.", "Analyze this redline and take out the marked duct.", "Analyze this redline and strike the note.", "Analyze this redline and x out the device.", "Analyze this redline and reorient the fixture.", "Analyze this redline and insert the receptacle.", "Analyze this redline and put the receptacle on the east wall.", "Analyze this redline and drop the receptacle into room 405.", "Analyze this redline and clone the view.", "Analyze this redline and frobnicate the marked duct.", "Analyze this redline and inspect the attachment."]) assert.equal(__testOnlyShouldPrioritizeInitialRedlinePreflight({ userText: prompt, userAttachments: attachment }), false, prompt);
  for (const prompt of ["Analyze this redline, frobnicate the duct, and return an evidence record.", "Frobnicate the duct based on this redline and return an evidence record.", "Analyze this redline for an evidence record, then frobnicate the duct.", "Analyze this redline and return an evidence record; frobnicate duct A."]) assert.equal(__testOnlyShouldPrioritizeInitialRedlinePreflight({ userText: prompt, userAttachments: attachment }), false, prompt);
  for (const prompt of ["Analyze this redline and frobnicate duct A only.", "Analyze this redline and frobnicate duct A; return a read-only response."]) assert.equal(__testOnlyShouldPrioritizeInitialRedlinePreflight({ userText: prompt, userAttachments: attachment }), false, prompt);
});

test("exact failed-live request uses the production read-only decision lane once and discards returned actions", async () => {
  const order: string[] = []; let summaries = 0, fastCalls = 0;
  const lane = await __testOnlyRunInitialRedlineDecisionLane({
    userText: failedLivePrompt, userAttachments: failedLiveAttachment,
    runInitialPreflight: async (action) => { order.push(action.type); },
    runFastPreflight: async () => { fastCalls += 1; order.push("fast"); return null; },
    summarize: async () => { summaries += 1; order.push("summary"); return { assistant_message: "Grounded deterministic evidence summary.", actions: [{ action_id: "write", method: "POST", path: "/revit/delete", body_json: "{}" }], workbench_actions: [{ type: "shell", command: "should-not-run" }], dev_actions: [{ type: "restart_backend" }], web_requests: [{ request_id: "web", url: "https://example.invalid", purpose: "should-not-run" }] } as any; }
  });
  assert.deepEqual(order, ["analyze_redline", "summary"]); assert.equal(summaries, 1); assert.equal(fastCalls, 0); assert.equal(lane.fastPreflight, null);
  assert.deepEqual(lane.response, { version: "operator.backend.v1", assistant_message: "Grounded deterministic evidence summary.", actions: [] }); assert.equal(JSON.stringify(lane.response).includes("should-not-run"), false); assert.equal(JSON.stringify(lane.response).includes("/revit/delete"), false);
});

test("top-level MEP routing bypass is structured-attachment-only and shared by dispatch modes", async () => {
  assert.equal(failedLivePrompt.length, 427);
  const req = { version: "operator.backend.v1", session_id: "01c787ea-1580-4ccc-9c15-94cbb0568d75", message_id: "6c48bfc5-d3e9-4605-acf2-53254af3ed5c", user_text: failedLivePrompt, user_attachments: failedLiveAttachment } as any;
  let resolverCalls = 0, coordinatorCalls = 0;
  const resolver = async () => { resolverCalls += 1; return { version: "operator.backend.v1", assistant_message: "resolver", actions: [] }; };
  const routed = await __testOnlyMaybeRunTopLevelMepRouteRedline(req, resolver as any);
  const coordinator = async () => { coordinatorCalls += 1; return { version: "operator.backend.v1", assistant_message: "Evidence summary", actions: [] }; };
  const response = routed ?? await coordinator();
  assert.equal(resolverCalls, 0); assert.equal(coordinatorCalls, 1); assert.deepEqual(response, { version: "operator.backend.v1", assistant_message: "Evidence summary", actions: [] });
  for (const variant of [{ ...req, user_text: "Delete this marked duct from the redline." }, { ...req, user_attachments: undefined }, { ...req, user_text: "Analyze this redline attachment." }]) { resolverCalls = 0; await __testOnlyMaybeRunTopLevelMepRouteRedline(variant, resolver as any); assert.equal(resolverCalls, 1); }
});

test("workbench analyze_redline appends only deterministic evidence and preserves legacy details", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redline-live-gap-")), previousRoot = process.env.OPERATOR_WORKSPACE_ROOT, relative = "artifacts/uploads/duct.pdf", file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buildCommentedPdf(1, new Map([[1, "12x10 SA duct 450 CFM"]]))); process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const actions = [{ type: "analyze_redline", file_path: relative, include_pdf_annotations: true }] as const;
    const [result] = await executeWorkbenchActions(actions as any); const details: any = result?.details, evidence = details?.aec_intent_evidence;
    assert.equal(result?.ok, true); assert.equal(details?.file_path, relative); assert.equal(details?.request?.file_path, relative); assert.equal(evidence?.evidence[0]?.sha256, createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
    const annotation = evidence.evidence.find((item: any) => item.kind === "pdf_annotation"); assert.equal(annotation.page.number, 1); assert.deepEqual(annotation.page.normalized_box, { min_x: annotation.page.normalized_box.min_x, min_y: annotation.page.normalized_box.min_y, max_x: annotation.page.normalized_box.max_x, max_y: annotation.page.normalized_box.max_y }); assert.equal(annotation.frame.coordinate_frame, "pdf-page-1-normalized");
    assert.equal(evidence.target.status, "ambiguous"); assert.deepEqual(evidence.intent.proposed_actions.map((item: any) => item.tool), ["/revit/sheets", "/revit/get-titleblock-info"]); assert.ok(evidence.intent.proposed_actions.every((item: any) => item.requires_apply === false)); assert.ok(evidence.verification.observed.every((item: any) => item.status === "not_run")); assert.equal(result?.type, "analyze_redline");
    const [hashFailure] = await executeWorkbenchActions(actions as any, { createRedlineAnalyzeEvidence: async () => { throw new Error("simulated post-analysis hash race"); } }); assert.equal(hashFailure?.ok, true); assert.equal((hashFailure?.details as any)?.aec_intent_evidence, undefined);
    const legacyProjection = (value: any) => { const copy = JSON.parse(JSON.stringify(value)); delete copy?.details?.aec_intent_evidence; delete copy?.details?.vision_artifacts; return copy; };
    assert.deepEqual(legacyProjection(result), legacyProjection(hashFailure));
    const [failed] = await executeWorkbenchActions([{ type: "analyze_redline", file_path: "missing.pdf" }]); assert.equal(failed?.ok, false); assert.equal((failed?.details as any)?.aec_intent_evidence, undefined);
  } finally { if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot; fs.rmSync(root, { recursive: true, force: true }); }
});
