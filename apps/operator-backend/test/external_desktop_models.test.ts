import assert from "node:assert/strict";
import { test } from "node:test";
import { availableExternalDesktopModels, externalDesktopPayload, externalDesktopProvider, requestExternalDesktopModel } from "../src/external_desktop_models.js";

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

test("Claude gets a nested schema for root combinators and the host gets exact original arguments", async (t) => {
  const schema = {
    type: "object", properties: { view_name: { type: "string" }, view_id: { type: "integer" } },
    anyOf: [{ required: ["view_name"] }, { required: ["view_id"] }], additionalProperties: false
  };
  const tools = [{ ...functions[0], parameters: schema }];
  const originalArguments = { view_name: "Test view" };
  const nativePart = { type: "tool_use", id: "toolu_view", name: "read_view", input: { arguments: originalArguments } };
  let replyInput: unknown = nativePart.input;
  let sent: any;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return Response.json({
      model: "claude-opus-5-5", id: "msg_test", stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 12 },
      content: [{ ...nativePart, input: replyInput }]
    });
  });
  const variable = "OPERATOR_ANTHROPIC_API_KEY";
  const old = process.env[variable];
  process.env[variable] = "synthetic-credential";
  t.after(() => { if (old === undefined) delete process.env[variable]; else process.env[variable] = old; });
  const send = () => requestExternalDesktopModel("anthropic", "claude-opus-5-5", "medium", "instruction", tools, [ask]);
  const response = await send();
  assert.deepEqual(sent.tools[0].input_schema, {
    type: "object", properties: { arguments: schema }, required: ["arguments"], additionalProperties: false
  });
  const call = response.output[0];
  assert.equal(call.arguments, JSON.stringify(originalArguments));
  assert.deepEqual(call.provider_part, nativePart);
  const next = externalDesktopPayload("anthropic", "claude-opus-5-5", "medium", "instruction", tools,
    [ask, call, { type: "function_call_output", call_id: nativePart.id, output: "Matched" }]);
  assert.deepEqual(next.messages[1].content, [nativePart]);
  assert.deepEqual(externalDesktopPayload("gemini", "gemini-4-neon", "medium", "instruction", tools, [ask])
    .tools[0].functionDeclarations[0].parametersJsonSchema, schema);
  replyInput = originalArguments;
  await assert.rejects(send, /external_model_unusable_response/);
  replyInput = { arguments: originalArguments, unrelated: true };
  await assert.rejects(send, /external_model_unusable_response/);
});
