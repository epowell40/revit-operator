import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { handleConversationIntakeHttp } from "../src/conversation_intake_http.js";
import { __closeForTests, getConversationHistory } from "../src/memory/sqlite_store.js";

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
});
