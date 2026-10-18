import fs from 'node:fs';import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {reviewCurrentWork,normalizeVisualReviewRequest,VISUAL_WORK_REVIEW_TOOL,visualWorkReviewModelOutput} from './visual_work_review.mjs';
const image='iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAcSURBVFhH7cEBAQAAAIIg/69uSEABAAAAAAB8GhkoAAFF1RG0AAAAAElFTkSuQmCC';
const bytes=Buffer.from(image,'base64'),hash='sha256:'+createHash('sha256').update(bytes).digest('hex');
const owner={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1,principal_id:'principal',document_fingerprint:'project'};
const retained168=JSON.parse(fs.readFileSync(new URL('./fixtures/visual-review-missing-baseline168.json',import.meta.url),'utf8'));
const checks=retained168.after_request.checks,viewId=retained168.after_request.view_id;
const request={view_id:viewId,recheck_evidence_id:'ev1_prior_review'};
function setup(){
 const now=Date.now(),calls=[],rect={x:10,y:10,width:40,height:40},vc={main_window_handle:'0x123',main_window_bounds:{x:0,y:0,width:100,height:100},view_rectangle:rect};
 const location={process_id:123,document_session_id:'doc',epoch:'epoch',through_sequence:0,view_id:viewId,view_name:'AIR DEVICE SCHEDULE',view_type:'Schedule',document_title:'Mechanical'};
 const ref={evidence_id:'ev1_before_image',content_hash:hash,byte_count:bytes.length,media_type:'image/png'};
 const frame={schema:'operator.visual_review_capture.v1',kind:'revit_view',process_id:123,view_id:viewId,main_window_handle:'0x123',foreground_window_handle:'0x123',rectangle:rect,captured_at_utc:new Date(now).toISOString(),selection_authority:'native_view_or_owned_modal',occlusion_check:'nine_point_screen_grid_not_pixel_exhaustive'};
 const baseline={evidence_ref:{evidence_id:request.recheck_evidence_id},review:{schema:'operator.visual_work_review.v1',ok:true,state:'mismatch',authority:'supporting_visual_assessment',native_postcondition_verified:false,whole_task_verified:false,owner,request:{view_id:viewId,checks},location,capture:{...ref,frame},reference:null},capture:{evidence_ref:ref,image_url:'data:image/png;base64,'+image},reference:null};
 const h={owner:()=>owner,assertControl:async()=>{},now:()=>now,readContext:async()=>({schema:'revit-operator.ui-context/v1',authority:'ui_identity_only',state:'available',revision:1,captured_at_utc:new Date(now).toISOString(),context:{visual_capture_context:vc,process_id:123,document:{sessionId:'doc',title:'Mechanical',activeView:{id:viewId,name:'AIR DEVICE SCHEDULE',type:'Schedule'}},nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:123,epoch:'epoch',documentSessionId:'doc',throughSequence:1,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]}}}),capture:async()=>({image_base64:image,frame}),retainImage:async pixels=>{const bytes=Buffer.from(pixels,'base64');return{ref:{...ref,evidence_id:'ev1_after_image',content_hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byte_count:bytes.length}};},settings:()=>({model:'gpt-6.1-sol',reasoning_effort:'medium'}),userRequest:()=> 'Remove the extra blank row and keep existing borders and project data.',readBaseline:async id=>{assert.equal(id,request.recheck_evidence_id);return baseline;},requestResponse:async body=>{calls.push(body);return{id:'resp_recheck',status:'completed',output:[],output_text:JSON.stringify({checks:checks.map(c=>({id:c.id,status:'matched',observed:'Synthetic before/after comparison.',correction:''}))})};}};
 return {h,calls,baseline};
}
test('retained168 missing-baseline failure has a scoped recheck request with original check identity and actual before pixels',async()=>{
 assert.equal(retained168.retained_after_state,'uncertain');assert.equal(retained168.retained_after_checks.find(c=>c.id==='data-layout').status,'uncertain');
 const f=setup(),r=await reviewCurrentWork(request,f.h);assert.equal(r.state,'matched');assert.deepEqual(r.request.checks,checks);
 const content=f.calls[0].input[0].content,prompt=JSON.parse(content[0].text);assert.equal(content.filter(c=>c.type==='input_image').length,2);assert.equal(content[2].image_url,f.baseline.capture.image_url);
 assert.deepEqual(prompt.checks,checks);assert.equal(prompt.baseline.evidence_id,request.recheck_evidence_id);assert.equal(prompt.baseline.location.through_sequence,0);assert.equal(prompt.location.through_sequence,1);assert.match(prompt.limits,/historical/);
 assert.deepEqual(f.calls[0].tools,[]);assert.equal(f.calls[0].previous_response_id,undefined);assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
 const output=visualWorkReviewModelOutput({output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_after_review'}]})},r,'ev1_after_review');
 const feedback=JSON.parse(output.output).evidence_projections[0].visual_work_review;assert.equal(feedback.baseline.evidence_id,request.recheck_evidence_id);assert.equal(feedback.recheck_evidence_id,'ev1_after_review');assert(Buffer.byteLength(output.output)<=8192);
});
test('recheck cannot redefine checks or replace a source reference and requires a bounded prior-review identity',()=>{
 assert.deepEqual(normalizeVisualReviewRequest(request),request);assert(VISUAL_WORK_REVIEW_TOOL.parameters.properties.recheck_evidence_id);
 for(const bad of [{...request,checks},{...request,reference_filename:'other.png'},{...request,recheck_evidence_id:'../../image'},{view_id:viewId},{...request,image_url:'data:image/png;base64,'+image}])assert.throws(()=>normalizeVisualReviewRequest(bad));
});
test('foreign owner/process/document/epoch/view, future sequence, failed review and corrupted before pixels stop before reviewer',async()=>{
 for(const mutate of [b=>b.review.owner={...owner,run_id:'other'},b=>b.review.owner={...owner,generation:2},b=>b.review.location.document_session_id='other',b=>b.review.location.process_id=999,b=>b.review.location.epoch='other',b=>b.review.location.view_id=42,b=>b.review.location.through_sequence=2,b=>b.review.ok=false,b=>b.review.state='unavailable',b=>b.capture.evidence_ref.content_hash='sha256:'+'a'.repeat(64),b=>b.review.capture.frame.kind='revit_dialog']){
  const f=setup();f.baseline=structuredClone(f.baseline);mutate(f.baseline);f.h.readBaseline=async()=>f.baseline;const r=await reviewCurrentWork(request,f.h);assert.equal(r.state,'unavailable');assert.equal(f.calls.length,0);assert.equal(r.whole_task_verified,false);
 }
});
test('historical reference stays historical; changed current pixels still invalidate recheck and never replay edits',async()=>{
 const f=setup();let n=0;const capture=f.h.capture;f.h.capture=async()=>{const c=await capture();if(++n===2){const b=Buffer.from(image,'base64');b[b.length-1]^=1;c.image_base64=b.toString('base64');}return c;};const r=await reviewCurrentWork(request,f.h);assert.equal(r.state,'unavailable');assert.equal(r.reason,'visual_review_visible_frame_changed_during_review');assert.equal(f.calls.length,1);
});

test('recheck includes original source reference separately and never primes with a prior verdict',async()=>{
 const f=setup();f.baseline.review.reference={filename:'office.png',evidence_id:'ev1_source',content_hash:hash};f.baseline.reference={filename:'office.png',image_url:'data:image/png;base64,'+image,evidence_ref:{evidence_id:'ev1_source',content_hash:hash,byte_count:bytes.length,media_type:'image/png'}};
 f.baseline.review.checks=[{id:'blank-row',status:'mismatch',observed:'Prior judgment must not prime checker.'}];
 const r=await reviewCurrentWork(request,f.h);assert.equal(r.state,'matched');const content=f.calls[0].input[0].content,data=JSON.parse(content[0].text);assert.equal(content.filter(c=>c.type==='input_image').length,3);assert.equal(data.reference.filename,'office.png');assert(!content[0].text.includes('Prior judgment'));assert.equal(data.baseline.state,undefined);
});

test('a plain recheck inherits prior native-target capture mode and effective resolution without an unrelated active-screen fallback',async()=>{
 const f=setup(),sizes=[];f.baseline.review.request.capture_mode='target_view';f.baseline.review.request.image_size=6000;f.baseline.review.capture_resolution={effective_width:5739};f.baseline.review.capture.frame={kind:'native_target_view'};
 f.h.readContext=async()=>{throw Error('Must not substitute current active screen');};
 f.h.readTargetContext=async()=>({process_id:123,document:{sessionId:'doc',title:'Mechanical',projectIdentity:{fingerprint:'project'},activeView:{id:7,name:'Other view',type:'DrawingSheet'}},nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:123,epoch:'epoch',documentSessionId:'doc',throughSequence:1,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]},canonical_attempt_settlement:{method:'GET',path:'/revit/context',requested_effect:'read',effect_state:'none'}});
 f.h.captureTarget=async(location,args)=>{sizes.push(args.image_size);return{image_base64:image,mime_type:'image/png',native_result:{processId:123,documentSessionId:'doc',projectFingerprint:'project',viewId,viewName:'M002',viewUniqueId:'target-unique',viewType:'DrawingSheet',sheetNumber:'M002',exportMode:'full_view',widthPx:40,heightPx:40,bytes:bytes.length,sha256:hash.slice(7),timestamp:new Date().toISOString(),canonical_attempt_settlement:{method:'POST',path:'/revit/export-image',requested_effect:'read',effect_state:'none'}}};};
 const r=await reviewCurrentWork(request,f.h);assert.equal(r.state,'matched');assert.equal(r.request.capture_mode,'target_view');assert.deepEqual(sizes,[5739,5739]);assert.equal(f.calls.length,1);
});
