import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import{runInNewContext}from'node:vm';
import*as shared from'../visual_work_review.mjs';import{confirmNativeViewActivation,focusNativeReviewTarget}from'../native_view_activation.mjs';import{nativeChangeObservationFromContext}from'../native_change_observations.mjs';

test('confirmed same-ID navigation preserves framing without redispatch', async () => {
  const activeView = { id: 41, name: 'Level 3' };
  const context = { process_id: 23, document: {
    sessionId: 'current-document', projectIdentity: { fingerprint: 'current-project' }, activeView
  } };
  let reads = 0, dispatches = 0, guards = 0;
  const options = {
    readContext: async () => { reads++; return context; },
    assertCurrent: async () => { guards++; },
    activate: async () => {
      dispatches++;
      return { ok: true, requestedViewId: 41, requestedViewName: 'Level 3', activeViewId: 41,
        activeViewName: 'Level 3', focusPending: false, didZoom: true };
    }
  };
  const repeated = await confirmNativeViewActivation({ view_id: 41 }, options);
  assert.deepEqual(repeated, { ok: true, active_view: activeView, already_active: true, request_dispatched: false });
  assert.deepEqual([reads, dispatches, guards], [1, 0, 2]);

  const fit = await confirmNativeViewActivation({ view_id: 41, zoom_to_fit: true }, options);
  assert.equal(fit.focus?.kind, 'fit');
  assert.equal(dispatches, 1, 'explicit fresh focus must still dispatch');
  await confirmNativeViewActivation({ view_name: 'Level 3' }, options);
  assert.equal(dispatches, 2, 'a name can collide, so exact name resolution still dispatches');
});

test('pause or missing fresh identity bars an already-active result', async () => {
  const context = { process_id: 23, document: {
    sessionId: 'current-document', projectIdentity: { fingerprint: 'current-project' }, activeView: { id: 41, name: 'Level 3' }
  } };
  const options = {
    readContext: async () => context,
    assertCurrent: async () => {},
    activate: () => assert.fail('no native activation may be dispatched')
  };
  let guards = 0;
  await assert.rejects(confirmNativeViewActivation({ view_id: 41 }, {
    ...options, assertCurrent: async () => { if (++guards === 2) throw Error('paused'); }
  }), /paused/);
  await assert.rejects(confirmNativeViewActivation({ view_id: 41 }, {
    ...options, readContext: async () => ({ ...context, process_id: null })
  }), /context_identity_unavailable/);
});
import {prepareFocusedInspection} from '../reviewed_inspection_closeout.mjs';
import {parseAssignmentKernelPublicationV2} from '@revitoperator/assignment-kernel-v2-contracts';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8'),a=source.indexOf('async function reviewCurrentRevitWork('),z=source.indexOf('function formatRevitContextMessage(',a);assert(a>0&&z>a);
const owner={assignment_id:'a',session_id:'s',run_id:'r',generation:1};
for(const contextBounds of [false,true])for(const modal of [false,true])for(const refreshOnly of [false,true])test('actual private focus composition retains modal admission: '+modal+' context:'+contextBounds+' refreshOnly:'+refreshOnly,async()=>{
 const calls=[];let active=7;
 const context=()=>({process_id:12,visual_capture_context:{main_window_handle:'0x12'},document:{sessionId:'doc',title:'Model',projectIdentity:{fingerprint:'project'},activeView:{id:active,name:'Sheet',type:'DrawingSheet'}},nativeChangeObservations:{schema:'operator.native_document_changes.v1',authority:'observed_changes_only',processId:12,documentSessionId:'doc',epoch:'epoch',throughSequence:0,retainedFromSequence:1,maxEvents:16,maxIdsPerEvent:64,events:[]},canonical_attempt_settlement:{method:'GET',path:'/revit/context',requested_effect:'read',effect_state:'none'}});
 const invoke=runInNewContext(source.slice(a,z)+';reviewCurrentRevitWork',{
  JSON,Buffer,Date,Error,AbortSignal,performance,focusNativeReviewTarget,nativeChangeObservationFromContext,
  visualReviewOwner:shared.visualReviewOwner,sameVisualReviewOwner:shared.sameVisualReviewOwner,
  // Exercise actual wrapper wiring; the public review implementation has its
  // own producer/consumer guards and image tests, without running a provider.
  reviewCurrentWork:async(args,host)=>{if(refreshOnly){await host.readTargetContext();return{state:'matched',raw_review_evidence:{}};}await host.focusTarget({view_id:41,show_element_ids:[101]},7);if(contextBounds)await host.focusTarget({view_id:41,bbox_min_xyz:[.05,1.5,0],bbox_max_xyz:[1.55,2.45,0]},41);return{state:'matched',raw_review_evidence:{}};},
  activateRevitView:async target=>{calls.push({navigation:target});active=41;return{ok:true,active_view:{id:41},...(target.show_element_ids||target.bbox_min_xyz?{focus:{confirmed:true,kind:target.show_element_ids?'elements':'bounds',native_navigation_only:true}}:{})};},addComputerEvent(){}
 });
 const options={evidenceScope:()=>({}),owner:()=>owner,assertControl:async()=>calls.push('control'),readContext:async()=>({schema:'revit-operator.ui-context/v1',state:'available',authority:'ui_identity_only',captured_at_utc:new Date().toISOString(),context:context()}),fetchNative:async()=>{calls.push('native-context');return new Response(JSON.stringify(context()));},runCaptureScript:async argv=>{assert.equal(argv[1],'review_native_read_admission');calls.push('admission');return JSON.stringify({schema:'operator.visual_review_native_read_admission.v1',process_id:12,main_window_handle:'0x12',main_window_enabled:!modal});}};
 if(modal){await assert.rejects(()=>invoke({},options),/native_read_admission_invalid/);assert.equal(calls.filter(c=>c?.navigation).length,0);assert.equal(calls.filter(c=>c==='native-context').length,0);}
 else{await invoke({},options);assert.equal(calls.filter(c=>c==='admission').length,refreshOnly?1:contextBounds?3:2);if(refreshOnly){assert.equal(calls.filter(c=>c==='native-context').length,1);assert.equal(calls.filter(c=>c?.navigation).length,0);}else assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(c=>c?.navigation).map(c=>c.navigation))),[{view_id:41},{view_id:41,show_element_ids:[101]},...(contextBounds?[{view_id:41,bbox_min_xyz:[.05,1.5,0],bbox_max_xyz:[1.55,2.45,0]}]:[])]);}
});

function productionFunction(name){const start=source.indexOf('function '+name+'(');assert(start>=0);return source.slice(start,source.indexOf('\n}',start)+2);}
for(const variant of ['ready','ready-large','foreign-session','malformed','paused','unknown','usage-held'])test('actual private inspection preparation validates canonical publication: '+variant,async()=>{
 const binding={...owner,principal_id:'local:test',document_fingerprint:'model'};
 const snapshot={schema:'revit-operator.assignment-snapshot/v2',assignment_version:7,current_binding:binding,
  spec:{binding:{...binding},source_user_request:'Review the completed note',requested_effect:'apply',created_at:'2026-10-27T09:00:00Z',criteria:[],work_units:[],work_plan_required:true},
  outcome:'active',terminal:false,quiescent:true,provider_call_ids:[],provider_calls:{},in_flight_provider_call_ids:[],operations:{read:{requested_effect:'read'}},observations:{},criteria:{},work_unit_states:{},unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],pending_input_variable_ids:[],pending_review_ids:[],execution_failure_ids:[],clarifications:{},
  execution_failures:{},work_plan:{items:[{item_id:'inspect',kind:'inspection',operation_ids:[]}]}};
 const publication={schema:'revit-operator.assignment-kernel-publication/v2',assignment_id:'a',assignment_version:7,snapshot,
  provider_ledger:{schema:'revit-operator.assignment-provider-ledger/v2',assignment_id:'a',run_id:'r',generation:1,call_ids:[],calls:{},in_flight_call_ids:[]}};
 parseAssignmentKernelPublicationV2(publication);
 if(variant==='foreign-session')snapshot.current_binding={...binding,session_id:'foreign'};
 if(variant==='malformed')publication.schema='untrusted';
 if(variant==='paused')snapshot.execution_control={state:'paused'};
 if(variant==='unknown')snapshot.unresolved_unknown_operation_ids=['unsettled'];
 if(variant==='usage-held')snapshot.provider_usage_hold={};
 const calls=[];let preparation;
 const invoke=runInNewContext([
  productionFunction('sidecarAssignmentBindingPayload'),productionFunction('validateSidecarAssignmentKernelPublication'),productionFunction('sidecarAssignmentKernelPublicationFromResponse'),source.slice(a,z),';reviewCurrentRevitWork'
 ].join('\n'),{JSON,Buffer,Date,Error,AbortSignal,performance,encodeURIComponent,prepareFocusedInspection,parseAssignmentKernelPublicationV2,
  visualReviewOwner:shared.visualReviewOwner,reviewCurrentWork:async(args,host)=>{preparation=await host.prepareFocusedInspection(args);return {state:'unavailable',raw_review_evidence:{}};},addComputerEvent(){}});
 await invoke({complete_inspection_item_id:'inspect',focus_element_ids:[101]}, {evidenceScope:()=>({}),owner:()=>owner,assertControl:async()=>{},readContext:async()=>{},fetchNative:async()=>{throw Error('Preparation must not touch Revit');},readBackend:async(route,options)=>{
  calls.push({route,options});if(options.method==='GET')return {assignment_kernel_v2:publication};
  const body=JSON.parse(options.body);assert.equal(body.action,'status');assert.deepEqual(body,{...owner,action:'status'});
  return {ok:true,verification_policy:'strict',work_plan:{next_native_inspection:{item_id:'inspect',validation_required:true,coverage_only:true,existing_element_read_candidates:['read'],required_target_ids:variant==='ready-large'?Array.from({length:500},(_,i)=>'element_id:'+(101+i)):['element_id:101']}}};
 }});
 assert.equal(preparation.state,variant.startsWith('ready')?'prepared':'not_submitted');
 assert.equal(calls.length,variant.startsWith('ready')?2:1);
 assert.equal(preparation.native_postcondition_verified,false);assert.equal(preparation.whole_task_verified,false);
});

