import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {computerStateIncludesSubmittedMessage} from '../public/task_navigation.mjs';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function fn(name){const start=source.indexOf('async function '+name+'(');return source.slice(start,source.indexOf('\n}\n',start)+2);}
function harness(){
 const state={sessionId:'current',taskNavigationEpoch:0,taskNavigationAssignmentId:'',computerSyncRequestId:0,activeRunKind:'computer',pendingComputerUserMessages:[],computerEvents:[],lastScreenshotVersion:0};
 const waiting=[];let renders=0;const noop=()=>{};
 const sync=vm.runInNewContext(fn('syncComputerState')+';syncComputerState',{state,selectedGoal:()=>null,fetchJsonWithTimeout:(route,_options,limit)=>{assert.equal(route,state.sessionId?'/api/computer/state?session_id='+state.sessionId:'/api/computer/state');assert.equal(limit,10000);return new Promise((resolve,reject)=>waiting.push({resolve,reject}))},
  computerStateIncludesSubmittedMessage,computerStateMatchesTask:()=>false,renderComputerControl:noop,desktopPreviewCaptureBlocked:()=>false,applyDesktopPreviewCaptureState:noop,certifiedReadComputerStateFixture:()=>null,renderNextCertifiedReadUi:noop,renderWorkReturnPanel:noop,
  reconcileComputerMessages:messages=>({messages,pendingUserMessages:[]}),mergeActivityEvents:(_old,events)=>events,setSession:id=>{state.sessionId=id},renderMessages(){renders++},renderEvents:noop,renderRunSummary:noop,renderScreenMeta:noop,refreshScreen:noop,
  setStatus:text=>{state.status=text},setStreaming:value=>{state.streaming=value}});
 return{state,sync,waiting,renders:()=>renders};
}
const complete={running:false,error:'',backendSessionId:'current',messages:[{role:'assistant',text:'Checked and complete'}],events:[],progress:{phase:'completed'}};
const submissionMessage={id:'submitted',role:'user',text:'Read model title and link count'};
const admitted=(session='admitted',running=false)=>({...complete,running,backendSessionId:session,
 assignmentBindingV2:{assignment_id:'task',session_id:session,run_id:'run',generation:1},
 messages:[submissionMessage,{role:'assistant',text:'Actual checked result'}]});
test('preflight session replacement after Revit reopen delivers the final answer automatically',async()=>{
 const h=harness();h.state.sessionId='';h.state.computerSubmissionMessageId='submitted';
 const preflight=h.sync();h.waiting[0].resolve({...complete,running:true,backendSessionId:'temporary',assignmentBindingV2:null,messages:[submissionMessage],progress:{phase:'starting'}});await preflight;
 assert.equal(h.state.computerSubmissionMessageId,'submitted','Keep correlation until startup has a canonical task or stops');
 assert.equal(h.state.sessionId,'','Do not pin a temporary preflight conversation');
 const final=h.sync();h.waiting[1].resolve(admitted());await final;
 assert.equal(h.state.sessionId,'admitted');assert.equal(h.state.computerMessages.at(-1).text,'Actual checked result');
 assert.equal(h.state.streaming,false);assert.equal(h.state.computerSubmissionMessageId,'');
});
test('a correlated submitted turn can replace a previous conversation only through admission',async()=>{
 const h=harness();h.state.sessionId='previous';h.state.computerSubmissionMessageId='submitted';
 const p=h.sync();h.waiting[0].resolve(admitted('new',true));await p;
 assert.equal(h.state.sessionId,'new');assert.equal(h.state.computerSubmissionMessageId,'');
 const foreign=h.sync();h.waiting[1].resolve(admitted('foreign'));await foreign;
 assert.equal(h.state.sessionId,'new');assert.equal(h.state.streaming,true);
});
test('unrelated and malformed admission cannot take over a pending submission',async()=>{
 for(const payload of [{...admitted(),messages:[{id:'other',role:'user'}]}, {...admitted(),assignmentBindingV2:{...admitted().assignmentBindingV2,session_id:'foreign'}}]){
  const h=harness();h.state.sessionId='';h.state.computerSubmissionMessageId='submitted';
  const p=h.sync();h.waiting[0].resolve(payload);await p;
  assert.equal(h.renders(),0);assert.equal(h.state.computerSubmissionMessageId,'submitted');
 }
});
test('a transport interruption between preflight and settlement recovers without resubmission',async()=>{
 const h=harness();h.state.sessionId='';h.state.computerSubmissionMessageId='submitted';
 const a=h.sync();h.waiting[0].resolve({...complete,running:true,backendSessionId:'temporary',messages:[submissionMessage]});await a;
 const b=h.sync();h.waiting[1].reject(Error('connection lost'));await assert.rejects(b,/connection lost/);h.state.activityConnectionLost=true;
 const c=h.sync();h.waiting[2].resolve(admitted());await c;
 assert.equal(h.state.activityConnectionLost,false);assert.equal(h.state.streaming,false);assert.equal(h.state.computerMessages.at(-1).text,'Actual checked result');
});
test('settled failed, paused and unknown outcomes are delivered without rewriting them as complete',async()=>{
 for(const phase of ['blocked','paused','waiting_for_usage','outcome_unknown','awaiting_user_input']){
  const h=harness();h.state.sessionId='';h.state.computerSubmissionMessageId='submitted';
  const p=h.sync();h.waiting[0].resolve({...admitted(),progress:{phase},error:phase==='blocked'?'Specific failure':''});await p;
  assert.equal(h.state.computerProgress.phase,phase);assert.equal(h.state.streaming,false);assert.equal(h.state.computerMessages.at(-1).text,'Actual checked result');
 }
});
test('admission with otherwise identical presentation still adopts the canonical session',async()=>{
 const h=harness();h.state.sessionId='';h.state.computerSubmissionMessageId='submitted';
 const final=admitted('canonical',true);const first=h.sync();h.waiting[0].resolve({...final,backendSessionId:'provisional',assignmentBindingV2:null});await first;
 const second=h.sync();h.waiting[1].resolve(final);await second;
 assert.equal(h.state.sessionId,'canonical');assert.equal(h.state.computerSubmissionMessageId,'');
});
test('fresh submission cannot adopt previous idle relay during preflight and lose the new answer',async()=>{
 const h=harness();h.state.sessionId='';h.state.computerSubmissionMessageId='submitted';
 const old=h.sync();h.waiting[0].resolve({...complete,backendSessionId:'previous',messages:[{id:'old',role:'user'}]});await old;
 const actual=h.sync();h.waiting[1].resolve({...complete,backendSessionId:'new',messages:[{id:'submitted',role:'user'},{role:'assistant',text:'Actual new answer'}]});await actual;
 assert.equal(h.state.sessionId,'new');assert.equal(h.state.computerMessages.at(-1).text,'Actual new answer');assert.equal(h.renders(),1);assert.equal(h.state.computerSubmissionMessageId,'');
});
test('submission nonce is frozen before optimistic rendering can yield to a status read',()=>{
 const start=source.indexOf('function beginOptimisticChatSubmission('),body=source.slice(start,source.indexOf('\n}\n',start)+2);
 const state={};let rendered=false;
 const begin=vm.runInNewContext(body+';beginOptimisticChatSubmission',{state,nextOptimisticChatSubmissionState(_state,submission){assert.equal(state.computerSubmissionMessageId,submission.id);return{activeRunKind:'computer',message:{id:submission.id}}},renderMessages(){rendered=true;}});
 begin({id:'clicked-once',mode:'computer-run'});assert.equal(state.computerSubmissionMessageId,'clicked-once');assert.equal(rendered,true);
});
test('slow completion poll is not invalidated by the next timer tick',async()=>{
 const h=harness();const first=h.sync(),second=h.sync();
 h.waiting[0].resolve(complete);await first;
 assert.equal(h.renders(),1,'The completed answer must publish even when a timer fires before the response arrives');
 assert.equal(h.state.streaming,false);assert.equal(h.waiting.length,1,'Only one state read may be in flight');await second;
});
test('failed polling releases the read slot so later completion can display',async()=>{
 const h=harness();const first=h.sync();h.waiting[0].reject(Error('connection lost'));await assert.rejects(first,/connection lost/);
 const next=h.sync();h.waiting[1].resolve(complete);await next;assert.equal(h.renders(),1);assert.equal(h.state.streaming,false);
});
test('navigation during a slow poll still rejects old-task completion',async()=>{
 const h=harness();const old=h.sync();h.state.taskNavigationEpoch++;h.state.sessionId='other';h.waiting[0].resolve(complete);await old;
 assert.equal(h.renders(),0);assert.equal(h.state.sessionId,'other');
});
