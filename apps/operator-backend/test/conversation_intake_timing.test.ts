import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { routeConversation, retainedIntakeDecision } from "../src/conversation_intake.js";
import { ModelConversationIntake } from "../src/brains/conversation_intake_model.js";
import { __closeForTests, latestMessageEvent, getConversationHistory } from "../src/memory/sqlite_store.js";

const request={version:"operator.backend.v1" as const,session_id:"timing",message_id:"timing",user_text:"Count the mechanical sheets."};
const decision={route:"inspect",answer:null,basis:"needs_tools",requested_effect:"read",entire_request_answered:false,
  confidence:0.99,reason:"A native count is needed.",question_kind:"current_model",identity_fields:[],read_evidence:"complete_collection"};
const receipt=()=>latestMessageEvent(request.session_id,"conversation.intake",request.message_id) as any;
async function isolated(run:()=>Promise<void>){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"operator-intake-timing-")),prior=process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT=root;__closeForTests();
  try{await run();}finally{__closeForTests();if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;
    assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith("operator-intake-timing-"));fs.rmSync(root,{recursive:true,force:true});}
}

test("timeout retains bounded host phase without inventing usage or accepting a late result",()=>isolated(async()=>{
  let phase:(name:string)=>void=()=>{},finish:(value:any)=>void=()=>{},signal:AbortSignal|undefined;
  const response=await routeConversation(request,{interpret:async(_input:any,s:AbortSignal,_correction:any,observe:any)=>{
    signal=s;phase=observe;observe?.("starting_client");return new Promise(resolve=>{finish=resolve;});
  }} as any,{timeoutMs:20});
  assert.equal(response.routing_status,"unavailable");assert.equal(signal?.aborted,true);
  assert.equal(receipt().host_timing.last_phase,"starting_client");assert.equal(receipt().host_timing.entries[0].attempt,1);
  assert.equal(receipt().telemetry,undefined,"No completed provider usage is available");
  const saved=JSON.stringify(receipt());phase?.("decision_decoded");finish({value:decision,telemetry:{usage:{total_tokens:99}}});
  await new Promise(resolve=>setTimeout(resolve,5));assert.equal(JSON.stringify(receipt()),saved);assert.deepEqual(getConversationHistory(request.session_id),[]);
  assert.equal((response as any).host_timing,undefined,"Diagnostics do not enter the HTTP response");
}));

test("actual model producer emits safe startup boundaries and observer exceptions cannot change its result",()=>isolated(async()=>{
  const keys=["OPERATOR_BRAIN","OPERATOR_CODEX_MODEL","OPERATOR_INTAKE_MODEL","OPERATOR_INTAKE_REASONING_EFFORT"],prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  process.env.OPERATOR_BRAIN="codex";process.env.OPERATOR_CODEX_MODEL="gpt-6.1-sol";delete process.env.OPERATOR_INTAKE_MODEL;delete process.env.OPERATOR_INTAKE_REASONING_EFFORT;
  let notify:(event:any)=>void=()=>{};const phases:string[]=[],turns:any[]=[];
  const client={stopAndWait:async()=>{},setServerRequestHandler:()=>{},ensureStarted:async()=>{},
    startThread:async(o:any)=>({model:o.model,thread:{id:"synthetic-timing"}}),onNotification:(f:any)=>{notify=f;return()=>{};},
    startBoundTurn:async(o:any)=>{turns.push(o);notify({threadId:"synthetic-timing",method:"item/completed",params:{item:{type:"agentMessage",text:JSON.stringify(decision)}}});return{turn:{id:"synthetic-turn"}};},
    waitForTurnCompleted:async()=>({status:"completed"}),getTurnInstructionBinding:()=>({source:"synthetic-unit"}),acknowledgePersistedTurnInstructionBinding:()=>{}};
  const model=new ModelConversationIntake({prepareIsolation:()=>({cwd:process.env.OPERATOR_WORKSPACE_ROOT!,codexHome:process.env.OPERATOR_WORKSPACE_ROOT!,release:()=>{}} as any),createClient:()=>client as any});
  const input={user_text:request.user_text,recent_conversation:[],ui_observation:{state:"unknown" as const}};
  try{
    const result=await (model.interpret as any)(input,new AbortController().signal,undefined,(phase:string)=>{phases.push(phase);throw Error("observer is diagnostic only");});
    assert.deepEqual(result.value,decision);
    assert.deepEqual(phases,["preparing_input","awaiting_previous_close","preparing_isolation","creating_client","starting_client","starting_thread","starting_turn","waiting_for_model","decoding_decision","decision_decoded"]);
    assert.equal(turns.length,1);assert.equal(JSON.parse(turns[0].input[0].text).user_text,request.user_text);
    assert.doesNotMatch(turns[0].input[0].text,/host_timing|starting_client|diagnostic/);
    assert.deepEqual(Object.keys(result.telemetry).sort(),["host_instruction_binding","model","provider","reasoning_effort","source_quote_catalog","thread_id","turn_id","usage"].sort());
  }finally{await model.close();for(const k of keys){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}}
}));

test("success and correction preserve timing outside immutable model inputs and keep original validators",()=>isolated(async()=>{
  let firstInput:unknown,calls=0;
  const response=await routeConversation(request,{interpret:async(input:any,_signal:any,correction:any,observe:any)=>{
    calls++;if(calls===1)firstInput=input;else{assert.equal(firstInput,input);assert.equal(correction.attempt,2);}
    assert(Object.isFrozen(input));assert.doesNotMatch(JSON.stringify(input),/host_timing|preparing_input|starting_client/);
    observe("preparing_input");observe("decision_decoded");
    return {value:calls===1?{...decision,confidence:0.4}:decision,telemetry:{provider:"synthetic-unit",usage:{total_tokens:7}}};
  }} as any);
  assert.equal(response.routing_status,"accepted");assert.equal(calls,2);assert.equal(retainedIntakeDecision(request)?.route,"inspect");
  const timing=receipt().host_timing;assert.deepEqual(timing.entries.map((r:any)=>r.attempt),[1,1,2,2]);
  assert.equal(timing.last_phase,"decision_decoded");assert.equal(timing.dropped_count,0);
  assert.deepEqual(receipt().telemetry.usage,{total_tokens:7});
  let previous=-1;for(const row of timing.entries){assert(row.elapsed_ms>=previous&&row.elapsed_ms<=timing.elapsed_ms);previous=row.elapsed_ms;}
  assert.equal((response as any).host_timing,undefined);
  await assert.rejects(routeConversation({...request,user_text:"Foreign replacement"},{interpret:async()=>{throw Error("must not execute");}}),/another question/);
}));

test("phase records are capped and allowlisted; diagnostic data cannot grant a rejected task",()=>isolated(async()=>{
  const response=await routeConversation(request,{interpret:async(_input:any,_signal:any,_correction:any,observe:any)=>{
    observe("SECRET-PATH-OR-MODEL-TEXT");for(let i=0;i<30;i++)observe("starting_client");
    observe("decision_decoded");return{value:{...decision,confidence:0.4}};
  }} as any);
  assert.equal(response.routing_status,"unavailable");assert.equal(retainedIntakeDecision(request),null);
  const timing=receipt().host_timing;assert.equal(timing.entries.length,24);assert.equal(timing.observed_count,62);assert.equal(timing.dropped_count,38);
  assert.equal(timing.last_phase,"decision_decoded");assert.doesNotMatch(JSON.stringify(timing),/SECRET|PATH|MODEL-TEXT/);
  assert(Buffer.byteLength(JSON.stringify(timing))<3500);
}));

test("explicit cancellation retains last host stage without a fallback or late decision",()=>isolated(async()=>{
  const controller=new AbortController();let phase:any;
  const pending=routeConversation(request,{interpret:async(_input:any,_signal:any,_correction:any,observe:any)=>{
    phase=observe;observe("waiting_for_model");queueMicrotask(()=>controller.abort(Error("User Pause")));return new Promise(()=>{});
  }} as any,{signal:controller.signal});
  await assert.rejects(pending,/User Pause/);assert.equal(receipt().state,"cancelled");assert.equal(receipt().host_timing.last_phase,"waiting_for_model");
  assert.equal(latestMessageEvent(request.session_id,"conversation.intake.fallback",request.message_id),null);
  const saved=JSON.stringify(receipt());phase("decision_decoded");assert.equal(JSON.stringify(receipt()),saved);assert.equal(retainedIntakeDecision(request),null);
}));

test("actual model startup failure is retained by router without model input, usage or automatic retry",()=>isolated(async()=>{
  const keys=["OPERATOR_BRAIN","OPERATOR_CODEX_MODEL","OPERATOR_INTAKE_MODEL","OPERATOR_INTAKE_REASONING_EFFORT"],prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  process.env.OPERATOR_BRAIN="codex";process.env.OPERATOR_CODEX_MODEL="gpt-6.1-sol";delete process.env.OPERATOR_INTAKE_MODEL;delete process.env.OPERATOR_INTAKE_REASONING_EFFORT;
  let starts=0,stops=0;const client={stopAndWait:async()=>{stops++;},setServerRequestHandler:()=>{},ensureStarted:async()=>{starts++;throw Error("synthetic client start failure");}};
  const model=new ModelConversationIntake({prepareIsolation:()=>({cwd:process.env.OPERATOR_WORKSPACE_ROOT!,codexHome:process.env.OPERATOR_WORKSPACE_ROOT!,release:()=>{}} as any),createClient:()=>client as any});
  try{
    const response=await routeConversation(request,model);assert.equal(response.routing_status,"unavailable");assert.equal(starts,1);
    assert.equal(receipt().host_timing.last_phase,"starting_client");assert.equal(receipt().telemetry,undefined);assert.equal(receipt().accepted,false);
    assert.equal(retainedIntakeDecision(request),null);await model.close();assert.equal(stops,1);
  }finally{await model.close();for(const k of keys){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}}
}));
