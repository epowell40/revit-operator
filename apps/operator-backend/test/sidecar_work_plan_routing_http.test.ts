import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {startExternalAssignmentRun} from '../src/assignments/external_assignment_start.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {handleAssignmentHttpRoute} from '../src/assignments/http_routes.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';

test('real strict status wire reaches Sidecar canonical recovery and refuses untracked export without altering task truth',async()=>{
 let directory=process.cwd(),modulePath='';
 while(!modulePath){
  modulePath=['packages/operator-assistant-ui/work_report.mjs','operator-desktop/work_report.mjs'].map(p=>path.join(directory,p)).find(p=>fs.existsSync(p))||'';
  if(!modulePath){const parent=path.dirname(directory);assert.notEqual(parent,directory);directory=parent;}
 }
 const {missingWorkReportContinuation}=await import(pathToFileURL(modulePath).href);
 const {requireTrackedNativeTask}=await import(pathToFileURL(path.join(path.dirname(modulePath),'native_task_routing.mjs')).href);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sidecar-routing-http-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_LOCAL_EXECUTOR_PROFILE:'',OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS:'none'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','fixture-only')},async()=>{
  const source='Tell me the active Revit project, sheet number and view name.',session='own';
  const goal=createGoal({title:source,objective:source,acceptance_criteria:['Deliver the requested native result.'],status:'active',related_session_id:session,created_by:'local-host',
   work_budget:{requested_effect:'read',source_user_request:source,mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent',document_fingerprint:'fixture-model'}});
  const run=startExternalAssignmentRun({goal,sessionId:session,requestedRunId:'sidecar:original',actor:'operator_desktop_outer_agent'});
  const before=structuredClone(getAssignmentKernelSnapshotV2(goal.id)!);
  const owner={kernel_version:2,goal_id:goal.id,session_id:session,run_id:run.runId,generation:run.generation};
  const request=async(route:string,options:any)=>{
   const req=Readable.from(options.body?[Buffer.from(options.body)]:[]) as any;req.method=options.method;
   let code=200,text='';const res:any={get statusCode(){return code;},set statusCode(c:number){code=c;},writeHead(c:number){code=c;},setHeader(){},end(v:string){text+=v;}};
   assert(await handleAssignmentHttpRoute(req,res,new URL('http://fixture'+route),id=>id===session));
   const result=JSON.parse(text);assert(code<400,JSON.stringify(result));return result;
  };
  const status=await request('/api/assignments/v2/work-plan',{method:'POST',body:JSON.stringify({action:'status',session_id:session,assignment_id:goal.id,run_id:run.runId,generation:run.generation})});
  assert.equal(status.verification_policy,'strict','missing field disabled the Sidecar strict completion reminder');
  assert.equal(status.outcome,'active');
  assert.match(status.edit_completion_guidance,/only.*applied edit.*IDs/i);
  assert.match(status.edit_completion_guidance,/Do not drop those checks or repeat edits/);
  assert.match(status.planning_guidance,/inspection/);
  assert.match(status.planning_guidance,/already correct/);
  const command={action:'complete',session_id:session,assignment_id:goal.id,run_id:run.runId,generation:run.generation,item_id:'inspection'};
  await assert.rejects(request('/api/assignments/v2/work-plan',{method:'POST',body:JSON.stringify({...command,expected_assignment_version:before!.assignment_version+1})}),/work_plan_version_changed/);
  await assert.rejects(request('/api/assignments/v2/work-plan',{method:'POST',body:JSON.stringify({...command,expected_assignment_version:before!.assignment_version})}),/work_plan_completion_references_required/);
  const next=await missingWorkReportContinuation(owner,request,0);
  assert.equal(next.kind,'continue');assert.match(next.input.content[0].text,/delegate_revit_task/);
  await assert.rejects(requireTrackedNativeTask(owner,request,'export_revit_sheets_pdf'),/canonical_native_task_required/);
  assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id),before,'routing/status cannot mint operations, evidence or completion');
 });}finally{
  __closeForTests();__testOnlyResetGoalListCache();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  const resolved=path.resolve(root);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('sidecar-routing-http-'));
  fs.rmSync(resolved,{recursive:true,force:true});
 }
});
