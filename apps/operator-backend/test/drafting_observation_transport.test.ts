import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {assertBoundedModelEvidencePayload,prepareBoundedModelEvidenceInput} from '../src/evidence/model_context_budget.js';

test('actual drafting observation producer crosses Responses consumer with bounded locators and unchanged pixels',async()=>{
 const ui=[path.resolve('../packages/operator-assistant-ui'),path.resolve('../../packages/operator-assistant-ui')]
  .find(p=>fs.existsSync(path.join(p,'visual_work_review.mjs')));assert(ui);
 const {reviewCurrentWork,visualWorkReviewModelOutput}=await import(pathToFileURL(path.join(ui,'visual_work_review.mjs')).href);
 const {reviewTestPng}=await import(pathToFileURL(path.join(ui,'fixtures/visual-review-image.mjs')).href);
 const bytes=reviewTestPng(80,60,255),sha=createHash('sha256').update(bytes).digest('hex');
 const view={id:41,uniqueId:'view-uid',viewType:'DraftingView'},now=Date.now();
 const raw={schema:'revit-operator.view-owned-detailing/v1',scope:'exact_owner_view',documentTitle:'Test',requestedViewIds:[41],viewsComplete:true,
  canonical_attempt_settlement:{method:'POST',path:'/revit/view-owned-detailing',requested_effect:'read',effect_state:'none',request_dispatched:true},
  views:[{view,totalOwnedCount:300,returnedCount:300,truncated:false,unreadableCount:0,itemsComplete:true,
   items:Array.from({length:300},(_,i)=>({elementId:100+i,uniqueId:'uid-'+i,ownerViewId:41,className:'DetailLine',
    curve:{kind:'Line',start:{x:i/10,y:0,z:0},end:{x:i/10,y:1,z:0}}}))}]};
 const host={owner:()=>({assignment_id:'a',session_id:'s',run_id:'r',generation:1,principal_id:'p',document_fingerprint:'project'}),
  assertControl:async()=>{},now:()=>now,readTargetContext:async()=>({process_id:123,
   document:{sessionId:'doc',title:'Test',projectIdentity:{fingerprint:'project'},activeView:{id:41,name:'Detail',type:'DraftingView'}},
   nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:123,epoch:'epoch',documentSessionId:'doc',throughSequence:4,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]},
   canonical_attempt_settlement:{method:'GET',path:'/revit/context',requested_effect:'read',effect_state:'none'}}),
  captureTarget:async()=>({image_base64:bytes.toString('base64'),mime_type:'image/png',native_result:{processId:123,documentSessionId:'doc',projectFingerprint:'project',viewId:41,activeViewId:41,viewUniqueId:'view-uid',viewName:'Detail',viewType:'DraftingView',sheetNumber:'',timestamp:new Date(now).toISOString(),exportMode:'full_view',widthPx:80,heightPx:60,bytes:bytes.length,sha256:sha,canonical_attempt_settlement:{method:'POST',path:'/revit/export-image',requested_effect:'read',effect_state:'none'}}}),
  retainImage:async()=>({ref:{evidence_id:'ev1_capture',content_hash:'sha256:'+sha,byte_count:bytes.length}}),
  readDraftingDetail:async()=>raw,settings:()=>({model:'gpt-6.1-sol',reasoning_effort:'medium'}),userRequest:()=> 'Draft the reference.',
  requestResponse:async()=>{throw Error('No second model for observation');}};
 const result=await reviewCurrentWork({review_mode:'observe',view_id:41,capture_mode:'target_view',checks:[{id:'detail',expected:'Find differences.'}]},host);
 assert.equal(result.state,'observed');const retained=JSON.stringify(result);
 const envelope={output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',omitted:0,retrieval:'Retrieve exact original rows.',
  evidence_projections:[{schema:'revit-operator.evidence-projection.v1',evidence_id:'ev1_review',byte_count:100000,trust_level:'host_observed'}]})};
 const output=visualWorkReviewModelOutput(envelope,result,'ev1_review').output;
 const wire=[{type:'function_call_output',call_id:'call-observe',output}];
 assert.doesNotThrow(()=>assertBoundedModelEvidencePayload(wire));
 assert.deepEqual(prepareBoundedModelEvidenceInput(wire),wire);
 assert.equal(output[1].image_url,'data:image/png;base64,'+bytes.toString('base64'));
 const index=JSON.parse(output[0].text).evidence_projections[0].visual_work_review.drafting_correction_index;
 assert(index.rows.length>0&&index.rows.length<300);assert.equal(index.retrieval.next_start,index.rows.length);
 assert.equal(index.coverage.source_rows_exhausted,false);assert.equal(index.coverage.whole_drawing_verified,false);
 assert.equal(index.source_sha256,createHash('sha256').update(JSON.stringify(raw)).digest('hex'));
 assert.equal(JSON.stringify(result),retained);assert.equal(result.raw_review_evidence.drafting_native_read.views[0].items.length,300);
 const oversized=structuredClone(wire);oversized[0].output[0].text=JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',omitted:0,retrieval:'Retrieve.',
  evidence_projections:[{schema:'revit-operator.evidence-projection.v1',evidence_id:'ev1_review',visual_work_review:{rows:'x'.repeat(25000)}}]});
 assert.throws(()=>assertBoundedModelEvidencePayload(oversized),/8192-byte evidence item budget/);
});
