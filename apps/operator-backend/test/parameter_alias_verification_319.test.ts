import assert from 'node:assert/strict';import {readFileSync}from'node:fs';import test from'node:test';
import {beginTeammateLoopOwner,endTeammateLoopOwner,guardTeammateMcpCall,recordTeammateMcpResult,__testOnlyResetTeammateLoopState}from'../src/teammate_loop_runtime.js';
import {reviewedTeammateNativeAliasRequest}from'../src/teammate_native_aliases.js';
const fixture=()=>JSON.parse(readFileSync('test/fixtures/parameter-alias-native-proof-319.json','utf8'));
function scenario(){
 __testOnlyResetTeammateLoopState();const f=fixture(),owner={};
 const lease=beginTeammateLoopOwner(owner,{version:'operator.backend.v1',session_id:f.snapshot.current_binding.session_id,message_id:'parameter-alias-message',
  user_text:'Set the three service texts, verify them, then update only the first device while preserving the other two.',
  context:{revit:{source:{live:true},process_id:1,document:{title:'Disposable alias fixture',projectIdentity:{fingerprint:f.snapshot.current_binding.document_fingerprint}}}}}as any);
 const first=guardTeammateMcpCall(owner,{tool:'revit_set_parameters',arguments:f.arguments});assert.equal(first.allowed,true,first.message);
 // A transport success cannot certify the model. Exact V2 native apply/read proof below must do so.
 recordTeammateMcpResult(owner,first,{content:[{type:'text',text:JSON.stringify({ok:true,changed:true})}]});
 const next={...structuredClone(f.arguments),changes:[{...f.arguments.changes[0],expectedOldValue:'A ONLY',value:'A UPDATED'}]};
 return{f,owner,lease,first,next};
}
test('319 retained typed batch native proof releases only its next distinct parameter edit',()=>{
 const{f,owner,lease,first,next}=scenario();try{
  assert.equal(first.state?.verified,false);
  const gate=guardTeammateMcpCall(owner,{tool:'revit_set_parameters',arguments:next},f.snapshot);
  assert.equal(gate.allowed,true,gate.message);assert.equal(gate.state?.apply_call?.path,'/revit/set-parameter');
 }finally{endTeammateLoopOwner(lease);}
});
for(const variant of ['unproved','foreign_session','foreign_generation','wrong_body','wrapper_only']as const)
test('319 '+variant+' cannot replace exact independent native proof',()=>{
 const{f,owner,lease,next}=scenario();try{
  if(variant==='unproved')for(const o of Object.values(f.snapshot.observations)as any[])o.facts=[];
  if(variant==='foreign_session')f.snapshot.current_binding.session_id='other-session';
  if(variant==='foreign_generation')f.snapshot.current_binding.generation++;
  if(variant==='wrong_body')f.snapshot.operations[f.apply_id].input.body.changes[0].value='OTHER';
  if(variant==='wrapper_only')delete f.snapshot.operations[f.apply_id];
  const gate=guardTeammateMcpCall(owner,{tool:'revit_set_parameters',arguments:next},f.snapshot);
  assert.equal(gate.allowed,false);assert.match(gate.message??'',/prior apply verification/);
 }finally{endTeammateLoopOwner(lease);}
});
test('319 canonical verified alias still refuses replay of the identical completed batch',()=>{
 const{f,owner,lease}=scenario();try{
  const gate=guardTeammateMcpCall(owner,{tool:'revit_set_parameters',arguments:f.arguments},f.snapshot);
  assert.equal(gate.allowed,false);assert.match(gate.message??'',/completed apply may not be retried/);
 }finally{endTeammateLoopOwner(lease);}
});
test('319 typed alias without a mode retains preview default and does not mutate the caller',()=>{
 const{owner,lease}=scenario();try{
  const freshOwner={},freshLease=beginTeammateLoopOwner(freshOwner,{version:'operator.backend.v1',session_id:'preview-alias',message_id:'preview',user_text:'Set the device service text.',context:{revit:{source:{live:true},process_id:1,document:{title:'Disposable',projectIdentity:{fingerprint:'preview-model'}}}}}as any);
  try{const args={changes:[{elementId:42,parameterName:'Comments',value:'TEST'}]},before=structuredClone(args);
   const gate=guardTeammateMcpCall(freshOwner,{tool:'revit_set_parameters',arguments:args});assert.equal(gate.allowed,true,gate.message);assert.equal(gate.call?.effect,'preview');assert.deepEqual(args,before);
  }finally{endTeammateLoopOwner(freshLease);}
 }finally{endTeammateLoopOwner(lease);}
});

test('319 reviewed alias matches the producer canonical mode and preserves every requested change',()=>{
 for(const mode of [{},{apply:true},{apply:true,dryRun:false},{apply:false,dryRun:true}]){
  const args={changes:[{elementId:42,parameterName:'Comments',value:'Test',expectedOldValue:'',preserveTextCase:true}],excludeElementIds:[43],...mode};
  const before=structuredClone(args),apply=mode.apply===true,dryRun=typeof mode.dryRun==='boolean'?mode.dryRun:!apply;
  assert.deepEqual(reviewedTeammateNativeAliasRequest('revit_set_parameters',args),{path:'/revit/set-parameter',body:{...args,apply,dryRun}});assert.deepEqual(args,before);
 }
 for(const mode of [{apply:true,dryRun:true},{apply:false,dryRun:false},{dryRun:false}])
  assert.equal(reviewedTeammateNativeAliasRequest('revit_set_parameters',mode),null);
 assert.equal(reviewedTeammateNativeAliasRequest('revit_unreviewed_write',{}),null);
});
