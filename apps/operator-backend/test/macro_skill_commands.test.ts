import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import { saveMacroSkill } from "../src/skills/macro_skills.js";
import { maybeHandleMacroSkill } from "../src/skills/macro_skill_commands.js";

function mkReq(session_id: string, message_id: string, user_text: string, tool_results?: any[]): ChatRequest {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id,
    message_id,
    user_text,
    ...(tool_results ? { tool_results } : {})
  };
}

test("macro skill runs step-by-step and can template from prior results", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  saveMacroSkill({
    id: "test_macro",
    name: "Test Macro",
    description: "Two steps with templating from step 1.",
    inputs: [{ name: "fileName", required: true }],
    actions: [
      { method: "GET", path: "/revit/ping" },
      { method: "POST", path: "/revit/export-pdf", body: { fileName: "Print_{{step.1.result.status}}_{{inputs.fileName}}" } }
    ]
  } as any);

  const r1 = maybeHandleMacroSkill(mkReq("s1", "m1", 'run skill test_macro with {"fileName":"X"}'));
  assert.ok(r1);
  assert.equal(r1!.actions.length, 1);
  assert.equal(r1!.actions[0]!.method, "GET");
  assert.equal(r1!.actions[0]!.path, "/revit/ping");

  const pingActionId = r1!.actions[0]!.action_id;
  const r2 = maybeHandleMacroSkill(
    mkReq("s1", "m2", "", [
      { action_id: pingActionId, method: "GET", path: "/revit/ping", status: "done", result_json: { status: "ok" } }
    ])
  );
  assert.ok(r2);
  assert.equal(r2!.actions.length, 1);
  assert.equal(r2!.actions[0]!.method, "POST");
  assert.equal(r2!.actions[0]!.path, "/revit/export-pdf");
  assert.deepEqual(r2!.actions[0]!.body, { fileName: "Print_ok_X" });

  const pdfActionId = r2!.actions[0]!.action_id;
  const r3 = maybeHandleMacroSkill(
    mkReq("s1", "m3", "", [
      { action_id: pdfActionId, method: "POST", path: "/revit/export-pdf", status: "done", result_json: { status: "Success" } },
      { action_id: pdfActionId + ":__auto_capture", method: "POST", path: "/revit/export-image", status: "done", result_json: { path: "x.png" } }
    ])
  );
  assert.ok(r3);
  assert.equal(r3!.actions.length, 0);
  assert.match(r3!.assistant_message, /Skill complete/i);
});

test("macro skill templating preserves primitive types for full-value templates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  saveMacroSkill({
    id: "test_types",
    name: "Test Types",
    description: "Ensures {{var}} keeps numbers/bools as primitives.",
    inputs: [
      { name: "n", required: true },
      { name: "flag", required: true }
    ],
    actions: [
      {
        method: "POST",
        path: "/revit/export-pdf",
        body: { dryRun: "{{inputs.flag}}", viewIds: [1], fileName: "X_{{inputs.n}}" }
      }
    ]
  } as any);

  const r1 = maybeHandleMacroSkill(mkReq("s2", "m1", 'run skill test_types with {"n":123,"flag":true}'));
  assert.ok(r1);
  assert.equal(r1!.actions.length, 1);
  assert.equal(r1!.actions[0]!.method, "POST");
  assert.equal(r1!.actions[0]!.path, "/revit/export-pdf");

  const body: any = r1!.actions[0]!.body;
  assert.equal(body.dryRun, true);
  assert.deepEqual(body.viewIds, [1]);
  assert.equal(body.fileName, "X_123");
});

test("create proposal writes bundle under workspace/proposals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const r = maybeHandleMacroSkill(mkReq("s3", "m1", "create proposal Add write gate with {\"summary\":\"Test\"}"));
  assert.ok(r);
  assert.equal(r!.actions.length, 0);
  assert.match(r!.assistant_message, /Created proposal bundle/i);

  const proposalsDir = path.join(root, "proposals");
  assert.ok(fs.existsSync(proposalsDir));
  const bundles = fs.readdirSync(proposalsDir).filter(d => fs.statSync(path.join(proposalsDir, d)).isDirectory());
  assert.equal(bundles.length, 1);

  const bundleDir = path.join(proposalsDir, bundles[0]!);
  for (const f of ["summary.md", "repro_steps.md", "patch.diff", "metadata.json"]) {
    assert.ok(fs.existsSync(path.join(bundleDir, f)));
  }
});

test("remember project standard saves structured profile entry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  const r = maybeHandleMacroSkill(mkReq("s4", "m1", "remember project standard sheets: Use E100 series for electrical plans."));
  assert.ok(r);
  assert.equal(r!.actions.length, 0);
  assert.match(r!.assistant_message, /Saved project standard \[sheets\]/);

  const profilePath = path.join(root, "memory", "project_profile.json");
  assert.ok(fs.existsSync(profilePath));
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  assert.equal(profile.standards.length, 1);
  assert.equal(profile.standards[0].category, "sheets");
  assert.equal(profile.standards[0].text, "Use E100 series for electrical plans.");
});

test("show project profile lists saved standards", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;

  maybeHandleMacroSkill(mkReq("s5", "m1", "remember standard titleblocks: Verify titleblock fields with sheet-aware captures."));
  const r = maybeHandleMacroSkill(mkReq("s5", "m2", "show project profile"));

  assert.ok(r);
  assert.equal(r!.actions.length, 0);
  assert.match(r!.assistant_message, /Project standards profile/);
  assert.match(r!.assistant_message, /Verify titleblock fields/);
});

test("remember project requirement infers a stable active-model scope", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const request = mkReq("s6", "m1", "remember project requirement tags.leaders: Keep leaders short and uncrossed.");
  request.context = { revit: { document: { title: "Snowdon Towers HVAC", path: "C:\\Models\\Snowdon.rvt" } } };
  const saved = maybeHandleMacroSkill(request);
  assert.match(saved?.assistant_message ?? "", /Saved durable project requirement req_/);
  const shown = maybeHandleMacroSkill(mkReq("s6", "m2", "show requirements"));
  assert.match(shown?.assistant_message ?? "", /tags\.leaders/);
  assert.match(shown?.assistant_message ?? "", /Keep leaders short and uncrossed/);
});

test("generic durable requirement command supports office and client scopes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-ws-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const office = maybeHandleMacroSkill(mkReq("s7", "m1", "remember requirement office bimtools tags.case: Use ALL CAPS."));
  const client = maybeHandleMacroSkill(mkReq("s7", "m2", "remember requirement client hospital-a rooms.naming: Preserve client room naming."));
  assert.match(office?.assistant_message ?? "", /office:bimtools/);
  assert.match(client?.assistant_message ?? "", /client:hospital-a/);
});
