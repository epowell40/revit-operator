import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {missingWorkReportContinuation} from '../work_report.mjs';
const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf('    if (!handledToolCalls) {');
const end=source.indexOf('    if (step === batchReminderStep',start);
assert(start>0&&end>start);
test('actual response-ending path keeps unified closeout in the same actor',async()=>{
 for(const nativeContext of [null,{catalog:true}]){
  const outputs=[],events=[];
  const context={handledToolCalls:false,nativeContext,
   computerState:{stopRequested:false,sidecarAssignment:{kernel_version:2,goal_id:'task',session_id:'session',run_id:'run',generation:1}},
   missingWorkReportContinuation,testHooks:{readBackendJson:async()=>({ok:true,verification_policy:'strict',outcome:'active'})},
   workReportReminders:0,draftingContinuationProgress:{},step:1,MAX_COMPUTER_STEPS:60,toolOutputs:outputs,
   addComputerEvent:message=>events.push(message)};
  await runInNewContext('(async()=>{'+source.slice(start,end)+'})()',context);
  assert.equal(outputs.length,1);assert.equal(events.length,1);
  const text=outputs[0].content[0].text;
  if(nativeContext){assert.doesNotMatch(text,/delegate_revit_task/);assert.match(text,/operator_evaluate_assignment_criteria/);}
  else assert.match(text,/delegate_revit_task/);
 }
});
