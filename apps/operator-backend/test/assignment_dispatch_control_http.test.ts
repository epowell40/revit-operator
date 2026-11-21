import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createServer} from 'node:http';
import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createGoal,getGoalStoragePath,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {startExternalAssignmentRun} from '../src/assignments/external_assignment_start.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {handleAssignmentHttpRoute} from '../src/assignments/http_routes.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';

test('authenticated GET opt-in returns fresh compact dispatch control; default publication and denial remain intact',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-control-http-')),old=process.env.OPERATOR_WORKSPACE_ROOT,oldKernel=process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;
 process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_ASSIGNMENT_KERNEL_V2='1';__testOnlyResetGoalListCache();
 let authorized=true,foreign=false;
 const context={operator_backend_auth:createOperatorBackendAuth('shared_token','fixture-only')};
 const server=createServer((req,res)=>{void runWithRequestContext(foreign?{...context,principal:{sub:'other',user_id:'other',license_id:'foreign-tenant',roles:[],tier:null,claims:{}}}:context,async()=>{
  try{if(!await handleAssignmentHttpRoute(req,res,new URL(req.url!,'http://fixture'),id=>{
   if(authorized&&id==='own-session')return true;res.writeHead(403).end();return false;
  }))res.writeHead(404).end();}catch(e){res.writeHead(500).end(String(e));}
 });});
 try{
  const goal=await runWithRequestContext(context,async()=>{
   const goal=createGoal({title:'Draft from PDF',objective:'Continue the reference drawing.',acceptance_criteria:['Deliver checked work.'],status:'active',created_by:'local-host',related_session_id:'own-session',work_budget:{requested_effect:'apply',source_user_request:'Continue the reference drawing.',mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent',document_fingerprint:'fixture-model'}});
   startExternalAssignmentRun({goal,sessionId:'own-session',requestedRunId:'sidecar:existing',actor:'operator_desktop_outer_agent'});return goal;
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');
  const url=`http://127.0.0.1:${address.port}/api/assignments/v2/${goal.id}`,headers={'x-operator-assignment-handoff':'dispatch_control_v1'};
  const fullResponse=await fetch(url),full:any=await fullResponse.json();assert.equal(fullResponse.status,200,JSON.stringify(full));assert(full.assignment_kernel_v2.provider_ledger);
  // Warm the compact projection. Repeated checks must not clone drawing history.
  await (await fetch(url,{headers})).json();
  const clone=globalThis.structuredClone;let fullPublications=0,fullSnapshots=0;
  let response:Response,compact:any;
  try{
   globalThis.structuredClone=((value:unknown,options?:Parameters<typeof structuredClone>[1])=>{
    if((value as {schema?:string})?.schema==='revit-operator.assignment-kernel-publication/v2')fullPublications++;
    if(value&&typeof value==='object'&&'operations' in value&&'spec' in value&&'provider_calls' in value)fullSnapshots++;
    return clone(value,options);
   }) as typeof structuredClone;
   response=await fetch(url,{headers});compact=await response.json();
  }finally{globalThis.structuredClone=clone;}
  assert.equal(fullPublications,0,'Compact HTTP reads must not construct/copy the full discarded publication.');
  assert.equal(fullSnapshots,0,'Warm control checks must not clone the full drawing snapshot.');
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(compact.assignment_kernel_v2,undefined);assert.equal(compact.assignment_dispatch_control_v1.snapshot.current_binding.assignment_id,goal.id);
  assert(Buffer.byteLength(JSON.stringify(compact))<2500);
  const current=getAssignmentKernelSnapshotV2(goal.id)!,binding=current.current_binding;
  await runWithRequestContext(context,async()=>controlAssignmentExecutionV2({binding,action:'pause',command_id:'new-pause',expected_command_id:current.execution_control?.command_id??null}));
  const paused:any=await(await fetch(url,{headers})).json();assert.equal(paused.assignment_dispatch_control_v1.snapshot.execution_control.state,'paused');
  assert(paused.assignment_dispatch_control_v1.assignment_version>compact.assignment_dispatch_control_v1.assignment_version);
  // A separate writer extends the persisted journal, bypassing this process's
  // cache. The ordinary authenticated route must see the new valid tail.
  const outside=`import {getAssignmentKernelSnapshotV2} from ${JSON.stringify(new URL('../src/assignments/assignment_kernel_v2_store.js',import.meta.url).href)};
    import {controlAssignmentExecutionV2} from ${JSON.stringify(new URL('../src/assignments/assignment_kernel_v2_controls.js',import.meta.url).href)};
    import {runWithRequestContext} from ${JSON.stringify(new URL('../src/request_context.js',import.meta.url).href)};
    import {createOperatorBackendAuth} from ${JSON.stringify(new URL('../src/operator_backend_auth.js',import.meta.url).href)};
    runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','fixture-only')},()=>{
      const s=getAssignmentKernelSnapshotV2(${JSON.stringify(goal.id)});
      controlAssignmentExecutionV2({binding:s.current_binding,action:'resume',command_id:'outside-resume',expected_command_id:'new-pause'});
    });`;
  execFileSync(process.execPath,['--input-type=module','-e',outside],{env:process.env,timeout:20000,stdio:'pipe'});
  const resumed:any=await(await fetch(url,{headers})).json();
  assert.equal(resumed.assignment_dispatch_control_v1.snapshot.execution_control.state,'running');
  assert.equal(resumed.assignment_dispatch_control_v1.snapshot.execution_control.command_id,'outside-resume');
  assert(resumed.assignment_dispatch_control_v1.assignment_version>paused.assignment_dispatch_control_v1.assignment_version);
  authorized=false;const denied=await fetch(url,{headers});assert.equal(denied.status,403);assert(!await denied.text());
  authorized=true;foreign=true;
  for(const options of [{headers},{}]){const denied=await fetch(url,options);assert([403,404].includes(denied.status));assert(!(await denied.text()).includes('current_binding'));}
  foreign=false;
  const file=getGoalStoragePath(goal.id)!;const altered=JSON.parse(fs.readFileSync(file,'utf8'));
  altered.assignment_kernel_v2.events[0].binding.generation+=1;
  fs.writeFileSync(file,JSON.stringify(altered));
  const corrupted=await fetch(url,{headers});assert.equal(corrupted.status,500,'Changed earlier bytes cannot reuse a valid cached prefix');
  assert(!(await corrupted.text()).includes('current_binding'));
 }finally{
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));__closeForTests();__testOnlyResetGoalListCache();
  if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;
  if(oldKernel===undefined)delete process.env.OPERATOR_ASSIGNMENT_KERNEL_V2;else process.env.OPERATOR_ASSIGNMENT_KERNEL_V2=oldKernel;
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('dispatch-control-http-'));fs.rmSync(root,{recursive:true,force:true});
 }
});
