import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { compactUiObservation, mayRouteConversation, routeConversation, validateIntakeDecision, type IntakeInput } from "../src/conversation_intake.js";
import { appendMessage, getPinnedGoal } from "../src/session_store.js";
import { __closeForTests, getConversationHistory } from "../src/memory/sqlite_store.js";
import { formatUiContextConversationHistory } from "../src/conversation_history.js";

const question="Can you see the open model? Please tell me its name and active view.";
const ui={ok:true,data:{document:{title:"Snowdon HVAC",path:"PRIVATE-PATH",activeView:{name:"Mechanical L4",type:"FloorPlan"},selection:[1,2]}}};
const answer={route:"answer",answer:"Snowdon HVAC is open, with Mechanical L4 active.",basis:"ui_identity",requested_effect:"none",entire_request_answered:true,confidence:0.98,reason:"Live UI labels answer the complete question."};
const body=(user_text=question,extra={})=>({version:"operator.backend.v1" as const,session_id:"session",message_id:"message",user_text,ui_observation:ui,...extra});

test("arbitrary conversational wording reaches semantic intake without a phrase filter",()=>{
  for(const prompt of [question,"Is this the mechanical model?","Am I in the HVAC file or the architectural one?",
    "Which discipline does this appear to be?","What does VAV stand for?","Tell me its name and then rename it.","Are we looking at the same thing?","¿Qué modelo está abierto?"])
    assert.equal(mayRouteConversation(body(prompt)),true,prompt);
  for(const extra of [{assignment_id:"work"},{assignment_run_id:"run"},{assignment_generation:0},{attachments:[{}]},
    {pending_attachments:[{}]},{user_attachments:[{}]},{tool_results:[{}]}]) assert.equal(mayRouteConversation(body(question,extra)),false);
  assert.equal(mayRouteConversation(body("x".repeat(16001))),false,"Never classify a truncated user request");
});

test("UI observations provide bounded labels without model files or fabricated geometry",()=>{
  assert.deepEqual(compactUiObservation(ui),{state:"available",document_title:"Snowdon HVAC",active_view_name:"Mechanical L4",active_view_type:"FloorPlan",selected_count:2});
  assert.deepEqual(compactUiObservation({ok:true,data:{document:null}}),{state:"no_open_model"});
  for(const bad of [null,{ok:false,data:ui.data},{ok:true,data:{}},{ok:true,data:{document:{}}}]) assert.deepEqual(compactUiObservation(bad),{state:"unavailable"});
});

test("a model routing decision cannot authorize writes or claim a partial answer is complete",()=>{
  assert.deepEqual(validateIntakeDecision(answer),answer);
  for(const bad of [{...answer,requested_effect:"change"},{...answer,requested_effect:"read"},{...answer,entire_request_answered:false},
    {...answer,basis:"needs_tools"},{...answer,confidence:0.4},{...answer,confidence:NaN},{...answer,answer:null},
    {...answer,extra:"unreviewed field"},{...answer,answer:"x".repeat(3001)},{...answer,route:"inspect"}])
    assert.equal(validateIntakeDecision(bad),null);
  assert.ok(validateIntakeDecision({...answer,route:"inspect",requested_effect:"read",basis:"needs_tools",answer:null,entire_request_answered:false}));
});

test("semantic answer is durable historical conversation and never repins a task; handoff preserves every clause",async()=>{
  process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),"operator-intake-test-"));
  __closeForTests();
  appendMessage("session",{role:"user",text:"Keep working on the duct reconstruction."});
  const pinned=getPinnedGoal("session");let calls=0;
  const interpreter={interpret:async(input:IntakeInput)=>{calls++;assert.equal(input.user_text,question);assert.doesNotMatch(JSON.stringify(input),/PRIVATE-PATH/);return{value:answer};}};
  const first=await routeConversation(body(),interpreter);
  assert.equal(first.route,"answer");assert.equal(first.history_saved,true);assert.equal(getPinnedGoal("session"),pinned);
  assert.equal(getConversationHistory("session").at(-1)?.text,answer.answer);
  assert.match(formatUiContextConversationHistory("session"),/not current Revit evidence or task completion/);
  __closeForTests();
  assert.equal((await routeConversation(body(),interpreter)).assistant_message,answer.answer);assert.equal(calls,1);
  await assert.rejects(routeConversation(body("Different question"),interpreter),/another question/);
  const mixed="Tell me which model is open, then rename the current view.";
  let original="";
  const handoff=await routeConversation(body(mixed,{message_id:"mixed"}),{interpret:async input=>{
    original=input.user_text;return{value:{...answer,route:"task",requested_effect:"change",basis:"needs_tools",answer:null,entire_request_answered:false}};
  }});
  assert.equal(original,mixed);assert.equal(handoff.route,"task");assert.equal(handoff.assistant_message,null);
  assert.equal(getConversationHistory("session").length,2,"Handoff must not append a partial or duplicate user conversation");
  assert.equal(getPinnedGoal("session"),pinned);__closeForTests();
});

test("timeout and invalid output fall back without recording a late answer; foreign history is excluded",async()=>{
  process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),"operator-intake-fallback-"));__closeForTests();
  let observedSignal:AbortSignal|undefined;let finish:(value:any)=>void=()=>{};
  const result=await routeConversation(body(),{interpret:async(_,signal)=>{observedSignal=signal;return await new Promise(resolve=>{finish=resolve;});}},{timeoutMs:10});
  assert.equal(result.route,"task");assert.equal(observedSignal?.aborted,true);
  finish({value:answer});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(getConversationHistory("session").length,0);
  await routeConversation(body(),{interpret:async()=>({value:answer})});
  const foreign=await routeConversation(body("Explain VAV",{session_id:"foreign"}),{interpret:async input=>{
    assert.deepEqual(input.recent_conversation,[]);return{value:{...answer,entire_request_answered:false}};
  }});
  assert.equal(foreign.route,"task");assert.equal(getConversationHistory("foreign").length,0);__closeForTests();
});
