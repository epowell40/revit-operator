import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import {Readable} from 'node:stream';
import assert from 'node:assert/strict';import test from 'node:test';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {routeConversation} from '../src/conversation_intake.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {handleAssignmentHttpRoute} from '../src/assignments/http_routes.js';
import {requestConversationPersistenceV1,retainDesktopInitialConversationV1,retainDesktopReviewConversationV1} from '../src/assignments/desktop_conversation.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {appendMessage,getHistory,getPinnedGoal} from '../src/session_store.js';
import {getConversationHistory,listConversationNavigation,__closeForTests} from '../src/memory/sqlite_store.js';
import {runWithRequestContext} from '../src/request_context.js';import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';

async function fixture(fn:(f:any)=>Promise<void>,desktop=true,objective='Correct the schedule gap, inspect it and save a separate copy.'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-desktop-conversation-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,REVIT_OPERATOR_MODE:'development',OPERATOR_LOCAL_EXECUTOR_PROFILE:'codex_v2_advisory_v1',OPERATOR_ASSIGNMENT_KERNEL_V2:'1',OPERATOR_BRAIN:'codex',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_HOSTED_ENABLED:'0'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const session='conversation-'+randomUUID(),message='human-'+randomUUID();
  const intake=await routeConversation({version:'operator.backend.v1',session_id:session,message_id:message,user_text:objective},
   {interpret:async()=>({value:{route:'task',answer:null,basis:'needs_tools',requested_effect:'change',entire_request_answered:false,confidence:0.99,reason:'Model correction.',question_kind:'current_model',identity_fields:[],read_evidence:'not_applicable',operation_scope:{schema:'revit-operator.interpreted-operation-scope/v1',requested_effect:'apply',model_effect:'apply',protected_clauses:[],prerequisites:[]}}})});assert.equal(intake.routing_status,'accepted');
  const goal=createGoal({title:objective,objective,acceptance_criteria:['Correct and inspect the schedule.'],status:'active',related_session_id:session,created_by:'local-host',work_budget:{requested_effect:'apply',document_fingerprint:'model',conversation_message_id:message,source_user_request:objective,...(desktop?{mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent'}:{})}});
  createAssignmentKernelForGoalV2({goal,run_id:'desktop-run'});const state=()=>getAssignmentKernelSnapshotV2(goal.id)!,binding=state().current_binding;
  const request:any={version:'operator.backend.v1',session_id:session,message_id:'helper-'+randomUUID(),user_text:'Inspect only; return to your owner.',assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation,context:{desktop_helper_scope_v1:{schema:'operator.desktop-helper-scope.v1',binding}}};
  const propose=async(proposal={claimed_completed:['Corrected the gap and inspected the result.'],remaining_work:[],uncertainties:['This is an actor report, not independent proof.']})=>{
   const req=Readable.from([Buffer.from(JSON.stringify({...binding,action:'propose_completion',completion_proposal:proposal}))]) as any;req.method='POST';let status=0,body='';
   const res:any={writeHead(code:number){status=code;},setHeader(){},end(value:string){body+=value;}};
   assert(await handleAssignmentHttpRoute(req,res,new URL('http://localhost/api/assignments/v2/work-plan'),id=>id===session));return {status:res.statusCode??status,body:JSON.parse(body)};
  };
  await fn({session,objective,message,binding,state,request,propose});
 });}finally{__testOnlyResetGoalListCache();__closeForTests();for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(root,{recursive:true,force:true});}
}

export function runDesktopConversationReplay(input?:{source:string;helper_prompt:string;helper_report:string;proposal:{claimed_completed:string[];remaining_work:string[];uncertainties:string[]}}){return fixture(async f=>{
 retainDesktopInitialConversationV1(f.binding);retainDesktopInitialConversationV1(f.binding);
 const before=structuredClone(f.state());
 if(input)f.request.user_text=input.helper_prompt;
 const helperReport=input?.helper_report??'{"internal_helper_report":"Correction and save remain."}';
 appendMessage(f.session,{role:'user',text:f.request.user_text},requestConversationPersistenceV1(f.request,f.request.user_text));
 appendMessage(f.session,{role:'assistant',text:helperReport},requestConversationPersistenceV1(f.request,helperReport));
 assert.deepEqual(f.state(),before,'conversation retention changes no task authority');assert.equal(getPinnedGoal(f.session),null);
 assert(getHistory(f.session).some(m=>m.text===helperReport),'private raw turn remains available');
 assert.deepEqual(getConversationHistory(f.session).map(m=>m.text),[f.objective]);
 assert.equal(listConversationNavigation(()=>true).find(m=>m.session_id===f.session)?.title,f.objective.replace(/\s+/g,' ').trim().slice(0,180));
 const review=await f.propose(input?.proposal);assert.equal(review.status,200);assert.equal(f.state().outcome,'awaiting_user_review');
 const canonical=structuredClone(f.state());retainDesktopReviewConversationV1(f.binding);assert.deepEqual(f.state(),canonical);
 __closeForTests();const history=getConversationHistory(f.session);assert.equal(history.length,2);assert.equal(history[0].text,f.objective);assert.match(history[1].text,/not independently verified/);assert.match(history[1].text,/Reported work/);assert(!history.some(m=>m.text===helperReport));
 assert.equal(history[1].message_id,f.state().completion_proposal.review_id);
},true,input?.source);}
test('desktop human source and HTTP review survive restart while helper text remains internal evidence',()=>runDesktopConversationReplay());

for(const kind of ['direct','foreign-marker','foreign-generation','human-wording'])test(`real user conversation is preserved for ${kind}`,()=>fixture(async f=>{
 const request=structuredClone(f.request);if(kind==='direct'||kind==='human-wording')delete request.context.desktop_helper_scope_v1;
 if(kind==='foreign-marker')request.context.desktop_helper_scope_v1.binding.run_id='other';if(kind==='foreign-generation')request.assignment_generation++;
 const text='Read-only discovery for UI task: this is a genuine human direction.';
 appendMessage(f.session,{role:'user',text},requestConversationPersistenceV1(request,text));assert.equal(getConversationHistory(f.session)[0]?.text,text);
}));

test('foreign binding and a paused report cannot overwrite history or reopen work',()=>fixture(async f=>{
 retainDesktopInitialConversationV1({...f.binding,run_id:'foreign'});assert.deepEqual(getConversationHistory(f.session),[]);
 retainDesktopInitialConversationV1(f.binding);controlAssignmentExecutionV2({binding:f.binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
 const before=structuredClone(f.state()),review=await f.propose();assert.equal(review.status,409);assert.deepEqual(f.state(),before);assert.equal(getConversationHistory(f.session).length,1);
}));

test('a conflicting durable human message is never replaced with a helper or new display',()=>fixture(async f=>{
 appendMessage(f.session,{role:'user',text:'A different actual human request.'},{display:{message_id:f.message,text:'A different actual human request.'}});
 assert.throws(()=>retainDesktopInitialConversationV1(f.binding),/identity conflict/);assert.equal(getConversationHistory(f.session)[0].text,'A different actual human request.');
}));

test('ordinary backend tasks do not acquire desktop conversation records',()=>fixture(async f=>{
 retainDesktopInitialConversationV1(f.binding);assert.deepEqual(getConversationHistory(f.session),[]);const review=await f.propose();assert.equal(review.status,200);assert.deepEqual(getConversationHistory(f.session),[]);
},false));
