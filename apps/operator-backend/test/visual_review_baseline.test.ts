import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {handleEvidenceHttpRoute} from '../src/evidence/evidence_http_routes.js';

test('host baseline HTTP reads canonical scoped before pixels, excludes prior verdict/history, and rejects foreign or failed evidence',async()=>{
 const prior=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'review-baseline-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 const server=http.createServer(async(req,res)=>{if(!await handleEvidenceHttpRoute(req,res,new URL(req.url||'/','http://localhost'))){res.statusCode=404;res.end();}});
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');
  const scope={session_id:'session',assignment_id:'assignment',run_id:'run',generation:1};
  // Larger than generic model image retrieval limit: this host-only retrieval
  // does not enlarge the model-evidence envelope or generic retrieval budget.
  const pixels=Buffer.alloc(1_100_000,42),image=storeEvidence({scope,source:'operator_desktop.native_target_view_review',trust_level:'untrusted_caller',media_type:'image/png',raw:pixels},8192);
  const raw={schema:'operator.visual_work_review.v1',ok:true,state:'mismatch',authority:'supporting_visual_assessment',native_postcondition_verified:false,whole_task_verified:false,owner:scope,request:{view_id:41,checks:[{id:'layout',expected:'Preserve rows.'}]},location:{view_id:41},capture:{evidence_id:image.ref.evidence_id,content_hash:image.ref.content_hash},reference:null,capture_resolution:{effective_width:5739},checks:[{id:'layout',status:'mismatch',observed:'Previous verdict must not prime reviewer.'}],raw_review_evidence:{reviewer_response:{output_text:'Prior confidence'},drafting_history:'Never send'}};
  const evidence=storeEvidence({scope,source:'operator_desktop.function.review_current_work',trust_level:'untrusted_caller',raw},8192);
  const read=async(body:unknown)=>fetch(`http://127.0.0.1:${address.port}/evidence/visual-review-baseline`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const body={scope,evidence_id:evidence.ref.evidence_id,content_hash:evidence.ref.content_hash},response=await read(body);assert.equal(response.status,200);
  const result=(await response.json() as any).result;assert.equal(result.capture.image_url,'data:image/png;base64,'+pixels.toString('base64'));assert.deepEqual(result.review.request,raw.request);assert.deepEqual(result.review.capture_resolution,raw.capture_resolution);assert.equal(result.review.checks,undefined);assert.equal(result.review.raw_review_evidence,undefined);assert.equal(result.review.native_postcondition_verified,false);
  for(const invalid of [{...body,scope:{...scope,session_id:'foreign'}},{...body,scope:{...scope,generation:2}},{...body,scope:{session_id:'session'}},{...body,content_hash:'sha256:'+'0'.repeat(64)}])assert.equal((await read(invalid)).status,400);
  for(const modify of [(r:any)=>{r.ok=false;r.state='unavailable';},(r:any)=>{r.capture.content_hash='sha256:'+'0'.repeat(64);},(r:any)=>{r.native_postcondition_verified=true;}]){const altered=structuredClone(raw);modify(altered);const saved=storeEvidence({scope,source:'operator_desktop.function.review_current_work',trust_level:'untrusted_caller',raw:altered},8192);assert.equal((await read({...body,evidence_id:saved.ref.evidence_id,content_hash:saved.ref.content_hash})).status,400);}
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;fs.rmSync(root,{recursive:true,force:true});}
});
