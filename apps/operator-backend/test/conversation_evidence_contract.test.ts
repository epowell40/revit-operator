import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { routeConversation, retainedIntakeDecision } from "../src/conversation_intake.js";
import { startAutoGoalIfEligible } from "../src/goals/auto_goal_start.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { openAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { markAssignmentKernelOperationDispatchStartedV2, settleAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { canonicalPayloadHashV2 } from "../src/execution_truth/assignment_kernel_v2_result_adapter.js";
import { evaluateCriterionV2, type AssignmentSnapshotV2, type SemanticFactV2 } from "../src/domain/assignment-kernel/index.js";
import { evaluateAssignmentObservationCriteriaV2 } from "../src/assignments/assignment_kernel_v2_lifecycle.js";
import { prepareAssignmentTurn } from "../src/assignments/turn_preparation.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";
import { __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { deriveProgressGapsV2 } from "../src/domain/assignment-kernel/progress/controller.js";
import { CONVERSATION_EVIDENCE_GUIDANCE } from "../src/conversation_evidence_guidance.js";

test("C56 project review retains evidence limits in the actual pending assessment handoff",()=>isolated(async()=>{
  const snapshot=await admitted("Review this model using its sheets, levels and views. Tell me what kind of project it is.","other","review-guidance");
  const gap=deriveProgressGapsV2(snapshot).find(row=>row.kind==="result_delivery_required");
  assert.ok(gap?.reason.includes(CONVERSATION_EVIDENCE_GUIDANCE));
  assert.equal(snapshot.terminal,false,"Guidance alone is not a completed inspection");
}));

async function isolated(run: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-read-contract-"));
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __closeForTests(); __testOnlyResetGoalListCache();
  try { await run(); } finally {
    __closeForTests(); __testOnlyResetGoalListCache();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function admitted(question: string, readEvidence: string, suffix = "one", recoverTimeout = false) {
  const request = { version: "operator.backend.v1" as const, session_id: `session-${suffix}`, message_id: `message-${suffix}`,
    user_text: question, ui_observation: { ok: true, data: { document: { title: "C53 Revit 2027 Controls" } } } };
  if(recoverTimeout){
    const unavailable=await routeConversation(request,{interpret:async()=>new Promise(()=>{})},{timeoutMs:5});
    assert.equal(unavailable.routing_status,"unavailable");
    assert.throws(()=>startAutoGoalIfEligible({session_id:request.session_id,message_id:request.message_id,user_text:question,
      tool_result_count:0,source:"chat",created_by:"test-owner"}),/classification/);
  }
  await routeConversation(request, { interpret: async () => ({ value: { route: "inspect", answer: null,
    question_kind: "current_model", identity_fields: [], read_evidence: readEvidence, basis: "needs_tools", requested_effect: "read",
    entire_request_answered: false, confidence: 0.99, reason: "Read evidence suited to the requested fact." } }) });
  const goal = startAutoGoalIfEligible({ session_id: request.session_id, message_id: request.message_id, user_text: question,
    tool_result_count: 0, source: "chat", created_by: "test-owner",
    request_context: { revit: { document: { title: "C53 Revit 2027 Controls" } }, ui: { response_style: "conversation" } } } as any)!;
  assert.ok(goal);
  assert.equal(goal.work_budget?.requested_effect,"read",question);
  assert.ok(retainedIntakeDecision({session_id:goal.related_session_id!,message_id:String(goal.work_budget?.conversation_message_id),user_text:goal.objective}), JSON.stringify({question,objective:goal.objective,budget:goal.work_budget}));
  createAssignmentKernelForGoalV2({ goal, run_id: `chat:${request.message_id}` });
  return getAssignmentKernelSnapshotV2(goal.id)!;
}

function observed(snapshot:AssignmentSnapshotV2,route:string,payload:unknown,facts:SemanticFactV2[],ordinal:number,body:Record<string,unknown>={}) {
  const lease=openAssignmentKernelOperationV2({snapshot,controller_request_id:`read-${ordinal}`,provider_turn_id:`turn-${ordinal}`,
    capability_id:"revit_call_tool",classified_effect:"read",arguments:{method:"POST",path:route,body}});
  markAssignmentKernelOperationDispatchStartedV2(lease);
  return settleAssignmentKernelOperationV2(lease,{content:[],structuredContent:{schema:"revit-operator.assignment-kernel-mcp-result/v2",
    operation_result_v2:{schema:"revit-operator.operation-result/v2",result_id:`result-${lease.operation_id}`,operation_id:lease.operation_id,
      binding:lease.binding,status:"succeeded",dispatch_state:"dispatched",persistent_effect:"none",native_transaction_state:"not_applicable",
      authority:"native-host",result_schema_id:`operator-native/POST:${route}/v2`,observation_required:true,raw_payload_hash:canonicalPayloadHashV2(payload),
      receipt_id:`receipt-${ordinal}`,native_correlation_id:`native-${ordinal}`,request_identity:lease.request_identity,completed_at:new Date().toISOString()},
    observation:{raw_payload:payload,semantic_facts:facts,target_scope:{},verification_relevance:["task_result"]}}});
}

const resultAvailable:SemanticFactV2={fact_id:"task.result_available",fact_class:"domain",value:true};

test("C56 recovered semantic handoff completes the actual native sheet count through observation and final delivery",()=>isolated(async()=>{
  for(const [index,total] of [17,0].entries()){
    const question=index?"Are there any electrical sheets? Check the full sheet set.":"Inspect the sheet list and count the mechanical sheets. Reply in one sentence.";
    const initial=await admitted(question,"complete_collection",`recovered-${index}`,true);
    const count=observed(initial,"/revit/sheets",{totalMatches:total,countOnly:true,hasMore:false},[resultAvailable,
      {fact_id:"collection.complete",fact_class:"domain",value:true},{fact_id:"collection.total",fact_class:"domain",value:total}],index+1,
      {action:"count",exact:true,sheetNumberPrefix:index?"E":"M"});
    assert.equal(count.observation!.evidence_class,"task_result");
    const completed=evaluateAssignmentObservationCriteriaV2({binding:count.snapshot.current_binding,
      claims:[{criterion_id:initial.spec.criteria[0]!.criterion_id,observation_ids:[count.observation!.observation_id]}],
      result_items:[{label:"Matching sheets",observation_id:count.observation!.observation_id,path:["totalMatches"]}],
      assessment:{overview:index?"There are no E-prefix sheets in the model.":"There are 17 mechanical sheets in the model.",
        findings:[{priority:"low",title:"Complete sheet count",text:"The native sheet counter checked the complete requested set.",evidence_indices:[1]}],limitations:[],questions:[]}});
    assert.equal(completed.outcome,"complete");assert.equal(completed.terminal,true);
    assert.equal(completed.result_delivery!.items[0]!.value,total);
  }
}));

test("C54 metadata can be retained but cannot pass the actual model-content criterion",()=>isolated(async()=>{
  const initial=await admitted("Is this the mechanical model?","model_content");
  const metadata=observed(initial,"/revit/native-api-ops",{documentTitle:"C53 Revit 2027 Controls",projectNumber:"7765328-33-M"},[resultAvailable],1);
  assert.ok(metadata.observation);
  const evaluate=(state:AssignmentSnapshotV2,observationIds:string[])=>evaluateCriterionV2({snapshot:state,criterion_id:state.spec.criteria[0]!.criterion_id,
    observation_ids:observationIds,evaluator_authority:"operator-runtime",evaluated_at:new Date().toISOString()});
  assert.notEqual(evaluate(metadata.snapshot,[metadata.observation.observation_id]).status,"pass");
  assert.notEqual(metadata.snapshot.outcome,"complete");
  evaluateAssignmentObservationCriteriaV2({binding:metadata.snapshot.current_binding,
    claims:[{criterion_id:initial.spec.criteria[0]!.criterion_id,observation_ids:[metadata.observation.observation_id]}]});
  const content=observed(metadata.snapshot,"/revit/quantify",{summary:{total:24,groups:{Ducts:24}}},
    [resultAvailable,{fact_id:"model.content_observed",fact_class:"domain",value:true}],2);
  assert.equal(evaluate(content.snapshot,[content.observation!.observation_id]).status,"pass");
  const foreign=structuredClone(content.snapshot);
  (foreign.observations[content.observation!.observation_id]!.binding as any).generation++;
  assert.notEqual(evaluate(foreign,[content.observation!.observation_id]).status,"pass");
}));

test("collection completion needs complete native facts while a literal project property remains a metadata read",()=>isolated(async()=>{
  const initial=await admitted("Inspect the sheet list and count the mechanical sheets. Reply in one sentence.","complete_collection");
  const partial=observed(initial,"/revit/sheets",{totalMatches:17,returned:2,hasMore:true},[resultAvailable],1,{action:"list",limit:2});
  const criterion=initial.spec.criteria[0]!.criterion_id;
  const evaluate=(state:AssignmentSnapshotV2,id:string)=>evaluateCriterionV2({snapshot:state,criterion_id:criterion,observation_ids:[id],
    evaluator_authority:"operator-runtime",evaluated_at:new Date().toISOString()});
  assert.notEqual(evaluate(partial.snapshot,partial.observation!.observation_id).status,"pass");
  evaluateAssignmentObservationCriteriaV2({binding:partial.snapshot.current_binding,
    claims:[{criterion_id:criterion,observation_ids:[partial.observation!.observation_id]}]});
  const count=observed(partial.snapshot,"/revit/sheets",{totalMatches:17,countOnly:true,hasMore:false},[resultAvailable,
    {fact_id:"collection.complete",fact_class:"domain",value:true},{fact_id:"collection.total",fact_class:"domain",value:17}],2,{action:"count"});
  assert.equal(evaluate(count.snapshot,count.observation!.observation_id).status,"pass");
  const completed=evaluateAssignmentObservationCriteriaV2({binding:count.snapshot.current_binding,
    claims:[{criterion_id:criterion,observation_ids:[count.observation!.observation_id]}],
    result_items:[{label:"Matching sheets",observation_id:count.observation!.observation_id,path:["totalMatches"]}],
    assessment:{overview:"There are 17 mechanical sheets.",findings:[{priority:"low",title:"Sheet count",text:"The native sheet query returned the complete filtered total.",evidence_indices:[1]}],limitations:[],questions:[]}});
  assert.equal(completed.terminal,true);
  assert.equal(completed.outcome,"complete");
  assert.equal(completed.result_delivery!.items[0]!.value,17);
  const literal=await admitted("What is the project number?","model_metadata","metadata");
  assert.deepEqual(literal.spec.criteria[0]!.semantic_fact_requirements,["task.result_available"]);
  assert.equal(retainedIntakeDecision({session_id:"session-one",message_id:"message-other",user_text:initial.spec.source_user_request}),null);
  assert.equal(retainedIntakeDecision({session_id:"foreign",message_id:"message-one",user_text:initial.spec.source_user_request}),null);
  assert.equal(retainedIntakeDecision({session_id:"session-one",message_id:"message-one",user_text:initial.spec.source_user_request+" Remove them."}),null);
}));

test("C54 sheet count admits the native requested collection instead of forcing element quantify", () => isolated(async () => {
  const snapshot = await admitted("Inspect the sheet list and count the mechanical sheets. Reply in one sentence.", "complete_collection");
  assert.ok(snapshot.spec.criteria[0]!.semantic_fact_requirements.includes("collection.complete"));
  for (const [index, tool] of ["revit_list_sheets", "revit_call_tool"].entries()) {
    const lease = openAssignmentKernelOperationV2({ snapshot, controller_request_id: `count-${index}`, provider_turn_id: `turn-${index}`,
      capability_id: tool, classified_effect: "read", arguments: tool === "revit_list_sheets"
        ? { action: "count", exact: true, sheetNumberPrefix: "M" }
        : { method: "POST", path: "/revit/sheets", body: { action: "count", exact: true, sheetNumberPrefix: "M" } } });
    assert.equal(lease.fulfillment_role, "delegated_task_execution");
    assert.deepEqual(lease.eligible_criterion_ids, snapshot.spec.criteria.map(item => item.criterion_id));
  }
}));

test("C54 model-content question cannot be fulfilled by document title and project number alone", () => isolated(async () => {
  for (const [index, question] of ["Is this the mechanical model?", "¿Qué sistemas contiene este modelo?", "Does the model contain any air distribution?"].entries()) {
    const snapshot = await admitted(question, "model_content", String(index));
    assert.ok(snapshot.spec.criteria.every(criterion => criterion.semantic_fact_requirements.includes("model.content_observed")),
      `${question}: a successful metadata operation alone cannot prove actual model contents; ${JSON.stringify(snapshot.spec.criteria)}`);
    assert.equal(snapshot.spec.result_delivery_required, true);
  }
}));

test("the actual turn admission honors a saved semantic read without borrowing another message's decision",()=>isolated(async()=>{
  const previous=process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
  process.env.OPERATOR_ASSIGNMENT_KERNEL_V2="1";
  try {
    for(const [index,userText] of ["What is the project number?","¿Qué sistemas contiene este modelo?"].entries()) {
      const sessionId=`edge-${index}`,messageId=`message-${index}`;
      await routeConversation({version:"operator.backend.v1",session_id:sessionId,message_id:messageId,user_text:userText},
        {interpret:async()=>({value:{route:"inspect",answer:null,question_kind:"current_model",identity_fields:[],read_evidence:index?"model_content":"model_metadata",
          basis:"needs_tools",requested_effect:"read",entire_request_answered:false,confidence:0.99,reason:"A fresh native read is needed."}})});
      const prepared=prepareAssignmentTurn({sessionId,messageId,userText,toolResults:[],source:"chat",createdBy:"test-owner",requestContext:{ui:{response_style:"conversation"}}});
      assert.equal(prepared?.kernelVersion,2);
      const snapshot=getAssignmentKernelSnapshotV2(prepared!.assignmentId)!;
      assert.equal(snapshot.spec.requested_effect,"read");
      assert.equal(snapshot.spec.criteria[0]!.semantic_fact_requirements.includes("model.content_observed"),index===1);
    }
  }finally{if(previous===undefined)delete process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;else process.env.OPERATOR_ASSIGNMENT_KERNEL_V2=previous;}
}));
