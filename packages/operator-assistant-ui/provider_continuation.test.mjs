import test from 'node:test';
import assert from 'node:assert/strict';
import {providerContinuationInput,providerCompletedToolOutputs,COMPACTED_VISUAL_CONTINUATION} from './provider_continuation.mjs';
const binding={assignment_id:'a',session_id:'s',run_id:'r',generation:1};
const profile={model:'gpt-6.1-terra',reasoning_effort:'medium'};
const saved={status:'ready',binding,previous_response_id:'response',input:[{type:'function_call_output',call_id:'last',output:'saved partial'}],...profile};
const input=[{role:'assistant',content:'old bounded history'},{role:'user',content:[{type:'input_text',text:'Continue'},{type:'input_image',image_url:'retained-source'}]}];

test('saved-task follow-up is not lost behind the composer automatic Resume message',()=>{
 const direction='Change only the middle note to COORDINATE WITH STRUCTURAL. Keep the other two notes, their positions, and the border unchanged. Do not save yet.';
 const restored=[
  {role:'assistant',content:'SAVED TASK CONTEXT. Historical reports are not current proof. Current input: '+direction},
  {role:'user',content:'Create three notes and a border.'},
  {role:'assistant',content:'Created three notes including COORDINATE WITH ARCHITECT.'},
  {role:'user',content:direction},
  {role:'user',content:[{type:'input_text',text:'Continue the existing task using its saved answers and evidence.'},{type:'input_image',image_url:'fresh-current-screen'}]}
 ];
 const result=providerContinuationInput(saved,binding,restored,profile);
 assert.equal(result.previous_response_id,'response');
 assert.ok(result.input.some(item=>item===restored[3]),'the actual latest instruction must reach the provider');
 assert.ok(result.input.some(item=>item===restored[0]),'current restored state must supplement older provider memory');
 assert.equal(result.input.filter(i=>i.type==='function_call_output').length,1);
 assert.equal(result.input.filter(i=>i.content?.some?.(c=>c.type==='input_image')).length,1);
 assert.deepEqual(restored.at(-1).content[1],{type:'input_image',image_url:'fresh-current-screen'});
});

test('compaction alone does not require recapture; actual missing/changed/recovered pixels still do',()=>{
 assert.match(COMPACTED_VISUAL_CONTINUATION,/Compaction alone does not require another capture/);
 assert.match(COMPACTED_VISUAL_CONTINUATION,/existing image-delivery, scope and native-currentness checks/);
 assert.match(COMPACTED_VISUAL_CONTINUATION,/pixels are missing, the model changed, or this is recovery/);
 assert.match(COMPACTED_VISUAL_CONTINUATION,/Never infer precise image details from opaque compacted memory/);
});
test('one owner resumes exact result before the bounded current context and fresh attachments',()=>{
 assert.deepEqual(providerContinuationInput(saved,binding,input,profile),{previous_response_id:'response',input:[...saved.input,...input]});
});
test('legacy context or intentional model change uses saved task context with requested profile unchanged',()=>{
 assert.deepEqual(providerContinuationInput({status:'unavailable'},binding,input,profile),{input});
 assert.deepEqual(providerContinuationInput(saved,binding,input,{...profile,model:'different'}),{input});
});
test('foreign malformed or incomplete provider checkpoint cannot resume',()=>{
 for(const patch of [{status:'pending'},{binding:{...binding,generation:2}},{previous_response_id:''},{input:[{type:'function_call'}]}])
  assert.throws(()=>providerContinuationInput({...saved,...patch},binding,input,profile));
 assert.throws(()=>providerContinuationInput(saved,binding,[],profile));
});
test('persist only actual tool outputs, never reclassify user feedback as a tool response',()=>{
 assert.deepEqual(providerCompletedToolOutputs([...saved.input,{role:'user',content:'feedback'}]),saved.input);
});
