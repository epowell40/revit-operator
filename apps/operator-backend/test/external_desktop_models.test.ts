import assert from "node:assert/strict";
import { test } from "node:test";
import { availableExternalDesktopModels, externalDesktopPayload, externalDesktopProvider } from "../src/external_desktop_models.js";

const functions = [{type:"function",name:"read_view",description:"Read a view",parameters:{type:"object"}}];
const originalText = {type:"input_text",text:"Current view"};
const image = {type:"input_image",image_url:"data:image/png;base64,AAE="};
const ask = {role:"user",content:[originalText,image]};
const feedback = {role:"user",content:[{type:"input_text",text:"Current host evidence"}]};

test("alternate models are explicit and require an authenticated local context", () => {
  assert.equal(externalDesktopProvider("gemini-4-neon"),"gemini");
  assert.equal(externalDesktopProvider("gemini-4-carbon"),"gemini");
  assert.equal(externalDesktopProvider("claude-opus-5-5"),"anthropic");
  assert.equal(externalDesktopProvider("gemini-latest"),undefined);
  assert.deepEqual(availableExternalDesktopModels(),[]);
});

test("Gemini receives literal signed tool call, result and image in order", () => {
  const signedCall = {functionCall:{name:"read_view",args:{}},thoughtSignature:"example-opaque-signature"};
  const history = [ask,{type:"function_call",call_id:"callA",name:"read_view",provider_transport:"gemini",provider_part:signedCall},
    feedback,{type:"function_call_output",call_id:"callA",output:[originalText,image]}];
  const payload = externalDesktopPayload("gemini","gemini-4-neon","medium","instruction",functions,history);
  assert.deepEqual(payload.contents[1],{role:"model",parts:[signedCall]});
  assert.deepEqual(payload.contents[2],{role:"user",parts:[
    {functionResponse:{name:"read_view",response:{output:"Current view"},parts:[{inlineData:{mimeType:"image/png",data:"AAE="}}]}},
    {text:"Current host evidence"}
  ]});
  assert.equal(payload.generationConfig.thinkingConfig.thinkingLevel,"MEDIUM");
});

test("Claude preserves signed assistant blocks and puts tool results first", () => {
  const thinking = {type:"thinking",thinking:"",signature:"example-opaque-signature"};
  const use = {type:"tool_use",id:"toolu_example",name:"read_view",input:{}};
  const history = [ask, {type:"reasoning",provider_transport:"anthropic",provider_part:thinking},
    {type:"function_call",call_id:use.id,name:use.name,provider_transport:"anthropic",provider_part:use},
    feedback,{type:"function_call_output",call_id:use.id,output:[originalText,image]}];
  const payload = externalDesktopPayload("anthropic","claude-opus-5-5","medium","instruction",functions,history);
  assert.deepEqual(payload.messages[1],{role:"assistant",content:[thinking,use]});
  assert.deepEqual(payload.messages[2],{role:"user",content:[
    {type:"tool_result",tool_use_id:use.id,content:[{type:"text",text:"Current view"},
      {type:"image",source:{type:"base64",media_type:"image/png",data:"AAE="}}]},
    {type:"text",text:"Current host evidence"}
  ]});
  assert.deepEqual(payload.thinking,{type:"adaptive",display:"omitted"});
});

test("tool boundaries, cross-provider replay, and unresolved file identities fail closed", () => {
  const send = (rows:unknown[]) => externalDesktopPayload("gemini","gemini-4-carbon","medium","instruction",functions,rows);
  assert.throws(() => send([ask,{type:"function_call_output",call_id:"forged",output:""}]),/without_call/);
  assert.throws(() => send([ask,{type:"reasoning",provider_transport:"anthropic",provider_part:{}}]),/foreign_history/);
  assert.throws(() => send([{role:"user",content:[{type:"input_image",file_id:"remote"}]}]),/embedded_media_required/);
});
