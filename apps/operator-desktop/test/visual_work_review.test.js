const modelText = output => Array.isArray(output) ? output.find(item => item.type === 'input_text').text : output;
import {focusedEvidenceFailureOutputV1} from '@revitoperator/assignment-kernel-v2-contracts/focused-evidence';
import test,{after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {runInNewContext} from 'node:vm';
import * as shared from '../visual_work_review.mjs';import {projectSidecarFunctionOutput,persistSidecarEvidence}from '../evidence_projection.js';
import {assertBoundedModelEvidencePayload,modelEvidenceEnvelope} from '../../operator-backend/dist/src/evidence/model_context_budget.js';
import {storeEvidence,retrieveEvidence} from '../../operator-backend/dist/src/evidence/evidence_store.js';
import {__closeForTests} from '../../operator-backend/dist/src/memory/sqlite_store.js';
import {createHash} from 'node:crypto';
import {reviewTestPng} from '../../../packages/operator-assistant-ui/fixtures/visual-review-image.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'visual-work-review-')),keys=['OPERATOR_DESKTOP_NO_LISTEN','OPERATOR_WORKSPACE_ROOT'],prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));Object.assign(process.env,{OPERATOR_DESKTOP_NO_LISTEN:'1',OPERATOR_WORKSPACE_ROOT:temp});
after(()=>{__closeForTests();for(const[k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(temp,{recursive:true,force:true});});
const desktop=await import('../server.js?visual-work-review'),source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');

test('ordinary visual check defaults to primary actor pixels without a reviewer or full task publication',async()=>{
 const {o}=pdfReferenceOptions();
 o.owner=()=>({...owner,kernel_version:2});

 o.readBackend=async()=>{throw Error('Observation must not retrieve the complete task for a reviewer');};
 o.requestResponse=async()=>{throw Error('Routine observation must not call another model');};
 const result=await desktop.reviewCurrentRevitWork({view_id:41,checks:args.checks,reference_attachment_read:{call_id:'call_pdf',page:1}},o);
 assert.equal(result.state,'observed',result.reason);assert.equal(result.request.review_mode,'observe');
 assert.equal(result.request_dispatched,false);assert.equal(result.whole_task_verified,false);
 assert.equal(result.native_postcondition_verified,false);assert(result.capture&&result.reference);
 const output=shared.visualWorkReviewModelOutput({output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[{evidence_id:'ev1_review'}]})},result,'ev1_review');
 assert.equal(output.output.filter(x=>x.type==='input_image').length,2,'Both actual images must reach the actor');
});

test('production visual wrapper persists encrypted-review references and keeps readable secret rejection',async()=>{
 const o=options(),opaque='gAAAA'+'a'.repeat(80)+'-sk-'+'b'.repeat(32)+'_tail';
 const response={id:'resp_review',status:'completed',output:[{type:'reasoning',id:'rs_review',summary:[],encrypted_content:opaque}],output_text:JSON.stringify({checks:[{id:'gap',status:'matched',observed:'No blank row remains.',correction:''}]})};
 const original=JSON.stringify(response);o.requestResponse=async()=>response;
 const result=await desktop.reviewCurrentRevitWork(args,o);
 assert.equal(result.state,'matched');assert.equal(JSON.stringify(response),original);
 const raw={...result,raw_review_evidence:result.raw_review_evidence};
 const saved=storeEvidence({scope:owner,source:'operator_desktop.function.review_current_work',trust_level:'untrusted_caller',verification_relevance:'supporting',raw},8192);
 assert(saved.ref.evidence_id);assert.equal(result.whole_task_verified,false);
 assert.equal(raw.raw_review_evidence.reviewer_response.output[0].encrypted_content_ref.response_id,response.id);
 const negative=structuredClone(raw);negative.raw_review_evidence.reviewer_response.output_text=opaque;
 assert.throws(()=>storeEvidence({scope:owner,source:'operator_desktop.function.review_current_work',trust_level:'untrusted_caller',raw:negative},8192),/secret screening/);
});

test('code-only production wrapper uses same reviewer transport without reading Revit or capturing the desktop',async()=>{
 const o=options();let requested=0;
 o.readContext=async()=>{throw Error('Code-only review must not read Revit');};o.capture=async()=>{throw Error('Code-only review must not capture');};
 o.codeReviewPacket=async ids=>({schema:'operator.native-code-review-packet/v1',executions:ids.map(id=>({call_id:id,evidence_id:'ev1_code',content_hash:'sha256:'+'a'.repeat(64),source_sha256:'sha256:'+'b'.repeat(64),source:'executed code'})),coverage:{all_assignment_calls:false}});
 o.requestResponse=async body=>{requested++;assert.deepEqual(body.tools,[]);assert.equal(body.input[0].content.length,1);assert.equal(body.model,'gpt-6.1-sol');return{id:'resp_code',status:'completed',output:[],output_text:JSON.stringify({code_review:{status:'matched',observed:'The selected code changes only the requested parameter.',correction:''}})};};
 const r=await desktop.reviewCurrentRevitWork({review_mode:'code_execution',code_evidence_ids:['ev1_'+'A'.repeat(32)]},o);
 assert.equal(requested,1);assert.equal(r.schema,'operator.native_code_review.v1');assert.equal(r.state,'matched');
 assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);assert.equal(r.capture,undefined);
});
const owner={assignment_id:'assignment',session_id:'session',run_id:'run',generation:1},args={review_mode:'independent',view_id:41,checks:[{id:'gap',expected:'No extra blank row.'}]},image='iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAcSURBVFhH7cEBAQAAAIIg/69uSEABAAAAAAB8GhkoAAFF1RG0AAAAAElFTkSuQmCC';
const frameContext={main_window_handle:'0x123',main_window_bounds:{x:0,y:0,width:100,height:100},view_rectangle:{x:10,y:10,width:40,height:40}};
function focused(){return {image_base64:image,frame:{schema:'operator.visual_review_capture.v1',kind:'revit_view',process_id:123,view_id:41,main_window_handle:'0x123',foreground_window_handle:'0x123',rectangle:{...frameContext.view_rectangle},captured_at_utc:new Date().toISOString(),selection_authority:'native_view_or_owned_modal',occlusion_check:'nine_point_screen_grid_not_pixel_exhaustive'}};}
const scene=()=>({schema:'revit-operator.ui-context/v1',state:'available',authority:'ui_identity_only',revision:1,captured_at_utc:new Date().toISOString(),context:{visual_capture_context:frameContext,process_id:123,document:{sessionId:'doc',title:'Mechanical',activeView:{id:41,name:'AIR DEVICE SCHEDULE',type:'Schedule'}},nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:123,epoch:'epoch',documentSessionId:'doc',throughSequence:0,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]}}});
function options(){const calls=[];return{calls,owner:()=>owner,assertControl:async()=>{calls.push('control');},readContext:async()=>{calls.push('context');return scene();},capture:async()=>focused(),retainImage:async()=>({ref:{evidence_id:'ev1_capture',content_hash:'sha256:'+'a'.repeat(64),byte_count:69}}),settings:()=>({model:'gpt-6.1-sol',reasoning_effort:'medium'}),userRequest:()=> 'Remove the schedule gap.',evidenceScope:()=>({session_id:owner.session_id,assignment_id:owner.assignment_id}),requestResponse:async body=>{calls.push(body);return{id:'resp_review',status:'completed',output:[],output_text:JSON.stringify({checks:[{id:'gap',status:'mismatch',observed:'Blank row before data is checked.',correction:'Clear that checkbox.'}]})};}};}

function pdfReferenceOptions(){
 const o=options(),pdf=Buffer.from('%PDF-1.7 source'),sha=createHash('sha256').update(pdf).digest('hex');
 const receipt={call_id:'call_pdf',tool_name:'native__operator_read_attachment',status:'success',arguments:{attachment_id:'source',pages:[1],mode:'detail'},result:{ok:true,native_stop_reason:null,content:[
  {type:'inputText',text:JSON.stringify({source:'record.pdf',attachment_id:'source',sha256:sha,mode:'detail',pages_returned:[1],coverage:[{page:1,visual_scope:'full_page',image_bytes:Buffer.from(image,'base64').length}]})},
  {type:'inputImage',imageUrl:'data:image/png;base64,'+image}]}};
 o.attachmentReadReceipts=()=>[receipt];o.referenceAttachments=()=>[{id:'source',filename:'record.pdf',mime:'application/pdf',dataBase64:pdf.toString('base64')}];
 o.retainReferenceImage=async bytes=>({ref:{evidence_id:'ev1_source',content_hash:'sha256:'+createHash('sha256').update(bytes).digest('hex'),byte_count:bytes.length}});
 return {o,receipt};
}
test('production wrapper forwards exact already-delivered PDF pixels and metadata to one existing reviewer',async()=>{
 const {o}=pdfReferenceOptions();const r=await desktop.reviewCurrentRevitWork({...args,reference_attachment_read:{call_id:'call_pdf',page:1}},o);
 assert.equal(r.ok,true);assert.equal(r.state,'mismatch');assert.equal(r.reference.source_render.page,1);
 const bodies=o.calls.filter(x=>typeof x==='object');assert.equal(bodies.length,1);
 assert.equal(bodies[0].input[0].content.filter(c=>c.type==='input_image').length,2);
 assert.equal(JSON.parse(bodies[0].input[0].content[0].text).reference.source_render.visual_scope,'full_page');
 assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
});
for(const bad of ['foreign','failed','changed-source','pause','owner-change','hash'])test('production PDF reference refuses '+bad+' before reviewer',async()=>{
 const {o,receipt}=pdfReferenceOptions();
 if(bad==='foreign')o.attachmentReadReceipts=()=>[];if(bad==='failed')receipt.status='failed';
 if(bad==='changed-source')o.referenceAttachments=()=>[];
 if(bad==='pause')o.assertControl=async()=>{throw Error('Paused');};
 if(bad==='owner-change'){const retain=o.retainReferenceImage;let changed=false;o.owner=()=>changed?{...owner,run_id:'other'}:owner;o.retainReferenceImage=async b=>{changed=true;return retain(b);};}
 if(bad==='hash')o.retainReferenceImage=async()=>({ref:{evidence_id:'ev1_source',content_hash:'sha256:'+'f'.repeat(64)}});
 const r=await desktop.reviewCurrentRevitWork({...args,reference_attachment_read:{call_id:'call_pdf',page:1}},o);
 assert.equal(r.state,'unavailable');assert.equal(o.calls.filter(x=>typeof x==='object').length,0);assert.equal(r.whole_task_verified,false);
});

test('production default identity reader preserves a rejected post-review ping at the actual wrapper boundary',async()=>{
 const start=source.indexOf('async function reviewCurrentRevitWork('),end=source.indexOf('function formatRevitContextMessage(',start);
 const o=options();delete o.readContext;let pings=0;
 const invoke=runInNewContext(source.slice(start,end)+';reviewCurrentRevitWork',{
  JSON,Buffer,Date,Error,AbortSignal,performance,reviewCurrentWork:shared.reviewCurrentWork,visualReviewOwner:shared.visualReviewOwner,sameVisualReviewOwner:shared.sameVisualReviewOwner,
  readVisualReviewUiIdentityV1:shared.readVisualReviewUiIdentityV1,
  fetchRevitBridge:async route=>{assert.equal(route,'/revit/ping');pings++;return pings===3
   ?new Response(JSON.stringify({code:'REVIT_CONTEXT_HOST_UNAVAILABLE',request_dispatched:false,outcome_unknown:false,retryable:true,reconciliation_required:false,error:'private response details'}),{status:409})
   :new Response(JSON.stringify({ui_context:scene()}));},addComputerEvent(){}
 });
 const r=await invoke(args,o);assert.equal(r.reason,'visual_review_native_identity_unavailable');assert.equal(r.state,'unavailable');assert.equal(pings,3);
 assert.equal(o.calls.filter(x=>typeof x==='object').length,1);assert.equal(r.identity_read_failure.http_status,409);assert.equal(r.identity_read_failure.native_error_code,'REVIT_CONTEXT_HOST_UNAVAILABLE');
 assert.equal(r.raw_review_evidence.native_identity_failure.request_dispatched,false);assert.equal(r.reviewer_response_id,'resp_review');assert.deepEqual(Array.from(r.checks),[]);
 assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);assert(!JSON.stringify(r).includes('private response details'));
});
test('actual production wrapper uses separate tool-free visual request and returns a targeted mismatch',async()=>{const o=options(),r=await desktop.reviewCurrentRevitWork(args,o);assert.equal(r.state,'mismatch');assert.equal(o.calls.filter(x=>x==='context').length,3);const p=o.calls.find(x=>typeof x==='object');assert.deepEqual(p.tools,[]);assert.equal(p.previous_response_id,undefined);assert.equal(p.model,'gpt-6.1-sol');assert.equal(p.reasoning_effort,'medium');assert.equal(r.native_postcondition_verified,false);});
test('actual tool dispatcher keeps host review authority out of actor JSON and raw evidence remains private',async()=>{const a=source.indexOf('async function executeFunctionToolCall(toolCall)'),z=source.indexOf('async function executeFunctionToolCallSafely',a),result={schema:'operator.visual_work_review.v1',state:'mismatch',native_postcondition_verified:false,checks:[{id:'gap',observed:'Blank row remains.'}]};Object.defineProperty(result,'raw_review_evidence',{value:{reviewer_response:{id:'resp_review'}}});const invoke=runInNewContext(source.slice(a,z)+';executeFunctionToolCall',{JSON,reviewCurrentRevitWork:async input=>{assert.equal(input.view_id,41);return result;}});const out=await invoke({name:'review_current_work',call_id:'review',arguments:JSON.stringify(args)});assert.equal(out.raw_evidence.raw_review_evidence.reviewer_response.id,'resp_review');assert.equal(out.host_visual_work_review,result);assert(!JSON.stringify(out).includes('host_visual_work_review'));assert(!out.output.includes('raw_review_evidence'));assert.equal(JSON.parse(out.output).state,'mismatch');});
test('actual projection boundary delivers reviewer discrepancy even if generic evidence projection omits it',async()=>{const raw=await desktop.reviewCurrentRevitWork(args,options());const tool={name:'review_current_work',call_id:'review',arguments:JSON.stringify(args)},out={type:'function_call_output',call_id:'review',output:JSON.stringify(raw)};Object.defineProperty(out,'raw_evidence',{value:raw});Object.defineProperty(out,'host_visual_work_review',{value:raw});const stored=[];
 const store=async body=>{stored.push(body);const size=Buffer.byteLength(JSON.stringify(body.raw_json)),ref={schema:'revit-operator.evidence-ref.v1',evidence_id:'ev1_review',content_hash:'sha256:'+'b'.repeat(64),byte_count:size};return{ok:true,ref,projection:{schema:'revit-operator.evidence-projection.v1',evidence_id:ref.evidence_id,content_hash:ref.content_hash,byte_count:size,projected_bytes:100,truncated:true},stored_unique_bytes:size,duplicate_bytes_avoided:0};};
 const a=source.indexOf('async function retainAndProjectFunctionOutput('),z=source.indexOf('async function retainScreenshotEvidence(',a);const project=runInNewContext(source.slice(a,z)+';retainAndProjectFunctionOutput',{...shared,focusedEvidenceFailureOutputV1,Date,JSON,Buffer,currentSidecarEvidenceScope:()=>owner,projectSidecarFunctionOutput,recordSidecarEvidencePerformance:()=>{}});const p=JSON.parse(modelText((await project(tool,out,{storeEvidence:store})).model_output.output));assert.equal(p.evidence_projections[0].visual_work_review.state,'mismatch');assert.equal(p.evidence_projections[0].visual_work_review.checks[0].correction,'Clear that checkbox.');assert.equal(p.evidence_projections[0].visual_work_review.source_evidence_id,'ev1_review');assert.equal(stored[0].raw_json.state,'mismatch');assert.equal(stored[0].verification_relevance,'supporting');
 const forged=JSON.parse((await project(tool,{type:'function_call_output',call_id:'fake',output:JSON.stringify(raw)},{storeEvidence:store})).model_output.output);assert.equal(forged.evidence_projections[0].visual_work_review,undefined);
});
test('general tool catalog and guidance expose iterative review, direct-only transport does not grow new tools',()=>{assert(desktop.buildComputerTools().some(t=>t.name==='review_current_work'));assert(!desktop.buildComputerTools({deterministicDelegateOnly:true}).some(t=>t.name==='review_current_work'));assert.match(desktop.SAFETY_INSTRUCTIONS,/review_current_work/);});
test('shared and actual deployed reviewer contract bytes agree',()=>{assert.equal(fs.readFileSync(new URL('../visual_work_review.mjs',import.meta.url),'utf8'),fs.readFileSync(new URL('../../../packages/operator-assistant-ui/visual_work_review.mjs',import.meta.url),'utf8'));});

test('retained168 production recheck reads bound before pixels and original checks from canonical scoped evidence',async()=>{
 const {readVisualReviewBaseline}=await import('../../operator-backend/dist/src/evidence/visual_review_baseline.js');
 const beforeOptions=options();beforeOptions.retainImage=async pixels=>storeEvidence({scope:owner,source:'operator_desktop.screenshot',trust_level:'untrusted_caller',media_type:'image/png',raw:Buffer.from(pixels,'base64')},8192);
 const before=await desktop.reviewCurrentRevitWork(args,beforeOptions);
 const saved=storeEvidence({scope:owner,source:'operator_desktop.function.review_current_work',trust_level:'untrusted_caller',raw:{...before,raw_review_evidence:before.raw_review_evidence}},8192);
 const receipt={tool_name:'review_current_work',status:'success',result:before,evidence_ref:saved.ref};
 const o=options(),reads=[];o.readContext=async()=>{const s=scene();s.context.nativeChangeObservations.throughSequence=1;return s;};
 o.reviewReceipts=()=>[receipt];o.readBaselineEvidence=async body=>{reads.push(body);return{ok:true,result:readVisualReviewBaseline(body)};};
 o.requestResponse=async body=>{o.calls.push(body);return{id:'resp_recheck',status:'completed',output:[],output_text:JSON.stringify({checks:[{id:'gap',status:'matched',observed:'Synthetic corrected gap compared to before pixels.',correction:''}]})};};
 const r=await desktop.reviewCurrentRevitWork({review_mode:'independent',view_id:41,recheck_evidence_id:saved.ref.evidence_id},o);assert.equal(r.state,'matched');assert.deepEqual(r.request.checks,args.checks);assert.equal(reads.length,1);assert.equal(reads[0].content_hash,saved.ref.content_hash);
 const body=o.calls.find(v=>typeof v==='object'),content=body.input[0].content;assert.equal(content.filter(c=>c.type==='input_image').length,2);assert.equal(content[2].image_url,'data:image/png;base64,'+image);assert.deepEqual(body.tools,[]);assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
 for(const altered of [[],[{...receipt,status:'failed'}],[{...receipt,result:{...before,owner:{...before.owner,run_id:'foreign'}}}]]){const blocked=options();blocked.reviewReceipts=()=>altered;blocked.readBaselineEvidence=async()=>{throw Error('Unowned evidence must not be fetched');};const result=await desktop.reviewCurrentRevitWork({view_id:41,recheck_evidence_id:saved.ref.evidence_id},blocked);assert.equal(result.state,'unavailable');assert.equal(result.reason,'visual_review_baseline_not_owned_receipt');assert.equal(blocked.calls.filter(v=>typeof v==='object').length,0);}
});

test('production correction recheck carries newly selected code and canonical before pixels through one reviewer',async()=>{
 const {readVisualReviewBaseline}=await import('../../operator-backend/dist/src/evidence/visual_review_baseline.js');
 const initial=options();initial.retainImage=async pixels=>storeEvidence({scope:owner,source:'operator_desktop.screenshot',trust_level:'untrusted_caller',media_type:'image/png',raw:Buffer.from(pixels,'base64')},8192);
 const before=await desktop.reviewCurrentRevitWork(args,initial);
 const saved=storeEvidence({scope:owner,source:'operator_desktop.function.review_current_work',trust_level:'untrusted_caller',raw:{...before,raw_review_evidence:before.raw_review_evidence}},8192);
 const o=options(),ids=['ev1_'+'A'.repeat(32)],packet={executions:[{evidence_id:ids[0],source:'actual correction',transaction:{status:'committed'}}],coverage:{all_assignment_calls:false}};let codeReads=0;
 o.reviewReceipts=()=>[{tool_name:'review_current_work',status:'success',result:before,evidence_ref:saved.ref}];
 o.readBaselineEvidence=async body=>({ok:true,result:readVisualReviewBaseline(body)});
 o.codeReviewPacket=async selected=>{codeReads++;assert.deepEqual(selected,ids);return packet;};
 o.requestResponse=async body=>{o.calls.push(body);return{id:'combined_recheck',status:'completed',output:[],output_text:JSON.stringify({checks:[{id:'gap',status:'matched',observed:'Corrected gap.',correction:''}],code_review:{status:'matched',observed:'Selected correction is in scope.',correction:''}})};};
 const r=await desktop.reviewCurrentRevitWork({view_id:41,recheck_evidence_id:saved.ref.evidence_id,code_evidence_ids:ids},o);
 assert.equal(r.state,'matched');assert.equal(codeReads,1);const bodies=o.calls.filter(v=>typeof v==='object');assert.equal(bodies.length,1);
 assert.deepEqual(JSON.parse(bodies[0].input[0].content[0].text).executed_code,packet);assert.equal(bodies[0].input[0].content.filter(c=>c.type==='input_image').length,2);
 assert.equal(r.whole_task_verified,false);assert.equal(r.native_postcondition_verified,false);
});

test('actual production target wrapper uses protected native context/export and delivers inactive-target pixels to the separate reviewer',async()=>{
 const captureDir=path.join(temp,'artifacts','captures');fs.mkdirSync(captureDir,{recursive:true});const file=path.join(captureDir,'Revit_41_20261102120000_'+'a'.repeat(32)+'.png'),bytes=Buffer.from(image,'base64');fs.writeFileSync(file,bytes);
 const o=options(),nativeCalls=[],admissions=[];o.readContext=async()=>{const s=scene();s.context.document.activeView.id=7;return s;};
 o.runCaptureScript=async argv=>{admissions.push(argv);assert.equal(argv[1],'review_native_read_admission');const s=JSON.parse(Buffer.from(argv[3],'base64').toString('utf8'));assert.equal(s.process_id,123);return JSON.stringify({schema:'operator.visual_review_native_read_admission.v1',process_id:123,main_window_handle:'0x123',main_window_enabled:true});};
 o.fetchNative=async(route,init)=>{nativeCalls.push({route,init});const settlement={method:init.method,path:route,requested_effect:'read',effect_state:'none'};
  if(route==='/revit/context'){const context=scene().context;context.document.projectIdentity={fingerprint:'project'};return new Response(JSON.stringify({...context,canonical_attempt_settlement:settlement}));}
  assert.equal(route,'/revit/export-image');assert.deepEqual(JSON.parse(init.body),{viewId:41,imageSize:4000,exportMode:'full_view'});
  fs.writeFileSync(file,bytes);
  return new Response(JSON.stringify({processId:123,documentSessionId:'doc',projectFingerprint:'project',viewId:41,activeViewId:7,viewName:'Notes, Symbols & Schedules',viewUniqueId:'target-unique',viewType:'DrawingSheet',sheetNumber:'M002',exportMode:'full_view',
   path:file,widthPx:40,heightPx:40,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),timestamp:new Date().toISOString(),canonical_attempt_settlement:settlement}));};
 delete o.retainImage;o.storeImageEvidence=async body=>({ok:true,...storeEvidence({...body,raw:Buffer.from(body.raw_base64,'base64')},8192)});
 const result=await desktop.reviewCurrentRevitWork({...args,capture_mode:'target_view'},o);assert.equal(result.state,'mismatch');assert.equal(result.location.sheet_number,'M002');assert.equal(result.capture.frame.kind,'native_target_view');assert.equal(nativeCalls.length,6);assert.equal(admissions.length,6);
 assert.equal(o.calls.filter(x=>typeof x==='object').length,1);const reviewer=o.calls.find(x=>typeof x==='object');assert.deepEqual(reviewer.tools,[]);assert.equal(reviewer.input[0].content[1].image_url,'data:image/png;base64,'+image);
 assert(!fs.existsSync(file),'Autogenerated duplicate is gone after durable retention; reviewer still received exact pixels');
 assert.equal(fs.readFileSync(new URL('../native_target_review_image.mjs',import.meta.url),'utf8'),fs.readFileSync(new URL('../../../packages/operator-assistant-ui/native_target_review_image.mjs',import.meta.url),'utf8'));
});

test('production focused native review uses protected visible-region export and root-confined pixels without screen fallback',async()=>{
 const captureDir=path.join(temp,'artifacts','captures');fs.mkdirSync(captureDir,{recursive:true});const file=path.join(captureDir,'region-wrapper.png'),bytes=Buffer.from(image,'base64');fs.writeFileSync(file,bytes);
 const o=options(),routes=[],admissions=[];o.capture=async()=>{throw Error('No tooltip/screenshot fallback');};
 o.runCaptureScript=async argv=>{admissions.push(argv);assert.equal(argv[1],'review_native_read_admission');return JSON.stringify({schema:'operator.visual_review_native_read_admission.v1',process_id:123,main_window_handle:'0x123',main_window_enabled:true});};
 o.fetchNative=async(route,init)=>{routes.push(route);const settlement={method:init.method,path:route,requested_effect:'read',effect_state:'none'};
  if(route==='/revit/context'){const c=scene().context;c.document.projectIdentity={fingerprint:'project'};return new Response(JSON.stringify({...c,canonical_attempt_settlement:settlement}));}
  assert.equal(route,'/revit/export-image');assert.deepEqual(JSON.parse(init.body),{viewId:41,imageSize:4000,exportMode:'visible_region'});
  return new Response(JSON.stringify({processId:123,documentSessionId:'doc',projectFingerprint:'project',viewId:41,activeViewId:41,viewName:'Notes, Symbols & Schedules',viewUniqueId:'region-unique',viewType:'DrawingSheet',sheetNumber:'M002',exportMode:'visible_region',viewport:{source:'UIDocument.ActiveView/UIView.GetZoomCorners',viewId:41,viewType:'DrawingSheet',zoomCornersXyz:[[-1,1,0],[1,-1,0]],coordinateUnits:'feet',displayPlaneOnly:true,placementMappingAvailable:false},path:file,widthPx:40,heightPx:40,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),timestamp:new Date().toISOString(),canonical_attempt_settlement:settlement}));};
 o.retainImage=async pixels=>({ref:{evidence_id:'ev1_region',content_hash:'sha256:'+createHash('sha256').update(Buffer.from(pixels,'base64')).digest('hex'),byte_count:bytes.length}});
 const r=await desktop.reviewCurrentRevitWork({...args,capture_mode:'native_visible_region'},o);assert.equal(r.state,'mismatch');assert.equal(r.capture.frame.export_mode,'visible_region');assert.deepEqual(r.capture.frame.viewport.zoomCornersXyz,[[-1,1,0],[1,-1,0]]);assert.equal(routes.filter(r=>r==='/revit/export-image').length,2);assert.equal(admissions.length,routes.length);assert.equal(o.calls.filter(x=>typeof x==='object').length,1);assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
 const timing=r.raw_review_evidence.host_stage_timings;assert.equal(timing.schema,'operator.visual_review_host_timing.v1');assert(timing.elapsed_ms>=0);
 assert.equal(timing.stages.native_read.calls,routes.length);assert.equal(timing.stages.native_read_admission.calls,admissions.length);
 assert.equal(timing.stages.ui_identity.calls,routes.length);assert(timing.stages.assignment_control.calls>routes.length);
 for(const row of Object.values(timing.stages)){assert.deepEqual(Object.keys(row).sort(),['calls','elapsed_ms']);assert(row.elapsed_ms>=0);}
 assert.equal(Object.keys(r).includes('raw_review_evidence'),false,'timing stays in retained host evidence, not model context');
 routes.length=0;admissions.length=0;o.calls.length=0;
 o.focusTarget=async()=>({ok:true,active_view:{id:41},focus:{confirmed:true,kind:'elements',native_navigation_only:true}});
 const observed=await desktop.reviewCurrentRevitWork({...args,capture_mode:'native_visible_region',review_mode:'observe',focus_element_ids:[101]},o);
 assert.equal(observed.state,'observed');assert.equal(routes.filter(r=>r==='/revit/context').length,4);assert.equal(routes.filter(r=>r==='/revit/export-image').length,1);
 assert.equal(admissions.length,routes.length,'every remaining native read still has modal admission');
 assert.equal(o.calls.filter(x=>typeof x==='object').length,0,'observation does not invoke another model');
 assert.equal(observed.raw_review_evidence.host_stage_timings.stages.native_read.calls,5);
});

test('modal native-read admission stops target export before any queued Revit callback or provider; no hidden screen fallback',async()=>{
 const o=options();let nativeCalls=0,captures=0;o.fetchNative=async()=>{nativeCalls++;throw Error('Must not queue behind modal');};o.runCaptureScript=async()=>{throw Error('visual_review_native_read_blocked_by_modal');};o.capture=async()=>{captures++;return focused();};
 const result=await desktop.reviewCurrentRevitWork({...args,capture_mode:'target_view'},o);assert.equal(result.state,'unavailable');assert.equal(result.reason,'visual_review_native_read_blocked_by_modal');assert.equal(nativeCalls,0);assert.equal(captures,0);assert.equal(o.calls.filter(x=>typeof x==='object').length,0);
});

test('exact167 production protected export path bounds native resolution once, preserving all identity admission and recheck calls',async()=>{
 const fixture=JSON.parse(fs.readFileSync(new URL('../../../packages/operator-assistant-ui/fixtures/visual-review-resolution167.json',import.meta.url),'utf8'));
 const captureDir=path.join(temp,'artifacts','captures');fs.mkdirSync(captureDir,{recursive:true});const o=options(),exports=[],admissions=[];
 o.readContext=async()=>scene();o.runCaptureScript=async argv=>{admissions.push(argv);return JSON.stringify({schema:'operator.visual_review_native_read_admission.v1',process_id:123,main_window_handle:'0x123',main_window_enabled:true});};
 o.fetchNative=async(route,init)=>{const settlement={method:init.method,path:route,requested_effect:'read',effect_state:'none'};
  if(route==='/revit/context'){const context=scene().context;context.document.projectIdentity={fingerprint:'project'};return new Response(JSON.stringify({...context,canonical_attempt_settlement:settlement}));}
  assert.equal(route,'/revit/export-image');const body=JSON.parse(init.body);assert.equal(body.exportMode,'full_view');assert.equal(body.viewId,fixture.request.view_id);exports.push(body.imageSize);
  const width=body.imageSize,height=Math.floor(width*4285/6000),bytes=reviewTestPng(width,height),file=path.join(captureDir,'resolution-'+exports.length+'.png');fs.writeFileSync(file,bytes);
  return new Response(JSON.stringify({processId:123,documentSessionId:'doc',projectFingerprint:'project',viewId:body.viewId,viewUniqueId:'target-unique',viewName:'Notes, Symbols & Schedules',viewType:'DrawingSheet',sheetNumber:'M002',exportMode:'full_view',path:file,widthPx:width,heightPx:height,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),timestamp:new Date().toISOString(),canonical_attempt_settlement:settlement}));};
 o.retainImage=async pixels=>({ref:{evidence_id:'ev1_resolution',content_hash:'sha256:'+createHash('sha256').update(Buffer.from(pixels,'base64')).digest('hex'),byte_count:Buffer.from(pixels,'base64').length}});
 o.requestResponse=async body=>{o.calls.push(body);return{id:'resp_resolution',status:'completed',output:[],output_text:JSON.stringify({checks:[{id:'no-spacer',status:'mismatch',observed:'Synthetic blank row.',correction:'Remove the extra row.'}]})};};
 const r=await desktop.reviewCurrentRevitWork({...fixture.request,review_mode:'independent'},o);assert.equal(r.state,'mismatch');assert.equal(exports.length,3);assert.equal(exports[0],6000);assert.equal(exports[1],exports[2]);assert(exports[1]<6000);assert.equal(admissions.length,8);assert.equal(o.calls.filter(x=>typeof x==='object').length,1);assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
});
test('exact167 valid visible-work mode with irrelevant size reaches actual wrapper focused capture checks',async()=>{
 const fixture=JSON.parse(fs.readFileSync(new URL('../../../packages/operator-assistant-ui/fixtures/visual-review-resolution167.json',import.meta.url),'utf8'));const o=options();
 const result=await desktop.reviewCurrentRevitWork({...fixture.next_request,review_mode:'independent',view_id:args.view_id,checks:args.checks},o);assert.equal(result.state,'mismatch');assert.equal(result.request.image_size,undefined);assert.equal(result.capture.frame.kind,'revit_view');
});
test('modal-safe production identity reader uses authenticated ping rather than a queued model context callback',()=>{const start=source.indexOf('async function reviewCurrentRevitWork('),end=source.indexOf('function formatRevitContextMessage(',start),part=source.slice(start,end);assert.match(part,/fetchRevitBridge\("\/revit\/ping"\)/);assert(!part.includes('await inspectRevitContext()'));assert.match(part,/requestComputerResponse\(body, \{allowTransientGatewayRetry:false\}\)/);});
test('production default capture sends only host native scene to the focused script, not the legacy screenshot path',async()=>{
 const o=options();delete o.capture;let scriptCalls=0;o.runCaptureScript=async args=>{scriptCalls++;assert.deepEqual(args.slice(0,3),['-Action','review_screenshot','-ReviewSceneBase64']);const value=JSON.parse(Buffer.from(args[3],'base64').toString('utf8'));assert.equal(value.view_id,41);assert.equal(value.process_id,123);assert.equal(value.visual_capture_context.main_window_handle,'0x123');assert(!JSON.stringify(value).includes('Remove the schedule gap'));return JSON.stringify(focused());};
 const result=await desktop.reviewCurrentRevitWork(args,o);assert.equal(result.state,'mismatch');assert.equal(scriptCalls,2);assert.equal(result.capture.frame.kind,'revit_view');assert.equal(result.whole_task_verified,false);
});
test('public and deployed Windows capture implementation agree, and only review uses it',()=>{
 assert.equal(fs.readFileSync(new URL('../scripts/visual_review_capture.ps1',import.meta.url),'utf8'),fs.readFileSync(new URL('../../../packages/operator-assistant-ui/visual_review_capture.ps1',import.meta.url),'utf8'));
 const script=fs.readFileSync(new URL('../scripts/desktop.ps1',import.meta.url),'utf8');assert.match(script,/"review_screenshot" \{/);assert.match(script,/Get-OperatorVisualReviewCapture \$scene/);assert.match(source,/async function captureScreenshot\(\)/);assert.match(source,/runDesktopScript\(\["-Action", "screenshot"\]\)/);
});
test('oversized feedback pages whole findings through the real scoped evidence store without clipping or cross-assignment reads',async()=>{
 const result=await desktop.reviewCurrentRevitWork(args,options());result.checks=Array.from({length:8},(_,i)=>({id:'check'+i,expected:'E'.repeat(600),status:'mismatch',observed:'O'.repeat(600),correction:'C'.repeat(600)}));
 const saved=storeEvidence({scope:owner,source:'operator_desktop.function.review_current_work',trust_level:'untrusted_caller',verification_relevance:'supporting',raw:result},8192);
 const wire=shared.visualWorkReviewModelOutput({type:'function_call_output',call_id:'large-review',output:JSON.stringify(modelEvidenceEnvelope([saved.projection]))},result,saved.ref.evidence_id);
 assertBoundedModelEvidencePayload([wire]);const feedback=JSON.parse(modelText(wire.output)).evidence_projections[0].visual_work_review;
 assert.equal(feedback.coverage.complete,false);const all=[...feedback.checks];let next=feedback.coverage.next_start;
 while(next!==null){const page=retrieveEvidence({evidence_id:saved.ref.evidence_id,scope:owner,item_range:{path:feedback.retrieval.checks_path,start:next,count:8},max_bytes:8192,purpose:'Read remaining whole visual discrepancy entries'});all.push(...page.selection);next=page.pagination.next_start;}
 assert.deepEqual(all,result.checks);assert.throws(()=>retrieveEvidence({evidence_id:saved.ref.evidence_id,scope:{...owner,assignment_id:'other-assignment'},item_range:{path:'checks',start:0,count:1},purpose:'Inspect a visual discrepancy'}));
 assert.equal(feedback.native_postcondition_verified,false);assert.equal(feedback.whole_task_verified,false);
});

test('production review and evidence relay keep changed native renders inspectable without certifying them',async()=>{
 const o=options(),bytes=reviewTestPng(40,40),changed=reviewTestPng(40,40,254);let capture=0;
 o.readTargetContext=async()=>{const c=scene().context;c.document.projectIdentity={fingerprint:'project'};c.canonical_attempt_settlement={method:'GET',path:'/revit/context',requested_effect:'read',effect_state:'none'};return c;};
 o.captureTarget=async()=>{const b=++capture===1?bytes:changed;return{image_base64:b.toString('base64'),mime_type:'image/png',native_result:{processId:123,documentSessionId:'doc',projectFingerprint:'project',viewId:41,activeViewId:41,viewUniqueId:'native-view',viewName:'Specifications',viewType:'DrawingSheet',sheetNumber:'M002',timestamp:new Date().toISOString(),exportMode:'full_view',widthPx:40,heightPx:40,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex'),canonical_attempt_settlement:{method:'POST',path:'/revit/export-image',requested_effect:'read',effect_state:'none'}}};};
 o.retainImage=async(pixels,metadata)=>persistSidecarEvidence({scope:owner,source:'operator_desktop.native_target_view_review',raw:Buffer.from(pixels,'base64'),mediaType:metadata.mime_type,...shared.visualReviewImageEvidenceOptions(metadata),verificationRelevance:'supporting',storeEvidence:async body=>({ok:true,...storeEvidence({scope:body.scope,source:body.source,media_type:body.media_type,trust_level:'untrusted_caller',target_scope:body.target_scope,bounded_summary:body.bounded_summary,verification_relevance:body.verification_relevance,raw:Buffer.from(body.raw_base64,'base64')},8192)})});
 const result=await desktop.reviewCurrentRevitWork({...args,capture_mode:'target_view'},o);assert.equal(result.state,'unavailable');assert.equal(result.reason,'visual_review_visible_frame_changed_during_review');
 const saved=storeEvidence({scope:owner,source:'operator_desktop.function.review_current_work',trust_level:'untrusted_caller',verification_relevance:'supporting',raw:{...result,raw_review_evidence:result.raw_review_evidence}},8192);
 const wire=shared.visualWorkReviewModelOutput({type:'function_call_output',call_id:'drift',output:JSON.stringify(modelEvidenceEnvelope([saved.projection]))},result,saved.ref.evidence_id);
 assertBoundedModelEvidencePayload([wire]);const feedback=JSON.parse(modelText(wire.output)).evidence_projections[0].visual_work_review;
 assert.equal(feedback.changed_capture.content_hash,'sha256:'+createHash('sha256').update(changed).digest('hex'));assert.deepEqual(feedback.checks,[]);assert.equal(feedback.recheck_evidence_id,null);
 const image=retrieveEvidence({evidence_id:feedback.changed_capture.evidence_id,scope:owner,image:true,purpose:'Inspect the actual changed render'});assert.equal(image.complete,true);assert.equal(image.selection.media_type,'image/png');assert.deepEqual(Buffer.from(image.selection.data_base64,'base64'),changed);
 assert(image.evidence_ref.target_scope.includes('sheet_number:M002'));assert(image.evidence_ref.target_scope.includes('view_id:41'));assert(image.evidence_ref.target_scope.includes('capture_role:during_review_recheck'));
 assert.match(image.evidence_ref.bounded_summary,/Specifications/);assert.match(image.evidence_ref.bounded_summary,/Not a pre-edit\/post-edit comparison/);assert.equal(image.evidence_ref.trust_level,'untrusted_caller');
 assert.throws(()=>retrieveEvidence({evidence_id:feedback.changed_capture.evidence_id,scope:{...owner,assignment_id:'foreign'},image:true,purpose:'Forbidden foreign image'}));
 assert.equal(feedback.native_postcondition_verified,false);assert.equal(feedback.whole_task_verified,false);
});

test('cold owner PDF review uses retained registered source identity and current-turn delivered pixels',async()=>{
 const {o}=pdfReferenceOptions();o.referenceAttachments=()=>[];o.registeredReferenceAttachmentIds=()=>['source'];
 const r=await desktop.reviewCurrentRevitWork({...args,reference_attachment_read:{call_id:'call_pdf',page:1}},o);
 assert.equal(r.ok,true);assert.equal(r.reference.source_render.source_identity_basis,'current_registered_attachment_read');
 assert.equal(o.calls.filter(x=>typeof x==='object').length,1);assert.equal(r.whole_task_verified,false);
});
test('cold owner PDF review does not render or call reviewer with a foreign registered source',async()=>{
 const {o}=pdfReferenceOptions();o.referenceAttachments=()=>[];o.registeredReferenceAttachmentIds=()=>['foreign'];
 const r=await desktop.reviewCurrentRevitWork({...args,reference_attachment_read:{call_id:'call_pdf',page:1}},o);
 assert.equal(r.state,'unavailable');assert.equal(o.calls.filter(x=>typeof x==='object').length,0);
});

test('production primary observation relays actual model and PDF images through the normal evidence and provider-output boundary',async()=>{
 const {o}=pdfReferenceOptions();const raw=await desktop.reviewCurrentRevitWork({...args,review_mode:'observe',reference_attachment_read:{call_id:'call_pdf',page:1}},o);
 assert.equal(raw.state,'observed');assert.equal(o.calls.filter(x=>typeof x==='object').length,0);
 const tool={name:'review_current_work',call_id:'observe',arguments:JSON.stringify({...args,review_mode:'observe'})},out={type:'function_call_output',call_id:'observe',output:JSON.stringify(raw)};
 Object.defineProperty(out,'raw_evidence',{value:raw});Object.defineProperty(out,'host_visual_work_review',{value:raw});const stored=[];
 const store=async body=>{stored.push(body);const ref={schema:'revit-operator.evidence-ref.v1',evidence_id:'ev1_observation',content_hash:'sha256:'+'c'.repeat(64),byte_count:Buffer.byteLength(JSON.stringify(body.raw_json))};return{ok:true,ref,projection:{...ref,schema:'revit-operator.evidence-projection.v1',projected_bytes:100,truncated:true},stored_unique_bytes:ref.byte_count,duplicate_bytes_avoided:0};};
 const a=source.indexOf('async function retainAndProjectFunctionOutput('),z=source.indexOf('async function retainScreenshotEvidence(',a);
 const project=runInNewContext(source.slice(a,z)+';retainAndProjectFunctionOutput',{...shared,focusedEvidenceFailureOutputV1,Date,JSON,Buffer,currentSidecarEvidenceScope:()=>owner,projectSidecarFunctionOutput,recordSidecarEvidencePerformance:()=>{}});
 const result=await project(tool,out,{storeEvidence:store}),content=result.model_output.output;
 assert.equal(content.filter(x=>x.type==='input_image').length,2);assert.equal(content[1].image_url,'data:image/png;base64,'+image);assert.equal(content[2].image_url,'data:image/png;base64,'+image);
 assert.equal(JSON.parse(content[0].text).evidence_projections[0].visual_work_review.state,'observed');assert(result.telemetry.projected_bytes>0);
 assert.equal(stored[0].verification_relevance,'supporting');assert.equal(stored[0].raw_json.whole_task_verified,false);assert.equal(stored[0].raw_json.native_postcondition_verified,false);
 const forged=await project(tool,{type:'function_call_output',call_id:'forged',output:JSON.stringify(raw)},{storeEvidence:store});assert.equal(typeof forged.model_output.output,'string');
});

test('production retained review reaches inspection-closeout presentation without losing pixels or aborting correction',async()=>{
 const {o}=pdfReferenceOptions(),raw=await desktop.reviewCurrentRevitWork({...args,reference_attachment_read:{call_id:'call_pdf',page:1}},o);
 assert.equal(raw.ok,true);const tool={name:'review_current_work',call_id:'review',arguments:JSON.stringify(args)},out={type:'function_call_output',call_id:'review',output:JSON.stringify(raw)};
 Object.defineProperty(out,'raw_evidence',{value:raw});Object.defineProperty(out,'host_visual_work_review',{value:raw});
 const store=async body=>{const ref={schema:'revit-operator.evidence-ref.v1',evidence_id:'ev1_closeout',content_hash:'sha256:'+'c'.repeat(64),byte_count:Buffer.byteLength(JSON.stringify(body.raw_json))};return{ok:true,ref,projection:{...ref,schema:'revit-operator.evidence-projection.v1',projected_bytes:100,truncated:true},stored_unique_bytes:ref.byte_count,duplicate_bytes_avoided:0};};
 const a=source.indexOf('async function retainAndProjectFunctionOutput('),z=source.indexOf('async function retainScreenshotEvidence(',a);
 const project=runInNewContext(source.slice(a,z)+';retainAndProjectFunctionOutput',{...shared,focusedEvidenceFailureOutputV1,Date,JSON,Buffer,currentSidecarEvidenceScope:()=>owner,projectSidecarFunctionOutput,recordSidecarEvidencePerformance:()=>{}});
 const first=await project(tool,out,{storeEvidence:store});assert(Array.isArray(first.model_output.output));
 const final=shared.visualWorkReviewModelOutput(first.model_output,raw,first.evidence_ref.evidence_id,{state:'not_submitted',reason:'visual_review_not_matched',item_id:'inspect'});
 assert.deepEqual(final.output.slice(1),first.model_output.output.slice(1));assert.equal(final.output.filter(x=>x.type==='input_image').length,2);
 const feedback=JSON.parse(modelText(final.output)).evidence_projections[0].visual_work_review;
 assert.equal(feedback.state,raw.state);assert.equal(feedback.inspection_closeout.state,'not_submitted');assert.equal(feedback.whole_task_verified,false);assert.equal(feedback.native_postcondition_verified,false);
 assertBoundedModelEvidencePayload([final]);
});

test('batch feedback refresh stays in the selected view and never replays focus navigation',()=>{
 const review={ok:true,owner,location:{view_id:41},capture:{frame:{viewport:{}}},reference:{content_hash:'old'},
   request:{view_id:41,capture_mode:'native_visible_region',focus_element_ids:[123],reference_attachment_read:{call_id:'call_pdf',page:1},checks:args.checks}};
 const region=shared.pairedDrawingRegion(review);
 assert.deepEqual(region.request.reference_attachment_read,review.request.reference_attachment_read);
 assert.equal(region.request.focus_element_ids,undefined);
 assert.equal(shared.refreshedDrawingFeedback(region,review),null,'plain data cannot impersonate host-delivered pixels');
 assert.equal(shared.pairedDrawingRegion({...review,reference:null}),null);
});

test('batch feedback requires a current native committed drawing operation',async()=>{
 const {isCommittedDrawingEdit}=await import('../desktop_native_tools.mjs');
 const binding={assignment_id:'a',run_id:'r',generation:1};
 const p={...binding,source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',
   attempt_id:'opv2_'+'a'.repeat(64),key_facts:{'transaction.status':'committed'}};
 const call={name:'native__revit_call_tool',arguments:{path:'/revit/connect-existing-mep-branch',method:'POST',body:{}}};
 const result=projection=>({result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[projection]})}]}});
 assert.equal(isCommittedDrawingEdit(call,result(p),binding),true);
 for(const patch of [{run_id:'foreign'},{effect_state:'unknown'},{key_facts:{}},{trust_level:'user_supplied'}])
   assert.equal(isCommittedDrawingEdit(call,result({...p,...patch}),binding),false);
 assert.equal(isCommittedDrawingEdit({...call,arguments:{...call.arguments,path:'/revit/save-as'}},result(p),binding),false);
 assert.equal(isCommittedDrawingEdit(call,{...result(p),stop_reason:'paused'},binding),false);
});

test('area backcheck supplies three distinct coverage checks to one existing independent review',()=>{
 const area={review_mode:'area_backcheck',view_id:41,capture_mode:'native_visible_region',reference_attachment_read:{call_id:'call_pdf',page:1}};
 const actual=shared.normalizeVisualReviewRequest({...area,checks:args.checks});
 assert.deepEqual(actual.checks.map(x=>x.id),[args.checks[0].id,'area_routes','area_symbols','area_annotations']);
 assert.equal(actual.review_mode,undefined,'normalized independent review uses its existing dispatch path');
 assert.equal(shared.normalizeVisualReviewRequest(area).checks.length,3);
 for(const change of [{reference_attachment_read:null},{capture_mode:'visible_work'},{complete_inspection_item_id:'finish'},{recheck_evidence_id:'old'},{checks:[{id:'area_routes',expected:'collision'}]}])
   assert.throws(()=>shared.normalizeVisualReviewRequest({...area,...change}));
});

test('paged native batch readback locates the full edit extent without pretending its rows are complete',async()=>{
 const {committedDrawingEditLocation}=await import('../desktop_native_tools.mjs');
 const binding={assignment_id:'a',run_id:'r',generation:1},base={...binding,trust_level:'authoritative_native',attempt_id:'opv2_'+'a'.repeat(64)};
 const edit={...base,source:'assignment_kernel_v2:operator_run_dynamic_revit_program',effect_state:'applied'};
 const extent={scope:'navigation_only',source_rows:80,min:[1,2,3],max:[5,6,7]};
 const summary={...base,source:'assignment_kernel_v2:revit_call_tool',inline_payload:{scope:'requested_element_ids_only',rows:[],coverage:{source_rows:80,spatial_rows:80,source_rows_exhausted:false},spatial_extent:extent}};
 const call={name:'native__operator_run_dynamic_revit_program',arguments:{mode:'apply'}};
 const result=(s=summary,e=edit)=>({result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[e,s]})}]}});
 const actual=committedDrawingEditLocation(call,result(),binding);
 assert.equal(actual.points.length,8);assert(actual.points.some(p=>JSON.stringify(p)==='[5,6,7]'));assert(actual.points.some(p=>JSON.stringify(p)==='[1,2,3]'));
 for(const patch of [{source_rows:79},{scope:'verified'},{min:[1,2]},{max:[0,0,0]},{min:[null,2,3]},{extra:true}]){
  const s={...summary,inline_payload:{...summary.inline_payload,spatial_extent:{...extent,...patch}}};
  assert.deepEqual(committedDrawingEditLocation(call,result(s),binding),{points:[]});
 }
 for(const patch of [{run_id:'foreign'},{generation:2},{trust_level:'user_supplied'},{attempt_id:'not-native'}])
  assert.deepEqual(committedDrawingEditLocation(call,result({...summary,...patch}),binding),{points:[]});
 assert.equal(committedDrawingEditLocation(call,result(summary,{...edit,effect_state:'unknown'}),binding),null);
 assert.deepEqual(committedDrawingEditLocation(call,result({...summary,inline_payload:{...summary.inline_payload,coverage:{...summary.inline_payload.coverage,spatial_rows:79}}}),binding),{points:[]});
});

test('post-edit reference follows native edit locations across room switches and abstains on ambiguous batches',()=>{
 const loc={process_id:7,document_session_id:'s',epoch:'e',view_id:41,view_unique_id:'u'};
 const region=(x,ref)=>({owner,location:loc,referenceHash:ref,radius:6,bounds:[{min:[x,0,10],max:[x+2,2,12]}]});
 const a=region(1,'west'),b=region(25,'east'),pick=(regions,points)=>shared.selectEditedDrawingRegion(regions,b,[{points}]);
 assert.equal(pick([b,a],[[2,1,11],[4,1,11]]),a);
 assert.equal(pick([b,a],[[2,1,11],[26,1,11]]),null);
 assert.equal(pick([b,a,region(1,'other')],[[2,1,11]]),null);
 assert.equal(pick([b,{...a,location:{...loc,epoch:'old'}}],[[2,1,11]]),null);
 assert.equal(pick([b,a],[[2,1,75]]),null);
 assert.equal(pick([b,a],[]),null);
 assert.deepEqual(shared.visualFocusBounds([1,2],[{id:1,found:true,uniqueId:'X',boundingBox:{min:{x:0,y:0,z:0},max:{x:3,y:3,z:1}}}]),[]);
});

test('confirmed contextual plan framing uses the branch extent even when focused on a distant landmark',()=>{
 const req={view_id:41,review_mode:'observe',capture_mode:'native_visible_region',reference_filename:'plan.png',
   focus_element_ids:[1],context_bbox_min_xyz:[18,13,40],context_bbox_max_xyz:[32,33,45],checks:args.checks};
 const loc={process_id:7,document_session_id:'s',epoch:'e',view_id:41,view_unique_id:'u'};
 const frame={view_type:'FloorPlan',width:4000,height:2021,viewport:{zoomCornersXyz:[[5.2,13,32],[44.8,33,32]]}};
 const r=shared.pairedDrawingRegion({ok:true,owner,location:loc,capture:{frame},reference:{content_hash:'source'},request:req});
 assert.equal(shared.selectEditedDrawingRegion([r],r,[{points:[[9.72,31.99,42.8],[30.38,31.99,42.8]]}]),r);
 assert.equal(shared.selectEditedDrawingRegion([r],r,[{points:[[54,70,42.8]]}]),null);
});

test('actor can discover and inspect bound failures without crossing run boundaries or replaying writes',async()=>{
 const {inspectExecution,desktopNativeBinding,installDesktopNativeTools}=await import('../desktop_native_tools.mjs');
 const a={kernel_version:2,goal_id:'task',session_id:'s',run_id:'r',generation:1},binding=desktopNativeBinding(a);
 const rows=[{execution_binding:binding,tool_name:'native__operator_run_dynamic_revit_program',call_id:'bad',status:'failed',
   request_effect:'apply',result:{ok:false,error:'CS1061: missing member'},evidence_ref:{evidence_id:'e'}},
   {execution_binding:{...binding,run_id:'other'},call_id:'foreign',result:{error:'private'}},
   {tool_name:'legacy',call_id:'unbound',result:{error:'unbound'}}];
 const d=inspectExecution(a,rows,{});assert.equal(d.calls.length,1);assert.equal(d.calls[0].error.text,'CS1061: missing member');
 assert.equal(d.calls[0].requested_effect,'apply');assert.equal(d.native_postcondition_verified,false);
 assert.throws(()=>inspectExecution(a,rows,{call_id:'foreign'}));assert.throws(()=>inspectExecution(a,rows,{call_id:'unbound'}));
 assert.throws(()=>inspectExecution({...a,generation:2},rows,{call_id:'bad'}));
 assert.throws(()=>inspectExecution(a,rows,{path:'C:/secret'}));
 const exposed=installDesktopNativeTools(desktop.buildComputerTools(),{schema:'operator.desktop-native-tools.v1',tools:[{type:'function',name:'native__sample',parameters:{type:'object'}}],guidance:'test'});
 assert(exposed.some(t=>t.name==='inspect_execution'));assert(exposed.some(t=>t.type==='computer'));
 assert(!desktop.buildComputerTools({deterministicDelegateOnly:true}).some(t=>t.name==='inspect_execution'));
});
test('execution inspection pages complete rows and distinguishes unknown from transport success',async()=>{
 const {inspectExecution,desktopNativeBinding}=await import('../desktop_native_tools.mjs');
 const a={kernel_version:2,goal_id:'task',session_id:'s',run_id:'r',generation:1},binding=desktopNativeBinding(a);
 const rows=Array.from({length:12},(_,i)=>({execution_binding:binding,call_id:'c'+i,tool_name:'native__sample',status:'success',
 result:{ok:true,content:[{type:'inputText',text:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',evidence_projections:[
 {...binding,source:'native',effect_state:'unknown',trust_level:'authoritative_native',evidence_id:'raw'}]})}]}}));
 const first=inspectExecution(a,rows,{}),next=inspectExecution(a,rows,{before_call_id:first.coverage.older_before_call_id});
 assert.equal(first.calls.length,8);assert.equal(next.calls.length,4);assert.equal(next.coverage.older_before_call_id,null);
 assert.equal(first.calls[0].native_outcomes[0].effect_state,'unknown');
 const detail=inspectExecution(a,[...rows,{execution_binding:binding,call_id:'v',tool_name:'review_current_work',
 result:{ok:true,state:'uncertain',reference:{filename:'partial.png'},checks:[{id:'four',status:'uncertain',observed:'Left endpoint cropped'}]}}],{call_id:'v'});
 assert.equal(detail.calls[0].checks[0].observed.text,'Left endpoint cropped');assert.equal(detail.whole_task_verified,false);
});

test('execution diagnostic dispatch preserves bounded details through projection and obeys Pause and scope',async()=>{
 const {inspectExecution,desktopNativeBinding}=await import('../desktop_native_tools.mjs');
 const assignment={kernel_version:2,session_id:'s',goal_id:'a',run_id:'r',generation:1},scope=desktopNativeBinding(assignment);
 const state={sidecarAssignment:assignment,functionToolReceipts:[{execution_binding:scope,tool_name:'native__sample',call_id:'failure',result:{error:'member does not exist'},status:'failed'}]};
 const begin=source.indexOf('async function executeFunctionToolCall('),end=source.indexOf('async function executeFunctionToolCallSafely',begin);
 let paused=false,reads=0;const dispatch=runInNewContext(source.slice(begin,end)+';executeFunctionToolCall',{JSON,Object,computerState:state,inspectExecution:(...a)=>{reads++;return inspectExecution(...a)},assertComputerActionControl:async()=>{if(paused)throw Error('paused')}});
 const call={name:'inspect_execution',call_id:'diag',arguments:'{}'},out=await dispatch(call);
 assert(!JSON.stringify(out).includes('host_execution_inspection'));
 const a=source.indexOf('async function retainAndProjectFunctionOutput('),z=source.indexOf('async function retainScreenshotEvidence(',a);
 let stores=0;const project=runInNewContext(source.slice(a,z)+';retainAndProjectFunctionOutput',{JSON,Date,Buffer,currentSidecarEvidenceScope:()=>scope,storeSidecarEvidenceOnBackend:()=>{},focusedEvidenceFailureOutputV1:()=>null,recordSidecarEvidencePerformance:()=>{},projectSidecarFunctionOutput:async()=>{stores++;return{model_output:{output:'generic truncation'},evidence_ref:{evidence_id:'retained'},telemetry:{}}}});
 const delivered=JSON.parse((await project(call,out)).model_output.output);
 assert.equal(delivered.calls[0].error.text,'member does not exist');assert.equal(delivered.diagnostic_evidence_id,'retained');assert.equal(delivered.whole_task_verified,false);
 const forged=await project(call,{type:'function_call_output',output:out.output});assert.equal(forged.model_output.output,'generic truncation');
 scope.run_id='foreign';const count=stores;await assert.rejects(project(call,out),/binding_changed/);assert.equal(stores,count);
 paused=true;await assert.rejects(dispatch(call),/paused/);assert.equal(reads,1);
});

test('execution inspection exposes actual pre-native compiler diagnostics without inventing settlement',async()=>{
 const {inspectExecution,desktopNativeBinding}=await import('../desktop_native_tools.mjs');
 const a={kernel_version:2,goal_id:'a',session_id:'s',run_id:'r',generation:1};
 const row={execution_binding:desktopNativeBinding(a),call_id:'compiler',tool_name:'native__operator_run_dynamic_revit_program',status:'failed',result:{ok:false,content:[{type:'inputText',text:JSON.stringify({schema:'revit-operator.dynamic-revit-program-run.v1',execution_status:'failed',native_outcome:null,diagnostics:[{code:'CS1061',message:"'MEPSystem' does not contain a definition for 'SystemType'",phase:'native_compile',severity:'error',repair_action:'edit_source',line:1}]})}]}};
 const r=inspectExecution(a,[row],{call_id:'compiler'});assert.equal(r.calls[0].diagnostics[0].code.text,'CS1061');assert.equal(r.calls[0].diagnostics[0].repair_action.text,'edit_source');assert.equal(r.calls[0].native_outcomes.length,0);assert.equal(r.native_postcondition_verified,false);
});
