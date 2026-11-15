import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import {unresolvedSheetTarget,executionFailureMessage} from '../target_resolution_failure.mjs';
import {stoppedWorkReturnMessage} from '../stopped_work_return.mjs';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf('async function tryFastSheetNameUpdate(parsed) {');
const end=source.indexOf('async function tryFastSheetParameterUpdateFromPrompt',start);
const catchStart=source.indexOf('      addComputerEvent(`Computer-use run failed:');
const catchEnd=source.indexOf('\n    }',catchStart);
assert(start>0&&end>start&&catchStart>0&&catchEnd>catchStart);
const assignment={kernel_version:2,goal_id:'task',session_id:'session',run_id:'run',generation:1};
const settlement={kernel_version:2,work_return:{assignment_id:'task',run_id:'run',generation:1,status:'failed',deviations_or_open_items:['Completion not verified.']}};

test('actual failed sheet lookup reaches the conversation with its useful diagnostic and no rename call',async()=>{
 const calls=[],messages=[];
 const lookup=process.env.OPERATOR_RETAINED_LOOKUP_REPLAY
  ? JSON.parse(fs.readFileSync(process.env.OPERATOR_RETAINED_LOOKUP_REPLAY,'utf8').replace(/^\uFEFF/,'')).functionToolReceipts[0].result.evidence.result_json
  : {status:'NotFound',action:'detail',selector:{sheetNumber:'M9999'}};
 const context={normalizeSheetNameStyle:x=>x,addComputerEvent:()=>{},coordinatedRevitBridgeHealth:async()=>({ok:true}),
  executeBackendAction:async request=>{calls.push(request);return {status:'done',result_json:lookup};},unresolvedSheetTarget,Error};
 let error;
 try{await runInNewContext(source.slice(start,end)+'\ntryFastSheetNameUpdate({sheetNumber:"M9999",sheetName:"MECHANICAL COORDINATION"})',context);}catch(e){error=e;}
 assert(error);assert.equal(calls.length,1);assert.equal(calls[0].path,'/revit/sheets');
 await runInNewContext('(async()=>{'+source.slice(catchStart,catchEnd)+'})()',{
  error,computerState:{error:error.message,sidecarAssignment:assignment},failureSettlement:settlement,
  executionFailureMessage,stoppedWorkReturnMessage,retainedOwnerWritingMessage:async()=>null,
  addComputerEvent:()=>{},addComputerMessage:(role,text)=>messages.push({role,text}),
 });
 assert.equal(messages.length,1);assert.match(messages[0].text,/M9999/);
 assert.match(messages[0].text,/sheet-rename step did not run/);assert.match(messages[0].text,/Completion not verified/);
 assert.equal(settlement.work_return.status,'failed');
});
