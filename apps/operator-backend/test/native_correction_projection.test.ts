import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {storeEvidence,retrieveEvidence} from '../src/evidence/evidence_store.js';
import {modelEvidenceEnvelope} from '../src/evidence/model_context_budget.js';
import {adaptMcpToolCallResultToDynamicResponse} from '../src/brains/codex_dynamic_result_adapter.js';
import {boundDesktopNativeOutput} from '../src/assignments/desktop_native_output.js';
import {projectNativeCorrectionTargets,reduceNativeCorrectionPage} from '../src/evidence/native_correction_projection.js';

const scope={session_id:'correction',assignment_id:'assignment',run_id:'run',attempt_id:'attempt',generation:1};
test('batch-reduced correction page resumes at the first omitted native row with gaps and missing fields intact',()=>{
 const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'correction-repage-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const payload=fixture();payload.result[0]!.boundingBox=null as any;payload.result[0]!.location=null as any;
  const saved=storeEvidence({scope,source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:payload},8192);
  const original=JSON.stringify(saved.projection),next=reduceNativeCorrectionPage(saved.projection);
  assert(next);const v=next.inline_payload;
  assert.equal(v.rows[0].row_index,1);assert(v.rows[0].missing_fields.includes('typeId'));
  const page=retrieveEvidence({scope,evidence_id:saved.ref.evidence_id,purpose:'Continue correction readback',max_bytes:6000,
   item_range:{path:v.retrieval.path,start:v.retrieval.next_start,count:2,fields:v.retrieval.fields}});
  assert.deepEqual((page.selection as any[])[0].values.location,payload.result[v.retrieval.next_start]!.location);
  assert.equal(JSON.stringify(saved.projection),original);assert.equal(page.complete,false);
  assert.equal(reduceNativeCorrectionPage({...next,inline_payload:{...v,rows:v.rows.slice(0,1),coverage:{...v.coverage,returned_rows:1}}}),null);
 }finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(root,{recursive:true,force:true});}
});
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
  assert.equal(inline.rows[0].row_index,0);assert.equal(inline.retrieval.path,'result');assert.equal(inline.coverage.source_rows,80);
  assert.equal(inline.coverage.complete,false);assert.equal(inline.task_verified,false);assert.equal(saved.projection.truncated,true);
  assert.deepEqual(inline.spatial_extent,{scope:'navigation_only',source_rows:80,min:[0,0,0],max:[80,1,0]});
  assert.deepEqual(reduceNativeCorrectionPage(saved.projection)?.inline_payload.spatial_extent,inline.spatial_extent);
  const response=adaptMcpToolCallResultToDynamicResponse({content:[{type:'text',text:'retained native result'}]},
   {tool:'revit_call_tool',arguments:{path:'/revit/get-element-summary'},projections:[saved.projection],omitted:0});
  const delivered=boundDesktopNativeOutput(response,scope,'current-read');
  const wire=JSON.stringify(delivered.contentItems);assert(wire.includes('native-uid-0'));assert(wire.includes('requested_element_ids_only'));
  assert(wire.includes('spatial_extent'),'complete navigation bounds survive the model-visible output adapter');
  const next=retrieveEvidence({scope,evidence_id:saved.ref.evidence_id,purpose:'Inspect next correction targets',max_bytes:6000,
   item_range:{path:inline.retrieval.path,start:inline.retrieval.next_start,count:2,fields:inline.retrieval.fields}});
  assert.equal(next.complete,false);assert.equal(next.pagination?.returned_count,2);
  assert.deepEqual((next.selection as any[])[0].values.location,payload.result[inline.retrieval.next_start]!.location);
  assert.equal(JSON.stringify(payload),before);assert.equal(saved.projection.content_hash,saved.ref.content_hash);
 }finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(root,{recursive:true,force:true});}
});

test('navigation extent abstains on any unresolved target and reducer rejects malformed extents',()=>{
 const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'correction-extent-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const payload=fixture(),saved=storeEvidence({scope,source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:payload},8192);
  for(const patch of [{found:false},{uniqueId:''},{boundingBox:null,location:null},{boundingBox:{min:{x:3,y:0,z:0},max:{x:2,y:1,z:0}}},{boundingBox:{min:{x:NaN,y:0,z:0},max:{x:2,y:1,z:0}}}]){
   const changed=fixture();Object.assign(changed.result[79]!,patch);
   assert.equal((projectNativeCorrectionTargets(saved.ref,changed,8192) as any)?.spatial_extent,undefined);
  }
  const v:any=saved.projection.inline_payload;
  for(const patch of [{source_rows:79},{scope:'verified'},{min:[1,2]},{max:[-1,0,0]},{min:[NaN,0,0]},{extra:true}])
   assert.equal(reduceNativeCorrectionPage({...saved.projection,inline_payload:{...v,spatial_extent:{...v.spatial_extent,...patch}}}),null);
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
