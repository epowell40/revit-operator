import test from 'node:test';import assert from 'node:assert/strict';
import {invokeDesktopNativeTool} from './desktop_native_tools.mjs';
const assignment={kernel_version:2,session_id:'session',goal_id:'assignment',run_id:'run',generation:1};
const execution={evidence_id:'ev1_'+'A'.repeat(32),content_hash:'sha256:'+'a'.repeat(64),source:'assignment_kernel_v2:operator_run_dynamic_revit_program',trust_level:'authoritative_native',effect_state:'applied',assignment_id:'assignment',run_id:'run',generation:1,attempt_id:'opv2_'+'b'.repeat(64)};
const readback={...execution,evidence_id:'ev1_'+'B'.repeat(32),source:'assignment_kernel_v2:revit_call_tool',effect_state:null};
const hint=o=>o.native_model_output.output.filter(b=>b.type==='input_text').map(b=>{try{return JSON.parse(b.text);}catch{return null;}}).find(v=>v?.schema==='operator.code-review-selector.v1');
async function fixture(mutate=()=>{}){
 const f={call:{name:'native__operator_run_dynamic_revit_program',call_id:'call_write',arguments:JSON.stringify({mode:'apply',source:'public class Task {}',native_program:{}})},
 result:{schema:'operator.desktop-native-result.v1',stop_reason:null,result:{success:true,contentItems:[]}},refs:[structuredClone(execution),structuredClone(readback)]};
 mutate(f);f.result.result.contentItems.push({type:'inputText',text:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:f.refs})});
 const raw=JSON.stringify(f.result),out=await invokeDesktopNativeTool({assignment,messageId:'m',responseId:'r',context:{},call:f.call,request:async()=>f.result});
 assert.equal(JSON.stringify(f.result),raw);assert.deepEqual(JSON.parse(out.output).content,f.result.result.contentItems);return out;
}
test('code review selector distinguishes executed program from its automatic native readback',async()=>{
 const h=hint(await fixture());assert.deepEqual(h?.code_evidence_ids,[execution.evidence_id]);
 assert.equal(h.native_postcondition_verified,false);assert.equal(h.whole_task_verified,false);
 assert.match(h.usage,/automatic.*readback/i);assert.match(h.usage,/combined/i);
});
test('same lookup is available for invoke and explicit read programs without claiming verification',async()=>{
 for(const wrapped of [false,true]){const h=hint(await fixture(f=>{f.refs[0].effect_state='none';const args={mode:'read',source:'public class Read {}',native_program:{}};f.call.name=wrapped?'native__invoke':'native__operator_run_dynamic_revit_program';f.call.arguments=JSON.stringify(wrapped?{tool:'operator_run_dynamic_revit_program',arguments:args}:args);}));assert.deepEqual(h.code_evidence_ids,[execution.evidence_id]);}
});
for(const variant of ['failed','paused','foreign','wrong_source','untrusted','unknown','bad_hash','bad_id','ambiguous','wrong_tool','bad_arguments'])test('selector omitted for '+variant,async()=>{
 const out=await fixture(f=>{const p=f.refs[0];if(variant==='failed')f.result.result.success=false;if(variant==='paused')f.result.stop_reason='paused';if(variant==='foreign')p.run_id='other';if(variant==='wrong_source')p.source='assignment_kernel_v2:revit_call_tool';if(variant==='untrusted')p.trust_level='caller';if(variant==='unknown')p.effect_state='unknown';if(variant==='bad_hash')p.content_hash='not-a-digest';if(variant==='bad_id')p.evidence_id='guess';if(variant==='ambiguous')f.refs.push({...p});if(variant==='wrong_tool')f.call.name='native__revit_call_tool';if(variant==='bad_arguments')f.call.arguments='{';});assert.equal(hint(out),undefined);
});
