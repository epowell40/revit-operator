import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import * as intake from "../src/brains/conversation_intake_model.js";
import { INTAKE_SCHEMA, intakeDecisionIssues } from "../src/conversation_intake.js";

const source='Move the "Project Location:" heading right. Preserve all other content. Save as "C:\\Review\\Result.rvt". Before changing equipment, ask for approval.';
const candidate=(quotes:string[])=>({route:"task",answer:null,basis:"needs_tools",requested_effect:"change",entire_request_answered:false,confidence:0.99,reason:"Requested edit and explicit prerequisite.",question_kind:"action",identity_fields:[],read_evidence:"not_applicable",operation_scope:{schema:"revit-operator.interpreted-operation-scope/v1",requested_effect:"apply",model_effect:"apply",protected_clauses:[quotes[1]],prerequisites:[{variable_id:"equipment_approval",kind:"approval",question:"Approve equipment change?",source_quote:quotes[3]}]}});

test("quoted text and Windows paths never enter provider enum literals; original source remains exact",()=>{
  const prepared=intake.conversationIntakeQuoteSchema({user_text:source});
  const enums=(prepared.schema.properties.operation_scope.anyOf[0] as any).properties.protected_clauses.items.enum;
  assert(enums.every((v:string)=>/^source_quote_[a-f0-9]{64}_\d+$/.test(v)));
  assert(!JSON.stringify(prepared.schema).includes("Project Location"));
  assert.equal(JSON.stringify(INTAKE_SCHEMA).includes("source_quote_"),false);
});

test("bounded Unicode catalogs retain all exact source choices through provider encoding",()=>{
  for(const text of [source, 'Keep "quoted" text.\r\nPreserve C:\\Review\\. 😀 保留原文。', '😀'.repeat(900), Array.from({length:180},(_,i)=>`Keep item ${i}.`).join(' ')]){
    const prepared=intake.conversationIntakeQuoteSchema({user_text:text});
    const choices=intake.conversationIntakeSourceQuotes(text);
    assert.deepEqual(prepared.sourceQuotes.map(row=>row.text),choices);
    assert(prepared.sourceQuotes.length<=128);
    const value={operation_scope:{protected_clauses:prepared.sourceQuotes.map(row=>row.id),prerequisites:[]}};
    assert.deepEqual(intake.resolveConversationIntakeSourceQuotes(value,{user_text:text}),{operation_scope:{protected_clauses:choices,prerequisites:[]}});
  }
});

test("Responses boundary sends unchanged source plus choices and decodes exact protection and prerequisite",{concurrency:false},async()=>{
  const keys=["OPERATOR_BRAIN","OPERATOR_OPENAI_API_KEY","OPERATOR_OPENAI_BASE_URL","OPERATOR_OPENAI_MODEL","OPERATOR_INTAKE_MODEL","OPERATOR_INTAKE_REASONING_EFFORT"];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const requests:any[]=[];
  const server=http.createServer((request,response)=>{
    const chunks:Buffer[]=[];request.on("data",chunk=>chunks.push(Buffer.from(chunk)));request.on("end",()=>{
      const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));requests.push(body);
      const data=JSON.parse(body.input),wire=candidate(data.source_quote_choices.map((row:any)=>row.id));
      response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({id:"test",object:"response",status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify(wire),annotations:[]}]}]}));
    });
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();assert(address&&typeof address==="object");
  const interpreter=new intake.ModelConversationIntake();
  try{
    process.env.OPERATOR_BRAIN="openai";process.env.OPERATOR_OPENAI_API_KEY="synthetic-test";process.env.OPERATOR_OPENAI_BASE_URL=`http://127.0.0.1:${address.port}`;
    process.env.OPERATOR_OPENAI_MODEL="gpt-6.1-sol";delete process.env.OPERATOR_INTAKE_MODEL;delete process.env.OPERATOR_INTAKE_REASONING_EFFORT;
    const input={user_text:source,recent_conversation:[],ui_observation:{state:"unknown" as const}};
    const result=await interpreter.interpret(input,new AbortController().signal);
    assert.deepEqual(result.value,candidate(intake.conversationIntakeSourceQuotes(source)));
    assert.equal(JSON.parse(requests[0].input).user_text,source);
    assert.equal(requests[0].tools,undefined);assert.equal(requests[0].text.format.strict,true);
    assert.match(requests[0].instructions,/return the id/);
    assert.equal((result.telemetry.source_quote_catalog as any).encoding,"request_bound_ids.v1");
    assert.equal(requests.length,1);
  }finally{
    interpreter.close();for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

test("transport choices decode before unchanged scope validation and cannot cross requests",()=>{
  const decode=(intake as any).resolveConversationIntakeSourceQuotes;
  assert.equal(typeof decode,"function");
  const prepared=intake.conversationIntakeQuoteSchema({user_text:source}) as any;
  const ids=prepared.sourceQuotes.map((v:any)=>v.id), raw=candidate(ids), snapshot=JSON.stringify(raw);
  const decoded=decode(raw,{user_text:source});
  assert.deepEqual(decoded,candidate(intake.conversationIntakeSourceQuotes(source)));
  assert.deepEqual(intakeDecisionIssues(decoded,{user_text:source,recent_conversation:[],ui_observation:{state:"unknown"}}),[]);
  assert.equal(JSON.stringify(raw),snapshot);
  for(const invalid of ["source_quote_unknown", "Preserve all other content.", null, 0, {}, ids[1]+"x"]){
    const bad=structuredClone(raw) as any;bad.operation_scope.protected_clauses[0]=invalid;
    assert.throws(()=>decode(bad,{user_text:source}),/source quote/i);
  }
  assert.throws(()=>decode(raw,{user_text:source+" Preserve annotations."}),/source quote/i);
  const bad=structuredClone(raw);bad.operation_scope.prerequisites[0]!.source_quote="foreign";
  assert.throws(()=>decode(bad,{user_text:source}),/source quote/i);
  for(const value of [null,{}, {operation_scope:null}, {operation_scope:{protected_clauses:"malformed",prerequisites:null}}])
    assert.deepEqual(decode(value,{user_text:source}),value,"Malformed shapes remain for canonical validator rejection");
});
