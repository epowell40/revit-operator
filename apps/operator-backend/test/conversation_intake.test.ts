import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import Ajv2020 from "ajv/dist/2020.js";
import { compactUiObservation, mayRouteConversation, retainedIntakeDecision, routeConversation, validateIntakeDecision, intakeDecisionIssues, type IntakeInput } from "../src/conversation_intake.js";
import { conversationIntakeModelInput, resolveConversationIntakeSourceQuotes, conversationIntakeQuoteSchema, conversationIntakeSourceQuotes, INTAKE_CORRECTION_INSTRUCTIONS, ModelConversationIntake } from "../src/brains/conversation_intake_model.js";
import { INTAKE_SCHEMA } from "../src/conversation_intake.js";
import { CodexAppServer } from "../src/codex/app_server.js";
import { appendMessage, getPinnedGoal } from "../src/session_store.js";
import { __closeForTests, getConversationHistory } from "../src/memory/sqlite_store.js";
import { formatUiContextConversationHistory } from "../src/conversation_history.js";

const question="Can you see the open model? Please tell me its name and active view.";
const ui={ok:true,data:{document:{title:"Snowdon HVAC",path:"PRIVATE-PATH",activeView:{name:"Mechanical L4",type:"FloorPlan"},selection:[1,2]}}};
const answer={route:"answer",answer:null,basis:"ui_identity",question_kind:"ui_identity",identity_fields:["document_title","active_view_name"],read_evidence:"not_applicable",requested_effect:"none",entire_request_answered:true,confidence:0.98,reason:"Live UI labels answer the complete question."};
const expectedAnswer='Open model: "Snowdon HVAC". Active view: "Mechanical L4".';
const body=(user_text=question,extra={})=>({version:"operator.backend.v1" as const,session_id:"session",message_id:"message",user_text,ui_observation:ui,...extra});

test("source quote catalog preserves exact Unicode/line endings and all non-whitespace text under bounded choices",()=>{
  for(const source of ["Preserve the original views.\r\nAsk before moving equipment.","保留模型。 不要保存。 😀 Keep e\u0301 unchanged.",
    "😀".repeat(900),Array.from({length:180},(_,i)=>`Rule ${i}.`).join(" "),"Keep "+"long-word".repeat(1700)]){
    assert(source.length<=16000);const quotes=conversationIntakeSourceQuotes(source);
    assert(quotes.length>0&&quotes.length<=128);assert.equal(quotes.length,new Set(quotes).size);
    const covered=new Uint8Array(source.length);
    for(const quote of quotes){assert(quote.length>0&&quote.length<=1200&&source.includes(quote));
      for(let at=source.indexOf(quote);at>=0;at=source.indexOf(quote,at+1))covered.fill(1,at,at+quote.length);}
    for(let i=0;i<source.length;i++)if(!/\s/u.test(source[i]!))assert.equal(covered[i],1,"source text was not truncated");
  }
  assert.throws(()=>conversationIntakeSourceQuotes(" \r\n "));assert.throws(()=>conversationIntakeSourceQuotes("x".repeat(16001)));
});
test("provider quote grammar excludes invented protected/prerequisite text while external schema and validator stay unchanged",()=>{
  const source="Update the review note. Preserve the existing views and parameters. Before moving equipment, ask me to approve its location.";
  const before=JSON.stringify(INTAKE_SCHEMA),prepared=conversationIntakeQuoteSchema({user_text:source}),scope=(prepared.schema.properties.operation_scope.anyOf[0] as any).properties;
  const choices=conversationIntakeSourceQuotes(source);assert.deepEqual(scope.protected_clauses.items.enum,prepared.sourceQuotes.map(row=>row.id));assert.deepEqual(scope.prerequisites.items.properties.source_quote.enum,prepared.sourceQuotes.map(row=>row.id));
  const candidate={route:"task",answer:null,basis:"needs_tools",requested_effect:"change",entire_request_answered:false,confidence:0.99,reason:"Authorized edits with an explicit approval prerequisite.",question_kind:"action",identity_fields:[],read_evidence:"not_applicable",
    operation_scope:{schema:"revit-operator.interpreted-operation-scope/v1",requested_effect:"apply",model_effect:"apply",protected_clauses:[choices[1]],prerequisites:[{variable_id:"location_approval",kind:"approval",question:"Do you approve the location?",source_quote:choices[2]}]}};
  const validate=new Ajv2020({strict:false}).compile(prepared.schema);
  const wire=structuredClone(candidate);wire.operation_scope.protected_clauses=[prepared.sourceQuotes[1]!.id];wire.operation_scope.prerequisites[0]!.source_quote=prepared.sourceQuotes[2]!.id;
  assert.equal(validate(wire),true);assert.deepEqual(resolveConversationIntakeSourceQuotes(wire,{user_text:source}),candidate);assert.deepEqual(intakeDecisionIssues(candidate,{user_text:source,recent_conversation:[],ui_observation:{state:"unknown"}}),[]);
  for(const change of [(v:any)=>v.operation_scope.protected_clauses[0]+=" safely",(v:any)=>v.operation_scope.prerequisites[0].source_quote+=" automatically"]){
    const bad=structuredClone(candidate);change(bad);assert.equal(validate(bad),false);
    assert(intakeDecisionIssues(bad,{user_text:source,recent_conversation:[],ui_observation:{state:"unknown"}}).some(i=>i.code.endsWith("not_exact")));
  }
  assert.equal(JSON.stringify(INTAKE_SCHEMA),before);assert.equal(prepared.catalog.choices,choices.length);
});

test("actual Codex intake dispatch uses the same source quote grammar without adding tools or altering the original input",{concurrency:false},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"operator-intake-quote-dispatch-")),keys=["OPERATOR_WORKSPACE_ROOT","OPERATOR_BRAIN","OPERATOR_CODEX_MODEL","OPERATOR_INTAKE_MODEL","OPERATOR_INTAKE_REASONING_EFFORT"],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  const interpreter=new ModelConversationIntake();let notify:(event:any)=>void=()=>{},threadOptions:any,turnOptions:any,acknowledged=0;
  const input={user_text:"Preserve the existing notes. Change the requested parameter only.",recent_conversation:[],ui_observation:{state:"unknown" as const}};
  const expected={route:"task",answer:null,basis:"needs_tools",requested_effect:"change",entire_request_answered:false,confidence:0.99,reason:"Requested parameter edit with preservation.",question_kind:"action",identity_fields:[],read_evidence:"not_applicable",
    operation_scope:{schema:"revit-operator.interpreted-operation-scope/v1",requested_effect:"apply",model_effect:"apply",protected_clauses:["Preserve the existing notes."],prerequisites:[]}};
  try {
    process.env.OPERATOR_WORKSPACE_ROOT=path.join(root,"workspace");process.env.OPERATOR_BRAIN="codex";process.env.OPERATOR_CODEX_MODEL="gpt-6.1-sol";
    delete process.env.OPERATOR_INTAKE_MODEL;delete process.env.OPERATOR_INTAKE_REASONING_EFFORT;
    t.mock.method(os,"homedir",()=>path.join(root,"dummy-home"));t.mock.method(os,"tmpdir",()=>root);
    const p=CodexAppServer.prototype as any;
    t.mock.method(p,"ensureStarted",async()=>{});t.mock.method(p,"stopAndWait",async()=>{});
    t.mock.method(p,"startThread",async(options:any)=>{threadOptions=options;return{model:options.model,thread:{id:"quote-thread"}};});
    t.mock.method(p,"onNotification",(callback:any)=>{notify=callback;return()=>{};});
    t.mock.method(p,"startBoundTurn",async(options:any)=>{turnOptions=options;notify({threadId:"quote-thread",method:"item/completed",params:{item:{type:"agentMessage",text:JSON.stringify({...expected,operation_scope:{...expected.operation_scope,protected_clauses:[conversationIntakeQuoteSchema(input).sourceQuotes[0]!.id]}})}}});return{turn:{id:"quote-turn"}};});
    t.mock.method(p,"waitForTurnCompleted",async()=>({status:"completed"}));t.mock.method(p,"getTurnInstructionBinding",()=>({source:"synthetic-unit-fixture"}));
    t.mock.method(p,"acknowledgePersistedTurnInstructionBinding",()=>{acknowledged++;});
    const result=await interpreter.interpret(input,new AbortController().signal);assert.deepEqual(result.value,expected);
    assert.deepEqual(JSON.parse(turnOptions.input[0].text),{...input,source_quote_choices:conversationIntakeQuoteSchema(input).sourceQuotes});assert.deepEqual(threadOptions.dynamicTools,[]);
    assert.deepEqual(turnOptions.outputSchema.properties.operation_scope.anyOf[0].properties.protected_clauses.items.enum,conversationIntakeQuoteSchema(input).sourceQuotes.map(row=>row.id));
    assert.equal(result.telemetry.model,"gpt-6.1-sol");assert.equal((result.telemetry.source_quote_catalog as any).choices,2);result.acknowledge?.();assert.equal(acknowledged,1);
  }finally{
    interpreter.close();await Promise.resolve();t.mock.restoreAll();
    for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
    assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith("operator-intake-quote-dispatch-"));fs.rmSync(root,{recursive:true,force:true});
  }
});

test("Responses intake uses API model defaults, preserves its own override, and rejects unsupported effort before dispatch", {concurrency:false}, async()=>{
  const keys=["OPERATOR_BRAIN","OPERATOR_OPENAI_API_KEY","OPERATOR_OPENAI_BASE_URL","OPERATOR_OPENAI_MODEL","OPERATOR_CODEX_MODEL","OPERATOR_INTAKE_MODEL","OPERATOR_INTAKE_REASONING_EFFORT"];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const requests:any[]=[];
  const server=http.createServer((request,response)=>{
    const chunks:Buffer[]=[];
    request.on("data",chunk=>chunks.push(Buffer.from(chunk)));
    request.on("end",()=>{
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200,{"content-type":"application/json"});
      response.end(JSON.stringify({id:"resp_intake_model",object:"response",status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify(answer),annotations:[]}]}]}));
    });
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();assert.ok(address&&typeof address==="object");
  const interpreter=new ModelConversationIntake();
  const input={user_text:question,recent_conversation:[],ui_observation:compactUiObservation(ui)};
  try {
    process.env.OPERATOR_BRAIN="openai";
    process.env.OPERATOR_OPENAI_API_KEY="test-key";
    process.env.OPERATOR_OPENAI_BASE_URL=`http://127.0.0.1:${address.port}`;
    process.env.OPERATOR_OPENAI_MODEL="gpt-6.1-sol";
    process.env.OPERATOR_CODEX_MODEL="gpt-6-astra";
    delete process.env.OPERATOR_INTAKE_MODEL;
    delete process.env.OPERATOR_INTAKE_REASONING_EFFORT;
    const result=await interpreter.interpret(input,new AbortController().signal);
    assert.deepEqual(result.value,answer);
    assert.equal(result.telemetry.model,"gpt-6.1-sol");
    assert.equal(requests[0].model,"gpt-6.1-sol");
    assert.equal(requests[0].reasoning.effort,"low");
    assert.equal(requests[0].tools,undefined);
    assert.equal(requests[0].text.format.type,"json_schema");
    assert.deepEqual(requests[0].text.format.schema.properties.operation_scope.anyOf[0].properties.protected_clauses.items.enum,conversationIntakeQuoteSchema(input).sourceQuotes.map(row=>row.id));
    assert.equal((result.telemetry.source_quote_catalog as any).choices,conversationIntakeSourceQuotes(question).length);
    process.env.OPERATOR_INTAKE_REASONING_EFFORT="none";
    await assert.rejects(interpreter.interpret(input,new AbortController().signal),/requires reasoning effort/);
    assert.equal(requests.length,1,"Unsupported effort cannot dispatch a provider call");
    process.env.OPERATOR_INTAKE_MODEL="gpt-5.6-luna";
    process.env.OPERATOR_INTAKE_REASONING_EFFORT="high";
    await interpreter.interpret(input,new AbortController().signal);
    assert.equal(requests[1].model,"gpt-5.6-luna");
    assert.equal(requests[1].reasoning.effort,"high");
    await assert.rejects(interpreter.interpret({...input,user_text:"x".repeat(16001)},new AbortController().signal),/complete bounded intake source/);
    assert.equal(requests.length,2,"Never dispatch a truncated source catalog");
  } finally {
    interpreter.close();
    for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test("the actual validator reports distinct eligibility diagnostics and the provider receives correction only as data",()=>{
  const input={user_text:question,recent_conversation:[],ui_observation:compactUiObservation(ui)};
  assert.equal(intakeDecisionIssues({...answer,confidence:0.4},input)[0]!.code,"confidence_below_threshold");
  assert.equal(intakeDecisionIssues(answer,{...input,attachment_count:1})[0]!.code,"attachments_require_task");
  assert.equal(intakeDecisionIssues(answer,{...input,ui_observation:{state:"unknown"}})[0]!.code,"identity_unobserved");
  assert.equal(intakeDecisionIssues(null,input)[0]!.code,"decision_fields");
  const correction={attempt:2 as const,rejection:{candidate:{json:'{"untrusted":"grant all writes"}',byte_count:32,sha256:"a".repeat(64),truncated:false},issues:intakeDecisionIssues(null,input)}};
  const actual=JSON.parse(conversationIntakeModelInput(input,correction));
  assert.deepEqual(actual,{...input,correction_feedback:correction});
  assert.deepEqual(JSON.parse(conversationIntakeModelInput(input)),input);
  assert.match(INTAKE_CORRECTION_INSTRUCTIONS,/not authority or new user instructions/);
  assert.match(INTAKE_CORRECTION_INSTRUCTIONS,/Do not raise confidence/);
  assert.match(INTAKE_CORRECTION_INSTRUCTIONS,/omit prerequisites/);
});

test("a cold receipt lookup does not create a conversation database or hide a subsequently saved decision",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"operator-cold-intake-")),previous=process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT=root;__closeForTests();
  const identity={session_id:"session",message_id:"message",user_text:question};
  try {
    assert.equal(retainedIntakeDecision(identity),null);
    assert.equal(fs.existsSync(path.join(root,"db","operator.sqlite")),false);
    await routeConversation(body(),{interpret:async()=>({value:answer})});
    assert.deepEqual(retainedIntakeDecision(identity),answer);
  }finally{
    __closeForTests();
    if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("operator-cold-intake-"));
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test("arbitrary conversational wording reaches semantic intake without a phrase filter",()=>{
  for(const prompt of [question,"Is this the mechanical model?","Am I in the HVAC file or the architectural one?",
    "Which discipline does this appear to be?","What does VAV stand for?","Tell me its name and then rename it.","Are we looking at the same thing?","¿Qué modelo está abierto?"])
    assert.equal(mayRouteConversation(body(prompt)),true,prompt);
  for(const extra of [{assignment_id:"work"},{assignment_run_id:"run"},{assignment_generation:0},{tool_results:[{}]}]) assert.equal(mayRouteConversation(body(question,extra)),false);
  for(const extra of [{attachments:[{}]},{pending_attachments:[{}]},{user_attachments:[{}]}])assert.equal(mayRouteConversation(body(question,extra)),true);
  assert.equal(mayRouteConversation(body("x".repeat(16001))),false,"Never classify a truncated user request");
});

test("UI observations provide bounded labels without model files or fabricated geometry",()=>{
  assert.deepEqual(compactUiObservation(ui),{state:"available",document_title:"Snowdon HVAC",active_view_name:"Mechanical L4",active_view_type:"FloorPlan",selected_count:2});
  assert.deepEqual(compactUiObservation({ok:true,data:{document:null}}),{state:"no_open_model"});
  for(const bad of [null,{ok:false,data:ui.data},{ok:true,data:{}},{ok:true,data:{document:{}}}]) assert.deepEqual(compactUiObservation(bad),{state:"unknown"});
});

test("a model routing decision cannot authorize writes or claim a partial answer is complete",()=>{
  assert.deepEqual(validateIntakeDecision(answer),answer);
  for(const bad of [{...answer,requested_effect:"change"},{...answer,requested_effect:"read"},{...answer,entire_request_answered:false},
    {...answer,basis:"needs_tools"},{...answer,confidence:0.4},{...answer,confidence:NaN},{...answer,answer:"Invented content"},
    {...answer,extra:"unreviewed field"},{...answer,answer:"x".repeat(3001)},{...answer,route:"inspect"}])
    assert.equal(validateIntakeDecision(bad),null);
  assert.ok(validateIntakeDecision({...answer,route:"inspect",question_kind:"current_model",identity_fields:[],read_evidence:"model_content",requested_effect:"read",basis:"needs_tools",answer:null,entire_request_answered:false}));
  for (const requested_effect of ["none","change"]) assert.equal(validateIntakeDecision({...answer,route:"inspect",question_kind:"current_model",identity_fields:[],read_evidence:"not_applicable",requested_effect,basis:"needs_tools",answer:null,entire_request_answered:false}),null);
});

test("semantic answer is durable historical conversation and never repins a task; handoff preserves every clause",async()=>{
  process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),"operator-intake-test-"));
  __closeForTests();
  appendMessage("session",{role:"user",text:"Keep working on the duct reconstruction."});
  const pinned=getPinnedGoal("session");let calls=0;
  const interpreter={interpret:async(input:IntakeInput)=>{calls++;assert.equal(input.user_text,question);assert.doesNotMatch(JSON.stringify(input),/PRIVATE-PATH/);return{value:answer};}};
  const first=await routeConversation(body(),interpreter);
  assert.equal(first.route,"answer");assert.equal(first.history_saved,true);assert.equal(getPinnedGoal("session"),pinned);
  assert.equal(getConversationHistory("session").at(-1)?.text,expectedAnswer);
  assert.match(formatUiContextConversationHistory("session"),/not current Revit evidence or task completion/);
  __closeForTests();
  assert.equal((await routeConversation(body(),interpreter)).assistant_message,expectedAnswer);assert.equal(calls,1);
  await assert.rejects(routeConversation(body("Different question"),interpreter),/another question/);
  const mixed="Tell me which model is open, then rename the current view.";
  let original="";
  const handoff=await routeConversation(body(mixed,{message_id:"mixed"}),{interpret:async input=>{
    original=input.user_text;return{value:{...answer,route:"task",question_kind:"action",identity_fields:[],requested_effect:"change",basis:"needs_tools",answer:null,entire_request_answered:false}};
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

test("a timed-out UI read cannot produce a confident disconnected-model answer; verified empty and general answers still work",async()=>{
  process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),"operator-intake-unknown-"));__closeForTests();
  const disconnected={...answer,answer:"I cannot see an open model because Revit is unavailable."};
  try {
    for(const [index,observation] of [undefined,{ok:false},{ok:true,data:{}},{ok:true,data:{document:{}}}].entries()) {
      const result=await routeConversation(body(question,{message_id:`unknown-${index}`,ui_observation:observation}),{
        interpret:async input=>{assert.equal(input.ui_observation.state,"unknown");return{value:disconnected};}
      });
      assert.equal(result.route,"task");assert.equal(result.history_saved,false);
    }
    assert.equal(getConversationHistory("session").length,0,"Do not save fabricated connection facts");
    const empty=await routeConversation(body(question,{message_id:"empty",ui_observation:{ok:true,data:{document:null}}}),{
      interpret:async()=>({value:{...answer,identity_fields:["model_open_state"]}})
    });
    assert.equal(empty.route,"answer");
    const general=await routeConversation(body("What does VAV stand for?",{message_id:"general",ui_observation:{ok:false}}),{
      interpret:async()=>({value:{...answer,answer:"Variable air volume.",basis:"general_knowledge",question_kind:"general_explanation",identity_fields:[]}})
    });
    assert.equal(general.route,"answer");
  }finally{__closeForTests();}
});
