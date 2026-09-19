import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { routeConversation, retainedIntakeDecision } from "../src/conversation_intake.js";
import { prepareAssignmentTurn } from "../src/assignments/turn_preparation.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { __closeForTests, appendEvent } from "../src/memory/sqlite_store.js";
import { __testOnlyResetGoalListCache, getCurrentGoalForSession } from "../src/goals/service.js";

const question="Inspect the sheet list and count the mechanical sheets. Reply in one sentence.";
const request={version:"operator.backend.v1" as const,session_id:"count-session",message_id:"count-message",user_text:question};
const decision={route:"inspect",answer:null,basis:"needs_tools",requested_effect:"read",entire_request_answered:false,
  confidence:0.99,reason:"The requested sheet count needs a complete native collection total.",question_kind:"current_model",identity_fields:[],read_evidence:"complete_collection"};
const admission=()=>prepareAssignmentTurn({sessionId:request.session_id,messageId:request.message_id,userText:question,toolResults:[],source:"chat",
  createdBy:"test-owner",requestContext:{revit:{document:{title:"Arbitrary file label"}},ui:{response_style:"conversation"}}});

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
