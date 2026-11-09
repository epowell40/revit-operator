import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {reviewCurrentWork,visualWorkReviewModelOutput} from './visual_work_review.mjs';
import {reviewTestPng} from './fixtures/visual-review-image.mjs';

const scene={process_id:123,document_session_id:'doc',epoch:'epoch',through_sequence:4,view_id:41,view_unique_id:'view-uid',view_type:'DraftingView',document_title:'Example'};
const capture={evidence_id:'ev1_capture',content_hash:'sha256:'+'a'.repeat(64)};
function fixture(n=245){return {schema:'revit-operator.view-owned-detailing/v1',scope:'exact_owner_view',documentTitle:'Example',requestedViewIds:[41],viewsComplete:true,
 canonical_attempt_settlement:{method:'POST',path:'/revit/view-owned-detailing',requested_effect:'read',effect_state:'none',request_dispatched:true},
 views:[{view:{id:41,uniqueId:'view-uid',viewType:'DraftingView'},totalOwnedCount:n,returnedCount:n,truncated:false,unreadableCount:0,itemsComplete:true,
 items:Array.from({length:n},(_,i)=>({elementId:100+i,uniqueId:'native-'+i,ownerViewId:41,className:'DetailLine',comparisonExcluded:false,
 curve:{kind:'Line',start:{x:i/10,y:0,z:0},end:{x:i/10,y:2,z:0}},boundingBox:{min:{x:i/10,y:0,z:0},max:{x:i/10,y:2,z:0}}}))}]};}
async function build(...args){const m=await import('./drafting_correction_index.mjs').catch(()=>null);assert.equal(typeof m?.buildDraftingCorrectionIndex,'function','fresh visual observation needs a native correction index');return m.buildDraftingCorrectionIndex(...args);}

test('dense drawings expose bounded spatial retrieval for late identities without a new C# inventory',async()=>{
 const raw=fixture(900),before=JSON.stringify(raw),r=await build(raw,scene,capture),s=r.spatial_selection;
 assert.equal(s.scope,'retained_native_bounds_candidates');assert.deepEqual(s.axes,['x','y']);
 assert.equal(s.regions.length,9);assert.equal(s.unbounded_rows,0);assert.equal(s.geometry_intersection_verified,false);
 const last=s.regions.at(-1);assert(last[3]>0);
 const selected=raw.views[0].items.filter(v=>s.axes.every((axis,i)=>v.boundingBox.min[axis]<=last[2][i]&&v.boundingBox.max[axis]>=last[1][i]));
 assert.equal(selected.length,last[3]);assert(selected.some(v=>v.elementId===999));
 assert(!r.rows.some(v=>v[0]===999),'late targets need spatial selection, not the truncated prefix');
 assert.equal(JSON.stringify(raw),before);assert(Buffer.byteLength(JSON.stringify(r))<=16384);
});

test('spatial candidates retain missing bounds and partial source limits without absence claims',async()=>{
 const raw=fixture(8);raw.views[0].items[7].boundingBox=null;raw.views[0].truncated=true;
 raw.views[0].totalOwnedCount=99;raw.views[0].itemsComplete=false;raw.viewsComplete=false;
 const r=await build(raw,scene,capture);assert.equal(r.spatial_selection.unbounded_rows,1);
 assert.equal(r.coverage.source_inventory_complete,false);assert.equal(r.spatial_selection.geometry_intersection_verified,false);
 assert.equal(r.spatial_selection.pixel_to_model_mapping,false);
});

test('degenerate or unrepresentable bounds cannot create invented spatial regions',async()=>{
 const raw=fixture(1);raw.views[0].items[0].boundingBox={min:{x:1,y:1,z:1},max:{x:1,y:1,z:1}};
 assert.equal((await build(raw,scene,capture)).spatial_selection.regions.length,1);
 raw.views[0].items[0].boundingBox={min:{x:-1e308,y:0,z:0},max:{x:1e308,y:1,z:0}};
 const s=(await build(raw,scene,capture)).spatial_selection;assert.equal(s.reason,'bounds_span_not_representable');assert.deepEqual(s.regions,[]);
});

test('current drawing index carries every small-detail line identity and endpoint without a C# rediscovery call',async()=>{
 const raw=fixture(),before=JSON.stringify(raw),r=await build(raw,scene,capture);
 assert.equal(r.state,'available');assert.equal(r.rows.length,245);assert.deepEqual(r.rows[144],[244,'Line',[[14.4,0,0],[14.4,2,0]]]);
 assert.equal(r.coverage.source_rows_exhausted,true);assert.equal(r.coverage.whole_drawing_verified,false);
 assert.equal(r.source_sha256,createHash('sha256').update(before).digest('hex'));assert.equal(r.capture.content_hash,capture.content_hash);
 assert.equal(r.location.document_session_id,'doc');assert.equal(JSON.stringify(raw),before);assert(Buffer.byteLength(JSON.stringify(r))<=16384);
});
test('nonlinear shapes and text use native bounds, never invented curve endpoints or pixel placement',async()=>{
 const raw=fixture(3),rows=raw.views[0].items;rows[0].curve={kind:'Ellipse',isBound:false};
 rows[1].className='TextNote';rows[1].curve=null;rows[1].visibleText='Valve';rows[2].curve=null;rows[2].boundingBox=null;
 const r=await build(raw,scene,capture);assert.equal(r.locators.other_kinds,'bounds');assert.equal(r.rows[0][1],'Ellipse');assert.equal(r.rows[1][3],'Valve');
 assert.equal(r.rows.length,2);assert.equal(r.coverage.unlocated_rows,1);assert.equal(r.pixel_to_model_mapping,false);
});
test('truncation and byte limits remain explicit and keep exact original source indices for retrieval',async()=>{
 const raw=fixture(2000);raw.views[0].truncated=true;raw.views[0].totalOwnedCount=2500;raw.views[0].itemsComplete=false;raw.viewsComplete=false;
 const r=await build(raw,scene,capture);assert.equal(r.coverage.source_inventory_complete,false);assert.equal(r.coverage.source_rows_exhausted,false);
 assert(r.rows.length>0&&r.rows.length<2000);assert.equal(r.retrieval.next_start,r.rows.length);assert(Buffer.byteLength(JSON.stringify(r))<=16384);
});
test('foreign view/document, failed native read and malformed geometry do not create a trusted locator',async()=>{
 for(const change of [r=>r.documentTitle='other',r=>r.requestedViewIds=[42],r=>r.views[0].view.uniqueId='other',r=>r.views[0].items[0].ownerViewId=42,
 r=>r.canonical_attempt_settlement.effect_state='unknown',r=>r.canonical_attempt_settlement.path='/other',r=>r.views[0].items.push(r.views[0].items[0])]){
  const raw=fixture(2);change(raw);assert.equal((await build(raw,scene,capture)).state,'unavailable');
 }
 const raw=fixture(1);raw.views[0].items[0].curve.start.x=NaN;raw.views[0].items[0].boundingBox=null;
 assert.equal((await build(raw,scene,capture)).rows.length,0);
});

function observationHost(){
 const bytes=reviewTestPng(80,60,255),hash=createHash('sha256').update(bytes).digest('hex'),now=Date.parse('2026-11-09T04:00:00Z');
 const calls=[],owner={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1,principal_id:'principal',document_fingerprint:'project'};
 let seq=4,type='DraftingView';
 const host={owner:()=>owner,assertControl:async()=>{},now:()=>now,
  readTargetContext:async()=>{calls.push('context');return {process_id:123,document:{sessionId:'doc',title:'Example',projectIdentity:{fingerprint:'project'},activeView:{id:41,name:'Detail',type}},
   nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:123,epoch:'epoch',documentSessionId:'doc',throughSequence:seq,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]},
   canonical_attempt_settlement:{method:'GET',path:'/revit/context',requested_effect:'read',effect_state:'none'}};},
  captureTarget:async()=>{calls.push('image');return {image_base64:bytes.toString('base64'),mime_type:'image/png',native_result:{processId:123,documentSessionId:'doc',projectFingerprint:'project',viewId:41,activeViewId:41,viewUniqueId:'view-uid',viewName:'Detail',viewType:type,sheetNumber:'',
   timestamp:new Date(now).toISOString(),exportMode:'full_view',widthPx:80,heightPx:60,bytes:bytes.length,sha256:hash,canonical_attempt_settlement:{method:'POST',path:'/revit/export-image',requested_effect:'read',effect_state:'none'}}};},
  retainImage:async()=>({ref:{evidence_id:'ev1_capture',content_hash:'sha256:'+hash,byte_count:bytes.length}}),
  readDraftingDetail:async()=>{calls.push('index');return fixture();},settings:()=>({model:'gpt-6.1-sol',reasoning_effort:'medium'}),userRequest:()=> 'Draft the attached detail.',
  requestResponse:async()=>{throw Error('Routine observation must not invoke a second model');}};
 return {host,calls,bytes,change:()=>seq++,setType:value=>type=value};
}
const request={review_mode:'observe',view_id:41,capture_mode:'target_view',checks:[{id:'detail',expected:'Find remaining visible discrepancies.'}]};
test('production observation sends actual current image and native locators together through the model-visible consumer',async()=>{
 const f=observationHost(),r=await reviewCurrentWork(request,f.host);assert.equal(r.state,'observed');assert.equal(r.drafting_correction_index.rows.length,245);
 assert.equal(f.calls.filter(v=>v==='index').length,1);assert(f.calls.lastIndexOf('context')>f.calls.indexOf('index'));
 assert.equal(r.raw_review_evidence.drafting_native_read.views[0].items.length,245);
 const envelope={output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review'}]})};
 const delivered=visualWorkReviewModelOutput(envelope,r,'ev1_review');assert.equal(delivered.output[1].image_url,'data:image/png;base64,'+f.bytes.toString('base64'));
 const feedback=JSON.parse(delivered.output[0].text).evidence_projections[0].visual_work_review;
 assert.equal(feedback.drafting_correction_index.rows[0][0],100);assert.equal(feedback.drafting_correction_index.retrieval.evidence_id,'ev1_review');
 assert.equal(feedback.native_postcondition_verified,false);assert(Buffer.byteLength(delivered.output[0].text)<=8192);
 assert.deepEqual(visualWorkReviewModelOutput(delivered,r,'ev1_review'),delivered,'second host presentation must not duplicate images or index');
});
test('document mutation during locator read prevents delivering a stale image/index pair',async()=>{
 const f=observationHost();f.host.readDraftingDetail=async()=>{f.change();return fixture();};
 const r=await reviewCurrentWork(request,f.host);assert.equal(r.state,'unavailable');assert.equal(r.reason,'visual_review_scene_changed_before_observation');assert.equal(r.drafting_correction_index,undefined);
});
test('failed locator read is explicit while a valid image remains usable, and non-drafting views add no read',async()=>{
 const f=observationHost();f.host.readDraftingDetail=async()=>({error:'read failed'});
 const r=await reviewCurrentWork(request,f.host);assert.equal(r.state,'observed');assert.equal(r.drafting_correction_index.state,'unavailable');
 const g=observationHost();g.setType('FloorPlan');assert.equal((await reviewCurrentWork(request,g.host)).drafting_correction_index,undefined);assert(!g.calls.includes('index'));
});

test('drawing index respects the downstream evidence item cap and pages exact remaining source rows',async()=>{
 const f=observationHost(),r=await reviewCurrentWork(request,f.host),before=JSON.stringify(r);
 const envelope={output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',omitted:0,retrieval:'Retrieve exact rows by evidence ID.',
  evidence_projections:[{schema:'revit-operator.evidence-projection.v1',evidence_id:'ev1_review'}]})};
 const delivered=visualWorkReviewModelOutput(envelope,r,'ev1_review');
 assert(Buffer.byteLength(delivered.output[0].text)<=8192,'actual Responses evidence item accepts at most 8192 bytes');
 const index=JSON.parse(delivered.output[0].text).evidence_projections[0].visual_work_review.drafting_correction_index;
 assert(index.rows.length>0&&index.rows.length<245);assert.equal(index.coverage.source_rows_exhausted,false);
 assert.equal(index.coverage.returned_rows,index.rows.length);assert.equal(index.retrieval.next_start,index.rows.length);
 assert.deepEqual(index.rows,r.drafting_correction_index.rows.slice(0,index.rows.length));
 assert.deepEqual(index.retrieval.source_row_indices,Array.from({length:index.rows.length},(_,i)=>i));
 assert.equal(index.source_sha256,r.drafting_correction_index.source_sha256);
 assert.deepEqual(index.spatial_selection,r.drafting_correction_index.spatial_selection,'the full spatial directory survives prefix clipping');
 assert.equal(JSON.stringify(r),before,'model projection must not trim retained native evidence');
 assert.equal(delivered.output[1].image_url,'data:image/png;base64,'+f.bytes.toString('base64'));
 assert.deepEqual(visualWorkReviewModelOutput(delivered,r,'ev1_review'),delivered);
});

function annotationTail(){
 const raw=fixture(340);
 for(let i=328;i<340;i++)Object.assign(raw.views[0].items[i],{className:'TextNote',curve:null,visibleText:'Equipment '+i});
 return raw;
}
test('annotation locators survive a dense curve page without increasing the index budget',async()=>{
 const raw=annotationTail(),before=JSON.stringify(raw),r=await build(raw,scene,capture),a=r.annotations;
 assert.equal(a.observed_text_notes,12);assert.equal(a.returned_text_notes,12);assert.equal(a.all_observed_notes_returned,true);
 assert.deepEqual(a.rows.map(r=>r.slice(0,2)),Array.from({length:12},(_,i)=>[328+i,428+i]));
 assert.equal(a.rows[0][2],'Equipment 328');assert.equal(a.rows[0][3],true);
 assert(Buffer.byteLength(JSON.stringify(a))<=2048);assert(Buffer.byteLength(JSON.stringify(r))<=16384);
 assert.equal(JSON.stringify(raw),before);assert.equal(r.native_postcondition_verified,false);
});
test('annotation excerpt, missing bounds, unreadable text and partial inventory remain explicit',async()=>{
 const raw=fixture(3),items=raw.views[0].items;
 items.forEach(r=>{r.className='TextNote';r.curve=null;r.boundingBox=null;});
 items[0].visibleText='A'.repeat(300);items[1].visibleText='Valve';
 raw.views[0].truncated=true;raw.views[0].totalOwnedCount=40;
 const r=await build(raw,scene,capture),a=r.annotations;
 assert.equal(a.rows[0][2].length,240);assert.equal(a.rows[0][3],false);assert.equal(a.rows[0][4],null);
 assert.equal(a.observed_text_notes,3);assert.equal(a.returned_text_notes,2);assert.equal(a.unreadable_text_notes,1);
 assert.equal(a.all_observed_notes_returned,false);assert.equal(r.coverage.source_inventory_complete,false);
});
test('many long annotations remain bounded and retain exact raw-source row pointers',async()=>{
 const raw=fixture(200);raw.views[0].items.forEach(r=>{r.className='TextNote';r.curve=null;r.visibleText='Long text '.repeat(40);});
 const r=await build(raw,scene,capture),a=r.annotations;
 assert(a.rows.length>0&&a.rows.length<200);assert.equal(a.all_observed_notes_returned,false);
 assert.equal(a.observed_text_notes,200);assert(Buffer.byteLength(JSON.stringify(a))<=2048);
 for(const row of a.rows)assert.equal(raw.views[0].items[row[0]].elementId,row[1]);
 assert(Buffer.byteLength(JSON.stringify(r))<=16384);
});
test('actual model-visible observation preserves annotation locators and fresh pixels within the existing envelope',async()=>{
 const f=observationHost();f.host.readDraftingDetail=async()=>annotationTail();
 const r=await reviewCurrentWork(request,f.host);
 const envelope={output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',omitted:0,retrieval:'Retrieve exact rows.',evidence_projections:[{schema:'revit-operator.evidence-projection.v1',evidence_id:'ev1_review'}]})};
 const delivered=visualWorkReviewModelOutput(envelope,r,'ev1_review');
 assert(Buffer.byteLength(delivered.output[0].text)<=8192);
 const index=JSON.parse(delivered.output[0].text).evidence_projections[0].visual_work_review.drafting_correction_index;
 assert.equal(index.annotations.returned_text_notes,12);assert.equal(index.annotations.rows[0][1],428);
 assert.equal(index.retrieval.evidence_id,'ev1_review');assert.equal(index.coverage.source_rows_exhausted,false);
 assert.equal(delivered.output[1].image_url,'data:image/png;base64,'+f.bytes.toString('base64'));
});
