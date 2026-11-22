import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import {assertDesktopHandoffNativeReady} from '../work_report.mjs';
import {computerCompletionPresentation,AssignmentVerificationPending} from '../computer_completion_presentation.mjs';

// Exercise the production settlement and bound Work Return reader together.
// A native stop returns normally from the tool loop, whose caller asks to
// settle "complete" even though the host has already recorded a blocked task.
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const extract=(name,next)=>source.slice(source.indexOf(`async function ${name}(`),source.indexOf(`\n${next}`,source.indexOf(`async function ${name}(`)));
const settlement=extract('settleSidecarComputerAssignment','function resetComputerConversation');
const normalizer=source.slice(source.indexOf('function normalizedSidecarWorkReturn('),source.indexOf('\nfunction sidecarPendingClarification('));
const reader=extract('refreshSidecarWorkReturn','async function refreshSidecarWorkReturnAfterSettlement');
function harness(status,{foreign=false,transport=false}={}) {
 const binding={kernel_version:2,goal_id:'retained-task',session_id:'session',run_id:'run',generation:1};
 const workReturn={assignment_id:binding.goal_id,run_id:binding.run_id,generation:1,status,
  deviations_or_open_items:['execution_lease_exhausted','Applied annotation changes are not saved.']};
 const state={sidecarAssignment:binding,desktopInputDispatched:true};
 let probes=0,reads=0;
 const settle=runInNewContext(normalizer+'\n'+reader+'\nconst refreshSidecarWorkReturnAfterSettlement=refreshSidecarWorkReturn;\n'+settlement+';settleSidecarComputerAssignment',{
  computerState:state,desktopHandoffReadinessRequired:()=>true,assertDesktopHandoffNativeReady,AssignmentVerificationPending,
  checkRevitBridgeHealth:async()=>{probes++;return {ok:false,context:null};},
  canonicalWorkReturnResultMessage:()=>null,sidecarPendingClarification:()=>null,
  readBackendJson:async(route)=>{
   assert.equal(route,'/api/assignments/retained-task/work-return','No dispatch or failure rewrite');
   reads++;if(transport)throw Error('transport unavailable');
   return {work_return:foreign?{...workReturn,run_id:'foreign'}:workReturn};
  }
 });
 return {settle,binding,state,workReturn,counts:()=>({probes,reads})};
}

for(const status of ['blocked','failed'])test(`native stop presents canonical ${status} without requiring another native readiness read`,async()=>{
 const h=harness(status),before=structuredClone(h.workReturn);
 const result=await h.settle('complete','Native task control stopped further execution.');
 assert.equal(result.work_return.status,status);
 assert.deepEqual(h.counts(),{probes:0,reads:1});
 assert.deepEqual(h.workReturn,before,'presentation must not change history or invent saved work');
 const ui=computerCompletionPresentation(result,null,h.binding);
 assert.equal(ui.phase,status);assert.equal(ui.disposition,'explicit_failure');
 assert.match(ui.retained_failure_message,/execution_lease_exhausted/);
 assert.match(ui.retained_failure_message,/not saved/);
});
for(const status of ['complete','complete_with_issues','verified_noop','awaiting_user_review','active'])test(`${status} still requires native readiness`,async()=>{
 const h=harness(status);await assert.rejects(h.settle('complete','Done'),/desktop_handoff_native_readiness_unproven/);
 assert.equal(h.counts().probes,1);
});
for(const variant of ['foreign','transport'])test(`${variant} Work Return cannot use a terminal presentation exception`,async()=>{
 const h=harness('blocked',{[variant]:true});
 await assert.rejects(h.settle('complete','Done'),variant==='foreign'?/foreign or stale/:/transport unavailable/);
});
