import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { assignmentWorkAllowanceV2, defaultAssignmentWorkBudgetV2, absoluteAssignmentWorkCallLimitV2 } from "../src/assignments/assignment_work_allowance_v2.js";
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 as ordinary } from "../src/assignments/assignment_kernel_v2_progress.js";

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
