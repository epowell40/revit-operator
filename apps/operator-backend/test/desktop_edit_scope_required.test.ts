import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {openAssignmentKernelOperationV2} from '../src/assignments/assignment_kernel_v2_execution.js';
import {deriveAssignmentOutcomeV2} from '../src/domain/assignment-kernel/outcome.js';
import {declareWorkPlanV2,completeWorkPlanItemV2} from '../src/domain/assignment-kernel/work_plan.js';
import {assignmentWorkAllowanceV2} from '../src/domain/assignment-kernel/effective_work_budget.js';
import {operationScopeRequestHash} from '../src/domain/assignment-kernel/operation_scope.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';

const retained=JSON.parse(fs.readFileSync('test/fixtures/desktop-edit-scope272.json','utf8'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-edit-scope-'));
const env={OPERATOR_WORKSPACE_ROOT:root,OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_LOCAL_EXECUTOR_PROFILE:'',OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS:'none'};
const prior=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
after(()=>{__closeForTests();for(const[k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});});
let serial=0;
function fresh(source=retained.snapshot.spec.source_user_request,effect='apply',desktop=true){
 const n=++serial,session='scope-session-'+n;
 const goal=createGoal({title:'Fixture '+n,objective:source,acceptance_criteria:['Return a truthful, evidence-backed result for the requested work.'],status:'active',created_by:'fixture-host',related_session_id:session,
  work_budget:{requested_effect:effect,source_user_request:source,conversation_message_id:'message-'+n,document_fingerprint:'fixture-model',
   ...(desktop?{mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent'}:{mode:'auto_goal'})}});
 const run=createAssignmentKernelForGoalV2({goal,run_id:'run-'+n});
 return getAssignmentKernelSnapshotV2(run.assignment_id)!;
}
function withCurrentScope(){
 const current=fresh(),s=structuredClone(retained.snapshot);
 s.spec.work_plan_required=current.spec.work_plan_required;
 s.spec.work_plan_min_items=(current.spec as any).work_plan_min_items;
 return s;
}
const at='2026-10-20T14:31:15.000Z',done='2026-10-20T14:34:05.000Z';
function declare(s:any,items:any[]){s.work_plan=declareWorkPlanV2({...s,operations:{}},{items,assumptions:[]},at);return s;}
const item=(item_id:string,description:string)=>({item_id,description,source_basis:description});

test('actual272 desktop request requires a retained full-task plan before its first native edit',()=>{
 const s=fresh();assert.equal(s.spec.work_plan_required,true);
 assert.equal((s.spec as any).work_plan_min_items,1,'one object is not automatically a broad workload');
 assert.throws(()=>openAssignmentKernelOperationV2({snapshot:s,controller_request_id:'fixture',provider_turn_id:'fixture-turn',capability_id:'revit_call_tool',classified_effect:'apply',
  arguments:{method:'POST',path:'/revit/create-text',body:{action:'create',viewId:1363423,text:'TERMINATE DRYER VENT PER MANF. REQUIREMENTS',x:-23.26,y:-40.03,typeId:10352}}}),/declare_work_plan_before_apply/);
});

test('retained272 native proof still proves its edit, but cannot complete the unplanned desktop request',()=>{
 const legacy=structuredClone(retained.snapshot),before=JSON.stringify(legacy);
 assert.equal(deriveAssignmentOutcomeV2(legacy),'complete','retain the original false-complete evidence');
 const current=withCurrentScope();assert.equal(deriveAssignmentOutcomeV2(current),'active');
 assert.equal(deriveAssignmentOutcomeV2(JSON.parse(JSON.stringify(current))),'active','cold reduction retains the obligation');
 assert.equal(JSON.stringify(legacy),before,'do not migrate or rewrite historical evidence');
});

test('a completed note cannot consume the distinct requested leader, inspection and saved-output items',()=>{
 const s=declare(withCurrentScope(),[item('note','Create the requested native note.'),item('leader','Add the requested leader at the termination.'),item('review','Check the actual M103 sheet.'),item('save','Save the requested separate result model.')]);
 const applied=Object.values(s.operations).find((o:any)=>o.requested_effect==='apply') as any;
 s.work_plan=completeWorkPlanItemV2(s,'note',[applied.operation_id],done);
 assert.equal(deriveAssignmentOutcomeV2(s),'active');
 assert.throws(()=>completeWorkPlanItemV2(s,'save',[applied.operation_id],done),(error:any)=>error.code==='work_plan_operation_unverified','one native effect cannot be reused as a second deliverable');
 assert.equal(s.work_plan.items.filter((i:any)=>i.completed_at).length,1);
});

test('a genuinely single-note request needs no invented leader or Save As requirement and no larger allowance',()=>{
 const s=withCurrentScope();s.spec.source_user_request='Add the native note TERMINATE DRYER VENT PER MANF. REQUIREMENTS.';
 declare(s,[item('note',s.spec.source_user_request)]);
 const applied=Object.values(s.operations).find((o:any)=>o.requested_effect==='apply') as any;
 s.work_plan=completeWorkPlanItemV2(s,'note',[applied.operation_id],done);
 assert.equal(deriveAssignmentOutcomeV2(s),'complete');
 assert.equal(assignmentWorkAllowanceV2(s).source_required_plan,undefined,'a desktop checklist alone earns no broad planning window');
});

test('read requests and non-desktop single edits retain their prior contract; source-wide work stays broad',()=>{
 assert.equal(fresh('Tell me the active project.','read').spec.work_plan_required,undefined);
 assert.equal(fresh('Change one parameter.','apply',false).spec.work_plan_required,undefined);
 const broad=fresh('Update all equipment tags and inspect the result.');
 assert.equal(broad.spec.work_plan_required,true);assert.notEqual((broad.spec as any).work_plan_min_items,1);
 assert.throws(()=>declareWorkPlanV2(broad,{items:[item('one','One subset of the broad request.')],assumptions:[]},done),
  (error:any)=>error.code==='work_plan_scope_incomplete','the existing broad-source minimum is unchanged');
});

test('a full source-bound desktop edit/inspection checklist does not unlock the broad-source resource window',()=>{
 const s=withCurrentScope();
 s.spec.interpreted_scope={source_message_id:'fixture-source',source_request_sha256:operationScopeRequestHash(s.spec.source_user_request),
  scope:{schema:'revit-operator.interpreted-operation-scope/v1',requested_effect:'apply',model_effect:'apply',protected_clauses:[],prerequisites:[]}};
 declare(s,[item('note','Create the requested note.'),{...item('inspect','Inspect the actual note and source requirements.'),kind:'inspection',depends_on:['note']}]);
 const allowance=assignmentWorkAllowanceV2(s);
 assert.equal(allowance.source_required_plan,undefined);
 assert.equal(allowance.provider_calls,assignmentWorkAllowanceV2({...s,spec:{...s.spec,work_plan_required:false}}).provider_calls);
});
