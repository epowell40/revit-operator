import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {storeEvidence,retrieveEvidence,readAuthoritativeEvidence} from '../src/evidence/evidence_store.js';

test('retained image byte budget is distinct from text and base64 transport overhead',()=>{
 const prior=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'retained-image-'));
 process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const scope={session_id:'image-session',assignment_id:'image-assignment',run_id:'image-run',generation:1};
  // Storage treats media as opaque bytes. Real native JPEG replay is a separate qualification.
  const bytes=Buffer.alloc(1_398_408,19),saved=storeEvidence({scope,source:'native_target_view_review',media_type:'image/jpeg',trust_level:'untrusted_caller',raw:bytes});
  const request={evidence_id:saved.ref.evidence_id,scope,purpose:'Inspect this retained titleblock capture',image:true as const};
  const result=retrieveEvidence(request);
  assert(Buffer.from((result.selection as any).data_base64,'base64').equals(bytes));
  assert(result.returned_bytes>bytes.length,'Transport expansion is measured, not mistaken for image bytes');
  assert.equal(result.evidence_ref.content_hash,saved.ref.content_hash);assert.equal(result.evidence_ref.trust_level,'untrusted_caller');
  assert.throws(()=>retrieveEvidence({...request,max_bytes:1_048_576}),/image.*byte limit/);
  assert.throws(()=>retrieveEvidence({...request,scope:{...scope,assignment_id:'foreign'}}),/Assignment scope/);
  const maximum=storeEvidence({scope,source:'bounded-image',media_type:'image/png',trust_level:'host_observed',raw:Buffer.alloc(5*1024*1024)});
  assert.equal(retrieveEvidence({...request,evidence_id:maximum.ref.evidence_id}).complete,true);
  const oversized=storeEvidence({scope,source:'oversized-image',media_type:'image/png',trust_level:'host_observed',raw:Buffer.alloc(5*1024*1024+1)});
  assert.throws(()=>retrieveEvidence({...request,evidence_id:oversized.ref.evidence_id}),/image.*byte limit/);
  const text=storeEvidence({scope,source:'large-text',trust_level:'host_observed',raw:{value:'x'.repeat(1_048_577)}});
  assert.throws(()=>retrieveEvidence({evidence_id:text.ref.evidence_id,scope,purpose:'Inspect one value',fields:['value'],max_bytes:5*1024*1024}),/1048576-byte limit/);
  fs.writeFileSync(path.join(root,saved.ref.artifact_location),Buffer.alloc(bytes.length,20));
  assert.throws(()=>retrieveEvidence(request),/hash verification/);
  assert.throws(()=>readAuthoritativeEvidence(saved.ref,scope),/hash verification/);
 }finally{if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;fs.rmSync(root,{recursive:true,force:true});}
});
