import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { declareWorkPlanV2, completeWorkPlanItemV2, inspectionIsCurrentV2, workPlanPendingV2 } from "../src/domain/assignment-kernel/work_plan.js";
import { projectWorkPlan } from "../src/assignments/work_plan_projection.js";
function fixture():any {
 const s=JSON.parse(fs.readFileSync("test/fixtures/c43-area-budget-plan.json","utf8"));
 const edits=Object.values(s.operations).filter((op:any)=>op.requested_effect==="apply") as any[];
 s.work_plan={schema:"revit-operator.assignment-work-plan/v2",assumptions:[],items:edits.map((op,i)=>({item_id:"edit"+i,description:"Synthetic completed placement",source_basis:"Native fixture",declared_at:"2026-09-16T14:00:00Z",operation_ids:[op.operation_id],completed_at:"2026-09-16T14:25:00Z"}))};
 s.work_plan.items.push({item_id:"qc",kind:"inspection",depends_on:["edit0","edit1"],description:"Inspect placements",source_basis:"Native inspection",declared_at:"2026-09-16T14:00:00Z",operation_ids:[]});
 s.operations.inspection={operation_id:"inspection",binding:s.current_binding,requested_effect:"read",persistent_effect:"none",settlement_state:"settled",opened_at:"2026-09-16T14:26:00Z",request_identity:{path:"/revit/get-connectors"},observation_ids:["inspection-observation"],result:{binding:s.current_binding,authority:"native-host",status:"succeeded",dispatch_state:"dispatched",raw_payload_hash:"test-hash"}};
 s.observations["inspection-observation"]={operation_id:"inspection",binding:s.current_binding,authority:"native-host",raw_payload_hash:"test-hash"};
 s.proof={observation_ids:["inspection-observation"],target_ids:["element_id:1542933","element_id:1542934"]};
 return s;
}
test("C43 edit and inspection scopes retain distinct completion requirements",()=>{
 const s=fixture();assert.equal(workPlanPendingV2(s),true);
 const plan=completeWorkPlanItemV2(s,"qc",["inspection"],"2026-09-16T14:27:00Z",s.proof);s.work_plan=plan;
 assert.equal(workPlanPendingV2(s),false);assert.equal(inspectionIsCurrentV2(JSON.parse(JSON.stringify(s)),plan.items[2]!),true);
 const edited=structuredClone(s);edited.operations.later={requested_effect:"apply",persistent_effect:"applied",result:{completed_at:"2026-09-16T14:28:00Z"}};
 assert.equal(workPlanPendingV2(edited),true);assert.equal(projectWorkPlan(edited.work_plan,undefined,0,edited)!.completed_count,2);
});
test("inspection rejects stale, partial, foreign, unverified and edit-substitution evidence",()=>{
 for(const change of [
  (s:any)=>s.proof.target_ids.pop(),(s:any)=>s.proof.observation_ids=[],
  (s:any)=>s.operations.inspection.opened_at="2020-01-01T00:00:00Z",
  (s:any)=>s.operations.inspection.result.status="failed_after_dispatch",
  (s:any)=>s.operations.inspection.result.authority="dynamic-runtime",
  (s:any)=>s.operations.inspection.binding={...s.current_binding,generation:2},
  (s:any)=>s.operations.inspection.persistent_effect="applied",
  (s:any)=>s.work_plan.items[0].completed_at=undefined,
  (s:any)=>s.work_plan.items[0].kind="inspection"
 ]){const s=fixture();change(s);assert.throws(()=>completeWorkPlanItemV2(s,"qc",["inspection"],"2026-09-16T14:27:00Z",s.proof),/Inspect all dependent/);}
 const s=fixture();s.work_plan.items[0].completed_at=undefined;
 assert.throws(()=>completeWorkPlanItemV2(s,"edit0",["inspection"],"2026-09-16T14:27:00Z",s.proof),/Read-only inspection/);
});
test("retained eight-item C43 declaration permits explicit QC dependencies without discarding scope",()=>{
 const s=JSON.parse(fs.readFileSync("test/fixtures/c43-area-budget-plan.json","utf8"));const items=s.work_plan.items.map((p:any)=>({item_id:p.item_id,description:p.description,source_basis:p.source_basis}));
 s.operations={};delete s.work_plan;
 const revised=items.map((item:any)=>item.item_id.endsWith("-qc")?{...item,kind:"inspection",depends_on:items.filter((p:any)=>p.item_id.startsWith(item.item_id.slice(0,4))&&!p.item_id.endsWith("-qc")).map((p:any)=>p.item_id)}:item);
 const plan=declareWorkPlanV2(s,{items:revised,assumptions:[]},"2026-09-16T14:00:00Z");assert.equal(plan.items.length,8);assert.equal(plan.items.filter(p=>p.kind==="inspection").length,2);
 revised[3].depends_on=[revised[3].item_id];assert.throws(()=>declareWorkPlanV2(s,{items:revised,assumptions:[]},"2026-09-16T14:00:00Z"),/Inspections must name/);
});
