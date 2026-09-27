import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { routeConversation, retainedIntakeDecision } from "../src/conversation_intake.js";
import { prepareAssignmentTurn } from "../src/assignments/turn_preparation.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { __closeForTests, appendEvent, latestMessageEvent } from "../src/memory/sqlite_store.js";
import { __testOnlyResetGoalListCache, getCurrentGoalForSession } from "../src/goals/service.js";

const question="Inspect the sheet list and count the mechanical sheets. Reply in one sentence.";
const request={version:"operator.backend.v1" as const,session_id:"count-session",message_id:"count-message",user_text:question};
const decision={route:"inspect",answer:null,basis:"needs_tools",requested_effect:"read",entire_request_answered:false,
  confidence:0.99,reason:"The requested sheet count needs a complete native collection total.",question_kind:"current_model",identity_fields:[],read_evidence:"complete_collection"};
const admission=()=>prepareAssignmentTurn({sessionId:request.session_id,messageId:request.message_id,userText:question,toolResults:[],source:"chat",
  createdBy:"test-owner",requestContext:{revit:{document:{title:"Arbitrary file label"}},ui:{response_style:"conversation"}}});

// Synthetic invalid candidate: the original Unit 403 failed candidate values
// were not retained and cannot be reconstructed from their unavailable receipts.
test("synthetic invalid intake gets one correction only after durable rejection, with immutable original input",()=>isolated(async()=>{
  let calls=0,acknowledged=0;let original:unknown;
  const interpreter={interpret:async(input:any,_signal:AbortSignal,correction?:any)=>{
    calls++;
    if(calls===1){original=input;return {value:{...decision,confidence:0.5},telemetry:{provider:"synthetic",usage:{input_tokens:12}},acknowledge:()=>{
      const receipt=latestMessageEvent(request.session_id,"conversation.intake",request.message_id) as any;
      assert.equal(receipt.accepted,false);assert.equal(receipt.decision,null);assert.equal(receipt.attempt,1);
      assert.ok(receipt.rejection.issues.some((i:any)=>i.code==="confidence_below_threshold"));acknowledged++;
    }};}
    assert.equal(input,original);assert.ok(Object.isFrozen(input));assert.equal(acknowledged,1);
    assert.equal(correction.attempt,2);assert.equal(correction.rejection.candidate.truncated,false);
    assert.throws(admission,/classification|intake/i);assert.equal(getCurrentGoalForSession(request.session_id),null);
    return {value:decision};
  }};
  assert.equal((await routeConversation(request,interpreter)).routing_status,"accepted");
  assert.equal(calls,2);assert.equal(retainedIntakeDecision(request)?.read_evidence,"complete_collection");
  assert.equal((await routeConversation(request,interpreter) as any).replayed,true);assert.equal(calls,2);
}));

async function isolated(run:()=>Promise<void>){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"operator-intake-recovery-"));
  const before=[process.env.OPERATOR_WORKSPACE_ROOT,process.env.OPERATOR_ASSIGNMENT_KERNEL_V2];
  process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_ASSIGNMENT_KERNEL_V2="1";
  __closeForTests();__testOnlyResetGoalListCache();
  try{await run();}finally{
    __closeForTests();__testOnlyResetGoalListCache();
    for(const [i,key] of ["OPERATOR_WORKSPACE_ROOT","OPERATOR_ASSIGNMENT_KERNEL_V2"].entries()){
      if(before[i]===undefined)delete process.env[key];else process.env[key]=before[i];
    }
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("operator-intake-recovery-"));fs.rmSync(root,{recursive:true,force:true});
  }
}

test("C56 timeout cannot admit the sheet question as legacy element inventory, including after restart and unrelated receipts",()=>isolated(async()=>{
  const response=await routeConversation(request,{interpret:async()=>new Promise(()=>{})},{timeoutMs:10});
  assert.throws(admission,/classification|intake/i);
  assert.equal((response as any).routing_status,"unavailable");
  assert.equal(getCurrentGoalForSession(request.session_id),null);
  for(let i=0;i<90;i++)appendEvent(request.session_id,"assistant","conversation.intake",{message_id:`other-${i}`,accepted:false,decision:null});
  __closeForTests();__testOnlyResetGoalListCache();
  assert.throws(admission,/classification|intake/i,"An exact-message unresolved receipt cannot be aged out by other conversation turns");
  const recovered=await routeConversation(request,{interpret:async()=>({value:decision})});
  assert.equal((recovered as any).routing_status,"accepted");
  const prepared=admission()!;
  assert.equal(prepared.kernelVersion,2);
  const spec=getAssignmentKernelSnapshotV2(prepared.assignmentId)!.spec;
  assert.ok(spec.criteria[0]!.semantic_fact_requirements.includes("collection.complete"));
  assert.ok(spec.criteria[0]!.semantic_fact_requirements.includes("collection.total"));
  assert.ok(!spec.criteria[0]!.semantic_fact_requirements.some(x=>x.startsWith("inventory.")));
}));

test("classification in progress cannot race task admission; a delayed decision retains the original request and model attempt",()=>isolated(async()=>{
  let finish:(value:any)=>void=()=>{};let calls=0;let signal:AbortSignal|undefined;
  const pending=routeConversation(request,{interpret:async(input,s)=>{calls++;signal=s;assert.equal(input.user_text,question);return new Promise(resolve=>{finish=resolve;});}},{timeoutMs:1000,softTimeoutMs:5});
  try{assert.throws(admission,/classification|intake/i);await new Promise(resolve=>setTimeout(resolve,20));}
  finally{finish({value:decision});}
  assert.equal((await pending as any).routing_status,"accepted");
  assert.equal(calls,1);assert.equal(signal!.aborted,false);
  assert.equal(retainedIntakeDecision(request)?.read_evidence,"complete_collection");
  assert.ok(admission());
}));

test("invalid or low-confidence classification never silently enters the ordinary worker",()=>isolated(async()=>{
  for(const value of [{...decision,confidence:0.5},{...decision,read_evidence:"invented"},null]){
    const response=await routeConversation(request,{interpret:async()=>({value})});
    assert.equal((response as any).routing_status,"unavailable");assert.throws(admission,/classification|intake/i);
  }
  assert.equal(getCurrentGoalForSession(request.session_id),null);
}));

test("a cancelled classifier cannot publish a late decision or authorize a replacement request",()=>isolated(async()=>{
  const controller=new AbortController();let finish:(value:any)=>void=()=>{};
  const pending=routeConversation(request,{interpret:async()=>new Promise(resolve=>{finish=resolve;})},{signal:controller.signal,timeoutMs:100});
  controller.abort();finish({value:decision});
  await assert.rejects(pending);assert.equal(retainedIntakeDecision(request),null);assert.throws(admission,/classification|intake/i);
  await assert.rejects(routeConversation({...request,user_text:question+" Then delete those sheets."},{interpret:async()=>({value:decision})}),/another|different|identity/i);
}));

test("synthetic second invalid interpretation stops at two and remains blocked after storage reopen",()=>isolated(async()=>{
  let calls=0,acks=0;
  const response=await routeConversation(request,{interpret:async()=>{calls++;return {value:{...decision,confidence:0.4},acknowledge:()=>acks++};}});
  assert.equal(response.routing_status,"unavailable");assert.equal(calls,2);assert.equal(acks,2);
  const receipt=latestMessageEvent(request.session_id,"conversation.intake",request.message_id) as any;
  assert.equal(receipt.attempt,2);assert.equal(receipt.accepted,false);assert.equal(receipt.decision,null);
  assert.equal(receipt.rejection.issues[0].code,"confidence_below_threshold");
  __closeForTests();__testOnlyResetGoalListCache();assert.equal(retainedIntakeDecision(request),null);
  assert.throws(admission,/classification|intake/i);assert.equal(getCurrentGoalForSession(request.session_id),null);
}));

test("synthetic correction consumes the original deadline rather than starting another timeout",t=>isolated(async()=>{
  let now=0,calls=0;const signals:AbortSignal[]=[];
  t.mock.method(Date,"now",()=>now);
  const response=await routeConversation(request,{interpret:async(_input,signal)=>{
    signals.push(signal);calls++;
    if(calls===1){now=20;return {value:{...decision,confidence:0.4}};}
    assert.equal(now,20);now=31;return {value:decision};
  }},{timeoutMs:30});
  assert.equal(calls,2);assert.equal(signals[0],signals[1]);assert.equal(signals[1]!.aborted,true);
  assert.equal(response.routing_status,"unavailable");assert.equal(retainedIntakeDecision(request),null);assert.throws(admission,/classification|intake/i);
  t.mock.restoreAll();
}));

test("an expired or already cancelled original request never starts an interpreter",()=>isolated(async()=>{
  let calls=0;const interpreter={interpret:async()=>{calls++;return {value:decision};}};
  assert.equal((await routeConversation(request,interpreter,{timeoutMs:0})).routing_status,"unavailable");
  const controller=new AbortController();controller.abort(Error("already cancelled"));
  await assert.rejects(routeConversation(request,interpreter,{signal:controller.signal}),/already cancelled/);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);assert.equal(retainedIntakeDecision(request),null);
}));

test("cancellation during synthetic correction ignores its later valid value",()=>isolated(async()=>{
  const controller=new AbortController();let calls=0,finish:(value:any)=>void=()=>{},started:()=>void=()=>{};
  const secondStarted=new Promise<void>(resolve=>{started=resolve;});
  const pending=routeConversation(request,{interpret:async()=>{
    if(++calls===1)return {value:{...decision,confidence:0.4}};
    return new Promise(resolve=>{finish=resolve;started();});
  }},{signal:controller.signal,timeoutMs:1000});
  await secondStarted;assert.throws(admission,/classification|intake/i);
  controller.abort(Error("cancelled by user"));finish({value:decision});
  await assert.rejects(pending,/cancelled by user/);assert.equal(calls,2);
  assert.equal(retainedIntakeDecision(request),null);assert.throws(admission,/classification|intake/i);
}));

test("interpreter and acknowledgment failures never receive a semantic retry",()=>isolated(async()=>{
  for(const failure of ["authentication denied","transport failed","quota exhausted","unexpected execution tool","invalid JSON", "provider unavailable"]){
    let calls=0;const result=await routeConversation(request,{interpret:async()=>{calls++;throw Error(failure);}});
    assert.equal(result.routing_status,"unavailable");assert.equal(calls,1);assert.throws(admission,/classification|intake/i);
  }
  let calls=0;
  const result=await routeConversation(request,{interpret:async()=>{calls++;return {value:{...decision,confidence:0.4},acknowledge:()=>{throw Error("acknowledgment failed");}};}});
  assert.equal(result.routing_status,"unavailable");assert.equal(calls,1);
}));

test("durable rejection failure prevents acknowledgment and correction at the actual SQLite boundary",()=>isolated(async()=>{
  let calls=0,acks=0,db:any;
  const Database=createRequire(import.meta.url)("better-sqlite3");
  try{
    const result=await routeConversation(request,{interpret:async()=>{
      calls++;db=new Database(path.join(process.env.OPERATOR_WORKSPACE_ROOT!,"db","operator.sqlite"));
      db.exec("CREATE TRIGGER reject_intake_receipt BEFORE INSERT ON events WHEN NEW.kind='conversation.intake' AND json_extract(NEW.payload_json,'$.state')='rejected' BEGIN SELECT RAISE(FAIL,'injected rejection persistence failure'); END;");
      return {value:{...decision,confidence:0.4},acknowledge:()=>acks++};
    }});
    assert.equal(result.routing_status,"unavailable");assert.equal(calls,1);assert.equal(acks,0);
    assert.equal(retainedIntakeDecision(request),null);assert.throws(admission,/classification|intake/i);
  }finally{db?.close();}
}));

test("synthetic oversized rejected values and telemetry retain bounded prefixes and complete hashes",()=>isolated(async()=>{
  const value={...decision,reason:"界".repeat(100_000)},telemetry={provider:"synthetic",oversized:"界".repeat(100_000)};
  const result=await routeConversation(request,{interpret:async()=>({value,telemetry})});
  assert.equal(result.routing_status,"unavailable");
  const receipt=latestMessageEvent(request.session_id,"conversation.intake",request.message_id) as any;
  for(const [retained,original] of [[receipt.rejection.candidate,value],[receipt.telemetry,telemetry]]){
    assert.equal(retained.truncated,true);assert.ok(Buffer.byteLength(retained.json)<=64*1024);
    assert.equal(retained.byte_count,Buffer.byteLength(JSON.stringify(original)));
    assert.equal(retained.sha256,createHash("sha256").update(JSON.stringify(original)).digest("hex"));
  }
  assert.deepEqual(receipt.rejection.issues.map((i:any)=>[i.code,i.path]),[["reason_length","$.reason"]]);
  assert.equal(receipt.decision,null);assert.equal(receipt.accepted,false);
}));
