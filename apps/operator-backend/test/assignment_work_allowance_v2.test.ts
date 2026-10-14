import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { assignmentWorkAllowanceV2, defaultAssignmentWorkBudgetV2, absoluteAssignmentWorkCallLimitV2, assignmentWorkBudgetStatusV2 } from "../src/assignments/assignment_work_allowance_v2.js";
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 as ordinary } from "../src/assignments/assignment_kernel_v2_progress.js";

test("whole-set redline usage warns before the cached-context limit without changing authority", () => {
  const s:any = fixture();
  s.spec.created_at = "2026-10-11T16:54:36Z";
  s.spec.execution_policy = { mode:"local_advisory_v1", max_provider_calls:64, max_operations:256,
    max_total_tokens:8_000_000, max_wall_clock_ms:1_200_000 };
  s.provider_calls = { retained: { admitted_at:s.spec.created_at, completed_at:"2026-10-11T17:01:06Z",
    usage:{total_tokens:8_188_259, input_tokens:8_181_432, output_tokens:6_827, cached_input_tokens:7_978_425} } };
  const original = JSON.stringify(s);
  const status = assignmentWorkBudgetStatusV2(s,ordinary,"2026-10-11T17:02:00Z");
  assert.equal(status.resources.total_tokens.remaining,0);
  assert.equal(status.cached_input_tokens,7_978_425);
  assert.deepEqual(status.token_breakdown,{input_tokens:8_181_432,cached_input_tokens:7_978_425,
    cache_write_input_tokens:null,uncached_input_tokens:null,output_tokens:6_827,
    input_includes_cached:true,input_includes_cache_write:true,cost_estimate_available:false});
  assert.equal(status.cost_estimate.total_usd,null,"an aggregate without request categories and model cannot establish cost");
  assert.equal(status.checkpoint_recommended,true);
  assert.deepEqual(status.approaching_limits,["total_tokens"]);
  assert.equal(JSON.stringify(s),original,"projection never resets usage or changes the frozen policy");
  s.provider_calls.retained.usage.total_tokens=6_000_000;
  assert.equal(assignmentWorkBudgetStatusV2(s,ordinary,"2026-10-11T17:02:00Z").checkpoint_recommended,true);
  s.provider_calls.retained.usage.total_tokens=5_999_999;
  assert.equal(assignmentWorkBudgetStatusV2(s,ordinary,"2026-10-11T17:02:00Z").checkpoint_recommended,false);
  delete s.provider_calls.retained.usage;
  delete s.provider_calls.retained.admitted_at;
  const missing=assignmentWorkBudgetStatusV2(s,ordinary,"2026-10-11T17:02:00Z");
  assert.equal(missing.missing_usage_calls,1);
  assert.equal(missing.token_breakdown.uncached_input_tokens,null);
  assert.equal(missing.token_breakdown.output_tokens,null);
  assert.equal(missing.resources.active_execution_ms.remaining,null);
  assert.equal(missing.checkpoint_recommended,true);
});

test("budget telemetry prices exact requests with coverage while leaving admission and usage unchanged", () => {
  const s:any=fixture();
  s.provider_calls={
    first:{model:"gpt-6.1-sol",usage:{input_tokens:150_000,cached_input_tokens:140_000,cache_write_input_tokens:1000,output_tokens:10,total_tokens:150_010}},
    second:{model:"gpt-6.1-sol",usage:{input_tokens:150_000,cached_input_tokens:140_000,cache_write_input_tokens:1000,output_tokens:10,total_tokens:150_010}}
  };
  const original=JSON.stringify(s),status=assignmentWorkBudgetStatusV2(s,ordinary,"2026-10-11T17:02:00Z");
  assert.equal(status.token_breakdown.uncached_input_tokens,18_000);
  assert.equal(status.token_breakdown.cache_write_input_tokens,2000);
  assert.equal(status.cost_estimate.status,"complete");
  assert.equal(status.cost_estimate.total_usd,(9000*2+140_000*.1+1000*2.5+10*10)*2/1_000_000,
    "assignment aggregate above272K does not apply a per-request multiplier");
  assert.equal(status.token_breakdown.cost_estimate_available,true);
  assert.equal(JSON.stringify(s),original);
  s.provider_calls.second.model="unpriced-model";
  const partial=assignmentWorkBudgetStatusV2(s,ordinary,"2026-10-11T17:02:00Z");
  assert.equal(partial.cost_estimate.status,"partial");
  assert.equal(partial.cost_estimate.total_usd,null);
  assert.equal(partial.cost_estimate.priced_calls,1);
  assert.equal(partial.cost_estimate.unpriced_calls,1);
  assert.equal(partial.cost_estimate.known_subtotal_usd,status.cost_estimate.total_usd!/2);
  s.provider_calls={};
  const empty=assignmentWorkBudgetStatusV2(s,ordinary,"2026-10-11T17:02:00Z");
  assert.equal(empty.cost_estimate.status,"unavailable");
  assert.equal(empty.cost_estimate.total_usd,null);
  assert.equal(empty.cost_estimate.known_subtotal_usd,null);
});

function fixture(count=0): any {
  const binding={assignment_id:"area",run_id:"run",generation:1,session_id:"session"};
  const s:any={current_binding:binding,spec:{requested_effect:"apply",work_plan_required:true},operations:{},observations:{},
    work_plan:{items:[{item_id:"a",declared_at:"2026-09-16T00:00:00Z"},{item_id:"b",declared_at:"2026-09-16T00:00:00Z"}]}};
  for(let i=0;i<count;i++){
    s.operations[`edit${i}`]={operation_id:`edit${i}`,binding,requested_effect:"apply",persistent_effect:"applied",settlement_state:"settled",
      opened_at:"2026-09-16T01:00:00Z",request_identity:{request_signature:`request${i}`},verification_operation_ids:[`read${i}`],
      result:{binding,authority:"native-host",status:"succeeded",native_transaction_state:"committed",affected_target_identities:[`element_id:${i+1}`]}};
    s.operations[`read${i}`]={target:{target_id:`id:${i+1}`},operation_id:`read${i}`,binding,requested_effect:"read",purpose:"verification",persistent_effect:"none",settlement_state:"settled",
      verification_of_operation_id:`edit${i}`,observation_ids:[`observation${i}`],result:{binding,authority:"native-host",status:"succeeded"}};
    s.observations[`observation${i}`]={operation_id:`read${i}`,binding,authority:"native-host",facts:[{fact_id:"verification.postcondition_satisfied",fact_class:"verification",value:true}]};
  }
  return s;
}

test("local work earns bounded continuation from distinct native readbacks without rewriting its frozen policy",()=>{
  const s=fixture(2);
  s.spec.created_at="2026-09-16T00:00:00Z";
  s.spec.execution_policy={mode:"local_advisory_v1",max_provider_calls:48,max_operations:256,max_total_tokens:8_000_000,max_wall_clock_ms:1_800_000,
    progress_allowance:{mode:"verified_native_changes_v1",max_provider_calls:256,max_operations:1024,max_total_tokens:32_000_000}};
  delete s.work_plan;
  s.provider_calls={used:{usage:{total_tokens:7_000_000}}};
  const retained=JSON.stringify(s);
  assert.deepEqual(assignmentWorkAllowanceV2(s),{broad:true,verified_changes:2,provider_calls:64});
  const budget=defaultAssignmentWorkBudgetV2(s,ordinary);
  assert.equal(budget.max_total_tokens,10_000_000);
  assert.equal(budget.max_operations,320);
  assert.equal(budget.max_wall_clock_ms,1_800_000);
  assert.equal(JSON.stringify(s),retained,"neither ledger nor creation policy changes");
  assert.deepEqual(defaultAssignmentWorkBudgetV2(JSON.parse(retained),ordinary),budget,"cold replay earns the same credit");
  for(const change of [
    (n:any)=>n.operations.read1.target.target_id="id:1",
    (n:any)=>n.observations.observation1.authority="model",
    (n:any)=>n.operations.edit1.persistent_effect="unknown",
    (n:any)=>n.operations.edit1.result.native_transaction_state="pending",
    (n:any)=>n.operations.edit1.result.binding={...n.current_binding,generation:2},
    (n:any)=>n.observations.observation1.facts[0].value=false,
    (n:any)=>n.operations.edit1.request_identity.request_signature="request0"
  ]){const n=structuredClone(s);change(n);assert.equal(assignmentWorkAllowanceV2(n).verified_changes,1);}
  const old=structuredClone(s);delete old.spec.execution_policy.progress_allowance;
  assert.equal(defaultAssignmentWorkBudgetV2(old,ordinary).max_total_tokens,8_000_000,"historical fixed budget stays fixed");
  const read=structuredClone(s);read.spec.requested_effect="read";
  assert.equal(assignmentWorkAllowanceV2(read).verified_changes,0);
  const unproved=structuredClone(s);unproved.observations={};
  assert.equal(defaultAssignmentWorkBudgetV2(unproved,ordinary).max_provider_calls,48,"claims and reads alone cannot earn calls");
  const maximum=fixture(100);maximum.spec={...maximum.spec,created_at:s.spec.created_at,execution_policy:s.spec.execution_policy};
  const cap=defaultAssignmentWorkBudgetV2(maximum,ordinary);
  assert.equal(cap.max_total_tokens,32_000_000);assert.equal(cap.max_provider_calls,256);assert.equal(cap.max_operations,1024);
});

test("sheet movement credit requires exact requested placements and never substitutes the owning sheet",()=>{
  const s=fixture(1);
  s.operations.edit0.request_identity.path="/revit/move-elements";
  s.operations.read0.request_identity={path:"/revit/sheets"};
  s.operations.read0.target.target_id="id:999";
  const deliverable={fact_id:"verification.deliverable_target_identities",fact_class:"verification",value:[] as unknown[]};
  s.observations.observation0.facts.push(deliverable);
  assert.equal(assignmentWorkAllowanceV2(s).verified_changes,0,"a missing historical input must fail closed without crashing");
  for(const ids of [undefined,[],[0],["12"]]){
    s.operations.edit0.input={body:{ids}};
    assert.equal(assignmentWorkAllowanceV2(s).verified_changes,0);
  }
  s.operations.edit0.input={body:{ids:[12,13]}};
  assert.equal(assignmentWorkAllowanceV2(s).verified_changes,0,"request arguments alone cannot create checked deliverables");
  deliverable.value=["element_id:12","element_id:13"];
  assert.equal(assignmentWorkAllowanceV2(s).verified_changes,1,"one verified native batch earns one credit");
  for(const value of [["element_id:0"],["element_id:12","element_id:12"],[12],"element_id:12",[]]){
    const n=structuredClone(s);n.observations.observation0.facts[1].value=value;
    assert.equal(assignmentWorkAllowanceV2(n).verified_changes,0,"malformed host deliverable facts cannot earn fallback credit");
  }
});

test("C43 broad work gets bounded planning credit; ordinary short work keeps its budget",()=>{
  const s=fixture(); assert.equal(assignmentWorkAllowanceV2(s).provider_calls,64);
  assert.equal(defaultAssignmentWorkBudgetV2(s,ordinary).max_total_tokens,8_000_000);
  for(const change of [(s:any)=>s.spec.requested_effect="read",(s:any)=>delete s.work_plan]){
    const n=structuredClone(s);change(n);assert.equal(defaultAssignmentWorkBudgetV2(n,ordinary),ordinary);assert.equal(absoluteAssignmentWorkCallLimitV2(n),64);
  }
});

test("C85 retained two-edit plan keeps working when initial classifier missed broad scope",()=>{
  const s=fixture();
  s.spec.work_plan_required=false;
  s.work_plan.items.push({item_id:"inspect",kind:"inspection",declared_at:"2026-09-16T00:00:00Z"});
  assert.deepEqual(assignmentWorkAllowanceV2(s),{broad:true,verified_changes:0,provider_calls:64});
  assert.equal(defaultAssignmentWorkBudgetV2(s,ordinary).max_provider_calls,64);
  assert.equal(absoluteAssignmentWorkCallLimitV2(s),64);
  for (const change of [
    (n:any)=>n.work_plan.items[1].kind="inspection",
    (n:any)=>n.work_plan.items.splice(1,1),
    (n:any)=>n.spec.requested_effect="read"
  ]) {
    const n=structuredClone(s); change(n);
    assert.equal(assignmentWorkAllowanceV2(n).broad,false,"a single edit or read-only plan keeps the ordinary budget");
    assert.equal(defaultAssignmentWorkBudgetV2(n,ordinary).max_provider_calls,ordinary.max_provider_calls);
  }
});

test("C99 one-edit task earns a bounded completion window after an exact native ready dry run",()=>{
  const s=fixture();
  s.work_plan.items[1].kind="inspection";
  s.operations.preview={operation_id:"preview",binding:s.current_binding,requested_effect:"preview",
    operation_role:"root",settlement_state:"settled",observation_ids:["preview-observation"],
    result:{binding:s.current_binding,authority:"native-host",status:"succeeded",native_transaction_state:"rolled_back"}};
  s.observations["preview-observation"]={operation_id:"preview",binding:s.current_binding,
    authority:"native-host",facts:[{fact_id:"control.field.status",fact_class:"control",value:"DryRunReady"}]};
  assert.equal(defaultAssignmentWorkBudgetV2(s,ordinary).max_provider_calls,48);
  assert.equal(defaultAssignmentWorkBudgetV2(s,ordinary).max_reasoning_turns,48);
  assert.equal(defaultAssignmentWorkBudgetV2(s,ordinary).max_total_tokens,6_000_000);
  assert.equal(absoluteAssignmentWorkCallLimitV2(s),64);
  for(const change of [
    (n:any)=>n.operations.preview.result.status="failed_after_dispatch",
    (n:any)=>n.operations.preview.result.native_transaction_state="committed",
    (n:any)=>n.operations.preview.result.authority="model",
    (n:any)=>n.operations.preview.result.binding={...n.current_binding,generation:2},
    (n:any)=>n.operations.preview.binding={...n.current_binding,generation:2},
    (n:any)=>n.observations["preview-observation"].facts[0].value="Blocked",
    (n:any)=>n.observations["preview-observation"].authority="model",
    (n:any)=>n.observations["preview-observation"].binding={...n.current_binding,generation:2},
    (n:any)=>n.spec.requested_effect="read"
  ]){const n=structuredClone(s);change(n);assert.equal(defaultAssignmentWorkBudgetV2(n,ordinary).max_provider_calls,ordinary.max_provider_calls);}
  const duplicate=structuredClone(s);
  duplicate.operations.preview2={...duplicate.operations.preview,operation_id:"preview2"};
  assert.equal(defaultAssignmentWorkBudgetV2(duplicate,ordinary).max_provider_calls,48);
});
test("C106 generic MCP native child earns the one-edit window only through its exact root",()=>{
  const s=fixture();
  s.work_plan.items[1].kind="inspection";
  const path="/revit/existing-conditions-mep-draft-workflow";
  s.operations.parent={operation_id:"parent",binding:s.current_binding,capability_id:"revit_call_tool",
    requested_effect:"preview",operation_role:"root",settlement_state:"settled",request_identity:{path}};
  s.operations.preview={operation_id:"preview",binding:s.current_binding,requested_effect:"preview",
    operation_role:"child",parent_operation_id:"parent",root_operation_id:"parent",
    request_identity:{path},settlement_state:"settled",observation_ids:["preview-observation"],
    result:{binding:s.current_binding,authority:"native-host",status:"succeeded",native_transaction_state:"rolled_back"}};
  s.observations["preview-observation"]={operation_id:"preview",binding:s.current_binding,
    authority:"native-host",facts:[{fact_id:"control.field.status",fact_class:"control",value:"DryRunReady"}]};
  assert.equal(assignmentWorkAllowanceV2(s).provider_calls,48);
  for(const change of [
    (n:any)=>n.operations.parent.request_identity.path="/revit/other",
    (n:any)=>n.operations.parent.capability_id="unrelated",
    (n:any)=>n.operations.parent.binding={...n.current_binding,generation:2},
    (n:any)=>n.operations.preview.root_operation_id="unrelated",
    (n:any)=>n.operations.preview.result.native_transaction_state="unknown",
    (n:any)=>n.input_invalidated_operation_ids=["parent"],
    (n:any)=>n.input_invalidated_operation_ids=["preview"]
  ]){const n=structuredClone(s);change(n);assert.equal(assignmentWorkAllowanceV2(n).provider_calls,32);}
});
test("retained C106 32-call stop would keep working with its exact native child receipt",()=>{
  const s=JSON.parse(fs.readFileSync("test/fixtures/c106-wrapped-preview-budget.json","utf8"));
  assert.equal(assignmentWorkAllowanceV2(s).provider_calls,48);
  const child=Object.values(s.operations).find((op:any)=>op.operation_role==="child") as any;
  const parent=s.operations[child.parent_operation_id];
  assert.equal(parent.capability_id,"revit_call_tool");
  assert.equal(child.result.native_transaction_state,"rolled_back");
  const foreign=structuredClone(s);
  foreign.operations[parent.operation_id].binding.generation++;
  assert.equal(assignmentWorkAllowanceV2(foreign).provider_calls,32);
});
test("only distinct independently verified native edits earn bounded continuation allowance",()=>{
  const s=fixture(2);assert.deepEqual(assignmentWorkAllowanceV2(s),{broad:true,verified_changes:2,provider_calls:80});
  assert.deepEqual(assignmentWorkAllowanceV2(JSON.parse(JSON.stringify(s))),assignmentWorkAllowanceV2(s),"cold replay preserves credit");
  for(const change of [
    (s:any)=>s.operations.edit1.request_identity.request_signature="request0",
    (s:any)=>s.operations.read1.target.target_id="id:1",
    (s:any)=>s.operations.edit1.persistent_effect="unknown",
    (s:any)=>s.operations.edit1.result.authority="dynamic-runtime",
    (s:any)=>s.operations.edit1.result.binding={...s.current_binding,generation:2},
    (s:any)=>s.operations.read1.result.authority="model",
    (s:any)=>s.observations.observation1.facts[0].value=false,
    (s:any)=>s.observations.observation1.binding={...s.current_binding,generation:2},
    (s:any)=>s.operations.edit1.opened_at="2020-01-01T00:00:00Z",
    (s:any)=>s.operations.read1.target={}
  ]){const n=structuredClone(s);change(n);assert.equal(assignmentWorkAllowanceV2(n).verified_changes,1);}
  const maximum=defaultAssignmentWorkBudgetV2(fixture(100),ordinary);
  assert.equal(maximum.max_provider_calls,256);assert.equal(maximum.max_total_tokens,32_000_000);
  assert.equal(maximum.max_wall_clock_ms,120*60_000);assert.equal(maximum.max_operations,1024);
  assert.equal(maximum.max_no_progress_epochs,ordinary.max_no_progress_epochs);
  assert.equal(maximum.max_equivalent_operations,ordinary.max_equivalent_operations);
});

test("C120 steering keeps bounded work credit for an already committed and physically verified edit",()=>{
  const s=fixture(1);
  s.input_invalidated_operation_ids=["edit0"];
  assert.deepEqual(assignmentWorkAllowanceV2(s),{broad:true,verified_changes:1,provider_calls:72});
  assert.equal(defaultAssignmentWorkBudgetV2(s,ordinary).max_provider_calls,72);
  assert.equal(absoluteAssignmentWorkCallLimitV2(s),72);
  const unverified=structuredClone(s);
  unverified.observations.observation0.facts=[];
  assert.equal(assignmentWorkAllowanceV2(unverified).provider_calls,64);
});

test("retained C43 32-call stop had two verified native placements and six uncompleted edit scopes",()=>{
 const s=JSON.parse(fs.readFileSync("test/fixtures/c43-area-budget-plan.json","utf8"));
 assert.equal(s.observed_provider_call_count,32);assert.equal(s.work_plan.items.length,8);
 assert.equal(assignmentWorkAllowanceV2(s).verified_changes,2);assert.equal(assignmentWorkAllowanceV2(s).provider_calls,80);
 assert(s.observed_provider_call_count<defaultAssignmentWorkBudgetV2(s,ordinary).max_provider_calls);
});
