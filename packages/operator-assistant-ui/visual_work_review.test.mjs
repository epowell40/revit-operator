import test from 'node:test';
const modelText = output => Array.isArray(output) ? output.find(item => item.type === 'input_text').text : output;import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {VISUAL_WORK_REVIEW_TOOL,reviewCurrentWork,normalizeVisualReviewRequest,parseVisualWorkReview,visualWorkReviewModelOutput} from './visual_work_review.mjs';
import * as identityReview from './visual_work_review.mjs';
const image='iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAcSURBVFhH7cEBAQAAAIIg/69uSEABAAAAAAB8GhkoAAFF1RG0AAAAAElFTkSuQmCC';
const binding={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1,principal_id:'principal',document_fingerprint:'project'};
const request={view_id:41,checks:[{id:'gap',expected:'No extra blank row below the headings.'},{id:'border',expected:'Medium grid lines are selected.'}]};
const now=Date.parse('2026-10-17T12:00:00Z');
test('PDF source review reuses a selected delivered attachment image instead of requiring a new PNG attachment',async()=>{
 const selected={call_id:'call_source',page:1};
 const f=host();
 f.h.referenceAttachmentRead=async value=>{assert.deepEqual(value,selected);return {filename:'record.pdf',image_url:'data:image/png;base64,'+image,evidence_ref:{evidence_id:'ev1_source',content_hash:'sha256:'+createHash('sha256').update(Buffer.from(image,'base64')).digest('hex')},source_render:{source_read_call_id:'call_source',page:1,source_sha256:'a'.repeat(64),image_sha256:createHash('sha256').update(Buffer.from(image,'base64')).digest('hex'),visual_scope:'region',requested_region:{min_u:0.2,min_v:0.3,max_u:0.5,max_v:0.7}}};};
 const result=await reviewCurrentWork({...request,reference_attachment_read:selected},f.h);
 assert.equal(result.ok,true);assert.equal(result.reference.source_render.page,1);
 const content=f.calls.providers[0].input[0].content;
 assert.equal(content.filter(x=>x.type==='input_image').length,2);
 assert.equal(JSON.parse(content[0].text).reference.source_render.source_read_call_id,'call_source');
 assert.equal(result.native_postcondition_verified,false);assert.equal(result.whole_task_verified,false);
});

test('source reference selection is exclusive with filename and cannot replace a recheck baseline',()=>{
 const selected={call_id:'call_source',page:1};
 assert.deepEqual(normalizeVisualReviewRequest({...request,reference_attachment_read:selected}).reference_attachment_read,selected);
 for(const change of [{reference_filename:'record.png'},{recheck_evidence_id:'ev1_old'},{reference_attachment_read:{...selected,page:0}},{reference_attachment_read:{...selected,path:'c:/other.png'}}])assert.throws(()=>normalizeVisualReviewRequest({...request,reference_attachment_read:selected,...change}));
});

function attachmentReadFixture(){
 const pdf=Buffer.from('%PDF-1.7 retained source'),sha=createHash('sha256').update(pdf).digest('hex');
 const region={min_u:0.2,min_v:0.3,max_u:0.5,max_v:0.7};
 const summary={source:'record.pdf',attachment_id:'source',sha256:sha,page_count:2,pages_returned:[2],mode:'detail',coverage:[{page:2,visual_scope:'region',image_bytes:Buffer.from(image,'base64').length}]};
 return {selection:{call_id:'call_source',page:2},summary,attachments:[{id:'source',filename:'record.pdf',mime:'application/pdf',dataBase64:pdf.toString('base64')}],receipts:[{call_id:'call_source',tool_name:'native__operator_read_attachment',status:'success',arguments:{attachment_id:'source',pages:[2],mode:'detail',region},result:{ok:true,native_stop_reason:null,content:[{type:'inputText',text:JSON.stringify(summary)},{type:'inputImage',imageUrl:'data:image/png;base64,'+image}]}}]};
}
function trackedAttachmentReadFixture(){
 const f=attachmentReadFixture(),content=f.receipts[0].result.content;
 const overlay=Buffer.from(image,'base64');overlay[overlay.length-1]^=1;
 const tracking={source_sha256:f.summary.sha256,page:2,marks:[{item_id:'branch',passes:[{stage:'checked',host_certified:false}]}],
   clean_reference_image_sha256:createHash('sha256').update(Buffer.from(image,'base64')).digest('hex'),overlay_image_sha256:createHash('sha256').update(overlay).digest('hex')};
 content.push({type:'inputText',text:JSON.stringify({drafting_tracking:tracking})},{type:'inputImage',imageUrl:'data:image/png;base64,'+overlay.toString('base64')});
 // Current native transport also delivers projected page metadata and a pixel
 // manifest. Neither replaces the immutable source header or clean pixels.
 content.splice(1,0,{type:'inputText',text:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{truncated:true}]})});
 return {f,tracking};
}
test('highlighted reference retains clean source selection through projected metadata and recovery',()=>{
 const {f}=trackedAttachmentReadFixture();f.attachments=[];f.registeredAttachmentIds=['source'];
 const r=identityReview.resolveAttachmentReviewImage(f.selection,f);
 assert.equal(r.image_url,'data:image/png;base64,'+image);assert.equal(r.source_render.page,2);
 assert.equal(r.source_render.source_identity_basis,'current_registered_attachment_read');
});
test('paired review receives clean source rather than highlighted completion claims',async()=>{
 const {f}=trackedAttachmentReadFixture(),h=host();h.h.referenceAttachmentRead=async selected=>{
  const r=identityReview.resolveAttachmentReviewImage(selected,f);
  return {...r,evidence_ref:{evidence_id:'ev1_source',content_hash:'sha256:'+r.source_render.image_sha256}};
 };
 const r=await reviewCurrentWork({...request,reference_attachment_read:f.selection},h.h);
 assert.equal(r.state,'matched');assert.equal(h.calls.providers.length,1);
 const pixels=h.calls.providers[0].input[0].content.filter(c=>c.type==='input_image');
 assert.equal(pixels.length,2);assert.equal(pixels[1].image_url,'data:image/png;base64,'+image);
 assert(!h.calls.providers[0].input[0].content[0].text.includes('host_certified'));
});
for(const bad of ['source','page','clean-hash','overlay-hash','missing-overlay','extra-image','reordered','duplicate-marker','same-pixels','malformed'])test('tracking image pairing rejects '+bad,()=>{
 const {f,tracking:t}=trackedAttachmentReadFixture(),content=f.receipts[0].result.content;
 if(bad==='source')t.source_sha256='b'.repeat(64);if(bad==='page')t.page=1;
 if(bad==='clean-hash')t.clean_reference_image_sha256='b'.repeat(64);if(bad==='overlay-hash')t.overlay_image_sha256='b'.repeat(64);
 if(bad==='same-pixels')t.overlay_image_sha256=t.clean_reference_image_sha256;
 content[3].text=bad==='malformed'?JSON.stringify({drafting_tracking:null}):JSON.stringify({drafting_tracking:t});
 if(bad==='missing-overlay')content.pop();if(bad==='extra-image')content.push({...content[2]});
 if(bad==='reordered')[content[2],content[4]]=[content[4],content[2]];
 if(bad==='duplicate-marker')content.push({...content[3]},{...content[4]});
 assert.throws(()=>identityReview.resolveAttachmentReviewImage(f.selection,f),/visual_review_attachment/);
});
test('image-budget omission preserves the sole clean source without inventing an overlay',()=>{
 const f=attachmentReadFixture();f.receipts[0].result.content.push({type:'inputText',text:JSON.stringify({drafting_tracking:{overlay_omitted:'image_budget',marks:[]}})});
 assert.equal(identityReview.resolveAttachmentReviewImage(f.selection,f).image_url,'data:image/png;base64,'+image);
});
test('a multi-page read keeps original page ordering when only one page has tracking',()=>{
 const {f}=trackedAttachmentReadFixture(),r=f.receipts[0];
 r.arguments.pages=[1,2];f.summary.pages_returned=[1,2];f.summary.coverage.unshift({...f.summary.coverage[0],page:1});
 r.result.content[0].text=JSON.stringify(f.summary);r.result.content.splice(1,0,{type:'inputImage',imageUrl:'data:image/png;base64,'+image});
 for(const page of [1,2])assert.equal(identityReview.resolveAttachmentReviewImage({...f.selection,page},f).source_render.page,page);
 const images=r.result.content.filter(x=>x.type==='inputImage');r.result.content.unshift({...images[0]});
 assert.throws(()=>identityReview.resolveAttachmentReviewImage(f.selection,f),/visual_review_attachment/);
});
test('delivered PDF pixels preserve exact source, call, page, crop and image identity without rendering',()=>{
 const f=attachmentReadFixture(),r=identityReview.resolveAttachmentReviewImage(f.selection,f);
 assert.equal(r.image_url,'data:image/png;base64,'+image);assert.equal(r.source_render.page,2);
 assert.deepEqual(r.source_render.requested_region,f.receipts[0].arguments.region);
 assert.equal(r.source_render.source_sha256,f.summary.sha256);assert.equal(r.source_render.width_px,40);
 assert.equal(r.source_render.source_read_call_id,'call_source');assert.match(r.source_render.limitation,/Not model evidence/);
 const d=attachmentReadFixture();delete d.receipts[0].arguments.mode;
 assert.equal(identityReview.resolveAttachmentReviewImage(d.selection,d).source_render.mode,'detail');
});
for(const bad of ['foreign-call','duplicate-call','wrong-tool','failed','stopped','foreign-source','changed-source','duplicate-attachment','wrong-page','duplicate-page','missing-image','wrong-pixels','wrong-bytes','malformed-region','scope-conflict','source-name','malformed-summary'])test('PDF reference rejects '+bad+' rather than substitute other source pixels',()=>{
 const f=attachmentReadFixture(),r=f.receipts[0],s=f.summary;
 if(bad==='foreign-call')f.selection.call_id='call_foreign';
 if(bad==='duplicate-call')f.receipts.push(structuredClone(r));
 if(bad==='wrong-tool')r.tool_name='native__invoke';
 if(bad==='failed')r.status='failed';if(bad==='stopped')r.result.native_stop_reason='paused';
 if(bad==='foreign-source')s.attachment_id='foreign';if(bad==='changed-source')f.attachments[0].dataBase64=Buffer.from('different').toString('base64');
 if(bad==='duplicate-attachment')f.attachments.push(structuredClone(f.attachments[0]));
 if(bad==='wrong-page')f.selection.page=1;if(bad==='duplicate-page')s.pages_returned=[2,2];
 if(bad==='missing-image')r.result.content.pop();if(bad==='wrong-pixels')r.result.content[1].imageUrl='file:///somewhere';
 if(bad==='wrong-bytes')s.coverage[0].image_bytes++;
 if(bad==='malformed-region')r.arguments.region.min_u=2;if(bad==='scope-conflict')s.coverage[0].visual_scope='full_page';
 if(bad==='source-name')s.source='other.pdf';
 r.result.content[0].text=bad==='malformed-summary'?'{broken':JSON.stringify(s);
 assert.throws(()=>identityReview.resolveAttachmentReviewImage(f.selection,f));
});
const frameContext={main_window_handle:'0x123',main_window_bounds:{x:0,y:0,width:100,height:100},view_rectangle:{x:10,y:10,width:40,height:40}};
function focused(){return {image_base64:image,frame:{schema:'operator.visual_review_capture.v1',kind:'revit_view',process_id:123,view_id:41,main_window_handle:'0x123',foreground_window_handle:'0x123',rectangle:{...frameContext.view_rectangle},captured_at_utc:new Date(now).toISOString(),selection_authority:'native_view_or_owned_modal',occlusion_check:'nine_point_screen_grid_not_pixel_exhaustive'}};}
function snapshot(seq=0){return{schema:'revit-operator.ui-context/v1',authority:'ui_identity_only',state:'available',revision:1,captured_at_utc:new Date(now).toISOString(),context:{visual_capture_context:frameContext,process_id:123,document:{sessionId:'doc',title:'Mechanical',activeView:{id:41,name:'AIR DEVICE SCHEDULE',type:'Schedule'}},nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:123,epoch:'epoch',documentSessionId:'doc',throughSequence:seq,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]}}};}
function response(status='matched'){return{id:'resp_review',status:'completed',output:[],output_text:JSON.stringify({checks:request.checks.map((c,i)=>({id:c.id,status:i===0?status:'matched',observed:i===0?'The blank-row checkbox is '+(status==='mismatch'?'checked.':'unchecked.'):'Grid selector reads Medium Lines.',correction:i===0&&status==='mismatch'?'Clear only the blank-row checkbox.':''}))})};}
function host(status='matched'){
 const calls={contexts:0,captures:0,providers:[],controls:0,retained:0};let owner=structuredClone(binding);
 const h={owner:()=>owner,assertControl:async()=>{calls.controls++;},readContext:async()=>{calls.contexts++;return snapshot();},capture:async()=>{calls.captures++;return focused();},retainImage:async pixels=>{calls.retained++;const bytes=Buffer.from(pixels,'base64');return{ref:{evidence_id:'ev1_capture',content_hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byte_count:bytes.length}};},settings:()=>({model:'gpt-6.1-sol',reasoning_effort:'medium'}),userRequest:()=> 'Remove the extra gap below the air-device schedule headings and preserve borders.',now:()=>now,evidenceScope:()=>({session_id:binding.session_id,assignment_id:binding.assignment_id}),requestResponse:async body=>{calls.providers.push(body);return response(status);}};
 return {h,calls,setOwner:b=>{owner=b;}};
}

test('plan review discovery separates native connections from screen lineweight inspection and printed output',()=>{
 const d=VISUAL_WORK_REVIEW_TOOL.description;
 assert.match(d,/physical connections.*native readback/i);
 assert.match(d,/Thin Lines.*visible_work/i);
 assert.match(d,/restore.*display setting/i);
 assert.match(d,/not.*printed.*lineweight/i);
 assert.match(d,/color alone.*selection/i);
});

test('plan-review instructions reach the separate reviewer without converting uncertain pixels into a native or complete pass',async()=>{
 const f=host('uncertain');
 f.h.userRequest=()=> 'Insert one inline valve in the plan and preserve the connected pipe system.';
 f.h.readContext=async()=>{f.calls.contexts++;const s=snapshot();s.context.readiness={selection_count:0};s.context.document.selection=[];return s;};
 const r=await reviewCurrentWork(request,f.h);
 assert.equal(f.calls.providers.length,1);
 const instructions=f.calls.providers[0].instructions;
 assert.match(instructions,/color alone.*selection/i);
 assert.match(instructions,/physical connections.*native readback/i);
 assert.match(instructions,/Thin Lines.*printed/i);
 assert.equal(r.state,'uncertain');
 assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
 assert.deepEqual(r.request.checks,request.checks);
 assert.equal(f.calls.captures,2);
 const output={output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review'}]})};
 const presented=JSON.parse(modelText(visualWorkReviewModelOutput(output,r,'ev1_review').output)).evidence_projections[0].visual_work_review;
 assert.equal(presented.state,'uncertain');assert.equal(presented.native_postcondition_verified,false);assert.equal(presented.whole_task_verified,false);
});

function staleScreenHost(status='matched'){
 const f=host(status);let refreshed=false;const calls={refreshes:0,captureAttempts:0};
 const native=()=>({...snapshot().context,document:{...snapshot().context.document,projectIdentity:{fingerprint:'project'}},canonical_attempt_settlement:{method:'GET',path:'/revit/context',requested_effect:'read',effect_state:'none'}});
 f.h.readContext=async()=>{const s=snapshot();s.captured_at_utc=new Date(now-(refreshed?0:13000)).toISOString();s.revision=refreshed?2:1;return s;};
 f.h.readTargetContext=async()=>{calls.refreshes++;refreshed=true;return native();};
 f.h.capture=async location=>{calls.captureAttempts++;if(now-Date.parse(location.identity_captured_at_utc)>10000){const e=Error('capture failed');e.stderr='visual_review_view_rectangle_stale\r\nAt trusted capture script';throw e;}return focused();};
 return {...f,refreshCalls:calls,native};
}

test('expired screen rectangle uses one guarded native identity refresh without another reviewer turn',async()=>{
 const f=staleScreenHost(),r=await reviewCurrentWork(request,f.h);
 assert.equal(r.state,'matched');assert.equal(f.refreshCalls.refreshes,1);assert.equal(f.calls.providers.length,1);
 assert.equal(f.refreshCalls.captureAttempts,3);assert.equal(r.raw_review_evidence.screen_identity_refreshes.length,1);
 assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
 const output={output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review'}]})};
 assert.equal(JSON.parse(modelText(visualWorkReviewModelOutput(output,r,'ev1_review').output)).evidence_projections[0].visual_work_review.state,'matched');
});

test('refresh preserves uncertain assessment and never repeats a stale capture twice',async()=>{
 const f=staleScreenHost('uncertain');assert.equal((await reviewCurrentWork(request,f.h)).state,'uncertain');
 const g=staleScreenHost();g.h.capture=async()=>{g.refreshCalls.captureAttempts++;const e=Error('capture failed');e.stderr='visual_review_view_rectangle_stale';throw e;};
 assert.equal((await reviewCurrentWork(request,g.h)).state,'unavailable');assert.equal(g.refreshCalls.refreshes,1);assert.equal(g.refreshCalls.captureAttempts,2);assert.equal(g.calls.providers.length,0);
});

for(const bad of ['process','document','epoch','sequence','view','project','settlement','unknown','frame','stale','revision','owner','pause','modal'])test('screen identity refresh rejects '+bad+' without trusting refreshed pixels',async()=>{
 const f=staleScreenHost(),read=f.h.readContext;let changed=false;
 f.h.readTargetContext=async()=>{changed=true;f.refreshCalls.refreshes++;const c=f.native();
  if(bad==='modal')throw Error('visual_review_native_read_admission_invalid');
  if(bad==='process')c.process_id=124;if(bad==='document')c.document.sessionId='foreign';
  if(bad==='epoch')c.nativeChangeObservations.epoch='foreign';if(bad==='sequence')c.nativeChangeObservations.throughSequence=1;
  if(bad==='view')c.document.activeView.id=42;if(bad==='project')c.document.projectIdentity.fingerprint='foreign';
  if(bad==='settlement')c.canonical_attempt_settlement.effect_state='unknown';if(bad==='unknown')c.outcome_unknown=true;return c;};
 f.h.readContext=async()=>{const s=await read();if(changed&&bad!=='stale'){s.captured_at_utc=new Date(now).toISOString();s.revision=bad==='revision'?1:2;}if(changed&&bad==='frame')s.context.visual_capture_context={...frameContext,view_rectangle:{...frameContext.view_rectangle,x:11}};return s;};
 if(bad==='owner')f.h.owner=()=>changed?{...binding,run_id:'foreign'}:binding;
 if(bad==='pause')f.h.assertControl=async()=>{if(changed)throw Error('Paused');};
 const r=await reviewCurrentWork(request,f.h);assert.equal(r.state,'unavailable');assert.equal(f.calls.providers.length,0);assert.equal(f.refreshCalls.captureAttempts,1);
});

test('fresh screen captures do not add a native refresh',async()=>{
 const f=host();f.h.readTargetContext=async()=>{assert.fail('fresh screen needs no native refresh');};
 assert.equal((await reviewCurrentWork(request,f.h)).state,'matched');assert.equal(f.calls.captures,2);assert.equal(f.calls.providers.length,1);
});

for(const drift of [false,true])test('expiry during reviewer preserves the pixel comparison, changed='+drift,async()=>{
 const f=host();let clock=now,revision=1,identityAt=now,refreshes=0,captures=0;
 f.h.now=()=>clock;f.h.readContext=async()=>({...snapshot(),revision,captured_at_utc:new Date(identityAt).toISOString()});
 f.h.readTargetContext=async()=>{refreshes++;revision++;identityAt=clock;return staleScreenHost().native();};
 f.h.requestResponse=async body=>{f.calls.providers.push(body);clock+=13000;return response();};
 f.h.capture=async location=>{captures++;if(clock-Date.parse(location.identity_captured_at_utc)>10000)throw Object.assign(Error('capture failed'),{stderr:'visual_review_view_rectangle_stale'});
  const value=focused();value.frame.captured_at_utc=new Date(clock).toISOString();if(drift&&clock>now){const bytes=Buffer.from(value.image_base64,'base64');bytes[bytes.length-1]^=1;value.image_base64=bytes.toString('base64');}return value;};
 const r=await reviewCurrentWork(request,f.h);assert.equal(refreshes,1);assert.equal(captures,3);assert.equal(f.calls.providers.length,1);
 assert.equal(r.state,drift?'unavailable':'matched');if(drift)assert.equal(r.reason,'visual_review_visible_frame_changed_during_review');
 assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
});

for(const error of [Error('visual_review_window_owner_changed'),Object.assign(Error('capture failed'),{stderr:'prefix visual_review_view_rectangle_stale suffix'}),Error('visual_review_view_rectangle_stale')])test('other or unstructured capture errors do not request a native refresh: '+error.message,async()=>{
 const f=staleScreenHost();f.h.capture=async()=>{throw error;};assert.equal((await reviewCurrentWork(request,f.h)).state,'unavailable');assert.equal(f.refreshCalls.refreshes,0);assert.equal(f.calls.providers.length,0);
});

test('failed identity ping after reviewer completion retains bounded transport truth without a verdict or retry',async()=>{
 const {h,calls}=host();let reads=0;
 h.readContext=async()=>++reads<3?snapshot():identityReview.readVisualReviewUiIdentityV1(async()=>new Response(JSON.stringify({
  code:'REVIT_CONTEXT_HOST_UNAVAILABLE',request_dispatched:false,outcome_unknown:false,retryable:true,reconciliation_required:false,
  error:'Do not retain arbitrary response text or credentials',ui_context:{secret:'untrusted extra data'}
 }),{status:409}));
 const r=await reviewCurrentWork(request,h);
 assert.equal(r.reason,'visual_review_native_identity_unavailable');assert.equal(r.state,'unavailable');assert.deepEqual(r.checks,[]);
 assert.equal(calls.providers.length,1);assert.equal(calls.captures,1);assert.equal(reads,3);assert.equal(r.reviewer_response_id,'resp_review');
 const expected={schema:'operator.visual_review_identity_failure.v1',stage:'http_response',route:'/revit/ping',http_status:409,
  native_error_code:'REVIT_CONTEXT_HOST_UNAVAILABLE',request_dispatched:false,outcome_unknown:false,retryable:true,reconciliation_required:false};
 assert.deepEqual(r.identity_read_failure,expected);assert.deepEqual(r.raw_review_evidence.native_identity_failure,expected);
 const o={output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review'}]})};
 const feedback=JSON.parse(modelText(visualWorkReviewModelOutput(o,r,'ev1_review').output)).evidence_projections[0].visual_work_review;
 assert.deepEqual(feedback.identity_read_failure,expected);assert.equal(feedback.native_postcondition_verified,false);assert.equal(feedback.whole_task_verified,false);
 assert(!JSON.stringify(r).includes('untrusted extra data'));assert(!JSON.stringify(r).includes('credentials'));
});

test('identity reader keeps HTTP status but never fabricates dispatch flags or exposes unstructured errors',async()=>{
 for(const status of [401,403,409,503]){
  let calls=0;try{await identityReview.readVisualReviewUiIdentityV1(async()=>{calls++;return new Response('non-JSON private transport details',{status});});assert.fail('must reject');}
  catch(e){assert.equal(calls,1);const d=identityReview.visualReviewIdentityFailureV1(e);assert.equal(d.http_status,status);assert.equal(d.native_error_code,null);
   assert.equal(d.request_dispatched,undefined);assert.equal(d.outcome_unknown,undefined);assert(!JSON.stringify(d).includes('private'));}
 }
 const value=snapshot();assert.deepEqual(await identityReview.readVisualReviewUiIdentityV1(async()=>new Response(JSON.stringify({ui_context:value}))),value);
 let attempts=0;try{await identityReview.readVisualReviewUiIdentityV1(async()=>{attempts++;return new Response(JSON.stringify({code:'private response text',request_dispatched:true,outcome_unknown:true,retryable:false,reconciliation_required:true,headers:{authorization:'private credential'}}),{status:503});});assert.fail('must reject');}
 catch(e){const d=identityReview.visualReviewIdentityFailureV1(e);assert.equal(attempts,1);assert.equal(d.native_error_code,null);assert.equal(d.outcome_unknown,true);assert.equal(d.reconciliation_required,true);assert.equal(d.request_dispatched,true);assert(!JSON.stringify(d).includes('private'));}
});

test('identity transport exceptions and invalid success bodies retain diagnostic scope without admitting work',async()=>{
 const error=Object.assign(new Error('private local path and transport material'),{code:'NATIVE_TRANSPORT_DISCOVERY_INVALID',request_dispatched:false,outcome_unknown:false,retryable:true,reconciliation_required:false});
 try{await identityReview.readVisualReviewUiIdentityV1(async()=>{throw error;});assert.fail('must reject');}catch(e){const d=identityReview.visualReviewIdentityFailureV1(e);assert.equal(d.stage,'transport_exception');assert.equal(d.http_status,null);assert.equal(d.native_error_code,error.code);assert.equal(d.request_dispatched,false);assert(!JSON.stringify(d).includes('private'));}
 for(const body of ['not JSON','{}','{"ui_context":null}']){
  try{await identityReview.readVisualReviewUiIdentityV1(async()=>new Response(body));assert.fail('invalid body must reject');}catch(e){const d=identityReview.visualReviewIdentityFailureV1(e);assert.equal(d.stage,'invalid_response');assert.equal(d.http_status,200);assert.equal(d.request_dispatched,undefined);}
 }
 assert.equal(identityReview.visualReviewIdentityFailureV1({visual_review_identity_failure:{schema:'foreign',route:'/revit/ping',http_status:409}}),null);
});

test('whole desktop or unbound/old/misdimensioned focused capture cannot reach the reviewer',async()=>{
 const variants=[()=>image,()=>({...focused(),frame:{...focused().frame,process_id:999}}),()=>({...focused(),frame:{...focused().frame,view_id:42}}),()=>({...focused(),frame:{...focused().frame,main_window_handle:'0xBAD'}}),()=>({...focused(),frame:{...focused().frame,captured_at_utc:new Date(now-11000).toISOString()}}),()=>({...focused(),frame:{...focused().frame,rectangle:{x:10,y:10,width:80,height:40}}}),()=>({...focused(),frame:{...focused().frame,kind:'desktop'}})];
 for(const variant of variants){const {h,calls}=host();h.capture=async()=>variant();const result=await reviewCurrentWork(request,h);assert.equal(result.state,'unavailable');assert.equal(calls.providers.length,0);assert.equal(calls.retained,0);}
});
test('host work capture is bound to the native location; owned modal retains that location without desktop context',async()=>{
 const {h,calls}=host();h.capture=async location=>{assert.equal(location.view_name,'AIR DEVICE SCHEDULE');assert.equal(location.visual_capture_context.main_window_handle,'0x123');const value=focused();value.frame.kind='revit_dialog';value.frame.foreground_window_handle='0x124';value.frame.rectangle={x:25,y:25,width:40,height:40};return value;};
 const result=await reviewCurrentWork(request,h);assert.equal(result.state,'matched');assert.equal(result.capture.frame.kind,'revit_dialog');const text=JSON.parse(calls.providers[0].input[0].content[0].text);assert.equal(text.capture.frame.foreground_window_handle,'0x124');assert.match(text.limits,/not the worker conversation/);assert.equal(text.location.view_id,41);
});
test('native view bounds changing during capture invalidates the focused frame before dispatch',async()=>{
 const {h,calls}=host();let n=0;h.readContext=async()=>{const value=snapshot();value.context.visual_capture_context=structuredClone(frameContext);if(n++)value.context.visual_capture_context.view_rectangle.width=80;return value;};const result=await reviewCurrentWork(request,h);assert.equal(result.state,'unavailable');assert.equal(result.reason,'visual_review_scene_changed_during_capture');assert.equal(calls.providers.length,0);
});
test('modal or work pixels changing while the reviewer thinks invalidate its result without an edit or hidden retry',async()=>{
 const {h,calls}=host();let n=0;h.capture=async()=>{const value=focused();if(n++){const bytes=Buffer.from(value.image_base64,'base64');bytes[bytes.length-1]^=1;value.image_base64=bytes.toString('base64');}return value;};const result=await reviewCurrentWork(request,h);assert.equal(result.state,'unavailable');assert.equal(result.reason,'visual_review_visible_frame_changed_during_review');assert.equal(calls.providers.length,1);assert.equal(result.raw_review_evidence.capture_recheck.pixels_unchanged,false);assert.equal(result.whole_task_verified,false);
});
test('Home or an inactive work view never dispatches a visual review for a background target',async()=>{
 for(const change of [s=>{s.context.document=null;},s=>{s.context.document.activeView.id=42;}]){
  const {h,calls}=host();h.readContext=async()=>{const value=snapshot();change(value);return value;};const result=await reviewCurrentWork(request,h);assert.equal(result.state,'unavailable');assert.equal(result.reason,'visual_review_native_scene_unavailable');assert.equal(calls.captures,0);assert.equal(calls.providers.length,0);
 }
 assert.match(VISUAL_WORK_REVIEW_TOOL.description,/parameter-only work may require native readback/);
});
test('large visual reports retain whole checks, explicit coverage and exact raw artifact selectors within the metadata item budget',async()=>{
 const {h}=host('mismatch'),result=await reviewCurrentWork(request,h);result.checks=Array.from({length:8},(_,i)=>({id:'check'+i,expected:'E'.repeat(600),status:'mismatch',observed:'O'.repeat(600),correction:'C'.repeat(600)}));
 const before=JSON.stringify(result),original={schema:'revit-operator.evidence-projection.v1',evidence_id:'ev1_review',content_hash:'sha256:'+'b'.repeat(64),key_facts:{duplicate:'x'.repeat(3500)},key_counts:{raw:8},diagnostics:['raw duplicate'],effect_state:'applied',inline_payload:{unneeded:'x'.repeat(3000)}};
 const output=JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[original],omitted:0,retrieval:'Retrieve missing evidence.'});
 const projected=visualWorkReviewModelOutput({output},result,'ev1_review'),envelope=JSON.parse(modelText(projected.output)),p=envelope.evidence_projections[0],feedback=p.visual_work_review;
 assert(Buffer.byteLength(modelText(projected.output))<=8192);assert(feedback.checks.length>0&&feedback.checks.length<8);assert.equal(feedback.coverage.complete,false);assert.equal(feedback.coverage.total,8);assert.equal(feedback.coverage.next_start,feedback.checks.length);
 assert.deepEqual(feedback.checks,result.checks.slice(0,feedback.checks.length));assert.equal(feedback.retrieval.evidence_id,'ev1_review');assert.equal(feedback.retrieval.checks_path,'checks');assert.equal(p.effect_state,null);assert.equal(p.inline_payload,undefined);assert.equal(envelope.visual_work_review,undefined);assert.equal(JSON.stringify(result),before);assert.equal(original.effect_state,'applied');
});
test('large capture diagnostics keep a useful error code and an honest scoped route to the full unmodified reason',async()=>{
 const {h}=host();h.capture=async()=>{throw Error('Command failed: '+'x'.repeat(3000)+'\nvisual_review_view_rectangle_stale\nFull private diagnostic');};
 const result=await reviewCurrentWork(request,h),original=JSON.stringify(result);
 const envelope={schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review'}],omitted:0,retrieval:'Retrieve missing fields.'};
 const wire=visualWorkReviewModelOutput({output:JSON.stringify(envelope)},result,'ev1_review'),feedback=JSON.parse(wire.output).evidence_projections[0].visual_work_review;
 assert.equal(feedback.reason_code,'visual_review_view_rectangle_stale');assert.equal(feedback.reason_complete,false);assert.equal(feedback.reason_summary.length,500);assert.equal(feedback.retrieval.reason_path,'reason');assert.equal(feedback.state,'unavailable');assert.equal(feedback.coverage.total,0);assert.equal(JSON.stringify(result),original);assert(Buffer.byteLength(wire.output)<=8192);
});

test('optional absent reference accepts model null or empty output without attachment lookup',async()=>{
 for(const reference_filename of [undefined,null,'','  \t ']){
  const input={...request,reference_filename};assert.deepEqual(normalizeVisualReviewRequest(input),request);
  const {h,calls}=host();h.referenceImage=async()=>{throw Error('No reference requested');};
  const result=await reviewCurrentWork(input,h);assert.equal(result.state,'matched');assert.equal(result.reference,null);
  assert.equal(calls.providers.length,1);assert.equal(calls.providers[0].input[0].content.filter(c=>c.type==='input_image').length,1);
 }
 assert(VISUAL_WORK_REVIEW_TOOL.parameters.properties.reference_filename.type.includes('null'));
 assert.match(VISUAL_WORK_REVIEW_TOOL.parameters.properties.reference_filename.description,/null.*no reference|no reference.*null/i);
});

test('optional absence does not accept invalid types, paths or fake named references',async()=>{
 for(const reference_filename of [false,0,[],{},' '.repeat(241),'/',String.raw`C:\private.png`,'https://example.test/image.png'])
  assert.throws(()=>normalizeVisualReviewRequest({...request,reference_filename}),/reference_filename_invalid/);
 const {h,calls}=host();h.referenceImage=async()=>null;
 const result=await reviewCurrentWork({...request,reference_filename:'none'},h);
 assert.equal(result.state,'unavailable');assert.equal(result.reason,'visual_review_reference_unavailable');assert.equal(calls.providers.length,0);
});
test('separate review receives fresh actual pixels and location, never drafting history/tools/previous response',async()=>{
 const {h,calls}=host('mismatch'),r=await reviewCurrentWork(request,h);assert.equal(r.state,'mismatch');assert.equal(r.checks[0].correction,'Clear only the blank-row checkbox.');assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);assert.equal(r.authority,'supporting_visual_assessment');assert.equal(calls.contexts,3);assert.equal(calls.captures,2);assert.equal(calls.retained,1);assert.equal(calls.providers.length,1);
 const body=calls.providers[0];assert.equal(body.context_role,'independent_review');assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.reasoning_effort,'medium');assert.deepEqual(body.tools,[]);assert.equal(body.previous_response_id,undefined);assert.equal(body.input.length,1);assert.equal(body.input[0].content[1].image_url,'data:image/png;base64,'+image);assert.equal(body.input[0].content[1].detail,'original');const data=JSON.parse(body.input[0].content[0].text);assert.equal(data.location.view_id,41);assert.equal(data.location.view_name,'AIR DEVICE SCHEDULE');assert.equal(data.location.identity_authority,'cached_ui_identity_only');assert.equal(data.capture.evidence_id,'ev1_capture');assert(!JSON.stringify(body).includes('assistant_message'));
});
test('a supported mismatch feeds a fresh subsequent review without rewriting the earlier discrepancy',async()=>{const a=host('mismatch'),first=await reviewCurrentWork(request,a.h),saved=JSON.stringify(first);const b=host('matched');b.h.readContext=async()=>snapshot(1);const second=await reviewCurrentWork(request,b.h);assert.equal(second.state,'matched');assert.equal(first.state,'mismatch');assert.equal(JSON.stringify(first),saved);assert.equal(second.location.through_sequence,1);assert.equal(second.native_postcondition_verified,false);assert.match(first.guidance,/correct only/);assert.match(second.guidance,/not whole-task/);});
test('unclear pixels require inspection rather than an edit retry',async()=>{const {h}=host('uncertain'),r=await reviewCurrentWork(request,h);assert.equal(r.state,'uncertain');assert.match(r.guidance,/closer view/);assert.match(r.guidance,/not treat missing evidence/);});
test('pause, unknown-effect control or stale owner before review dispatches no capture or provider',async()=>{for(const reason of ['paused','unknown_effect_requires_reconciliation']){const {h,calls}=host();h.assertControl=async()=>{throw Error(reason);};const r=await reviewCurrentWork(request,h);assert.equal(r.state,'unavailable');assert.equal(r.reason,reason);assert.equal(calls.providers.length,0);assert.equal(calls.captures,0);}});
test('foreign owner after provider, including principal/doc/run/generation, cannot acquire a current match',async()=>{for(const k of ['principal_id','document_fingerprint','run_id','session_id','assignment_id','generation']){const {h,calls,setOwner}=host();h.requestResponse=async body=>{calls.providers.push(body);setOwner({...binding,[k]:k==='generation'?2:'other'});return response();};const r=await reviewCurrentWork(request,h);assert.equal(r.state,'unavailable',k);assert.equal(r.reason,'visual_review_owner_changed');assert.equal(calls.providers.length,1);}});
test('native changes, SaveAs session, process, epoch and view transitions during capture prevent provider execution',async()=>{for(const alter of [s=>{s.context.nativeChangeObservations.throughSequence=1;},s=>{s.context.document.sessionId='other';s.context.nativeChangeObservations.documentSessionId='other';},s=>{s.context.process_id=2;s.context.nativeChangeObservations.processId=2;},s=>{s.context.nativeChangeObservations.epoch='other';},s=>{s.context.document.activeView.id=42;}]){const {h,calls}=host();let n=0;h.readContext=async()=>{const s=snapshot();if(n++)alter(s);return s;};const r=await reviewCurrentWork(request,h);assert.equal(r.state,'unavailable');assert.equal(calls.providers.length,0);}});
test('a later model change while reviewer reasons invalidates the assessment instead of passing stale pixels',async()=>{const {h,calls}=host();let n=0;h.readContext=async()=>snapshot(++n===3?1:0);const r=await reviewCurrentWork(request,h);assert.equal(r.state,'unavailable');assert.equal(r.reason,'visual_review_scene_changed_during_review');assert.equal(r.reviewer_response_id,'resp_review');assert.equal(calls.providers.length,1);});
test('new user direction invalidates the old visual assessment without discarding its raw response',async()=>{const {h}=host();let direction='Remove the gap.';h.userRequest=()=>direction;h.requestResponse=async()=>{direction='Keep the gap instead.';return response();};const r=await reviewCurrentWork(request,h);assert.equal(r.ok,false);assert.equal(r.state,'unavailable');assert.equal(r.reason,'visual_review_user_direction_changed');assert.equal(r.raw_review_evidence.reviewer_response.id,'resp_review');assert(!JSON.stringify(r).includes('raw_review_evidence'));});
test('missing or stale cached identity fails promptly without ExternalEvent fallback or provider',async()=>{for(const value of [{}, {...snapshot(),state:'unavailable'},{...snapshot(),authority:'postcondition'},{...snapshot(),captured_at_utc:new Date(now-300001).toISOString()},{...snapshot(),captured_at_utc:new Date(now+5001).toISOString()}]){const {h,calls}=host();h.readContext=async()=>value;assert.equal((await reviewCurrentWork(request,h)).state,'unavailable');assert.equal(calls.captures,0);assert.equal(calls.providers.length,0);}});
test('actual named reference pixels are included only through the host attachment resolver',async()=>{const {h,calls}=host();h.referenceImage=async name=>({filename:name,image_url:'data:image/png;base64,'+image,evidence_ref:{evidence_id:'ev1_reference',content_hash:'sha256:'+'b'.repeat(64)}});const r=await reviewCurrentWork({...request,reference_filename:'office.png'},h);assert.equal(r.state,'matched');assert.equal(r.reference.evidence_id,'ev1_reference');assert.equal(calls.providers[0].input[0].content.filter(c=>c.type==='input_image').length,2);const data=JSON.parse(calls.providers[0].input[0].content[0].text);assert.equal(data.reference.filename,'office.png');});
test('actor cannot inject image paths, provider settings, native observations or malformed/partial check coverage',()=>{for(const input of [{...request,image_url:'https://untrusted/'},{...request,model:'other'},{...request,owner:binding},{...request,reference_filename:'C:/private.png'},{...request,checks:[request.checks[0],request.checks[0]]},{...request,view_id:-1}])assert.throws(()=>normalizeVisualReviewRequest(input));for(const change of [p=>{p.checks.pop();},p=>{p.checks[1].id='foreign';},p=>{p.checks[1].id='gap';},p=>{p.checks[0].status='passed';},p=>{p.checks[0].observed='';},p=>{p.whole_task_verified=true;}]){const r=response(),p=JSON.parse(r.output_text);change(p);assert.throws(()=>parseVisualWorkReview({...r,output_text:JSON.stringify(p)},request));}});
test('refusals, incomplete response, model tool calls, malformed JSON and review budget failure never trigger a hidden retry',async()=>{for(const value of [{...response(),status:'incomplete'},{...response(),output:[{type:'function_call',name:'local_shell'}]},{...response(),output:[{type:'message',content:[{type:'refusal'}]}]},{...response(),output_text:'not JSON'}]){const {h,calls}=host();h.requestResponse=async body=>{calls.providers.push(body);return value;};const r=await reviewCurrentWork(request,h);assert.equal(r.state,'unavailable');assert.equal(calls.providers.length,1);}const {h,calls}=host();h.requestResponse=async body=>{calls.providers.push(body);throw Error('provider_budget_exceeded');};const r=await reviewCurrentWork(request,h);assert.equal(r.state,'unavailable');assert.equal(r.reason,'provider_budget_exceeded');assert.equal(calls.providers.length,1);});
test('projection binds the actual host review to its retained artifact and bounds context',async()=>{const {h}=host('mismatch'),r=await reviewCurrentWork(request,h),o={output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review'}]})};const p=JSON.parse(modelText(visualWorkReviewModelOutput(o,r,'ev1_review').output));assert.equal(p.evidence_projections[0].visual_work_review.state,'mismatch');assert.equal(p.evidence_projections[0].visual_work_review.source_evidence_id,'ev1_review');assert.equal(p.evidence_projections[0].visual_work_review.native_postcondition_verified,false);assert.throws(()=>visualWorkReviewModelOutput(o,r,'ev1_foreign'));assert.throws(()=>visualWorkReviewModelOutput({...o,output:o.output.slice(0,-1)+',"padding":"'+'x'.repeat(32768)+'"}'},r,'ev1_review'),/budget/);});


test('combined review uses one provider request for visual checks and exact executed-code assessment',async()=>{
 const f=host(),packet={executions:[{call_id:'call_write',source:'executed source',transaction:{status:'committed'}}],coverage:{all_assignment_calls:false}};
 f.h.codeReviewPacket=async ids=>{assert.deepEqual(ids,['ev1_'+'A'.repeat(32)]);return packet;};
 f.h.requestResponse=async body=>{f.calls.providers.push(body);const r=response();const parsed=JSON.parse(r.output_text);parsed.code_review={status:'mismatch',observed:'Code also deletes unrelated equipment.',correction:'Restore only the unintended deletion through an authorized correction.'};r.output_text=JSON.stringify(parsed);return r;};
 const r=await reviewCurrentWork({...request,code_evidence_ids:['ev1_'+'A'.repeat(32)]},f.h);
 assert.equal(f.calls.providers.length,1);assert.equal(r.state,'mismatch');assert.equal(r.code_review.status,'mismatch');assert(r.checks.every(c=>c.status==='matched'));
 const input=JSON.parse(f.calls.providers[0].input[0].content[0].text);assert.deepEqual(input.executed_code,packet);assert.deepEqual(f.calls.providers[0].tools,[]);
 assert.equal(r.whole_task_verified,false);assert.equal(r.native_postcondition_verified,false);
});
test('combined review cannot accept omitted code assessment as a visual pass',async()=>{
 const f=host();f.h.codeReviewPacket=async()=>({executions:[]});const r=await reviewCurrentWork({...request,code_evidence_ids:['ev1_'+'A'.repeat(32)]},f.h);
 assert.equal(r.state,'unavailable');assert.equal(r.whole_task_verified,false);assert.equal(f.calls.providers.length,1);
});

test('cold continuation reuses a fresh registered-source read without original upload bytes in chat memory',()=>{
 const f=attachmentReadFixture();f.attachments=[];f.registeredAttachmentIds=['source'];
 const r=identityReview.resolveAttachmentReviewImage(f.selection,f);
 assert.equal(r.filename,'record.pdf');assert.equal(r.source_render.source_sha256,f.summary.sha256);
 assert.equal(r.image_url,'data:image/png;base64,'+image);
 assert.equal(r.source_render.source_identity_basis,'current_registered_attachment_read');
});
test('registered-source continuation cannot excuse missing receipts, foreign IDs or conflicting uploaded bytes',()=>{
 for(const kind of ['missing-receipt','foreign-id','duplicate-id','failed','changed-bytes','duplicate-upload','filename-path','malformed-summary']){
  const f=attachmentReadFixture();f.registeredAttachmentIds=['source'];
  if(kind==='changed-bytes')f.attachments[0].dataBase64=Buffer.from('changed').toString('base64');else if(kind==='duplicate-upload')f.attachments.push({...f.attachments[0]});else f.attachments=[];
  if(kind==='missing-receipt')f.receipts=[];if(kind==='foreign-id')f.registeredAttachmentIds=['foreign'];if(kind==='duplicate-id')f.registeredAttachmentIds=['source','source'];
  if(kind==='failed')f.receipts[0].status='failed';
  if(kind==='filename-path'){f.summary.source='c:/record.pdf';f.receipts[0].result.content[0].text=JSON.stringify(f.summary);}
  if(kind==='malformed-summary')f.receipts[0].result.content[0].text='{}';
  assert.throws(()=>identityReview.resolveAttachmentReviewImage(f.selection,f),undefined,kind);
 }
});

test('primary drafting observation delivers current model and source images without a reviewer or completion claim',async()=>{
 const f=host();f.h.referenceImage=async name=>({filename:name,image_url:'data:image/png;base64,'+image,evidence_ref:{evidence_id:'ev1_reference',content_hash:'sha256:'+'b'.repeat(64)}});
 const r=await reviewCurrentWork({...request,review_mode:'observe',reference_filename:'source.png'},f.h);
 assert.equal(r.state,'observed');assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);assert.equal(f.calls.providers.length,0);
 const o={type:'function_call_output',call_id:'call_observe',output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_observe'}]})};
 const delivered=visualWorkReviewModelOutput(o,r,'ev1_observe');assert(Array.isArray(delivered.output));assert.equal(delivered.output.filter(x=>x.type==='input_image').length,2);
 assert.equal(delivered.output[1].image_url,'data:image/png;base64,'+image);assert.equal(delivered.output[2].image_url,'data:image/png;base64,'+image);
 const text=JSON.parse(delivered.output[0].text);assert.equal(text.evidence_projections[0].visual_work_review.state,'observed');assert.equal(text.evidence_projections[0].visual_work_review.native_postcondition_verified,false);
 assert(!JSON.stringify(r).includes('image_url'),'Pixels are model inputs, not repeated raw JSON');
});

test('ordinary primary observation needs no invented reviewer checklist',async()=>{
 const f=host(),{checks,...observation}=request;
 const r=await reviewCurrentWork({...observation,review_mode:'observe'},f.h);
 assert.equal(r.ok,true);assert.equal(r.state,'observed');assert.deepEqual(r.checks,[]);
 assert.equal(f.calls.providers.length,0);assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
 assert.throws(()=>normalizeVisualReviewRequest(observation),'Independent review still requires explicit visual checks');
});

test('a completed independent review also returns its actual work pixels for primary correction',async()=>{
 const f=host();f.h.referenceImage=async name=>({filename:name,image_url:'data:image/png;base64,'+image,evidence_ref:{evidence_id:'ev1_reference',content_hash:'sha256:'+'b'.repeat(64)}});
 const result=await reviewCurrentWork({...request,reference_filename:'source.png'},f.h);assert.equal(result.ok,true);
 const output=visualWorkReviewModelOutput({type:'function_call_output',call_id:'review',output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review'}]})},result,'ev1_review');
 assert(Array.isArray(output.output));assert.equal(output.output.filter(x=>x.type==='input_image').length,2);
 assert.equal(f.calls.providers.length,1,'No extra review/capture API round to let the primary see what was judged.');
 const feedback=JSON.parse(output.output[0].text).evidence_projections[0].visual_work_review;
 assert.equal(feedback.native_postcondition_verified,false);assert.equal(feedback.whole_task_verified,false);
});
test('observation cannot close inspection or request code approval, and stale or foreign captures remain unavailable',async()=>{
 for(const extra of [{complete_inspection_item_id:'inspect'},{code_evidence_ids:['ev1_code']},{recheck_evidence_id:'ev1_old'}])assert.throws(()=>normalizeVisualReviewRequest({...request,review_mode:'observe',...extra}));
 for(const fault of ['native-change','foreign-owner']){const f=host();let n=0;f.h.readContext=async()=>{const s=snapshot();if(n++&&fault==='native-change')s.context.nativeChangeObservations.throughSequence=1;return s;};
 if(fault==='foreign-owner')f.h.capture=async()=>{f.setOwner({...binding,run_id:'foreign'});return {image_base64:image,frame:snapshot().frame};};
 const r=await reviewCurrentWork({...request,review_mode:'observe'},f.h);assert.equal(r.state,'unavailable');assert.equal(f.calls.providers.length,0);}
});
