import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root=["../packages/operator-assistant-ui","../../packages/operator-assistant-ui"].map(p=>path.resolve(p)).find(p=>fs.existsSync(path.join(p,"conversation_intake.mjs")))!;
const {tryConversationIntake}=await import(pathToFileURL(path.join(root,"conversation_intake.mjs")).href);

test("Sidecar delegates novel wording to the semantic agent with live labels instead of client metadata",async()=>{
  const seen:string[]=[];let authorizations=0,reads=0;
  for(const prompt of ["Is this the mechanical model?","Can you see the open model? Please tell me its name and active view.","Which project did I leave open?"]){
    const result=await tryConversationIntake({user_text:prompt,session_id:"owned",message_id:prompt,context:{revit:{document:{title:"FORGED"}}}},
      {authorize:async()=>{authorizations++;},readContext:async()=>{reads++;return {ok:true,data:{document:{title:"Live HVAC"}}};},
        route:async(body:any)=>{seen.push(body.user_text);assert.equal(body.context,undefined);assert.equal(body.ui_observation.data.document.title,"Live HVAC");
          return {route:"answer",assistant_message:"Live HVAC is open.",history_saved:true};}});
    assert.equal(result.text,"Live HVAC is open.");
  }
  assert.equal(seen.length,3);assert.equal(reads,3);assert.equal(authorizations,3);
});

test("Sidecar never drops a mixed instruction and preserves auth, timeout, explicit task and failure boundaries",async()=>{
  const prompt="Tell me the model name, then rename the view.";const original={user_text:prompt,session_id:"owned",message_id:"one"};
  let reads=0;const progress:string[]=[];
  const deps={onHandoff:(text:string)=>progress.push(text),authorize:async()=>{},readContext:async()=>{reads++;return {ok:false};},route:async(body:any)=>{assert.equal(body.user_text,prompt);return {route:"task",assistant_message:null};}};
  assert.equal(await tryConversationIntake(original,deps),null);assert.deepEqual(original,{user_text:prompt,session_id:"owned",message_id:"one"});
  for(const extra of [{attachments:[{}]},{assignment_id:"task"},{assignment_generation:0},{tool_results:[{}]}])
    assert.equal(await tryConversationIntake({...original,...extra},deps),null);
  assert.equal(reads,1);
  assert.deepEqual(progress,["I’ll work through that."],"Only a real handoff emits its progress message");
  assert.equal(await tryConversationIntake(original,{...deps,route:async()=>({route:"inspect"})}),null);
  assert.equal(progress.at(-1),"Let me check.");
  await assert.rejects(tryConversationIntake(original,{...deps,authorize:async()=>{throw Error("Denied");}}),/Denied/);assert.equal(reads,2);
  let signal:AbortSignal|undefined;
  assert.equal(await tryConversationIntake(original,{...deps,observationTimeoutMs:10,readContext:async(s:AbortSignal)=>{signal=s;return new Promise(()=>{});}}),null);
  assert.equal(signal?.aborted,true);
  assert.equal(await tryConversationIntake(original,{...deps,route:async()=>{throw Error("Router unavailable");}}),null);
  assert.equal(await tryConversationIntake(original,{...deps,route:async()=>({route:"answer",assistant_message:"Unsaved",history_saved:false})}),null);
});
