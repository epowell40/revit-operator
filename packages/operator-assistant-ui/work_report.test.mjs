import test from "node:test";
import assert from "node:assert/strict";
import { submitWorkReportForReview, WORK_REPORT_TOOL, retainedWorkReportMessage } from "./work_report.mjs";
const binding={kernel_version:2,session_id:"session",goal_id:"assignment",run_id:"run",generation:3};
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
 assert.deepEqual(Object.keys(WORK_REPORT_TOOL.parameters.properties),["claimed_completed","remaining_work","uncertainties"]);
});

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
