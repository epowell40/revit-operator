import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {modelEvidenceEnvelope} from '../src/evidence/model_context_budget.js';
import {adaptMcpToolCallResultToDynamicResponse} from '../src/brains/codex_dynamic_result_adapter.js';
import {boundDesktopNativeOutput} from '../src/assignments/desktop_native_output.js';
import {projectNativeCorrectionTargets} from '../src/evidence/native_correction_projection.js';

const scope={session_id:'correction',assignment_id:'assignment',run_id:'run',attempt_id:'attempt',generation:1};
function fixture(){
 const result=Array.from({length:80},(_,i)=>({id:i+100,found:true,uniqueId:'native-uid-'+i,className:'DetailLine',category:'Lines',name:'Detail Lines',
  boundingBox:{min:{x:i,y:0,z:0},max:{x:i+1,y:1,z:0}},location:{type:'curve',curveType:'Line',p0:{x:i,y:0,z:0},p1:{x:i+1,y:1,z:0}},
  unrelatedParameters:'x'.repeat(1000)}));
 return {result,nativeProgramEffectState:{scope:'native_drafting_effect_state_v1',complete:true,requestedElementIds:result.map(r=>r.id),items:[]}};
}
test('native readback gives the owner usable identities and geometry with exact original-row retrieval',()=>{
 const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'native-correction-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const payload=fixture(),before=JSON.stringify(payload);
  const saved=storeEvidence({scope,source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:payload},8192);
  const inline:any=saved.projection.inline_payload;
  assert.equal(inline?.scope,'requested_element_ids_only');assert(inline.rows.length>0&&inline.rows.length<80);
  assert.equal(inline.rows[0].values.uniqueId,payload.result[0]!.uniqueId);assert.deepEqual(inline.rows[0].values.location,payload.result[0]!.location);
  assert.equal(inline.rows[0].row_index,0);assert.deepEqual(inline.retrieval.path,['result']);assert.equal(inline.coverage.source_rows,80);
  assert.equal(inline.coverage.complete,false);assert.equal(inline.task_verified,false);assert.equal(saved.projection.truncated,true);
  const response=adaptMcpToolCallResultToDynamicResponse({content:[{type:'text',text:'retained native result'}]},
   {tool:'revit_call_tool',arguments:{path:'/revit/get-element-summary'},projections:[saved.projection],omitted:0});
  const delivered=boundDesktopNativeOutput(response,scope,'current-read');
  const wire=JSON.stringify(delivered.contentItems);assert(wire.includes('native-uid-0'));assert(wire.includes('requested_element_ids_only'));
  assert.equal(JSON.stringify(payload),before);assert.equal(saved.projection.content_hash,saved.ref.content_hash);
 }finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(root,{recursive:true,force:true});}
});

test('correction table rejects foreign, untrusted and inconsistent target collections',()=>{
 const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'native-correction-guard-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const payload=fixture(),saved=storeEvidence({scope,source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:payload},8192);
  for(const patch of [{source:'other'},{trust_level:'untrusted_caller' as const},{trust_level:'host_observed' as const}])
   assert.equal(projectNativeCorrectionTargets({...saved.ref,...patch},payload,8192),null);
  const wrongIds=fixture();wrongIds.nativeProgramEffectState.requestedElementIds[0]=99999;
  assert.equal(projectNativeCorrectionTargets(saved.ref,wrongIds,8192),null);
  const duplicate=fixture();duplicate.result[1]!.id=duplicate.result[0]!.id;
  assert.equal(projectNativeCorrectionTargets(saved.ref,duplicate,8192),null);
  assert.equal(projectNativeCorrectionTargets(saved.ref,payload,100),null,'a tiny budget cannot produce misleading sliced geometry');
  const empty={result:[],nativeProgramEffectState:{scope:'native_drafting_effect_state_v1',requestedElementIds:[]}};
  assert.equal(projectNativeCorrectionTargets(saved.ref,empty,8192),null,'empty requested targets are not model absence proof');
 }finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(root,{recursive:true,force:true});}
});

test('correction table preserves original indices across nonspatial rows and leaves the input untouched',()=>{
 const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'native-correction-index-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const payload=fixture();payload.result[0]!.boundingBox=null as any;payload.result[0]!.location=null as any;
  const before=JSON.stringify(payload),saved=storeEvidence({scope,source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:payload},8192);
  const inline:any=saved.projection.inline_payload;assert.equal(inline.rows[0].row_index,1);assert.equal(inline.rows[0].values.uniqueId,'native-uid-1');
  assert(inline.retrieval.next_start>inline.rows.length);assert.equal(inline.coverage.spatial_rows,79);assert.equal(JSON.stringify(payload),before);
 }finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(root,{recursive:true,force:true});}
});
