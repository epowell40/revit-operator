import test from 'node:test';import assert from 'node:assert/strict';
import {visualReviewImageEvidenceOptions}from './visual_work_review.mjs';
const metadata={capture_mode:'target_view',capture_role:'review_capture',capture_frame:{view_id:41,document_session_id:'document-session',view_unique_id:'view-unique',view_name:'Notes, Symbols & Schedules',sheet_number:'M002'}};
test('image discovery labels keep parent sheet and exact view while explicitly limiting the claim',()=>{
 const p=visualReviewImageEvidenceOptions(metadata);assert(p.targetScope.includes('view_id:41'));assert(p.targetScope.includes('sheet_number:M002'));assert(p.targetScope.includes('document_session:document-session'));assert(p.targetScope.includes('view_unique_id:view-unique'));
 assert.match(p.boundedSummary,/Notes, Symbols & Schedules/);assert.match(p.boundedSummary,/Not a pre-edit\/post-edit comparison or verified outcome/);assert(Buffer.byteLength(p.boundedSummary)<600);
 assert.equal(p.trust_level,undefined);assert.equal(p.native_postcondition_verified,undefined);
});
test('recheck and resolution attempt roles stay distinct; absent sheet number does not fabricate one',()=>{
 for(const role of ['during_review_recheck','resolution_attempt']){const p=visualReviewImageEvidenceOptions({...metadata,capture_role:role,capture_frame:{...metadata.capture_frame,sheet_number:null}});assert(p.targetScope.includes('capture_role:'+role));assert(!p.targetScope.some(v=>v.startsWith('sheet_number:')));assert.match(p.boundedSummary,new RegExp(role));}
});
test('actor-shaped/ambiguous provenance is rejected and display labels stay bounded',()=>{
 for(const bad of [{...metadata,capture_role:'after_edit'},{...metadata,capture_mode:'auto'},{...metadata,capture_frame:{...metadata.capture_frame,view_id:null}},{...metadata,capture_frame:{...metadata.capture_frame,document_session_id:''}}])assert.throws(()=>visualReviewImageEvidenceOptions(bad));
 const p=visualReviewImageEvidenceOptions({...metadata,capture_frame:{...metadata.capture_frame,view_name:'N'.repeat(500)+'\n',sheet_number:'M002\n'}});assert(p.boundedSummary.length<=600);assert(!p.boundedSummary.includes('\n'));assert(p.targetScope.includes('sheet_number:M002'));
});
