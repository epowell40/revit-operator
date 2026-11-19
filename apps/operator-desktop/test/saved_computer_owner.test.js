import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import {parseAssignmentKernelPublicationV2} from '@revitoperator/assignment-kernel-v2-contracts';
import {nativeChangeObservationCursor} from '../native_change_observations.mjs';
import {selectChatSubmissionMode,routeSavedChatSubmission} from '../public/composer_intake.mjs';
import {savedComputerBinding,savedAssignmentExecutor,assertComputerDispatchSnapshot,assertComputerResumeControl,savedComputerConversation} from '../saved_computer_assignment.mjs';
import * as savedConversationHelpers from '../saved_computer_assignment.mjs';
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function body(source,name){let i=source.indexOf('async function '+name+'(');if(i<0)i=source.indexOf('function '+name+'(');assert(i>=0);return source.slice(i,source.indexOf('\n}\n',i)+2);}
const binding={assignment_id:'task',session_id:'session',run_id:'run',generation:1};
test('browser state shows resumed conversation without publishing host context as chat',()=>{
 const history={session_id:binding.session_id,messages:[
  {role:'user',text:'SAVED TASK CONTEXT. Keep this literal message.'},
  {role:'assistant',text:'The model is saved. A door check remains.'},
 ]};
 const messages=savedComputerConversation({objective:'Check the door',work_budget:{attachment_ids:['original-dwg']}},
  {current_binding:binding,operations:{older:{operation_id:'retained-operation'}}},history);
 const start=server.indexOf('app.get("/api/computer/state",');
 assert.ok(start>=0);
 const routeSource=server.slice(start,server.indexOf('\n});',start)+4);
 let state;
 runInNewContext(routeSource,{
  app:{get(path,handler){assert.equal(path,'/api/computer/state');handler({}, {setHeader(){},json(data){state=data;}});}},
  computerState:{messages},browserComputerAssignmentBinding:()=>binding,
  modelCallReceiptsSnapshot:()=>[],providerUsageCoverageSnapshot:()=>({}),
  modelCallReceiptIntegritySnapshot:()=>({}),browserSafeCertifiedReadUi:()=>null,
  browserComputerMessages:savedConversationHelpers.browserComputerMessages,
 });
 assert.deepEqual(JSON.parse(JSON.stringify(state.messages)),history.messages);
 assert.match(savedConversationHelpers.selectComputerConversationForInput(messages,12,binding)[0].text,/retained-operation/);
});
test('initial model input retains authenticated saved source and punch list beyond twelve messages',()=>{
 const goal={objective:'Finish both systems',work_budget:{attachment_ids:['registered-original-pdf'],conversation_message_id:'original-request'}};
 const snapshot={current_binding:binding,spec:{source_user_request:goal.objective},work_plan:{items:[{id:'system-a',status:'partial',remaining:'two devices'}]},operations:{},advisory_followups:{items:[{text:'Source label still unchecked'}]}};
 const history={session_id:'session',messages:Array.from({length:12},(_,i)=>({role:i%2?'assistant':'user',text:'ordinary turn '+i}))};
 const messages=savedComputerConversation(goal,snapshot,history);
 messages.push({role:'user',text:'Continue the remaining work'});
 const build=runInNewContext(body(server,'buildComputerInput')+';buildComputerInput',{
   computerState:{messages,sidecarAssignment:binding},MAX_CONVERSATION_MESSAGES:12,
   selectComputerConversationForInput:savedConversationHelpers.selectComputerConversationForInput,
   toComputerInputMessage:(message)=>message
 });
 const input=build(null,{includeCurrentScreen:false});
 assert.match(input[0].text,/registered-original-pdf/);
 assert.match(input[0].text,/two devices/);
 assert.match(input[0].text,/Source label still unchecked/);
 assert.match(input[0].text,/not current proof/);
 assert.equal(input.at(-1).text,'Continue the remaining work');
 assert.equal(input.length,13,'One host context plus the existing twelve recent messages.');
});
function resumeHarness(executor='computer'){
 const sent=[];const goal={_bindingV2:binding,_executionControl:{command_id:'resume-1'},_assignmentVersion:12};
 const state={streaming:false,sessionId:'session',backendLocal:true,backendAuthMode:'shared_token',backendAvailable:true,backendConfigStatus:'ready',computerUseAvailable:true,
  localExecutor:{schema:'revit-operator.local-executor-capability/v1',source:'backend_configuration',profile:'codex_v2_advisory_v1',executor:'codex',assignment_kernel:2,execution_policy:'local_advisory_v1'}};
 const resume=runInNewContext(body(app,'resumeCanonicalAssignment')+';resumeCanonicalAssignment',{
  state,routeSavedChatSubmission,selectedGoal:()=>goal,createChatSubmission:text=>({text,attachments:[],mode:selectChatSubmissionMode(state,text),newComputerConversation:false}),
  fetchJson:async()=>({ok:true,executor,binding}),
  sendComputerPrompt:async(s,o)=>sent.push({owner:'computer',s,o}),sendBackendPrompt:async(s,o)=>sent.push({owner:'backend',s,o})
 });return {goal,sent,resume,state};
}
test('saved computer resume keeps optimistic progress and messages on the confirmed owner',async()=>{
 const h=resumeHarness();await h.resume(h.goal);
 const next=runInNewContext(body(app,'nextOptimisticChatSubmissionState')+';nextOptimisticChatSubmissionState')(
  {backendMessages:[],computerMessages:[],pendingComputerUserMessages:[]},h.sent[0].s);
 assert.equal(next.activeRunKind,'computer');assert.equal(next.backendMessages.length,0);
 assert.equal(next.computerMessages.length,1);assert.equal(next.pendingComputerUserMessages.length,1);
 assert.equal(h.sent[0].s.newComputerConversation,false);
});
test('ordinary Resume keeps the authenticated saved desktop executor and exact control binding',async()=>{
 const h=resumeHarness();await h.resume(h.goal);assert.equal(h.sent.length,1);assert.equal(h.sent[0].owner,'computer');
 assert.deepEqual(JSON.parse(JSON.stringify(h.sent[0].s.assignmentBindingV2)),binding);
 assert.equal(h.sent[0].s.assignmentResumeControl.command_id,'resume-1');assert.equal(h.sent[0].s.assignmentResumeControl.assignment_version,12);
});
test('backend-owned saved task stays on backend rather than acquiring desktop authority',async()=>{
 const h=resumeHarness('backend');await h.resume(h.goal);assert.equal(h.sent[0].owner,'backend');assert.equal(h.sent[0].s.mode,'backend');assert.equal(h.sent[0].s.newComputerConversation,false);
});

test('unknown executor cannot route or publish an optimistic resumed message',async()=>{
 const h=resumeHarness('foreign');await assert.rejects(h.resume(h.goal),/could not be confirmed/);assert.equal(h.sent.length,0);
});
test('navigation during the saved executor lookup cannot dispatch in another conversation',async()=>{
 const h=resumeHarness();const pending=h.resume(h.goal);h.state.sessionId='other';await assert.rejects(pending,/selected task changed/);assert.equal(h.sent.length,0);
});
test('canonical Pause rejects a previously returned desktop action before input/readiness dispatch',async()=>{
 let input=0,marked=0,checked=0;
 const run=runInNewContext(body(server,'executeComputerAction')+';executeComputerAction',{
  computerState:{stopRequested:false,sidecarAssignment:{...binding,kernel_version:2}},
  assertComputerActionControl:async()=>{checked++;throw Error('desktop_assignment_paused');},
  desktopReadinessObligation:()=>({beforeInput(){marked++;}}),addComputerEvent(){},
  runDesktopScript:async()=>{input++;},summarizeComputerAction:()=>'',Buffer
 });
 await assert.rejects(run({type:'type',text:'must not type'}),/paused/);assert.equal(checked,1);assert.equal(marked,0);assert.equal(input,0);
});


