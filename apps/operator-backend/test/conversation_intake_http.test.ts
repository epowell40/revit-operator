import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { handleConversationIntakeHttp } from "../src/conversation_intake_http.js";
import { __closeForTests, getConversationHistory } from "../src/memory/sqlite_store.js";
import { conversationWorkProfile } from "../src/brains/conversation_work_profile.js";

test("HTTP intake authorizes before model use, uses full text, persists the answer and falls back for attachments",async t=>{
  process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),"operator-intake-http-"));__closeForTests();
  let calls=0;const seen:string[]=[];
  const server=http.createServer((req,res)=>void handleConversationIntakeHttp(req,res,{
    readJson:async request=>{let raw="";for await(const chunk of request)raw+=chunk;return JSON.parse(raw);},
    authorized:session=>{if(session!=="owned"){res.writeHead(403).end();return false;}return true;},
    respond:(status,body)=>res.writeHead(status,{"content-type":"application/json"}).end(JSON.stringify(body)),
    interpreter:{interpret:async input=>{calls++;seen.push(input.user_text);return {value:{route:"answer",answer:"The open model is Snowdon HVAC.",
      basis:"ui_identity",requested_effect:"none",entire_request_answered:true,confidence:0.99,reason:"Supplied UI identity."}};}}
  })).listen(0,"127.0.0.1");await once(server,"listening");
  t.after(()=>{server.close();__closeForTests();});
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const prompt="Can you see the open model? Please tell me its name and active view.";
  const post=(extra={})=>fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({version:"operator.backend.v1",
    session_id:"owned",message_id:"one",user_text:prompt,ui_observation:{ok:true,data:{document:{title:"Snowdon HVAC"}}},...extra})});
  assert.equal((await post({session_id:"foreign"})).status,403);assert.equal(calls,0);
  const answer=await(await post()).json() as any;assert.equal(answer.route,"answer");assert.deepEqual(seen,[prompt]);
  assert.equal(getConversationHistory("owned").length,2);
  const redline=await(await post({message_id:"two",attachments:[{id:"redline"}]})).json() as any;
  assert.equal(redline.route,"task");assert.equal(calls,1);
  assert.equal((await post({user_text:"Reuse the message id for a different question"})).status,400);assert.equal(calls,1);
  const unknown=await(await post({message_id:"unknown",ui_observation:{ok:false}})).json() as any;
  assert.equal(unknown.route,"task");assert.equal(unknown.history_saved,false);
  assert.equal(getConversationHistory("owned").length,2,"A model's confident UI claim cannot turn a missing HTTP observation into an answer");
});

test("HTTP classification persists an exact-message speed profile; foreign and mixed work cannot borrow it",async t=>{
  process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),"operator-profile-http-"));__closeForTests();
  const server=http.createServer((req,res)=>void handleConversationIntakeHttp(req,res,{
    readJson:async request=>{let raw="";for await(const chunk of request)raw+=chunk;return JSON.parse(raw);},
    authorized:session=>{if(session!=="owned"){res.writeHead(403).end();return false;}return true;},
    respond:(status,body)=>res.writeHead(status,{"content-type":"application/json"}).end(JSON.stringify(body)),
    interpreter:{interpret:async()=>({value:{route:"inspect",answer:null,basis:"needs_tools",requested_effect:"read",entire_request_answered:false,confidence:0.99,reason:"Bounded read."}})}
  })).listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>{server.close();__closeForTests();});
  const request:any={version:"operator.backend.v1",session_id:"owned",message_id:"new-question",user_text:"What systems are represented?",
    context:{ui:{speed_settings:{speed_mode:true,agent_reasoning_effort:"medium"}}}};
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const post=(body:any)=>fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await post({...request,session_id:"foreign"})).status,403);
  assert.equal(conversationWorkProfile(request).focused,false);
  assert.equal((await(await post(request)).json() as any).route,"inspect");
  assert.equal(conversationWorkProfile(request).settings.reasoning_effort,"low");
  assert.equal(conversationWorkProfile({...request,user_text:request.user_text+" Change them."}).focused,false);
});
