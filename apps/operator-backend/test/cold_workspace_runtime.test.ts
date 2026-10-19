import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

for (const scope of ['local', 'tenant-after-default-prewarm'] as const)
test(`first bound Revit request initializes its own runtime: ${scope}`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ocr-'));
 const script=`
 import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
 const root=process.env.OPERATOR_WORKSPACE_ROOT;
 const tenant=${JSON.stringify(scope)}==='tenant-after-default-prewarm';
 // Isolate the existing CLI auth-copy helper from the developer account.
 os.homedir=()=>root;
 const load=p=>import(pathToFileURL(path.resolve('src',p)).href);
 const {createGoal}=await load('goals/service.ts');
 const {createAssignmentKernelForGoalV2}=await load('assignments/assignment_kernel_v2_factory.ts');
 const {getAssignmentKernelSnapshotV2}=await load('assignments/assignment_kernel_v2_store.ts');
  const {recentCommandEvents}=await load('memory/sqlite_store.ts');
 const {runWithRequestContext,createPrincipalBoundSessionId,getScopedWorkspaceRoot}=await load('request_context.ts');const {createOperatorBackendAuth}=await load('operator_backend_auth.ts');
 const principal=tenant?{sub:'fixture-subject',user_id:'fixture-user',tenant_id:'fixture-tenant',license_id:'fixture-tenant',roles:['user'],tier:null,claims:{}}:undefined;
 const sessionId=principal?createPrincipalBoundSessionId(principal):'cold-session';
 const {decideCodex,warmCodexAppServer}=await load('brains/codex_brain.ts');
 if(tenant)await warmCodexAppServer().catch(()=>{});
 await runWithRequestContext({principal,operator_backend_auth:createOperatorBackendAuth('shared_token','fixture-only')},async()=>{
  const text='adjust the equipment tags on E101 so all the new electrical equipment tags are underlined';
  const goal=createGoal({title:text,objective:text,acceptance_criteria:['The requested tag appearance is corrected and checked.'],status:'active',related_session_id:sessionId,created_by:'test-only',work_budget:{requested_effect:'apply',document_fingerprint:'synthetic-model'}});
  const binding=createAssignmentKernelForGoalV2({goal,run_id:'cold-run'});
  const result=await decideCodex({version:'operator.backend.v1',session_id:sessionId,message_id:'cold-request',user_text:text,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation});
  const snapshot=getAssignmentKernelSnapshotV2(goal.id),failure=Object.values(snapshot.execution_failures).at(-1);
  console.log(JSON.stringify({phase:failure?.phase,failure_id:failure?.failure_id,operations:Object.keys(snapshot.operations).length,provider_calls:Object.keys(snapshot.provider_calls).length,
   response:result.assistant_message,diagnostic:recentCommandEvents(sessionId,'codex.execution.setup.error',1)[0],auth_copied:fs.existsSync(path.join(getScopedWorkspaceRoot(root,principal),'.codex','auth.json'))}));
 });
 `;
 const env:NodeJS.ProcessEnv={...process.env,OPERATOR_WORKSPACE_ROOT:root,OPERATOR_ASSIGNMENT_KERNEL_V2:'1',REVIT_OPERATOR_MODE:'development',OPERATOR_HOSTED_ENABLED:'0',
  OPERATOR_CODEX_BIN:path.join(root,'deliberately-absent-fixture-codex.exe'),OPERATOR_THIN_REFERENCE_SESSION_IDS:'',OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS:'',
  OPERATOR_CODEX_TURN_TIMEOUT_MS:'2000'};
 delete env.OPENAI_API_KEY;delete env.OPERATOR_OPENAI_API_KEY;
 try{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),env,timeout:20000,windowsHide:true,maxBuffer:100000});
  const result=JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!);
  assert.equal(result.phase,'provider_start',JSON.stringify(result));
  assert.match(result.failure_id,/^provider-start:/,'an intentionally absent provider binary must not be misclassified as a missing Revit runtime');
  assert.equal(result.operations,0);assert.equal(result.provider_calls,0);assert.equal(result.auth_copied,false);
  assert.equal(result.diagnostic.phase,'provider_start');assert.equal(result.diagnostic.cause_code,'provider-start');
  assert.equal(result.diagnostic.native_dispatch_this_request,false);assert.equal(result.diagnostic.provider_started,false);
 }finally{
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('ocr-'));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});
 }
});
