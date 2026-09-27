import assert from "node:assert/strict";
import test from "node:test";
import { AssignmentJournalV2, ASSIGNMENT_EVENT_V2_SCHEMA, ASSIGNMENT_SPEC_V2_SCHEMA,
  OPERATION_V2_SCHEMA, OPERATION_RESULT_V2_SCHEMA, PROVIDER_CALL_V2_SCHEMA,
  ASSIGNMENT_EXECUTION_FAILURE_V2_SCHEMA, decideAssignmentProgressV2, reduceAssignmentEventsV2,
  type AssignmentProgressBudgetV2, type AssignmentSpecV2, type OperationV2 } from "../src/domain/assignment-kernel/index.js";

const binding = {assignment_id:"held-task",run_id:"original-run",generation:1,session_id:"original-chat",principal_id:"owner",document_fingerprint:"fixture-rvt"};
const budget: AssignmentProgressBudgetV2 = {max_provider_calls:10,max_reasoning_turns:10,max_operations:20,
  max_equivalent_operations:2,max_no_progress_epochs:4,max_reconciliation_attempts:3,max_wall_clock_ms:600_000,max_total_tokens:100_000};
const at = (seconds: number) => new Date(Date.UTC(2026,8,27,16,0,seconds)).toISOString();
function spec(advisory = true): AssignmentSpecV2 {
  return {schema:ASSIGNMENT_SPEC_V2_SCHEMA,binding,source_user_request:"Continue the bounded drafting task.",requested_effect:"apply",
    criteria:[{criterion_id:"result",requirement:"Requested result",required:true,semantic_fact_requirements:[],
      accepted_evaluator_authority_ids:["test"],accepted_observation_authority_ids:["native-host"]}],
    input_variables:[{variable_id:"direction",required:false,value_state:"known",value:"original",sensitive:false}],
    work_units:["read","apply"].map(effect=>({work_unit_id:`work-${effect}`,requested_effect:effect as "read"|"apply",execution_class:"independent",
      dependency_ids:[],criterion_ids:["result"],input_variable_ids:[],independently_useful:true,safe_to_retain:true,rollback_scope:"none"})),
    authorization_policy_id:"original-policy",created_at:at(0),...(advisory ? {execution_policy:{mode:"local_advisory_v1",selected_by:"trusted_local_host",
      session_id:binding.session_id,document_fingerprint:binding.document_fingerprint,max_turns:8,max_provider_calls:10,max_operations:20,max_total_tokens:100_000,max_wall_clock_ms:600_000}} : {})};
}
function event(j: AssignmentJournalV2, body: any, actor="test", time=at(j.events().length+1)): any {
  return {schema:ASSIGNMENT_EVENT_V2_SCHEMA,event_id:`event-${j.events().length+1}`,assignment_id:binding.assignment_id,
    assignment_version:j.snapshot().assignment_version+1,binding,occurred_at:time,actor,...body};
}
function journal(value=spec()): AssignmentJournalV2 {
  return new AssignmentJournalV2([{schema:ASSIGNMENT_EVENT_V2_SCHEMA,event_id:"created",assignment_id:binding.assignment_id,
    assignment_version:1,binding,occurred_at:at(0),actor:"test",event_type:"assignment_created",spec:value}]);
}
function hold(j: AssignmentJournalV2, changes: any = {}, holdId="hold-one") {
  const time=at(j.events().length+1);
  const value={schema:"revit-operator.provider-usage-hold/v1",hold_id:holdId,binding,attempt_id:"message-one",
    provider_thread_id:"provider-thread",provider_turn_id:"provider-turn",code:"usageLimitExceeded",recorded_at:time,
    resume_budget:budget,...changes};
  return event(j,{event_type:"provider_usage_hold_recorded",hold:value},"assignment-execution-controller",time);
}
function resume(j: AssignmentJournalV2, changes: any = {}) {
  const snapshot:any=j.snapshot();
  return event(j,{event_type:"execution_control_requested",command_id:`resume-${snapshot.assignment_version}`,
    action:"resume",expected_command_id:snapshot.execution_control?.command_id??null,
    expected_hold_id:snapshot.provider_usage_hold?.hold_id,expected_assignment_version:snapshot.assignment_version,...changes},"authenticated-user");
}
function decision(j: AssignmentJournalV2, allowance=budget, time=at(50)) {
  return decideAssignmentProgressV2({snapshot:j.snapshot(),budget:allowance,now:time});
}
function operation(id: string, effect:"read"|"apply"="read", extras:any={}): OperationV2 {
  return {schema:OPERATION_V2_SCHEMA,operation_id:id,binding,work_unit_id:`work-${effect}`,capability_id:`fixture.${effect}`,
    requested_effect:effect,purpose:"work",advances_criterion_ids:["result"],resolves_gap_ids:[],target:{document_fingerprint:binding.document_fingerprint},
    input:{id},admission_state:"admitted",dispatch_state:"not_dispatched",persistent_effect:"none",settlement_state:"open",
    observation_ids:[],verification_operation_ids:[],opened_at:at(1),deadline_at:at(59),...extras};
}
function admit(j: AssignmentJournalV2, value: OperationV2) { j.append(event(j,{event_type:"operation_admitted",operation:value})); }
function settleNone(j: AssignmentJournalV2, id:string, end=at(8)) {
  j.append(event(j,{event_type:"operation_result_recorded",result:{schema:OPERATION_RESULT_V2_SCHEMA,result_id:`result-${id}`,operation_id:id,binding,
    status:"completed_without_native_dispatch",dispatch_state:"not_dispatched",persistent_effect:"none",native_transaction_state:"not_applicable",
    authority:"execution-controller",result_schema_id:"fixture/v1",observation_required:false,completed_at:end}}));
}
function completedCall(j: AssignmentJournalV2, id="raw-response", tokens=10) {
  j.append(event(j,{event_type:"provider_call_receipt_recorded",call:{schema:PROVIDER_CALL_V2_SCHEMA,call_id:id,binding,state:"completed",
    provider:"openai",model:"configured-model",reasoning_effort:"medium",gap_ids:["criterion:result"],criterion_ids:["result"],expected_information:["Continue work"],
    admitted_at:at(1),completed_at:at(2),success:false,usage:{input_tokens:tokens,output_tokens:0,reasoning_tokens:0,total_tokens:tokens,estimated_cost_usd:null}}}));
}
function rejectsUnchanged(j: AssignmentJournalV2, candidate:any, code:RegExp) {
  const prior=j.snapshot(), priorEvents=j.events();
  assert.throws(()=>j.append(candidate),(error:any)=>{ assert.match(error.code,code); return true; });
  assert.deepEqual(j.snapshot(),prior); assert.deepEqual(j.events(),priorEvents);
}

test("a zero-response quota hold survives journal replay without fake provider usage or terminal failure",()=>{
  const j=journal(), original=j.snapshot(); const retained=hold(j); j.append(retained);
  const snapshot:any=j.snapshot();
  assert.deepEqual(snapshot.provider_usage_hold,retained.hold);
  assert.deepEqual(snapshot.provider_calls,{}); assert.deepEqual(snapshot.execution_failures,{});
  assert.equal(snapshot.terminal,false); assert.equal(snapshot.outcome,"active");
  assert.equal(decision(j).decision,"await_provider_resume");
  assert.deepEqual(new AssignmentJournalV2(j.events()).snapshot(),snapshot);
  assert.deepEqual(reduceAssignmentEventsV2(j.events()),snapshot);
  assert.deepEqual(snapshot.spec,original.spec); assert.deepEqual(snapshot.current_binding,original.current_binding);
  assert.deepEqual(j.append(retained),snapshot,"exact event retries are idempotent");
  rejectsUnchanged(j,event(j,{event_type:"run_superseded",superseded_by_generation:2}),/assignment_provider_usage_held/);
});

test("controller hold admission rejects forged, stale, malformed and secret-bearing records atomically",()=>{
  const j=journal();
  const changes:any[]=[{code:"rateLimitExceeded"},{code:"usage_limit_exceeded"},{attempt_id:""},{provider_thread_id:"\nsecret"},
    {binding:{...binding,generation:2}},{binding:{...binding,credential:"must-not-retain"}},
    {resume_budget:{...budget,max_provider_calls:0}},{resume_budget:{...budget,max_total_tokens:Infinity}},
    {resume_budget:{...budget,untrusted_bonus:100}},{additionalDetails:"must-not-retain"},
    {worker_identity:{provider:"openai_codex",configured_billing_mode:"chatgpt",requested_model:"gpt-6-astra",requested_reasoning_effort:"medium",reported_model:null,reported_model_source:null,api_key:"must-not-retain"}},
    {worker_identity:{provider:"openai_codex",configured_billing_mode:"chatgpt",requested_model:"gpt-6-astra",requested_reasoning_effort:"minimal",reported_model:null,reported_model_source:null}},
    {worker_identity:{provider:"openai_codex",configured_billing_mode:"chatgpt",requested_model:"gpt-6-astra",requested_reasoning_effort:"medium",reported_model:"gpt-6-astra",reported_model_source:null}}];
  for(const change of changes) rejectsUnchanged(j,hold(j,change),/provider_usage_hold/);
  rejectsUnchanged(j,{...hold(j),actor:"model"},/authority/);
  rejectsUnchanged(j,hold(j,{recorded_at:at(30)}),/time/);
  const identity={provider:"openai_codex",configured_billing_mode:"chatgpt",requested_model:"gpt-6-astra",requested_reasoning_effort:"max",reported_model:null,reported_model_source:null};
  j.append(hold(j,{worker_identity:identity}));
  assert.deepEqual((j.snapshot() as any).provider_usage_hold.worker_identity,identity);
  rejectsUnchanged(j,hold(j,{},"replacement"),/already_active/);
});

test("a hold blocks fresh provider admissions and ordinary root reads or edits",()=>{
  const j=journal(); j.append(hold(j));
  rejectsUnchanged(j,event(j,{event_type:"provider_call_state_recorded",call_id:"new-call",state:"admitted",provider:"openai",model:"configured-model",
    expected_information:["continue"]}),/assignment_provider_usage_held/);
  for(const effect of ["read","apply"] as const) rejectsUnchanged(j,event(j,{event_type:"operation_admitted",operation:operation(`new-${effect}`,effect)}),/assignment_provider_usage_held/);
  rejectsUnchanged(j,event(j,{event_type:"operation_admitted",operation:operation("fake-reconciliation","read",{purpose:"reconciliation"})}),/assignment_provider_usage_held/);
});

test("admitted provider settlement and honest late raw receipts survive the hold",()=>{
  const j=journal();
  j.append(event(j,{event_type:"provider_call_state_recorded",call_id:"inflight",state:"admitted",provider:"openai",model:"configured-model",expected_information:["continue"]}));
  j.append(hold(j)); assert.equal(decision(j).decision,"await_provider");
  rejectsUnchanged(j,resume(j),/not_quiescent/);
  j.append(event(j,{event_type:"provider_call_state_recorded",call_id:"inflight",state:"completed",success:false,error_class:"provider"}));
  completedCall(j,"late-raw-response",12);
  assert.equal(j.snapshot().in_flight_provider_call_ids.length,0);
  assert.equal(j.snapshot().provider_calls["late-raw-response"]!.usage!.total_tokens,12);
  assert.equal(decision(j).decision,"await_provider_resume");
});

test("held admitted parents retain child authority and settle without admitting new roots",()=>{
  const j=journal(); admit(j,operation("parent")); j.append(hold(j));
  assert.equal(decision(j).decision,"await_operation");
  admit(j,operation("child","read",{operation_role:"child",parent_operation_id:"parent",root_operation_id:"parent",blocks_parent_settlement:true}));
  assert.throws(()=>settleNone(j,"parent"),/child/);
  settleNone(j,"child"); settleNone(j,"parent");
  assert.equal(j.snapshot().quiescent,true); assert.equal(decision(j).decision,"await_provider_resume");
});

test("unknown native effects precede hold waiting and allow only exact read-only reconciliation",()=>{
  const j=journal(); admit(j,operation("uncertain","apply"));
  j.append(event(j,{event_type:"native_dispatch_recorded",operation_id:"uncertain"},"native-host"));
  j.append(hold(j));
  j.append(event(j,{event_type:"operation_result_recorded",result:{schema:OPERATION_RESULT_V2_SCHEMA,result_id:"unknown-result",operation_id:"uncertain",binding,
    status:"timed_out",dispatch_state:"dispatched",persistent_effect:"unknown",native_transaction_state:"unknown",authority:"native-host",
    result_schema_id:"fixture/v1",observation_required:false,completed_at:at(8)}}));
  assert.equal(decision(j).decision,"reconcile_operation");
  rejectsUnchanged(j,resume(j),/reconciliation_required/);
  rejectsUnchanged(j,event(j,{event_type:"operation_admitted",operation:operation("wrong-subject","read",{purpose:"reconciliation",reconciliation_of_operation_id:"foreign"})}),/assignment_provider_usage_held/);
  admit(j,operation("readback","read",{purpose:"reconciliation",reconciliation_of_operation_id:"uncertain"}));
  settleNone(j,"readback");
  rejectsUnchanged(j,resume(j),/reconciliation_required/);
  j.append(event(j,{event_type:"reconciliation_recorded",operation_id:"uncertain",resolved_effect:"none",observation_ids:[]},"native-recovery"));
  assert.equal(decision(j).decision,"await_provider_resume");
  j.append(resume(j)); assert.equal((j.snapshot() as any).provider_usage_hold,undefined);
});

test("Resume requires the current hold, exact assignment version, command and authenticated binding",()=>{
  const j=journal(); j.append(hold(j));
  for(const change of [{expected_hold_id:undefined},{expected_hold_id:"older-hold"},{expected_assignment_version:undefined},
    {expected_assignment_version:1},{expected_command_id:"older-pause"}]) rejectsUnchanged(j,resume(j,change),/stale/);
  rejectsUnchanged(j,{...resume(j),actor:"provider"},/authority/);
  rejectsUnchanged(j,{...resume(j),binding:{...binding,document_fingerprint:"other-rvt"}},/stale_binding/);
  const before=j.snapshot(), command=resume(j); j.append(command); const after:any=j.snapshot();
  assert.equal(after.provider_usage_hold,undefined); assert.equal(after.execution_control.state,"running");
  for(const field of ["spec","current_binding","provider_calls","operations","observations","input_values"] as const) assert.deepEqual(after[field],before[field]);
  assert.deepEqual(j.append(command),after);
  rejectsUnchanged(j,resume(j,{expected_hold_id:"hold-one"}),/hold_stale/);
  assert.equal(j.events().filter(row=>row.event_type === ("provider_usage_hold_recorded" as any)).length,1);
});

test("independent Pause remains held until one exact fenced Resume clears both choices",()=>{
  const j=journal(); j.append(hold(j)); const stale=resume(j);
  j.append(event(j,{event_type:"execution_control_requested",command_id:"user-pause",action:"pause",expected_command_id:null},"authenticated-user"));
  assert.equal(decision(j).decision,"paused"); assert.ok((j.snapshot() as any).provider_usage_hold);
  rejectsUnchanged(j,{...stale,assignment_version:j.snapshot().assignment_version+1,event_id:"stale-resume"},/assignment_control_stale/);
  j.append(resume(j)); assert.equal(j.snapshot().execution_control!.state,"running"); assert.equal((j.snapshot() as any).provider_usage_hold,undefined);
});

test("ordinary Pause and Resume remain compatible without hold/version fields",()=>{
  const j=journal();
  j.append(event(j,{event_type:"execution_control_requested",command_id:"pause",action:"pause",expected_command_id:null},"authenticated-user"));
  assert.equal(decision(j).decision,"paused");
  j.append(event(j,{event_type:"execution_control_requested",command_id:"resume",action:"resume",expected_command_id:"pause"},"authenticated-user"));
  assert.equal(decision(j).decision,"admit_reasoning_turn");
});

test("cleared hold identities cannot resurrect through new events or journal forks",()=>{
  const j=journal(); const original=hold(j); j.append(original); j.append(resume(j));
  const reloaded=new AssignmentJournalV2(j.events());
  rejectsUnchanged(reloaded,hold(reloaded),/identity_reused/);
  const fork=reloaded.fork(); fork.append(hold(fork,{},"hold-next"));
  assert.equal((reloaded.snapshot() as any).provider_usage_hold,undefined);
  assert.equal((fork.snapshot() as any).provider_usage_hold.hold_id,"hold-next");
  rejectsUnchanged(fork,resume(fork,{expected_hold_id:"hold-one"}),/hold_stale/);
  assert.deepEqual(reloaded.append(original),reloaded.snapshot(),"a historical exact duplicate never reactivates its projection");
});

test("pending user input and review cannot be cleared by quota Resume",()=>{
  for(const kind of ["input","review"]) {
    const j=journal(); j.append(hold(j));
    if(kind === "input") j.append(event(j,{event_type:"input_requested",variable_id:"direction",clarification_id:"question",question:"Which option?"}));
    else j.append(event(j,{event_type:"review_requested",review_id:"review",work_unit_ids:["work-read"],reason:"Review required"}));
    rejectsUnchanged(j,resume(j),/input_or_review_pending/);
    assert.equal(decision(j).decision,kind === "input" ? "request_user_input" : "request_user_review");
  }
});

test("frozen call, token, operation and active-time allowances remain cumulative across waiting",()=>{
  for(const kind of ["calls","tokens","operations","time"] as const) {
    const j=journal(spec(false));
    if(kind === "operations" || kind === "time") {admit(j,operation("prior")); settleNone(j,"prior",at(3));}
    const allowance={...budget,...(kind === "calls" ? {max_provider_calls:1} : kind === "tokens" ? {max_total_tokens:5}
      : kind === "operations" ? {max_operations:1} : {max_wall_clock_ms:2_000})};
    j.append(hold(j,{resume_budget:allowance}));
    if(kind === "calls" || kind === "tokens") completedCall(j,"late-billed-response",5);
    rejectsUnchanged(j,resume(j),/budget_exhausted/);
    assert.equal(decision(j,budget,at(86400)).decision,"blocked");
    assert.ok((j.snapshot() as any).provider_usage_hold);
  }
  const waiting=journal(); completedCall(waiting); waiting.append(hold(waiting));
  const command=resume(waiting); command.occurred_at=at(86400); waiting.append(command);
  assert.equal((waiting.snapshot() as any).provider_usage_hold,undefined,"idle waiting does not consume active-time allowance");
  assert.equal(Object.keys(waiting.snapshot().provider_calls).length,1,"Resume grants no fresh accounting ledger");
});

test("a captured allowance cannot exceed the immutable advisory policy on Resume",()=>{
  const value=spec(); value.execution_policy={...value.execution_policy!,max_provider_calls:1};
  const j=journal(value); j.append(hold(j,{resume_budget:budget})); completedCall(j);
  rejectsUnchanged(j,resume(j),/budget_exhausted/);
});

test("hold prevents semantic auto-completion while real failure and terminal facts remain authoritative",()=>{
  const j=journal(spec(false));
  j.append(event(j,{event_type:"criterion_evaluated",evaluation:{criterion_id:"result",status:"not_applicable",basis:"policy",
    supporting_operation_ids:[],supporting_facts:[],evaluator_authority:"test",reason:"No remaining work",evaluated_at:at(1)}}));
  assert.equal(j.snapshot().outcome,"active","apply task still requires native effect or equivalence");
  const reading=spec(false); reading.requested_effect="read";
  const readJournal=journal(reading);
  readJournal.append(event(readJournal,{event_type:"criterion_evaluated",evaluation:{criterion_id:"result",status:"not_applicable",basis:"policy",
    supporting_operation_ids:[],supporting_facts:[],evaluator_authority:"test",reason:"No remaining work",evaluated_at:at(1)}}));
  assert.equal(readJournal.snapshot().outcome,"complete"); readJournal.append(hold(readJournal));
  assert.equal(readJournal.snapshot().outcome,"active"); assert.equal(decision(readJournal).decision,"await_provider_resume");
  j.append(hold(j));
  j.append(event(j,{event_type:"execution_failure_recorded",failure:{schema:ASSIGNMENT_EXECUTION_FAILURE_V2_SCHEMA,failure_id:"drain-failed",binding,
    error_class:"runtime",phase:"response_handoff",code:"assignment_runtime_failed"}}));
  assert.equal(j.snapshot().outcome,"failed"); assert.ok((j.snapshot() as any).provider_usage_hold);
  rejectsUnchanged(j,resume(j),/execution_blocked/);
  j.append(event(j,{event_type:"assignment_terminal",outcome:"failed",reason:"Independent drain failure"}));
  rejectsUnchanged(j,resume(j),/terminal_immutable/);
});
