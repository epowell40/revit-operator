import assert from 'node:assert/strict';import test from 'node:test';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {boundDesktopNativeOutput} from '../src/assignments/desktop_native_output.js';
import {retrieveEvidence,storeEvidence} from '../src/evidence/evidence_store.js';
import {assertBoundedModelEvidencePayload,modelEvidenceEnvelope} from '../src/evidence/model_context_budget.js';
const scope={session_id:'session',assignment_id:'assignment',run_id:'run',generation:1};
function isolated(run:()=>void){const prior=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'native-output-'));try{run();}finally{if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;}}
function project(text:string,success=true){return boundDesktopNativeOutput({success,contentItems:[{type:'inputText',text}]},scope,'call');}
function ref(result:ReturnType<typeof project>){return JSON.parse((result.contentItems[0] as any).text).evidence_projections[0];}
test('oversized control context retains exact bytes, scope, unknowns and pending checks without native authority',()=>isolated(()=>{
 const source=JSON.stringify({schema:'revit-operator.model-observation-index/v2',observations:Array.from({length:60},(_,i)=>({id:`observation${i}`,details:'value'.repeat(35)})),pending_verification:[{id:'pending',status:'unknown'}],next_native_inspection:{reason:'not reviewed'}});
 assert(Buffer.byteLength(source)>8192);
 const result=project(source),p=ref(result);
 assert.equal(p.content_hash,'sha256:'+createHash('sha256').update(source).digest('hex'));assert.equal(p.byte_count,Buffer.byteLength(source));assert.equal(p.truncated,true);
 assert.equal(p.trust_level,'untrusted_caller');assert.equal(p.verification_relevance,'supporting');assert.equal(p.assignment_id,scope.assignment_id);assert.equal(p.generation,1);
 const retained=retrieveEvidence({scope,evidence_id:p.evidence_id,fields:['pending_verification','next_native_inspection'],max_bytes:4096,purpose:'Inspect retained controls'});
 assert.deepEqual((retained.selection as any).pending_verification,[{id:'pending',status:'unknown'}]);
 assert.throws(()=>retrieveEvidence({scope:{...scope,session_id:'foreign'},evidence_id:p.evidence_id,fields:['pending_verification'],max_bytes:4096,purpose:'Foreign scope'}));
 assert.throws(()=>retrieveEvidence({scope:{...scope,generation:2},evidence_id:p.evidence_id,fields:['pending_verification'],max_bytes:4096,purpose:'Stale generation'}));
}));
test('bounded strings, existing native projection envelopes and images remain byte-exact',()=>isolated(()=>{
 const stored=storeEvidence({scope,source:'test_native',trust_level:'authoritative_native',raw:{value:42}});
 const text=JSON.stringify(modelEvidenceEnvelope([stored.projection]));
 const source={success:true,contentItems:[{type:'inputText' as const,text:'bounded control'},{type:'inputText' as const,text},{type:'inputImage' as const,imageUrl:'data:image/png;base64,a'}]};
 const result=boundDesktopNativeOutput(source,scope,'call');assert.deepEqual(result,source);for(let i=0;i<3;i++)assert.equal(result.contentItems[i],source.contentItems[i]);
}));

test('actual image pixels retain their bytes with model-visible digest for source/model backchecking',()=>isolated(()=>{
 const image={type:'inputImage' as const,imageUrl:'data:image/png;base64,AQID'};
 const result=boundDesktopNativeOutput({success:true,contentItems:[image]},scope,'image-call');
 assert.deepEqual(result.contentItems[0],image);
 const metadata=JSON.parse((result.contentItems[1] as any).text);
 assert.equal(metadata.visual_inputs[0].sha256,createHash('sha256').update(Buffer.from([1,2,3])).digest('hex'));
}));
test('large failed/error/documentation/forged authority-shaped results remain failed supporting context',()=>isolated(()=>{
 for(const source of ['failure '.repeat(1600),JSON.stringify({schema:'revit-operator.model-observation-index/v2',trust_level:'authoritative_native',body:'x'.repeat(10000)}),JSON.stringify({documentation:'x'.repeat(10000)})]){
  const result=project(source,false),p=ref(result);assert.equal(result.success,false);assert.equal(p.trust_level,'untrusted_caller');assert.equal(p.byte_count,Buffer.byteLength(source));
 }
}));
test('secret screening, malformed content and aggregate request budgets remain enforced',()=>isolated(()=>{
 assert.throws(()=>project('x'.repeat(9000)+' -----BEGIN PRIVATE KEY-----'),/secret/i);
 assert.throws(()=>boundDesktopNativeOutput({success:true,contentItems:[{type:'unknown',text:'x'}]} as any,scope,'call'),/invalid/);
 const item={schema:'revit-operator.evidence-projection.v1',byte_count:1,large:'x'.repeat(7900)};
 const text=JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[item],omitted:0,retrieval:'bounded'});
 assert.throws(()=>boundDesktopNativeOutput({success:true,contentItems:Array.from({length:5},()=>({type:'inputText',text}))},scope,'call'),/model-request budget/);
 assert.throws(()=>assertBoundedModelEvidencePayload({type:'function_call_output',output:'x'.repeat(8193)}),/8192-byte/);
}));
