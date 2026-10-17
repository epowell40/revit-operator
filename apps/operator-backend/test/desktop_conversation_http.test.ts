import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {spawn,type ChildProcess} from 'node:child_process';import {once} from 'node:events';import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';import test from 'node:test';
import {routeConversation} from '../src/conversation_intake.js';import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {appendMessage} from '../src/session_store.js';import {requestConversationPersistenceV1} from '../src/assignments/desktop_conversation.js';import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';import {__testOnlyResetGoalListCache} from '../src/goals/service.js';

test('actual HTTP task creation and review persist the human conversation across a cold backend restart',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-desktop-history-http-')),session='desktop-'+randomUUID(),message='human-'+randomUUID(),text='Correct the schedule gap and save a separate copy.';
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0'};
 const prior=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 const socket=net.createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=(socket.address() as net.AddressInfo).port;await new Promise<void>(r=>socket.close(()=>r()));
 const base='http://127.0.0.1:'+port,headers={'content-type':'application/json','x-operator-token':'synthetic-desktop-history-token'},children:ChildProcess[]=[],closed=new WeakSet<ChildProcess>();
 const stop=async(child:ChildProcess)=>{if(child.exitCode===null&&child.signalCode===null)child.kill();if(!closed.has(child))await once(child,'close',{signal:AbortSignal.timeout(5000)});};
 t.after(async()=>{for(const child of children)await stop(child);__closeForTests();__testOnlyResetGoalListCache();for(const[k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','synthetic-desktop-history-token')},async()=>{
  const result=await routeConversation({version:'operator.backend.v1',session_id:session,message_id:message,user_text:text},{interpret:async()=>({value:{route:'task',answer:null,basis:'needs_tools',requested_effect:'change',entire_request_answered:false,confidence:0.99,reason:'Model correction.',question_kind:'current_model',identity_fields:[],read_evidence:'not_applicable',operation_scope:{schema:'revit-operator.interpreted-operation-scope/v1',requested_effect:'apply',model_effect:'apply',protected_clauses:[],prerequisites:[]}}})});assert.equal(result.routing_status,'accepted');
 });__closeForTests();
 const start=async()=>{
  const childEnv={...process.env,...env,OPERATOR_BACKEND_PORT:String(port),OPERATOR_API_BASE_URL:base,OPERATOR_AUTH_MODE:'shared_token',OPERATOR_TOKEN:headers['x-operator-token'],OPERATOR_CODEX_BIN:path.join(root,'provider-not-used-in-http-test')};
  // Retain the Codex executor profile but prevent startup prewarm from launching
  // a workstation CLI. This HTTP conversation test never invokes a provider.
  for(const key of ['OPENAI_API_KEY','OPERATOR_OPENAI_API_KEY'])delete (childEnv as any)[key];
  const child=spawn(process.execPath,['dist/src/index.js'],{cwd:process.cwd(),env:childEnv,stdio:'ignore'});children.push(child);child.once('close',()=>closed.add(child));
  const deadline=Date.now()+20000;while(Date.now()<deadline){if(child.exitCode!==null)throw Error('Backend exited before readiness');try{if((await fetch(base+'/health',{headers})).ok)return child;}catch{}await new Promise(r=>setTimeout(r,25));}throw Error('Backend readiness timeout');
 };
 const first=await start();
 const created=await fetch(base+'/api/agent-goal',{method:'POST',headers,body:JSON.stringify({session_id:session,title:text,objective:text,acceptance_criteria:['Correct and inspect the schedule.'],work_budget:{requested_effect:'apply',document_fingerprint:'synthetic-history-model',conversation_message_id:message,source_user_request:text,mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent'},start_assignment_run:true,assignment_run_id:'desktop-history-run',assignment_run_actor:'operator_desktop_outer_agent'})});
 const goal:any=await created.json();assert.equal(created.status,200,JSON.stringify(goal));assert.equal(goal.assignment_run.kernel_version,2);
 const history=async()=>{const response=await fetch(base+'/session/history?session_id='+session,{headers});assert.equal(response.status,200);return (await response.json() as any).messages;};
 assert.deepEqual((await history()).map((m:any)=>m.text),[text]);
 __testOnlyResetGoalListCache();const snapshot=getAssignmentKernelSnapshotV2(goal.goal.id)!,binding=snapshot.current_binding;
 const request:any={version:'operator.backend.v1',session_id:session,message_id:'internal-helper',assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation,context:{desktop_helper_scope_v1:{schema:'operator.desktop-helper-scope.v1',binding}}};
 await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','synthetic-desktop-history-token')},()=>appendMessage(session,{role:'user',text:'Internal delegated prompt, not a human request.'},requestConversationPersistenceV1(request,'Internal delegated prompt, not a human request.')));
 assert.deepEqual((await history()).map((m:any)=>m.text),[text]);
 const report=await fetch(base+'/api/assignments/v2/work-plan',{method:'POST',headers,body:JSON.stringify({...binding,action:'propose_completion',completion_proposal:{claimed_completed:['Corrected and inspected the requested schedule.'],remaining_work:[],uncertainties:['Actor report only.']}})});assert.equal(report.status,200,await report.text());
 const warm=await history();assert.equal(warm.length,2);assert.match(warm[1].text,/not independently verified/);assert.match(warm[1].text,/Corrected and inspected/);
 await stop(first);await start();assert.deepEqual(await history(),warm);
 assert.equal((await fetch(base+'/session/history?session_id='+session)).status,401,'ordinary session authentication remains required');
 assert.equal(fs.existsSync(path.join(root,'.codex','goals_1.sqlite')),false,'the HTTP fixture must not launch a real CLI or create its goal database');
});
