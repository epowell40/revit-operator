import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import {computerStateMatchesTask} from '../public/task_navigation.mjs';
import {savedComputerBinding} from '../saved_computer_assignment.mjs';
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const start=app.indexOf('async function syncComputerState('),end=app.indexOf('\n}\n',start)+2;
const binding={assignment_id:'task',session_id:'session',run_id:'run',generation:1};
test('relay publishes only the existing V2 task identity, never executor internals',()=>{
 const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
 const i=server.indexOf('function browserComputerAssignmentBinding('),j=server.indexOf('\n}\n',i)+2;
 const computerState={sidecarAssignment:{kernel_version:2,goal_id:'task',session_id:'session',run_id:'run',generation:1,secret:'never expose'}};
 const project=runInNewContext(server.slice(i,j)+';browserComputerAssignmentBinding',{computerState,savedComputerBinding});
 assert.deepEqual(JSON.parse(JSON.stringify(project())),binding);
 for(const assignment of [null,{}, {...computerState.sidecarAssignment,kernel_version:1},{...computerState.sidecarAssignment,generation:0}]){computerState.sidecarAssignment=assignment;assert.equal(project(),null);}
 assert.match(server,/const binding=browserComputerAssignmentBinding\(\)/);
 assert.match(server,/assignmentBindingV2: binding/);
});
function harness(payload,change){
 const state={taskNavigationMode:true,sessionId:'session',taskNavigationAssignmentId:'task',taskNavigationEpoch:1,computerSyncRequestId:0,activeRunKind:'',pendingComputerUserMessages:[],computerMessages:[],computerEvents:[],lastScreenshotVersion:0};
 const goal={_bindingV2:binding};let reads=0,renders=0;
 const sync=runInNewContext(app.slice(start,end)+';syncComputerState',{
  state,selectedGoal:()=>goal,computerStateMatchesTask,
  fetchJsonWithTimeout:async route=>{assert.equal(route,'/api/computer/state?session_id=session');reads++;change?.(state,goal);return payload;},
  desktopPreviewCaptureBlocked:()=>false,applyDesktopPreviewCaptureState(){},certifiedReadComputerStateFixture:()=>null,renderNextCertifiedReadUi(){},renderWorkReturnPanel(){},
  reconcileComputerMessages:messages=>({messages,pendingUserMessages:[]}),mergeActivityEvents:(_old,events)=>events,
  setSession:id=>{assert.equal(id,state.sessionId);},renderMessages(){renders++;},renderEvents(){},renderRunSummary(){},renderScreenMeta(){},setStatus(){},setStreaming:value=>state.streaming=value,
  refreshScreen(){throw Error('No screenshot is needed for transcript restoration');}
 });return{sync,state,counts:()=>({reads,renders})};
}
const payload=(running=true)=>({running,backendSessionId:'session',assignmentBindingV2:binding,messages:[{role:'assistant',text:'Current saved partial; tags still pending.'}],events:[],progress:{phase:running?'working':'awaiting_user_review'}});
test('opening a saved task observes its exact current relay and latest report without dispatching',async()=>{
 for(const running of [true,false]){const h=harness(payload(running));await h.sync();assert.equal(h.counts().renders,1);assert.equal(h.state.computerMessages[0].text,payload().messages[0].text);assert.equal(h.state.streaming,running);}
});
test('live copy reaches the current conversation only and is cleared on settlement',async()=>{
 const report=payload(),message={role:'assistant',text:'Saved file: Review copy.rvt'};
 report.checkedProjectCopy={binding,message};
 const h=harness(report);
 await h.sync();assert.equal(h.state.checkedProjectCopy?.message,message);
 assert(h.state.computerMessages.every(item=>item.text!==message.text));
 report.checkedProjectCopy={binding:{...binding,generation:2},message};
 await h.sync();assert.equal(h.state.checkedProjectCopy,null);
 report.running=false;report.checkedProjectCopy={binding,message};
 await h.sync();assert.equal(h.state.checkedProjectCopy,null);
});
test('foreign or cold relay never replaces selected history',async()=>{
 for(const p of [{...payload(),assignmentBindingV2:{...binding,run_id:'other'}},{...payload(),assignmentBindingV2:null},{...payload(),backendSessionId:'foreign'}]){const h=harness(p);await h.sync();assert.equal(h.counts().renders,0);assert.equal(h.state.computerMessages.length,0);}
});
test('navigation and backend ownership prevent late relay adoption',async()=>{
 for(const change of [s=>s.taskNavigationEpoch++,s=>s.sessionId='other',s=>s.taskNavigationAssignmentId='other',(_s,g)=>g._bindingV2={...binding,generation:2},s=>s.activeRunKind='backend']){const h=harness(payload(),change);await h.sync();assert.equal(h.counts().renders,0);}
 const h=harness(payload());h.state.activeRunKind='backend';h.state.streaming=true;await h.sync();assert.equal(h.state.streaming,true);assert.equal(h.counts().renders,0);
});
