import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildHostProgressEpochV2} from '../src/assignments/supporting_discovery_progress.js';
import {decideAssignmentProgressV2} from '../src/domain/assignment-kernel/progress/controller.js';
import {DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2} from '../src/assignments/assignment_kernel_v2_progress.js';
import type {AssignmentSnapshotV2,OperationV2,ObservationV2} from '../src/domain/assignment-kernel/index.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const file=[path.join(here,'fixtures/postedit-preservation-progress.json'),path.join(here,'../../test/fixtures/postedit-preservation-progress.json')].find(fs.existsSync)!;
const f=JSON.parse(fs.readFileSync(file,'utf8')) as {before:AssignmentSnapshotV2;stages:{epoch:any;operation:OperationV2;observation:ObservationV2}[]};
type Mutable<T>={-readonly [K in keyof T]:Mutable<T[K]>};
function transition(before:AssignmentSnapshotV2,stage=f.stages[0]!){
 const after=structuredClone(before),{operation:o,observation:obs}=structuredClone(stage);
 after.operations={...after.operations,[o.operation_id]:o};after.observations={...after.observations,[obs.observation_id]:obs};
 after.observation_versions={...after.observation_versions,[obs.observation_id]:stage.epoch.after_assignment_version};
 after.assignment_version=stage.epoch.after_assignment_version;return after;
}
const epoch=(before:AssignmentSnapshotV2,after:AssignmentSnapshotV2,stage=f.stages[0]!)=>buildHostProgressEpochV2({before,after,
 stated_gap_ids:stage.epoch.unresolved_gap_ids,admitted_operation_ids:stage.epoch.admitted_operation_ids,recorded_at:stage.epoch.recorded_at});
const editId=Object.values(f.before.operations).find(o=>o.requested_effect==='apply')!.operation_id;
test('retained four post-edit preservation reads add knowledge once without certifying inspection',()=>{
 let before=structuredClone(f.before);
 for(const stage of f.stages){const after=transition(before,stage),e=epoch(before,after,stage);
  assert.deepEqual(e.progress_reasons,['controller_knowledge_added'],stage.operation.input.path as string);
  assert.equal(e.genuine_progress,true);assert.deepEqual(after.criteria,before.criteria);assert.deepEqual(after.work_plan,before.work_plan);
  const duplicate=structuredClone(stage),newId=stage.operation.operation_id+'-repeat',newObs=stage.observation.observation_id+'-repeat';
  duplicate.operation.operation_id=newId;duplicate.operation.observation_ids=[newObs];duplicate.operation.result!.operation_id=newId;
  duplicate.observation.operation_id=newId;duplicate.observation.observation_id=newObs;
  duplicate.epoch.admitted_operation_ids=[newId];
  const repeated=transition(after,duplicate);assert.equal(epoch(after,repeated,duplicate).genuine_progress,false,'same interval/new IDs cannot buy progress');
  before=after;
 }
});
test('existing controller can continue to save after useful preservation; hard limits and unknown/Pause still win',()=>{
 let s=structuredClone(f.before);
 for(const stage of f.stages){const after=transition(s,stage);after.progress_epochs=[...s.progress_epochs,epoch(s,after,stage)];s=after;}
 const decide=(snapshot=s,budget=DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2)=>decideAssignmentProgressV2({snapshot,budget,now:f.stages.at(-1)!.epoch.recorded_at});
 assert.equal(decide().decision,'admit_reasoning_turn');assert.equal(s.terminal,false);assert(s.work_plan!.items.some(i=>!i.completed_at));
 assert.equal(decide({...s,execution_control:{...s.execution_control!,state:'paused'}}).decision,'paused');
 assert.equal(decide({...s,unresolved_unknown_operation_ids:[editId]}).decision,'reconcile_operation');
 assert.equal(decide(s,{...DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,max_operations:1}).reason,'operation_budget_exhausted');
 const repeat=epoch(s,s);s={...s,progress_epochs:[...s.progress_epochs,...Array.from({length:4},()=>repeat)]};
 assert.equal(decide().reason,'no_progress_budget_exhausted');
});
for(const variant of ['no-plan','no-dependency','inspection-complete','inspection-deferred','edit-pending','write-unknown','write-foreign','write-failed','write-invalidated','write-unobserved','write-after-read','write-preview','write-rollback','write-unsettled','write-without-receipt'])test('no preservation renewal from '+variant,()=>{
 const before=structuredClone(f.before) as Mutable<AssignmentSnapshotV2>,write=before.operations[editId]!,inspection=before.work_plan!.items.find(i=>i.item_id==='final_native_visual_preservation')!;
 if(variant==='no-plan')delete before.work_plan;
 if(variant==='no-dependency')inspection.depends_on=[];
 if(variant==='inspection-complete')inspection.completed_at=f.stages[0]!.operation.opened_at;
 if(variant==='inspection-deferred')inspection.deferrals=[{resumed_at:undefined} as any];
 if(variant==='edit-pending')delete before.work_plan!.items.find(i=>i.kind==='edit'&&i.operation_ids.includes(editId))!.completed_at;
 if(variant==='write-unknown')write.persistent_effect='unknown';
 if(variant==='write-foreign')write.result!.binding={...write.binding,generation:2};
 if(variant==='write-failed')write.result!.status='failed_after_dispatch';
 if(variant==='write-invalidated')before.input_invalidated_operation_ids=[editId];
 if(variant==='write-unobserved')write.observation_ids=[];
 if(variant==='write-after-read')write.result!.completed_at='2099-01-01T00:00:00Z';
 if(variant==='write-preview')write.requested_effect='preview';
 if(variant==='write-rollback')write.result!.native_transaction_state='rolled_back';
 if(variant==='write-unsettled')write.settlement_state='pending' as any;
 if(variant==='write-without-receipt')delete write.result!.receipt_id;
 assert.equal(epoch(before,transition(before)).genuine_progress,false);
});
for(const variant of ['failed','unbound','unobserved','foreign','no-gap','caller-epoch','invalidated'])test('read proof and identity guard: '+variant,()=>{
 const before=structuredClone(f.before),after=transition(before),o=after.operations[f.stages[0]!.operation.operation_id]!,obs=after.observations[o.observation_ids[0]!]!;
 if(variant==='failed')o.result!.status='failed_after_dispatch';
 if(variant==='unbound')obs.raw_payload_hash='different';
 if(variant==='unobserved')o.observation_ids=[];
 if(variant==='foreign')obs.binding={...obs.binding,generation:2};
 if(variant==='no-gap')o.resolves_gap_ids=[];
 if(variant==='invalidated')after.input_invalidated_operation_ids=[o.operation_id];
 if(variant==='caller-epoch'){
  const repeated=transition(after);(repeated.operations[o.operation_id]!.input.body as any).writeEpoch='invented';
  assert.equal(epoch(after,repeated).genuine_progress,false);return;
 }
 assert.equal(epoch(before,after).genuine_progress,false);
});
