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

function assessmentHost(status='mismatch'){
 const f=observationHost();f.host.requestResponse=async input=>{f.calls.push('review');return {id:'resp_review',status:'completed',model:'gpt-6.1-sol',output:[{type:'message'}],output_text:JSON.stringify({checks:input.input[0].content.filter(c=>c.type==='input_text').map(c=>JSON.parse(c.text)).flatMap(v=>v.checks).map(c=>({id:c.id,status,observed:'A symbol stroke needs closer comparison.',correction:status==='mismatch'?'Check the current stroke and source before correcting.':''}))})};};return f;
}
const assessmentRequest={view_id:41,capture_mode:'target_view',checks:request.checks};
const reviewEnvelope={output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review'}]})};

test('independent drafting discrepancy delivers fresh repair locators and pixels to the primary actor',async()=>{
 for(const status of ['mismatch','uncertain']){
  const f=assessmentHost(status),r=await reviewCurrentWork(assessmentRequest,f.host);
  assert.equal(r.state,status);assert.equal(r.drafting_correction_index?.state,'available');
  assert.equal(f.calls.filter(x=>x==='index').length,1);assert.equal(f.calls.filter(x=>x==='review').length,1);
  assert(f.calls.indexOf('index')>f.calls.indexOf('review'));assert(f.calls.lastIndexOf('context')>f.calls.indexOf('index'));
  const before=JSON.stringify(r),out=visualWorkReviewModelOutput(reviewEnvelope,r,'ev1_review');
  const feedback=JSON.parse(out.output[0].text).evidence_projections[0].visual_work_review;
  assert.deepEqual(feedback.checks,r.checks);assert.equal(feedback.drafting_correction_index.retrieval.evidence_id,'ev1_review');
  assert.equal(out.output[1].image_url,'data:image/png;base64,'+f.bytes.toString('base64'));
  assert.equal(feedback.native_postcondition_verified,false);assert.equal(feedback.whole_task_verified,false);
  assert(Buffer.byteLength(out.output[0].text)<=8192);assert.equal(JSON.stringify(r),before);
  assert.deepEqual(visualWorkReviewModelOutput(out,r,'ev1_review'),out);
 }
});

test('matched assessments and non-drafting views do not incur correction inventory reads',async()=>{
 for(const [status,type] of [['matched','DraftingView'],['mismatch','FloorPlan']]){
  const f=assessmentHost(status);f.setType(type);const r=await reviewCurrentWork(assessmentRequest,f.host);
  assert.equal(r.state,status);assert.equal(r.drafting_correction_index,undefined);assert(!f.calls.includes('index'));
 }
});

test('post-review locator mutation prevents stale repair feedback',async()=>{
 const f=assessmentHost();f.host.readDraftingDetail=async()=>{f.change();return fixture();};
 const r=await reviewCurrentWork(assessmentRequest,f.host);
 assert.equal(r.state,'unavailable');assert.equal(r.reason,'visual_review_scene_changed_before_correction_feedback');
 assert.equal(r.drafting_correction_index,undefined);
});

test('failed or foreign optional repair inventory remains unavailable without replacing the visual finding',async()=>{
 for(const read of [async()=>{throw Error('native collector unavailable');},async()=>{const v=fixture();v.documentTitle='foreign';return v;}]){
  const f=assessmentHost();f.host.readDraftingDetail=read;const r=await reviewCurrentWork(assessmentRequest,f.host);
  assert.equal(r.state,'mismatch');assert.equal(r.drafting_correction_index?.state,'unavailable');assert.equal(r.whole_task_verified,false);
  const out=visualWorkReviewModelOutput(reviewEnvelope,r,'ev1_review');assert.equal(out.output[1].type,'input_image');
 }
});

test('repair feedback reserves complete checks before optional dense locator rows',async()=>{
 const f=assessmentHost(),r=await reviewCurrentWork(assessmentRequest,f.host);
 r.checks=Array.from({length:3},(_,i)=>({id:'check'+i,expected:'Expected visible symbol. '.repeat(6),status:i===1?'mismatch':'matched',observed:'Actual observed appearance. '.repeat(9),correction:i===1?'Inspect the indicated stroke against the source and current native geometry. '.repeat(3):''}));
 const out=visualWorkReviewModelOutput(reviewEnvelope,r,'ev1_review'),feedback=JSON.parse(out.output[0].text).evidence_projections[0].visual_work_review;
 assert.deepEqual(feedback.checks,r.checks);assert.equal(feedback.coverage.complete,true);assert(feedback.drafting_correction_index);
 assert(Buffer.byteLength(out.output[0].text)<=8192);
});

test('repair presentation preserves historical binding and exact findings without duplicating prior camera metadata',async()=>{
 const f=assessmentHost(),r=await reviewCurrentWork(assessmentRequest,f.host);
 r.baseline={evidence_id:'ev1_before',location:{...scene,view_name:'Prior'},capture,frame:{kind:'native_target_view',width:4000,height:1993,viewport:{description:'Retained historical camera. '.repeat(80)}}};
 r.code_review={status:'matched',observed:'The selected code modifies only the requested detail. '.repeat(12),correction:''};
 r.request.code_evidence_ids=['ev1_code'];const before=JSON.stringify(r);
 const out=visualWorkReviewModelOutput(reviewEnvelope,r,'ev1_review'),v=JSON.parse(out.output[0].text).evidence_projections[0].visual_work_review;
 assert.deepEqual(v.checks,r.checks);assert.equal(v.baseline.evidence_id,'ev1_before');assert.deepEqual(v.baseline.capture,capture);
 assert.equal(v.baseline.location.document_session_id,scene.document_session_id);assert.equal(v.baseline.location.through_sequence,scene.through_sequence);
 assert.equal(v.baseline.historical_context,true);assert.equal(v.baseline.presentation_complete,false);assert.equal(v.retrieval.baseline_path,'baseline');
 assert.equal(v.code_review.status,'matched');assert.equal(v.code_review.details_complete,false);assert.equal(v.retrieval.code_review_path,'code_review');
 assert.deepEqual(v.code_review_evidence_ids,['ev1_code']);assert.equal(JSON.stringify(r),before);
 r.code_review={status:'mismatch',observed:'An unrelated deletion is present.',correction:'Do not accept this execution.'};
 const bad=JSON.parse(visualWorkReviewModelOutput(reviewEnvelope,r,'ev1_review').output[0].text).evidence_projections[0].visual_work_review;
 assert.deepEqual(bad.code_review,r.code_review);assert.equal(bad.whole_task_verified,false);
});
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

test('bounded locator lanes cannot crowd fresh pixels out of a production-sized evidence envelope',async()=>{
 let partial=false,retained=false;
 for(const scopeCount of [25,45,65,85,100]){
  const f=observationHost();f.host.readDraftingDetail=async()=>{
   const raw=fixture(800);for(let i=788;i<800;i++)Object.assign(raw.views[0].items[i],{className:'TextNote',curve:null,visibleText:'Annotation '.repeat(23)});return raw;
  };
  const r=await reviewCurrentWork(request,f.host),before=JSON.stringify(r);
  const envelope={output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review',content_hash:'sha256:'+'c'.repeat(64),artifact_ref:'ev1_review',target_scope:Array.from({length:scopeCount},(_,i)=>'element_unique_id:12345678-1234-1234-1234-123456789012-'+i)}]})};
  if(scopeCount===100){assert.throws(()=>visualWorkReviewModelOutput(envelope,r,'ev1_review'),/projection_budget_exceeded/,'do not discard required source/target bindings to fit an oversized envelope');assert.equal(JSON.stringify(r),before);continue;}
  const out=visualWorkReviewModelOutput(envelope,r,'ev1_review'),feedback=JSON.parse(out.output[0].text).evidence_projections[0].visual_work_review,index=feedback.drafting_correction_index;
  assert(Buffer.byteLength(out.output[0].text)<=8192);assert.equal(out.output[1].image_url,'data:image/png;base64,'+f.bytes.toString('base64'));
  assert.deepEqual(JSON.parse(out.output[0].text).evidence_projections[0].target_scope,JSON.parse(envelope.output).evidence_projections[0].target_scope,'smaller duplicate metadata must preserve every target binding');
  assert.equal(index.source_sha256,r.drafting_correction_index.source_sha256);assert.equal(feedback.whole_task_verified,false);
  if(index.annotations){assert.equal(index.annotations.returned_text_notes,index.annotations.rows.length);assert.equal(index.annotations.all_observed_notes_returned,index.annotations.rows.length===12);partial||=index.annotations.rows.length<r.drafting_correction_index.annotations.rows.length;}
  if(index.state==='retained_only'){retained=true;assert.equal(index.retrieval.index_path,'drafting_correction_index');assert.equal(index.retrieval.evidence_id,'ev1_review');}
  assert.equal(JSON.stringify(r),before);assert.deepEqual(visualWorkReviewModelOutput(out,r,'ev1_review'),out);
 }
 assert(partial,'exercise whole annotation-row clipping');assert(retained,'exercise reference-only fallback');
});

test('single review feedback shares locator identity and keeps a bounded typed retrieval instruction',async()=>{
 const f=assessmentHost();f.host.readDraftingDetail=async()=>fixture(900);
 const r=await reviewCurrentWork(assessmentRequest,f.host),before=JSON.stringify(r);
 const projection={evidence_id:'ev1_review',content_hash:'sha256:'+'c'.repeat(64),artifact_ref:'ev1_review',
  target_scope:Array.from({length:65},(_,i)=>'element_unique_id:12345678-1234-1234-1234-123456789012-'+i)};
 const source={schema:'revit-operator.model-evidence-envelope.v1',omitted:0,retrieval:'Generic selector catalogue retained in the original evidence.',evidence_projections:[projection]};
 const envelope={output:JSON.stringify(source)};
 const out=visualWorkReviewModelOutput(envelope,r,'ev1_review'),parsed=JSON.parse(out.output[0].text),v=parsed.evidence_projections[0].visual_work_review,index=v.drafting_correction_index;
 assert.equal(parsed.retrieval,'Use the typed review retrieval selectors for retained evidence.');assert.equal(index.state,'retained_only');
 assert.equal(index.location_path,'location');assert.equal(index.capture_path,'capture');
 for(const [k,value]of Object.entries(r.drafting_correction_index.location))assert.deepEqual(v.location[k],value);
 for(const [k,value]of Object.entries(r.drafting_correction_index.capture))assert.deepEqual(v.capture[k],value);
 assert.deepEqual(v.checks,r.checks);assert.equal(v.coverage.complete,true);
 assert.equal(index.source_sha256,r.drafting_correction_index.source_sha256);assert.equal(index.retrieval.evidence_id,'ev1_review');
 assert.equal(v.native_postcondition_verified,false);assert.equal(v.whole_task_verified,false);
 assert.equal(JSON.stringify(r),before);assert.equal(envelope.output,JSON.stringify(source));
 assert.equal(out.output[1].image_url,'data:image/png;base64,'+f.bytes.toString('base64'));
 assert(Buffer.byteLength(out.output[0].text)<=8192);assert.deepEqual(visualWorkReviewModelOutput(out,r,'ev1_review'),out);
});

test('different locator identities and other evidence retain their own bindings and retrieval instructions',async()=>{
 for(const variant of ['location','capture','other_projection','omitted']){
  const f=assessmentHost();f.host.readDraftingDetail=async()=>fixture(900);
  const r=await reviewCurrentWork(assessmentRequest,f.host);
  if(variant==='location')r.drafting_correction_index.location.document_session_id='different-session';
  if(variant==='capture')r.drafting_correction_index.capture.content_hash='sha256:'+'d'.repeat(64);
  const source={schema:'revit-operator.model-evidence-envelope.v1',omitted:variant==='omitted'?1:0,retrieval:'Other retained evidence still needs this selector catalogue.',
   evidence_projections:[{evidence_id:'ev1_review',target_scope:Array.from({length:65},(_,i)=>'element_unique_id:12345678-1234-1234-1234-123456789012-'+i)},...(variant==='other_projection'?[{evidence_id:'ev1_other'}]:[])]};
  const before=JSON.stringify(r),out=visualWorkReviewModelOutput({output:JSON.stringify(source)},r,'ev1_review'),parsed=JSON.parse(out.output[0].text),v=parsed.evidence_projections[0].visual_work_review,index=v.drafting_correction_index;
  assert.equal(index.state,'retained_only');
  if(variant==='location'){assert.deepEqual(index.location,r.drafting_correction_index.location);assert.equal(index.location_path,undefined);}
  if(variant==='capture'){assert.deepEqual(index.capture,r.drafting_correction_index.capture);assert.equal(index.capture_path,undefined);}
  if(['other_projection','omitted'].includes(variant))assert.equal(parsed.retrieval,source.retrieval);
  assert.equal(JSON.stringify(r),before);assert.equal(v.whole_task_verified,false);assert(Buffer.byteLength(out.output[0].text)<=8192);
 }
});
