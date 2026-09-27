import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { routeConversation, mayRouteConversation, validateIntakeDecision, intakeDecisionIssues, INTAKE_INSTRUCTIONS, INTAKE_SCHEMA } from "../src/conversation_intake.js";
import { operationScopeIssues, operationScopeRequestHash, validBoundOperationScope, validOperationScope } from "../src/domain/assignment-kernel/operation_scope.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";
import { __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { prepareAssignmentTurn } from "../src/assignments/turn_preparation.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { openAssignmentKernelOperationV2, openAssignmentKernelChildOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { advanceAssignmentKernelProgressV2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import { supplyAssignmentInputV2 } from "../src/assignments/assignment_kernel_v2_lifecycle.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { runWithRequestContext } from "../src/request_context.js";
import { buildTeammateTurnContract } from "../src/teammate_loop_runtime.js";
import { appendCurrentAssignmentKernelEventV2 } from "../src/assignments/assignment_kernel_v2_store.js";

// Exact causal conditional/protection clauses from the retained disposable-model
// GUI failure; names, room numbers, provider IDs and workstation paths omitted.
const condition = "Before making any model changes, ask me how to represent the ambiguous 6-inch bathroom ceiling-device symbol and wait for my answer.";
const protection = "Do not rebuild adjacent units or change the architectural background.";
const prompt = `${condition} After my answer, complete the confidently supported remaining work. ${protection}`;
const scope = (effect = "apply", prerequisites: any[] = [{variable_id:"device_representation",kind:"information",question:"How should I represent the ambiguous ceiling device?",source_quote:condition}]) => ({
  schema:"revit-operator.interpreted-operation-scope/v1",requested_effect:effect,model_effect:effect,protected_clauses:[protection],prerequisites
});
const decision = (operation_scope: any = scope()) => ({route:"task",answer:null,basis:"needs_tools",requested_effect:operation_scope.requested_effect === "read" ? "read" : "change",
  entire_request_answered:false,confidence:0.99,reason:"The whole request authorizes later bounded work after receiving information.",
  question_kind:"action",identity_fields:[],read_evidence:operation_scope.requested_effect === "read" ? "other" : "not_applicable",operation_scope});
const body = (user_text = prompt, extra = {}) => ({version:"operator.backend.v1" as const,session_id:"semantic-scope",message_id:"request",user_text,...extra});

test("actual intake instructions and output schema distinguish missing information from permission, independent of ordering",()=>{
  // Regression for the retained GUI failure: the actual classifier prompt had
  // contradicted its information definition with this unconditional rule.
  assert.doesNotMatch(INTAKE_INSTRUCTIONS,/Ask-before-acting is an approval prerequisite/);
  assert.match(INTAKE_INSTRUCTIONS,/ordering alone does not make a question an approval/);
  assert.match(INTAKE_INSTRUCTIONS,/Separate information and approval prerequisites/);
  const kind=INTAKE_SCHEMA.properties.operation_scope.anyOf[0].properties.prerequisites.items.properties.kind;
  assert.match(kind.description,/facts or design choices/);
  assert.match(kind.description,/permission to act/);
  assert.doesNotMatch(kind.description,/before.*approval/i);
});

async function workspace(fn:()=>Promise<void>) {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT, v2 = process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"operator-semantic-scope-"));
  process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_ASSIGNMENT_KERNEL_V2="1";__closeForTests();__testOnlyResetGoalListCache();
  try { await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth("shared_token","scope-test")},fn); }
  finally { __closeForTests();__testOnlyResetGoalListCache();
    if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;
    if(v2===undefined)delete process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;else process.env.OPERATOR_ASSIGNMENT_KERNEL_V2=v2;
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true}); }
}
async function prepare(user_text=prompt, interpreted=decision()) {
  assert.equal((await routeConversation(body(user_text),{interpret:async()=>({value:interpreted})})).routing_status,"accepted");
  const prepared=prepareAssignmentTurn({sessionId:"semantic-scope",messageId:"request",userText:user_text,toolResults:[],source:"chat",createdBy:null,
    requestContext:{revit:{document:{projectIdentity:{fingerprint:"disposable-model"}}}}})!;
  return getAssignmentKernelSnapshotV2(prepared.assignmentId)!;
}
function apply(snapshot:any) { return openAssignmentKernelOperationV2({snapshot,controller_request_id:"apply",provider_turn_id:"turn",
  capability_id:"element.update",classified_effect:"apply",arguments:{elementId:42}}); }
function teammate(snapshot:any) {return buildTeammateTurnContract({user_text:prompt,session_id:snapshot.current_binding.session_id,
  assignment_id:snapshot.current_binding.assignment_id,assignment_run_id:snapshot.current_binding.run_id,assignment_generation:snapshot.current_binding.generation,context:{}});}

test("scope diagnostic predicates preserve exact quotes, duplicate identifiers and model-effect limits",()=>{
  const cases:[any,string][]=[
    [{...scope(),protected_clauses:["Not a source clause"]},"protected_clause_not_exact"],
    [scope("apply",[{...scope().prerequisites[0],source_quote:"Invented source quote"}]),"prerequisite_quote_not_exact"],
    [scope("apply",[scope().prerequisites[0],scope().prerequisites[0]]),"prerequisite_duplicate_id"],
    [{...scope("read"),model_effect:"apply"},"model_effect_exceeds_scope"],
  ];
  for(const [value,code] of cases){
    assert.equal(validOperationScope(value,prompt),false);assert.equal(operationScopeIssues(value,prompt)[0]!.code,code);
    assert.equal(intakeDecisionIssues(decision(value),{user_text:prompt,recent_conversation:[],ui_observation:{state:"unknown"}})[0]!.code,code);
  }
});

test("synthetic quote correction preserves immutable approval and information requirements at real creation admission",()=>workspace(async()=>{
  // Synthetic invalid quote: no original failed Unit 403 candidate was retained.
  const approval="Ask for my approval before changing anything.";
  const text=`${prompt} ${approval}`;
  const valid=decision(scope("apply",[...scope().prerequisites,{variable_id:"consent",kind:"approval",question:"May I make the changes?",source_quote:approval}]));
  const invalid=structuredClone(valid);invalid.operation_scope.prerequisites[0].source_quote="A paraphrase not present in the request";
  let calls=0;
  assert.equal((await routeConversation(body(text),{interpret:async(input,_signal,correction)=>{
    assert.equal(input.user_text,text);if(++calls===1)return {value:invalid};
    assert.equal(correction?.rejection.issues[0]!.code,"prerequisite_quote_not_exact");return {value:valid};
  }})).routing_status,"accepted");
  assert.equal(calls,2);
  const prepared=prepareAssignmentTurn({sessionId:"semantic-scope",messageId:"request",userText:text,toolResults:[],source:"chat",createdBy:null,
    requestContext:{revit:{document:{projectIdentity:{fingerprint:"disposable-model"}}}}})!;
  const snapshot=getAssignmentKernelSnapshotV2(prepared.assignmentId)!;
  assert.deepEqual(snapshot.spec.interpreted_scope!.scope,valid.operation_scope);
  assert.deepEqual(new Set(snapshot.pending_input_variable_ids),new Set(["device_representation","consent"]));
  assert.equal(snapshot.spec.source_user_request,text);assert.throws(()=>apply(snapshot),/admission_after_terminal_outcome|input_missing/);
}));

test("attachment-bearing text reaches semantic intake without sending pixels or answering the attached work",()=>workspace(async()=>{
  assert.equal(mayRouteConversation(body(prompt,{user_attachments:[{id:"source"}]})),true);
  let called=false;
  const result=await routeConversation(body(prompt,{pending_attachments:[{name:"source.pdf",data:"PRIVATE-BASE64"}]}),{interpret:async input=>{
    called=true;assert.equal((input as any).attachment_count,1);assert.doesNotMatch(JSON.stringify(input),/PRIVATE-BASE64|source.pdf/);return {value:decision()};
  }});
  assert.equal(called,true);assert.equal(result.route,"task");assert.equal(result.history_saved,false);
}));

test("trusted interpretation persists final apply scope and waits for authenticated information before actual admission",()=>workspace(async()=>{
  let snapshot=await prepare();assert.equal(snapshot.spec.requested_effect,"apply");
  assert.deepEqual((snapshot.spec as any).interpreted_scope.scope,scope());
  assert.deepEqual(snapshot.pending_input_variable_ids,["device_representation"]);
  assert.equal(snapshot.outcome,"awaiting_user_input");
  assert.throws(()=>apply(snapshot),/admission_after_terminal_outcome|input_missing/);
  assert.equal(teammate(snapshot).write_authorized,false);
  snapshot=advanceAssignmentKernelProgressV2({binding:snapshot.current_binding}).snapshot;
  const clarification=Object.values(snapshot.clarifications)[0]!;
  assert.equal(clarification.question,scope().prerequisites[0].question);
  for(const value of [null,"", "   ", [], {}]) assert.throws(()=>supplyAssignmentInputV2({binding:snapshot.current_binding,
    clarification_id:clarification.clarification_id,external_values:{device_representation:value}}),/prerequisite_answer_required/);
  snapshot=supplyAssignmentInputV2({binding:snapshot.current_binding,clarification_id:clarification.clarification_id,
    external_values:{device_representation:"Use an explicitly provisional proxy; leave service unresolved."}});
  assert.deepEqual(snapshot.pending_input_variable_ids,[]);
  __testOnlyResetGoalListCache();snapshot=getAssignmentKernelSnapshotV2(snapshot.current_binding.assignment_id)!;
  assert.equal(apply(snapshot).requested_effect,"apply");
  assert.equal(teammate(snapshot).write_authorized,true);assert.equal(teammate(snapshot).no_write,false);
  assert.equal(snapshot.spec.source_user_request,prompt,"The initial request is never rewritten");
}));

test("explicit read and preview envelopes remain bounded despite a working-agent apply request",()=>workspace(async()=>{
  const snapshot=await prepare("Inspect the devices; leave the model unchanged.",decision({...scope("read",[]),protected_clauses:[]}));
  assert.equal(snapshot.spec.requested_effect,"read");assert.throws(()=>apply(snapshot),/work_unit|no_model_write|effect/);
}));

test("approval prerequisite is not satisfied by arbitrary text or false",()=>workspace(async()=>{
  const instruction="Ask for my approval before changing the selected element.";
  let snapshot=await prepare(instruction,decision({...scope("apply",[{variable_id:"approve_changes",kind:"approval",question:"Approve the requested change?",source_quote:instruction}]),protected_clauses:[]}));
  snapshot=advanceAssignmentKernelProgressV2({binding:snapshot.current_binding}).snapshot;
  const clarification=Object.values(snapshot.clarifications)[0]!;
  for(const value of [false,"yes","true","no",{approved:true}]) {
    assert.throws(()=>supplyAssignmentInputV2({binding:snapshot.current_binding,clarification_id:clarification.clarification_id,external_values:{approve_changes:value}}),/approval/);
    assert.deepEqual(getAssignmentKernelSnapshotV2(snapshot.current_binding.assignment_id)!.pending_input_variable_ids,["approve_changes"]);
  }
  snapshot=supplyAssignmentInputV2({binding:snapshot.current_binding,clarification_id:clarification.clarification_id,external_values:{approve_changes:true}});
  assert.equal(apply(snapshot).requested_effect,"apply");
}));

test("semantic scope requires bounded typed prerequisites rather than arbitrary extra model fields",()=>{
  assert.ok(validateIntakeDecision(decision()));
  assert.equal(validateIntakeDecision({...decision(),operation_scope:null}),null);
  for(const bad of [{...scope(),extra:true},scope("delete"),scope("apply",[{...scope().prerequisites[0],kind:"already_approved"}])])
    assert.equal(validateIntakeDecision(decision(bad)),null);
});

test("preview-only semantic scope permits preview but never apply",()=>workspace(async()=>{
  const snapshot=await prepare("Show me a noncommitting preview of changing the selected element.",decision({...scope("preview",[]),protected_clauses:[]}));
  assert.equal(snapshot.spec.requested_effect,"preview");assert.throws(()=>apply(snapshot),/work_unit|effect|no_model_write/);
  const lease=openAssignmentKernelOperationV2({snapshot,controller_request_id:"preview",provider_turn_id:"preview-turn",capability_id:"element.update",classified_effect:"preview",arguments:{elementId:42,dryRun:true}});
  assert.equal(lease.requested_effect,"preview");assert.equal(teammate(snapshot).write_authorized,false);
}));

test("provider input events cannot fulfill interpreted prerequisites",()=>workspace(async()=>{
  let snapshot=await prepare();snapshot=advanceAssignmentKernelProgressV2({binding:snapshot.current_binding}).snapshot;
  const clarification=Object.values(snapshot.clarifications)[0]!;
  assert.throws(()=>appendCurrentAssignmentKernelEventV2({goal_id:snapshot.current_binding.assignment_id,binding:snapshot.current_binding,event_id:"forged-input",actor:"provider",
    body:{event_type:"input_supplied",variable_id:"device_representation",clarification_id:clarification.clarification_id,value:"Provider chose a proxy"}}),/input_prerequisite_authority_invalid/);
  assert.deepEqual(getAssignmentKernelSnapshotV2(snapshot.current_binding.assignment_id)!.pending_input_variable_ids,["device_representation"]);
}));

test("unquoted or changed-source scope is not accepted as an exact-message interpretation",()=>workspace(async()=>{
  const invalid=decision({...scope(),protected_clauses:["A condition the user never said"]});
  assert.equal((await routeConversation(body(),{interpret:async()=>({value:invalid})})).routing_status,"unavailable");
  assert.throws(()=>prepareAssignmentTurn({sessionId:"semantic-scope",messageId:"request",userText:prompt,toolResults:[],source:"chat",createdBy:null}),/classification is not ready/);
}));

test("client hints and legacy semantic decisions do not override the legacy no-write envelope",()=>workspace(async()=>{
  const legacy:any=decision();delete legacy.operation_scope;
  await routeConversation(body(prompt,{operation_scope:scope(),requested_effect:"apply"}),{interpret:async()=>({value:legacy})});
  const prepared=prepareAssignmentTurn({sessionId:"semantic-scope",messageId:"request",userText:prompt,toolResults:[],source:"chat",createdBy:null,
    requestContext:{ui:{operation_scope:scope(),requested_effect:"apply"}}})!;
  const snapshot=getAssignmentKernelSnapshotV2(prepared.assignmentId)!;
  assert.equal(snapshot.spec.requested_effect,"read");assert.equal(snapshot.spec.interpreted_scope,undefined);
  assert.throws(()=>apply(snapshot),/no_model_write|work_unit|effect/);
  assert.equal(buildTeammateTurnContract({user_text:prompt,context:{ui:{operation_scope:scope()}}} as any).no_write,true);
}));

test("attachment task cannot replay an earlier text-only answer or accept a fabricated attachment answer",()=>workspace(async()=>{
  const answer={route:"answer",answer:"Variable air volume.",basis:"general_knowledge",requested_effect:"none",entire_request_answered:true,confidence:0.99,
    reason:"Definition",question_kind:"general_explanation",identity_fields:[],read_evidence:"not_applicable",operation_scope:null};
  assert.equal((await routeConversation(body("What does VAV mean?",{user_attachments:[{}]}),{interpret:async()=>({value:answer})})).routing_status,"unavailable");
  await assert.rejects(routeConversation(body("What does VAV mean?"),{interpret:async()=>({value:answer})}),/attachment context/);
}));

test("semantic scope binds the exact untrimmed message while the Goal retains its ordinary display normalization",()=>workspace(async()=>{
  const exact=`\n  ${prompt}\n`;
  const snapshot=await prepare(exact);
  assert.equal(snapshot.spec.source_user_request,exact);
  assert.equal(snapshot.spec.interpreted_scope?.scope.requested_effect,"apply");
  assert.deepEqual(snapshot.pending_input_variable_ids,["device_representation"]);
}));

test("export authority preserves a separate global ban on changing the Revit model",()=>workspace(async()=>{
  const source="Export the selected elements to an Excel workbook. Do not change Revit.";
  const snapshot=await prepare(source,decision({...scope("apply",[]),model_effect:"read",protected_clauses:["Do not change Revit."]}));
  assert.equal(snapshot.spec.requested_effect,"apply");assert.equal(teammate(snapshot).no_write,true);
  assert.equal(teammate(snapshot).model_effect_limit,"read");
  assert.throws(()=>apply(snapshot),/user_no_model_write_limit/);
  assert.throws(()=>openAssignmentKernelOperationV2({snapshot,controller_request_id:"preview",provider_turn_id:"preview-turn",capability_id:"element.update",classified_effect:"preview",arguments:{dryRun:true}}),/user_no_model_write_limit/);
  const exported=openAssignmentKernelOperationV2({snapshot,controller_request_id:"export",provider_turn_id:"export-turn",capability_id:"revit_call_tool",classified_effect:"apply",
    arguments:{method:"POST",path:"/revit/export-elements-xlsx",body:{elementIds:[42]}}});
  assert.equal(exported.requested_effect,"apply");
  assert.throws(()=>openAssignmentKernelChildOperationV2({binding:exported.binding,parent_operation_id:exported.operation_id,child_ordinal:0,
    operation_role:"child",capability_id:"native:POST:/revit/delete-elements",classified_effect:"apply",method:"POST",path:"/revit/delete-elements",arguments:{elementIds:[42]}}),/user_no_model_write_limit/);
}));


test("scope request hashes preserve exact legacy UTF-8 identity and bound-effect rejection",()=>{
  const texts=["", "plain text", "line\nend", "line\r\nend", "é", "e\u0301", "模型 🏗️", "\ufefftext", "\ud800", "text\udfff", " \ttrailing ", "x".repeat(10000)];
  for(const text of texts){
    const legacyHash=createHash("sha256").update(text).digest("hex");
    assert.equal(operationScopeRequestHash(text),legacyHash,JSON.stringify(text));
    const spec:any={source_user_request:text,requested_effect:"read",input_variables:[],work_units:[],interpreted_scope:{
      source_message_id:"exact-message",source_request_sha256:legacyHash,
      scope:{schema:"revit-operator.interpreted-operation-scope/v1",requested_effect:"read",model_effect:"read",protected_clauses:[],prerequisites:[]}}};
    assert.equal(validBoundOperationScope(spec),true,"Existing raw-text receipt must remain valid");
    assert.equal(validBoundOperationScope({...spec,source_user_request:text+" "}),false,"Changed source cannot reuse the receipt");
    const changed=structuredClone(spec);changed.interpreted_scope.scope.requested_effect="apply";
    assert.equal(validBoundOperationScope(changed),false,"Interpreted receipt cannot widen canonical scope");
  }
  assert.notEqual(operationScopeRequestHash("line\nend"),operationScopeRequestHash("line\r\nend"));
  assert.notEqual(operationScopeRequestHash("é"),operationScopeRequestHash("e\u0301"));
});
