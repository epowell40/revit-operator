import test from 'node:test';
import assert from 'node:assert/strict';
import {retainedBatch} from './model_evidence_correction_batch.fixtures.js';
import {prepareBoundedModelEvidenceInput as prepare,assertBoundedModelEvidencePayload as validate} from '../src/evidence/model_context_budget.js';
import {boundDesktopNativeOutput} from '../src/assignments/desktop_native_output.js';
const projections=(row:any):any[]=>row.output.flatMap((b:any)=>{try{return JSON.parse(b.text).evidence_projections??[]}catch{return []}});
const opaque=(row:any)=>row.output.filter((b:any)=>{try{return !JSON.parse(b.text).evidence_projections}catch{return true}});

test('retained three-write batch delivers checked targets without failing the model request',()=>{
 const input=structuredClone(retainedBatch),before=structuredClone(input);
 input.forEach(r=>validate(r));assert.throws(()=>validate(input),/32768-byte/);
 const out:any=prepare(input);assert(validate(out).projected_bytes<=32768);assert.deepEqual(input,before);
 assert.deepEqual(out.map((r:any)=>r.call_id),input.map(r=>r.call_id));let reduced=0;
 out.forEach((row:any,i:number)=>{
  assert.deepEqual(opaque(row),opaque(input[i]));
  const old=projections(input[i]),next=projections(row);assert.equal(next.length,old.length);
  next.forEach((p,j)=>{
   const a=old[j],v=p.inline_payload,w=a.inline_payload;
   if(w?.scope==='requested_element_ids_only'&&v.rows.length<w.rows.length){
    reduced++;assert(v.rows.length>=1);assert.deepEqual(v.rows,w.rows.slice(0,v.rows.length));
    assert.equal(v.retrieval.next_start,w.rows[v.rows.length].row_index);
    assert.equal(v.retrieval.evidence_id,a.evidence_id);assert.equal(v.coverage.returned_rows,v.rows.length);
    assert.equal(v.coverage.complete,false);assert.equal(v.coverage.source_rows_exhausted,false);
    assert.equal(v.coverage.source_rows,w.coverage.source_rows);assert.equal(v.coverage.spatial_rows,w.coverage.spatial_rows);
    assert.equal(v.native_postcondition_verified,false);assert.equal(v.task_verified,false);
    for(const k of Object.keys(a).filter(k=>!['inline_payload','truncated','additional_evidence'].includes(k)))assert.deepEqual(p[k],a[k],k);
   }else if(!a.source.startsWith('desktop_native_transport:'))assert.deepEqual(p,a,'write receipt and other native facts unchanged');
  });
 });assert(reduced>0);assert.strictEqual(prepare(out),out);
});

test('small correction responses remain byte-exact; producer and image consumer preserve delivered pixels',()=>{
 const small=structuredClone(retainedBatch.slice(0,1));assert.strictEqual(prepare(small),small);
 const scope={session_id:'fixture',assignment_id:'assignment',run_id:'run',generation:1};
 const input=structuredClone(retainedBatch).map(row=>{
  const result=boundDesktopNativeOutput({success:true,contentItems:row.output.map((b:any)=>({type:'inputText',text:b.text}))},scope,row.call_id);
  return {...row,output:result.contentItems.map((b:any)=>({type:'input_text',text:b.text}))};
 });input[0]!.output.push({type:'input_image',image_url:'data:image/png;base64,AAAA'} as any);
 const out:any=prepare(input);validate(out);assert.deepEqual(opaque(out[0]),opaque(input[0]));
});

test('foreign, malformed, unknown and claimed-complete corrections never gain compact presentation',()=>{
 for(const patch of ['source','trust','unknown','verified','coverage','row','retrieval','extra']){
  const input=structuredClone(retainedBatch);
  for(const row of input)for(const b of row.output){let e:any;try{e=JSON.parse(b.text)}catch{continue}
   for(const p of e.evidence_projections??[]){if(p.inline_payload?.scope!=='requested_element_ids_only')continue;
    const v=p.inline_payload;
    if(patch==='source')p.source='foreign';if(patch==='trust')p.trust_level='untrusted_caller';
    if(patch==='unknown')p.effect_state='unknown';if(patch==='verified')v.task_verified=true;
    if(patch==='coverage')v.coverage.returned_rows++;if(patch==='row')v.rows[1].row_index=v.rows[0].row_index;
    if(patch==='retrieval')v.retrieval.evidence_id='ev1_foreign';if(patch==='extra')v.pending_verification=['keep'];
   }b.text=JSON.stringify(e);
  }assert.throws(()=>prepare(input),/32768-byte/,patch);
 }
});
