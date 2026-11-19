import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { routeConversation, intakeDecisionIssues } from "../src/conversation_intake.js";
import { storeAttachmentUpload } from "../src/attachments/upload_store.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

test("complete short registered references support one direct answer after authenticated intake", async t => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-intake-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  t.after(() => {
    __closeForTests();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true });
  });
  const session_id = "source-intake-test";
  const uploads = [
    ["Prior equipment.json", '{"tag":"EA-12","airflow_cfm":275}'],
    ["Room crosswalk.csv", "Sector,Room\nEast mezzanine,421B\n"],
    ["Preservation note.txt", "Preserve the existing panel names. 留用现有配电盘名称。"],
  ].map(([filename, text]) => storeAttachmentUpload({
    filename: filename!, session_id, data_base64: Buffer.from(text!).toString("base64"),
  }));
  const user_text = "These three files are examples from earlier projects. Compare them and give me three things, with the source filename for each: the airflow for EA-12, the room associated with East mezzanine, and what the preservation note says to keep. Treat the examples as references only. Leave the current Revit model untouched and do not save a file.";
  const answer = "EA-12 is 275 CFM (Prior equipment.json). East mezzanine is room 421B (Room crosswalk.csv). Keep the existing panel names (Preservation note.txt).";
  const body = { version: "operator.backend.v1" as const, session_id, message_id: "source-only", user_text,
    intake_attachment_count: uploads.length, intake_attachment_ids: uploads.map(upload => upload.id) };
  let calls = 0;
  const interpreter = { interpret: async (input: any) => {
    calls++;
    assert.deepEqual(input.registered_references.map((ref: any) => ref.sha256), uploads.map(upload => upload.sha256));
    assert.match(input.registered_references[2].text, /留用现有配电盘名称/);
    return { value: { route: "answer", answer, basis: "registered_references", requested_effect: "none",
      entire_request_answered: true, confidence: 0.99, reason: "The registered files answer every part.",
      question_kind: "research", identity_fields: [], read_evidence: "not_applicable", operation_scope: null } };
  } };
  const result = await routeConversation(body, interpreter);
  assert.equal(result.route, "answer");
  assert.equal(result.assistant_message, answer);
  assert.equal(calls, 1);
  assert.deepEqual(await routeConversation(body, interpreter), { ...result, replayed: true });
  assert.equal(calls, 1);
  const ordinaryRead = {
    route: "task", answer: null, basis: "needs_tools", requested_effect: "read", entire_request_answered: false,
    confidence: 0.99, reason: "More evidence is needed.", question_kind: "research", identity_fields: [],
    read_evidence: "other", operation_scope: {
      schema: "revit-operator.interpreted-operation-scope/v1", requested_effect: "read", model_effect: "read",
      protected_clauses: [], prerequisites: [],
    },
  };
  const handoff = { interpret: async (input: any) => {
    assert.equal(input.registered_references, undefined);
    return { value: ordinaryRead };
  } };
  for (const [message_id, changes] of [
    ["mixed-model", { user_text: user_text + " Also count the air devices in the current Revit model." }],
    ["model-edit", { user_text: user_text + " Change the current model to match these examples." }],
    ["foreign-session", { session_id: "another-session" }],
    ["missing-current-source", { intake_attachment_ids: [uploads[0]!.id, uploads[1]!.id, "different-id"] }],
    ["duplicate-id", { intake_attachment_ids: [uploads[0]!.id, uploads[0]!.id, uploads[2]!.id] }],
    ["missing-sources", { intake_attachment_ids: [] }],
  ] as const) {
    const unresolved = await routeConversation({ ...body, ...changes, message_id }, handoff);
    assert.equal(unresolved.route, "task", message_id);
    assert.equal(unresolved.assistant_message, null);
  }
  const candidate = (await interpreter.interpret({ registered_references: uploads.map(upload => ({
    sha256: upload.sha256, text: "留用现有配电盘名称",
  })) })).value;
  const unbound = intakeDecisionIssues(candidate, { user_text, recent_conversation: [],
    ui_observation: { state: "unknown" }, attachment_count: uploads.length });
  assert.equal(unbound[0]?.code, "registered_reference_answer_unbound");
  fs.writeFileSync(path.join(root, uploads[0]!.relative_path), '{"tag":"EA-12","airflow_cfm":975}');
  await assert.rejects(routeConversation(body, interpreter), /different registered source set/);
  assert.equal((await routeConversation({ ...body, message_id: "changed-source" }, handoff)).route, "task");
});
