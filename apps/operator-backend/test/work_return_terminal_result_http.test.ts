import assert from 'node:assert/strict';import test from 'node:test';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {settleAssignmentKernelExecutionFailureV2} from '../src/assignments/assignment_kernel_v2_execution_failure.js';
import {handleWorkReturnHttpRoute} from '../src/work_returns/http_routes.js';
import {verifyWorkReturnHash} from '../src/work_returns/generator.js';
import {DESKTOP_SCOPED_HELPER_GUIDANCE} from '../src/assignments/desktop_executor_owner.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';

test('actual Work Return HTTP keeps a bound canonical stopped result without changing the persisted return',()=>runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},()=>{
 const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-return-result-'));process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{const goal=createGoal({title:'Review stopped edit',objective:'Add an editable review note in unused paper, verify and save separately.',acceptance_criteria:['Requested note and delivery verified.'],status:'active',related_session_id:'return-http-session',work_budget:{requested_effect:'apply',document_fingerprint:'a'.repeat(64)}});
  createAssignmentKernelForGoalV2({goal,run_id:'return-http-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  let activeBody:any;assert(handleWorkReturnHttpRoute({method:'GET'} as any,{setHeader(){},end(bytes:string){activeBody=JSON.parse(bytes)}} as any,new URL('http://localhost/api/assignments/'+goal.id+'/work-return'),()=>true));
  assert(!activeBody.terminal_result_presentation,'Active work has no terminal result');
  let unauthorizedWrites=0;assert(handleWorkReturnHttpRoute({method:'GET'} as any,{setHeader(){unauthorizedWrites++},end(){unauthorizedWrites++}} as any,new URL('http://localhost/api/assignments/'+goal.id+'/work-return'),()=>false));assert.equal(unauthorizedWrites,0);
  settleAssignmentKernelExecutionFailureV2({binding,failure_id:'user-stop',error_class:'canceled',phase:'provider_turn'});
  const before=JSON.stringify(getAssignmentKernelSnapshotV2(goal.id));let body:any,status=200;
  const response={setHeader(){},get statusCode(){return status},set statusCode(v:number){status=v},end(bytes:string){body=JSON.parse(bytes)}};
  assert(handleWorkReturnHttpRoute({method:'GET'} as any,response as any,new URL('http://localhost/api/assignments/'+goal.id+'/work-return'),s=>s==='return-http-session'));
  assert.equal(status,200);assert(verifyWorkReturnHash(body.work_return));assert.equal(body.work_return.status,'blocked');
  assert.equal(body.terminal_result_presentation?.work_return_id,body.work_return.work_return_id,'Native-backed canonical handoff must survive the actual Work Return route');
  assert.equal(body.terminal_result_presentation?.binding.run_id,binding.run_id);assert.match(body.terminal_result_presentation?.terminal_result_v2.result_summary??'',/did not complete/);
  assert.equal(JSON.stringify(getAssignmentKernelSnapshotV2(goal.id)),before,'A result read must not advance or settle historical work');
 }finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;__testOnlyResetGoalListCache();fs.rmSync(root,{recursive:true,force:true});}
}));
test('actual worker guidance defines spatially ready work before grouped edits and checkpoint save',()=>{
 assert.match(DESKTOP_SCOPED_HELPER_GUIDANCE,/rendered.{0,90}(?:before|prior)|(?:before|prior).{0,90}rendered/i);
 assert.match(DESKTOP_SCOPED_HELPER_GUIDANCE,/aggregate.{0,90}(?:not|never)|(?:not|never).{0,90}aggregate/i);
});
