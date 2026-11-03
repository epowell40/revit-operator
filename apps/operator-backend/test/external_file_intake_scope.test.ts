import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { routeConversation, retainedIntakeDecision } from "../src/conversation_intake.js";
import { assignmentSpecFromGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

// These are consumer/authority regressions with explicit synthetic interpreter
// outputs, not a claim that a model chose the classifications. Actual provider
// calibration uses this same corpus and retains independent raw decisions.
const corpus = JSON.parse(fs.readFileSync(path.join(process.cwd(), "test/fixtures/external_file_intake_cases.v1.json"), "utf8"));
for (const row of corpus.cases) test(`source-scoped intake consumer: ${row.id}`, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "operator-file-intake-"));
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = workspace;
  __closeForTests();
  try {
    const evidence = row.accepted_read_evidence[0];
    const operation_scope = {schema:"revit-operator.interpreted-operation-scope/v1", requested_effect:row.effect,
      model_effect:row.effect, protected_clauses:[row.text], prerequisites:[]};
    const decision = {route:row.effect === "apply" ? "task" : "inspect", answer:null, basis:"needs_tools",
      requested_effect:row.effect === "apply" ? "change" : "read", entire_request_answered:false, confidence:0.99,
      reason:"Synthetic source-scoped consumer fixture.", question_kind:row.question_kind, identity_fields:[],
      read_evidence:evidence, operation_scope};
    const request = {version:"operator.backend.v1" as const,session_id:row.id,message_id:"source-request",user_text:row.text};
    assert.equal((await routeConversation(request,{interpret:async () => ({value:decision})})).routing_status,"accepted");
    const accepted = retainedIntakeDecision(request)!;
    assert.deepEqual(accepted.operation_scope,operation_scope);
    const spec = assignmentSpecFromGoalV2({run_id:"source-scope-consumer",goal:{id:row.id,objective:row.text,
      related_session_id:row.id,created_by:"source-scope-test",acceptance_criteria:["Return the requested evidence-backed result."],
      work_budget:{requested_effect:row.effect,source_user_request:row.text,conversation_message_id:request.message_id,
        // Untrusted conflicting hints must not replace the retained decision.
        read_evidence:evidence === "other" ? "model_content" : "other"}} as any});
    assert.equal(spec.requested_effect,row.effect);
    assert.deepEqual(spec.interpreted_scope?.scope,operation_scope);
    assert.equal(spec.interpreted_scope?.source_request_sha256,createHash("sha256").update(row.text).digest("hex"));
    const facts = spec.criteria[0]!.semantic_fact_requirements;
    assert.ok(facts.includes("task.result_available"));
    assert.equal(facts.includes("model.content_observed"),evidence === "model_content");
    assert.equal(facts.includes("collection.complete"),evidence === "complete_collection");
    assert.equal(facts.includes("collection.total"),evidence === "complete_collection");
    const policy = spec.criteria[0]!.evidence_policy;
    assert.ok(policy);
    assert.equal(policy.require_native_dispatch,true);
    assert.equal(policy.require_current_generation,true);
  } finally {
    __closeForTests();
    if(previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    assert.equal(path.dirname(path.resolve(workspace)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(workspace).startsWith("operator-file-intake-"));
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});
