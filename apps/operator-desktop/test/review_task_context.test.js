import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import {visualReviewOwner} from '../visual_work_review.mjs';
import {canonicalReviewTaskContext} from '../review_task_context.mjs';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const begin=source.indexOf('async function reviewCurrentRevitWork('),end=source.indexOf('function formatRevitContextMessage(',begin);

test('recovered review uses canonical objective rather than the transient resume message',async()=>{
 const binding={assignment_id:'task',session_id:'session',run_id:'run',generation:1,principal_id:null,document_fingerprint:null};
 const local={...binding,goal_id:'task',kernel_version:2},snapshot={schema:'revit-operator.assignment-snapshot/v2',assignment_version:12,current_binding:binding,spec:{source_user_request:'Read the current project title and report it.'},input_values:{},clarifications:{}};
 let canonicalReads=0;
 const invoke=runInNewContext(source.slice(begin,end)+';reviewCurrentRevitWork',{
  JSON,Buffer,Date,Error,AbortSignal,visualReviewOwner,
  computerState:{messages:[{role:'user',text:'Continue the existing task using its saved answers and evidence.'}],sidecarAssignment:local},
  canonicalReviewTaskContext,
  nativeDocumentCheckpointRequestMatchesV2:()=>false,
  attachSidecarAssignmentKernelPublication:async(_read,_input,owner)=>{assert.equal(owner.assignment_id,'task');canonicalReads++;return{assignment_snapshot_v2:snapshot};},
  buildNativeCodeReviewPacket:async(_ids,h)=>({owner:await h.readCanonicalOwner()}),
  reviewExecutedCode:async(_args,h)=>{const text=h.userRequest();await h.codeReviewPacket(['ev1_'+'A'.repeat(32)]);assert.equal(h.userRequest(),text,'Objective stable across packet admission');return{state:'matched',deliveredRequest:text};},
  addComputerEvent(){}
 });
 const result=await invoke({review_mode:'code_execution',code_evidence_ids:['ev1_'+'A'.repeat(32)]},{owner:()=>local,assertControl:async()=>{},readContext:async()=>null,settings:()=>({model:'test',reasoning_effort:'medium'}),evidenceScope:()=>binding,readBackend:async()=>{throw Error('unexpected transport');}});
 assert.equal(result.deliveredRequest,snapshot.spec.source_user_request);
 assert.equal(canonicalReads,1,'Reuse one validated task publication for objective and code owner');
});

const binding={assignment_id:'task',session_id:'session',run_id:'run',generation:1,principal_id:'local',document_fingerprint:'a'.repeat(64)};
function task(){return{schema:'revit-operator.assignment-snapshot/v2',assignment_version:12,current_binding:{...binding},spec:{source_user_request:'Adjust the requested equipment label.'},input_values:{height:'Keep the existing height.',draft:'unresolved'},clarifications:{height:{variable_id:'height',question:'Height?',resolved_at:'2026-11-21T10:00:00Z'},pending:{variable_id:'draft',question:'Pending?'},missing:{variable_id:'absent',resolved_at:'2026-11-21T10:00:00Z'}}};}
test('review context retains the objective and only actual resolved inputs without modifying history',()=>{
 const s=task(),before=JSON.stringify(s),text=canonicalReviewTaskContext(s,binding);
 assert(text.startsWith(s.spec.source_user_request));assert.match(text,/Keep the existing height\./);assert(!text.includes('unresolved'));assert(!text.includes('Pending?'));
 assert.equal(JSON.stringify(s),before);assert.match(text,/not independent authorization/);
});
test('foreign, missing and malformed canonical context never falls back to a resume message',()=>{
 for(const k of ['assignment_id','session_id','run_id','generation','principal_id','document_fingerprint']){const s=task();s.current_binding[k]=k==='generation'?2:'foreign';assert.throws(()=>canonicalReviewTaskContext(s,binding),/owner_mismatch/,k);}
 for(const patch of [{schema:'wrong'},{assignment_version:0},{spec:{source_user_request:''}},{spec:{source_user_request:'x'.repeat(12001)}},{input_values:null},{clarifications:null}])assert.throws(()=>canonicalReviewTaskContext({...task(),...patch},binding));
});
test('oversized input values are explicitly omitted, recent resolved direction is preserved, and output remains bounded',()=>{
 const s=task();s.input_values={};s.clarifications={};
 for(let i=0;i<40;i++){s.input_values['v'+i]='value'+i+' '+'x'.repeat(800);s.clarifications['c'+i]={variable_id:'v'+i,question:'Question '+i,resolved_at:new Date(Date.UTC(2026,10,21,10,0,i)).toISOString()};}
 s.input_values.huge='z'.repeat(20000);s.clarifications.huge={variable_id:'huge',question:'Large',resolved_at:'2026-11-21T11:00:00Z'};
 const text=canonicalReviewTaskContext(s,binding);assert(text.length<=12000);assert.match(text,/value39/);assert(!text.includes('z'.repeat(100)));assert.match(text,/omitted/);assert.match(text,/Do not infer their contents/);
});
