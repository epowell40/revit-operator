import test from "node:test";
import assert from "node:assert/strict";
import { submitWorkReportForReview, WORK_REPORT_TOOL, retainedWorkReportMessage } from "../work_report.mjs";
const binding={kernel_version:2,session_id:"session",goal_id:"assignment",run_id:"run",generation:3};
test('partial repairs and a blocking decision share a recoverable clarification without a plan or a completion claim',async()=>{
 const {requestTaskInput,retainedTaskInputMessage}=await import('../task_input.mjs');
 const owner={assignment_id:'assignment',session_id:'session',run_id:'run',generation:3};
 const report={claimed_completed:['Connected four grilles. Saved Repair.rvt.'],remaining_work:['Identify the inline symbol.'],uncertainties:['No legend is visible.'],needs_input:{question:'Which device does the inline symbol represent?',field:'inline_device'}};
 const status=async(_url,options)=>{assert.equal(JSON.parse(options.body).action,'status');return {ok:true,outcome:'active',verification_policy:'advisory'}};
 let saved;
 const result=await submitWorkReportForReview(binding,report,status,{requestInput:input=>requestTaskInput(binding,input,async(_url,options)=>{
   if(options.method==='GET')return {assignment_kernel_v2:{snapshot:{current_binding:owner,spec:{input_variables:[]}}}};
   saved=JSON.parse(options.body);
   return {ok:true,assignment_snapshot_v2:{current_binding:owner,outcome:'awaiting_user_input',pending_input_variable_ids:['inline_device'],clarifications:{[saved.clarification_id]:{variable_id:'inline_device',question:saved.question,work_summary:saved.work_summary}}}};
 })});
 const message=retainedTaskInputMessage({name:'report_work_for_review'},{output:JSON.stringify(result)});
 assert.equal(saved.question,report.needs_input.question);assert.ok(message.includes(saved.work_summary));assert.equal(result.verified,false);
 for(const text of [report.needs_input.question,...report.claimed_completed,...report.remaining_work,...report.uncertainties])assert.ok(message.includes(text));
 for(const state of [{outcome:'active',verification_policy:'strict'},{outcome:'paused',verification_policy:'advisory'}])await assert.rejects(submitWorkReportForReview(binding,report,async()=>({ok:true,...state}),{requestInput:()=>assert.fail('unexpected write')}),/active_advisory/);
});
const proposal={claimed_completed:["Printed file inspected: M000.pdf"],remaining_work:["Independent completion verification"],uncertainties:[]};
test("report uses only the host binding and retains backend outcome without upgrading it",async()=>{
 const calls=[];const pending={ok:true,outcome:"active",completion_proposal:{verified:false}};
 const result=await submitWorkReportForReview(binding,proposal,async(route,options)=>{calls.push({route,...JSON.parse(options.body)});return calls.length===1?{verification_policy:"advisory"}:pending;});
 assert.equal(result,pending);assert.equal(calls.length,2);assert.equal(calls[1].assignment_id,"assignment");assert.equal(calls[1].run_id,"run");assert.equal(calls[1].generation,3);assert.equal(calls[1].action,"propose_completion");assert.deepEqual(calls[1].completion_proposal,proposal);
});
test("strict policy and an already retained report never submit another proposal",async()=>{
 for(const status of [{verification_policy:"strict"},{verification_policy:"advisory",completion_proposal:{verified:false}}]){
 let calls=0;await assert.rejects(submitWorkReportForReview(binding,proposal,async()=>{calls++;return status;}),/work_report/);assert.equal(calls,1);
 }
});
test("malformed report and injected identity fail before backend access",async()=>{
 for(const value of [{...proposal,assignment_id:"other"},{...proposal,uncertainties:[""]},{claimed_completed:[],remaining_work:[],uncertainties:[]}]){
 await assert.rejects(submitWorkReportForReview(binding,value,()=>assert.fail("no request")),/invalid/);
 }
 await assert.rejects(submitWorkReportForReview({...binding,generation:0},proposal,()=>assert.fail("no request")),/binding/);
});
test("interrupted proposal or backend safety rejection is never automatically replayed",async()=>{
 for(const message of ["fetch failed","assignment_execution_paused","assignment_kernel_v2_binding_mismatch","unknown_effect"]){
 let calls=0;await assert.rejects(submitWorkReportForReview(binding,proposal,async()=>{if(++calls===1)return {verification_policy:"advisory"};throw new Error(message);}),new RegExp(message));assert.equal(calls,2);
 }
});
test("tool labels claims unverified and cannot accept a model-selected assignment identity",()=>{
 assert.match(WORK_REPORT_TOOL.description,/unverified/);assert.equal(WORK_REPORT_TOOL.parameters.additionalProperties,false);
 assert.deepEqual(Object.keys(WORK_REPORT_TOOL.parameters.properties),["needs_input","claimed_completed","remaining_work","uncertainties","written_findings"]);
});

import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {retainedTaskInputMessage} from '../task_input.mjs';
test("actual Sidecar function dispatch passes current host assignment and propagates report",async()=>{
 const source=readFileSync(new URL("../server.js",import.meta.url),"utf8");
 const start=source.indexOf("async function executeFunctionToolCall(");const end=source.indexOf("\nasync function executeFunctionToolCallSafely",start);
 const events=[];const invoke=runInNewContext(source.slice(start,end)+";executeFunctionToolCall",{
 computerState:{sidecarAssignment:binding},desktopHandoffReadinessRequired:()=>false,submitWorkReportForReview,addComputerEvent:e=>events.push(e),
 readBackendJson:async(_route,options)=>JSON.parse(options.body).action==="status"?{verification_policy:"advisory"}:{ok:true,outcome:"active"}});
 const output=await invoke({name:"report_work_for_review",call_id:"call",arguments:JSON.stringify(proposal)});
 assert.equal(JSON.parse(output.output).outcome,"active");assert.match(events[0],/unverified/);
});
test("public and private report adapters are identical",()=>assert.equal(readFileSync(new URL("../work_report.mjs",import.meta.url),"utf8"),readFileSync(new URL("../../../packages/operator-assistant-ui/work_report.mjs",import.meta.url),"utf8")));

test("only retained backend advisory proposal ends the turn with explicitly unverified prose",()=>{
 const call={name:"report_work_for_review"};
 const result={ok:true,verification_policy:"advisory",completion_proposal:{...proposal,review_id:"review",verified:false}};
 const output={output:JSON.stringify(result)};
 assert.match(retainedWorkReportMessage(call,output),/not independently verified/);
 assert.match(retainedWorkReportMessage(call,output),/M000.pdf/);
 assert.equal(retainedWorkReportMessage({name:"local_shell"},output),null);
 assert.equal(retainedWorkReportMessage(call,{output:JSON.stringify({...result,completion_proposal:{...result.completion_proposal,verified:true}})}),null);
 assert.equal(retainedWorkReportMessage(call,{output:JSON.stringify({...result,ok:false})}),null);
});

test("actual loop returns at a retained review boundary before any subsequent action or provider call",async()=>{
 const source=readFileSync(new URL("../server.js",import.meta.url),"utf8");
 const start=source.indexOf("        const savedWorkReport =");const end=source.indexOf("        const authoritativeCompletion =",start);
 assert.ok(start>0&&end>start);
 const state={};let later=0,checkpoints=0;
 const run=runInNewContext("(async function(){"+source.slice(start,end)+"later();return null;})",{
 retainComputerProviderContext:async()=>{checkpoints++;},toolOutputs:[],nativeRequest:()=>assert.fail('No extra dispatch'),
 retainedWorkReportMessage,retainedTaskInputMessage,computerState:state,response:{id:"response"},item:{name:"report_work_for_review"},
 functionOutput:{output:JSON.stringify({ok:true,verification_policy:"advisory",completion_proposal:{...proposal,review_id:"review",verified:false}})},later:()=>later++});
 assert.match(await run(),/independent review/);assert.equal(later,0);assert.equal(checkpoints,1);assert.equal(state.lastResponseId,"response");
});

test("long desktop reports have a concise unverified summary and lossless Details",()=>{
 const qualified="Changed M002. "+"Detailed native evidence. ".repeat(25)+"Visual review unavailable; not independently verified.";
 const proposal={claimed_completed:[qualified,"Saved the new copy."],remaining_work:["Review the titleblock layout."],uncertainties:["Whole-project scope was not checked."]};
 const report=retainedWorkReportMessage({name:"report_work_for_review"},{output:JSON.stringify({ok:true,verification_policy:"advisory",completion_proposal:{...proposal,verified:false,review_id:"review"}})});
 assert.ok(report.includes("## Details"));
 const [summary,details]=report.split("## Details");
 assert.ok(summary.length<800);assert.match(summary,/not independently verified/);
 assert.match(summary,/Work reported: 2 items in Details/);assert.ok(!summary.includes("Changed M002."));
 assert.match(summary,/Remaining work: Review the titleblock layout/);assert.match(summary,/Uncertainties: Whole-project scope was not checked/);
 for(const item of Object.values(proposal).flat())assert.ok(details.includes(item));
});

test("a report with no completed work cannot imply completion or hide its open items",()=>{
 const report=retainedWorkReportMessage({name:"report_work_for_review"},{output:JSON.stringify({ok:true,verification_policy:"advisory",completion_proposal:{claimed_completed:[],remaining_work:["Resolve the arrow target."],uncertainties:["No edit was dispatched."],verified:false,review_id:"review"}})});
 assert.match(report.split("## Details")[0],/No completed work was reported/);
 assert.match(report,/Resolve the arrow target/);assert.match(report,/No edit was dispatched/);
});
