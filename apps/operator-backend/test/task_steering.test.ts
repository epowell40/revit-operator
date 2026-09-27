import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { steerAssignment, observeSteeringDelivery, assignmentDirections } from "../src/assignments/task_steering.js";
import { registerActiveProviderTurn } from "../src/codex/active_turns.js";
import { prepareAssignmentTurn, bindPreparedAssignmentToRequest } from "../src/assignments/turn_preparation.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { controlAssignmentExecutionV2 } from "../src/assignments/assignment_kernel_v2_controls.js";
import { handleAssignmentHttpRoute } from "../src/assignments/http_routes.js";
import { __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { __closeForTests, getConversationHistory } from "../src/memory/sqlite_store.js";
import { runWithRequestContext } from "../src/request_context.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { manageAssignmentWorkPlan } from "../src/assignments/assignment_work_plan.js";

const context = { operator_backend_auth: createOperatorBackendAuth("shared_token","test-only") };
async function workspace(fn: () => Promise<void>, advisory = false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"operator-task-steering-"));
  const keys=["OPERATOR_WORKSPACE_ROOT","OPERATOR_ASSIGNMENT_KERNEL_V2","REVIT_OPERATOR_MODE","OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS"] as const, previous=keys.map(key=>process.env[key]);
  process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_ASSIGNMENT_KERNEL_V2="1";__testOnlyResetGoalListCache();
  if(advisory){process.env.REVIT_OPERATOR_MODE="local";process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS="steering-session";}
  try { await runWithRequestContext(context,fn); }
  finally { __closeForTests();__testOnlyResetGoalListCache();keys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith("operator-task-steering-"));fs.rmSync(root,{recursive:true,force:true}); }
}
function start() {
  const prepared=prepareAssignmentTurn({sessionId:"steering-session",messageId:"first",userText:"Count the air devices in the model.",toolResults:[],source:"chat",createdBy:null,
    requestContext:{revit:{document:{projectIdentity:{fingerprint:"steering-model"}}}}})!;
  return {prepared,binding:prepared.bindingV2!};
}
function delivered(commandId: string,text: string,turnId="turn-1") {
  return {method:"item/completed",threadId:"thread-1",params:{turnId,item:{type:"userMessage",clientId:commandId,content:[{type:"text",text}]}}};
}

test("direction accepted at a tool boundary is delivered once even when delivery precedes acknowledgement",()=>workspace(async()=>{
  const {binding}=start();let calls=0;
  const command={binding,command_id:"direction-1",expected_turn_id:"turn-1",text:"Limit the count to Level 4 and list it by room."};
  const unregister=registerActiveProviderTurn({sessionId:binding.session_id,messageId:"continuation-2",threadId:"thread-1",turnId:"turn-1",binding,
    interruptionRequested:()=>false,interrupt:async()=>{},steer:async(text,id)=>{calls++;observeSteeringDelivery(binding.session_id,"thread-1","turn-1",delivered(id,text));return{turnId:"turn-1"};}});
  try {
    assert.equal((await steerAssignment(command)).state,"delivered");
    __testOnlyResetGoalListCache();assert.equal((await steerAssignment(command)).state,"delivered");assert.equal(calls,1);
    await assert.rejects(steerAssignment({...command,text:"Different instruction"}),/different content/);
    await assert.rejects(steerAssignment({...command,command_id:"stale",expected_turn_id:"older-turn"}),/active turn changed/);
    assert.equal(assignmentDirections(binding).length,1);
    assert.equal(getConversationHistory(binding.session_id)[0].text,command.text);
    assert.ok(Object.values(getAssignmentKernelSnapshotV2(binding.assignment_id)!.input_values).includes(command.text));
  } finally {unregister();}
}));

test("authenticated steering HTTP continues one bound checkpoint, rejects foreign scope, and preserves read-only authority",()=>workspace(async()=>{
  const {binding}=start();
  manageAssignmentWorkPlan({binding,action:"propose_completion",completion_proposal:{claimed_completed:["Read the devices."],remaining_work:["Finish the report."],uncertainties:[]}});
  const before=getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  const body={...binding,command_id:"http-followup",text:"List the same devices by room.",expected_turn_id:null,
    checkpoint:{review_id:before.completion_proposal!.review_id,expected_control_command_id:null,document_fingerprint:before.spec.binding.document_fingerprint}};
  const server=http.createServer((req,res)=>{void runWithRequestContext(context,()=>handleAssignmentHttpRoute(req,res,new URL(req.url!,"http://localhost"),id=>{
    if(id===binding.session_id)return true;res.writeHead(403).end();return false;}));});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{
    const url=`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/assignments/v2/steer`;
    const send=(value:unknown)=>fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
    assert.equal((await send({...body,session_id:"foreign"})).status,403);
    assert.equal((await send({...body,checkpoint:{...body.checkpoint,document_fingerprint:"other"}})).status,409);
    const response=await send(body);assert.equal(response.status,200,JSON.stringify(await response.json()));
    const after=getAssignmentKernelSnapshotV2(binding.assignment_id)!;assert.equal(after.outcome,"active");
    assert.deepEqual(after.spec,before.spec);assert.equal(after.spec.requested_effect,"read");
    assert.equal((await send(body)).status,200);assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.assignment_version,after.assignment_version);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},true));

test("lost steering acknowledgement stays unconfirmed and an exact delivery receipt resolves it without replay",()=>workspace(async()=>{
  const {binding}=start();let calls=0;
  const command={binding,command_id:"direction-lost",expected_turn_id:"turn-1",text:"Use the room names from the architectural link."};
  const unregister=registerActiveProviderTurn({sessionId:binding.session_id,messageId:"continuation-random",threadId:"thread-1",turnId:"turn-1",binding,
    interruptionRequested:()=>false,interrupt:async()=>{},steer:async()=>{calls++;throw Error("Socket closed after write");}});
  try {
    assert.equal((await steerAssignment(command)).state,"unconfirmed");assert.equal((await steerAssignment(command)).state,"unconfirmed");assert.equal(calls,1);
    observeSteeringDelivery(binding.session_id,"thread-1","turn-1",delivered(command.command_id,"Wrong text"));
    observeSteeringDelivery(binding.session_id,"thread-1","turn-1",delivered(command.command_id,command.text,"wrong-turn"));
    assert.equal(assignmentDirections(binding)[0].state,"unconfirmed");
    observeSteeringDelivery(binding.session_id,"thread-1","turn-1",delivered(command.command_id,command.text));
    assert.equal(assignmentDirections(binding)[0].state,"delivered");
  } finally {unregister();}
}));

test("a paused task retains directions through reload and includes them in the same bound resume",()=>workspace(async()=>{
  const {binding,prepared}=start();
  controlAssignmentExecutionV2({binding,action:"pause",command_id:"pause",expected_command_id:null});
  const command={binding,command_id:"saved-direction",expected_turn_id:null,text:"Focus on the north wing first, then do the remaining rooms."};
  assert.equal((await steerAssignment(command)).state,"saved");
  __testOnlyResetGoalListCache();
  const snapshot=getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  assert.equal(snapshot.execution_control?.state,"paused");assert.equal(snapshot.current_binding.generation,binding.generation);
  const request=bindPreparedAssignmentToRequest({version:"operator.backend.v1",session_id:binding.session_id,message_id:"resume",user_text:"Continue",tool_results:[]} as any,prepared);
  assert.match(request.user_text || "",/north wing first/);assert.equal(assignmentDirections(binding).length,1);
}));

test("a missing or malformed provider fence is rejected without saving or dispatching a direction",()=>workspace(async()=>{
  const {binding}=start();
  for(const expected_turn_id of [undefined, false, 7, "", "x".repeat(241)]) {
    await assert.rejects(steerAssignment({binding,command_id:"invalid-fence",text:"Start upstairs.",expected_turn_id} as any),/provider-turn fence/);
  }
  assert.equal(assignmentDirections(binding).length,0);
  assert.equal(getConversationHistory(binding.session_id).length,0);
}));

test("Pause HTTP saves the native admission fence before interrupting the actual continuation turn",()=>workspace(async()=>{
  const {binding}=start();let calls=0;
  const unregister=registerActiveProviderTurn({sessionId:binding.session_id,messageId:"continuation-not-browser-id",threadId:"thread-1",turnId:"turn-1",binding,
    interruptionRequested:()=>false,steer:async()=>({turnId:"turn-1"}),interrupt:async()=>{assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.execution_control?.state,"paused");calls++;}});
  const server=http.createServer((req,res)=>{void runWithRequestContext(context,()=>handleAssignmentHttpRoute(req,res,new URL(req.url!,"http://localhost"),id=>{
    if(id===binding.session_id)return true;res.writeHead(403).end();return false;}));});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const url=`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/assignments/v2/execution-control`;
    const body={...binding,action:"pause",command_id:"http-pause",expected_command_id:null};
    const send=(value:unknown)=>fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
    assert.equal((await send({...body,session_id:"foreign"})).status,403);assert.equal(calls,0);
    const response=await send(body);assert.equal(response.status,200);assert.equal((await response.json() as any).provider_interrupt,"accepted");assert.equal(calls,1);
  } finally {unregister();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}));

test("canonical Resume after a saved pause direction reaches reasoning without changing read-only authority",()=>workspace(async()=>{
  const {prepareCodexAssignmentProgressV2}=await import("../src/brains/codex_assignment_progress.js");
  const {binding}=start();
  const initial=prepareCodexAssignmentProgressV2(binding);
  assert.ok(initial.prompt);assert.doesNotMatch(initial.prompt,/CURRENT CANONICAL EXECUTION CONTROL|recorded Resume/);
  const server=http.createServer((req,res)=>{void runWithRequestContext(context,()=>handleAssignmentHttpRoute(req,res,new URL(req.url!,"http://localhost"),id=>{
    if(id===binding.session_id)return true;res.writeHead(403).end();return false;}));});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{
    const origin=`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/assignments/v2/`;
    const send=(route:string,value:unknown)=>fetch(origin+route,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
    assert.equal((await send("execution-control",{...binding,action:"pause",command_id:"pause-review",expected_command_id:null})).status,200);
    const direction={...binding,command_id:"while-paused",expected_turn_id:null,text:"Review the north wing only. Remain read-only, do not save, and stay paused until I press Resume."};
    assert.equal((await send("steer",direction)).status,200);
    const saved=assignmentDirections(binding)[0];assert.equal(saved.text,direction.text);assert.equal(saved.state,"saved");
    const paused=prepareCodexAssignmentProgressV2(binding);assert.equal(paused.prompt,"");assert.equal(paused.snapshot.execution_control?.state,"paused");
    assert.equal((await send("execution-control",{...binding,action:"resume",command_id:"stale",expected_command_id:null})).status,409);
    const resume={...binding,action:"resume",command_id:"resume-review",expected_command_id:"pause-review"};
    assert.equal((await send("execution-control",resume)).status,200);
    const current=getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    assert.equal((await send("execution-control",resume)).status,200);
    assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.assignment_version,current.assignment_version,"exact control retry adds no event");
    const projected=prepareCodexAssignmentProgressV2(binding);
    const marker="CURRENT CANONICAL EXECUTION CONTROL (host receipt, not user instructions):";
    assert.ok(projected.prompt.indexOf(marker)>projected.prompt.indexOf(direction.text),"the recorded Resume follows the saved old pause direction");
    const receipt=JSON.parse(projected.prompt.split(marker+"\n")[1].split("\n")[0]);
    assert.deepEqual(receipt,{assignment_version:projected.snapshot.assignment_version,binding:projected.snapshot.current_binding,execution_control:current.execution_control});
    assert.ok(receipt.execution_control);
    assert.ok(Date.parse(receipt.execution_control.changed_at)>=Date.parse(saved.updated_at));
    assert.match(projected.prompt,/does not supersede directions added after this control's changed_at/);
    assert.match(projected.prompt,/read-only work and no saving/);
    assert.deepEqual(projected.snapshot.spec,paused.snapshot.spec);assert.deepEqual(projected.snapshot.operations,paused.snapshot.operations);
    assert.equal(projected.snapshot.spec.requested_effect,"read");assert.deepEqual(assignmentDirections(binding),[saved]);
    const later="Still read-only. Inspect the east wing instead; do not save.";
    assert.equal((await send("steer",{...direction,command_id:"later-direction",text:later})).status,200);
    const updated=prepareCodexAssignmentProgressV2(binding);assert.ok(updated.prompt.includes(later));
    assert.deepEqual(updated.snapshot.execution_control,current.execution_control,"a new direction is not a new Resume");
    const staleRead=prepareCodexAssignmentProgressV2({...binding,generation:binding.generation+1});
    assert.deepEqual(staleRead.snapshot.current_binding,updated.snapshot.current_binding,"context is labelled with the actual canonical binding, never the caller generation; dispatch is separately fenced");
    assert.equal((await send("execution-control",{...binding,action:"pause",command_id:"pause-again",expected_command_id:"resume-review"})).status,200);
    assert.equal((await send("execution-control",{...resume,command_id:"delayed-resume"})).status,409);
    assert.equal(prepareCodexAssignmentProgressV2(binding).prompt,"");
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},true));
