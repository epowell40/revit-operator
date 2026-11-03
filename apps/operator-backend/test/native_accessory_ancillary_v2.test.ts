import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {nativeAccessoryPreservationV2} from '../src/verification/native_accessory_preservation_v2.js';
import {ancillaryExample,actualAncillary133} from './native_accessory_ancillary.fixtures.js';
const run=(f:any)=>nativeAccessoryPreservationV2(f.input,f.affected,f.apply,f.after);
const closure149File=[new URL('./fixtures/internal-dependency-closure149.json',import.meta.url),new URL('../../test/fixtures/internal-dependency-closure149.json',import.meta.url)].find(p=>fs.existsSync(p))!;
const closure149=JSON.parse(fs.readFileSync(closure149File,'utf8'));
function nonCovering149(){
 const f=ancillaryExample();
 for(const s of [f.apply.preservationBefore.nativePlacementState,f.apply.preservationAfter.nativePlacementState,f.after.nativePlacementState]){
  // Actual149 identity/dependencies; qualified parameter template is synthetic.
  const r=structuredClone(s.internalBookkeeping.internals[0]);r.elementId=closure149.owner.id;r.uniqueId=closure149.owner.unique_id;
  delete r.dependentIds;r.dependencyObservation={status:'unavailable',reason:'dependency_closure_not_eligible',observedDependentIds:closure149.dependencies.items.map((x:any)=>x.id)};
  s.internalBookkeeping.unavailableInternals.push(r);
 }
 return f;
}
test('actual149 dependency group remains non-covering while independent physical preservation verifies',()=>assert.ok(run(nonCovering149())));
for(const mode of ['modified','deleted','missing','identity','dependency-change','reason','status','duplicate','negative','too-many','self-only','false-coverage','extra-field','profile'])test(`non-covering149 refuses ${mode}`,()=>{
 const f=nonCovering149(),s=f.after.nativePlacementState,r=s.internalBookkeeping.unavailableInternals[0],d=r.dependencyObservation;
 if(mode==='modified'){
  for(const xs of [f.apply.transaction.modified_element_ids,f.apply.transaction.affected_element_ids,f.apply.changeTracking.observedModifiedIds])xs.push(17);
  f.affected.push('element_id:17');for(const state of [s,f.apply.preservationAfter.nativePlacementState]){state.requestedChangedIds.push(17);state.affected.push({elementId:17,uniqueId:r.uniqueId,exists:true});}
 }else if(mode==='deleted')f.apply.transaction.deleted_element_ids.push(17);
 else if(mode==='missing')s.internalBookkeeping.unavailableInternals=[];
 else if(mode==='identity')r.uniqueId='foreign';
 else if(mode==='dependency-change')d.observedDependentIds.push(999);
 else for(const state of [s,f.apply.preservationBefore.nativePlacementState,f.apply.preservationAfter.nativePlacementState]){
  const row=state.internalBookkeeping.unavailableInternals[0],obs=row.dependencyObservation;
  if(mode==='reason')obs.reason='unknown';else if(mode==='status')obs.status='complete';
  else if(mode==='duplicate')obs.observedDependentIds=[17,17];else if(mode==='negative')obs.observedDependentIds=[-1];
  else if(mode==='too-many')obs.observedDependentIds=Array.from({length:65},(_,i)=>i+1);
  else if(mode==='self-only')obs.observedDependentIds=[17];else if(mode==='false-coverage')row.dependentIds=[17];
  else if(mode==='extra-field')obs.covered=true;else if(mode==='profile')row.hasBounds=true;
 }
 assert.equal(run(f),null);
});
function unavailableLayoutExample(){
 const f=ancillaryExample(),unknown={elementId:777,uniqueId:'unavailable-layout',className:'Autodesk.Revit.DB.Element',
  categoryId:null,typeId:-1,hasLocation:false,hasBounds:false,schemaGuids:[],
  parameterObservation:{status:'unavailable',reason:'parameter_layout_read_failed',error:'AccessViolationException'}};
 for(const s of [f.apply.preservationBefore.nativePlacementState,f.apply.preservationAfter.nativePlacementState,f.after.nativePlacementState])
  s.internalBookkeeping.unavailableInternals.push(structuredClone(unknown));
 return f;
}
test('explicit unavailable internal layout does not block independently covered physical work',()=>assert.ok(run(unavailableLayoutExample())));
function largerUnavailableCohort(){
 const f=unavailableLayoutExample();
 for(const s of [f.apply.preservationBefore.nativePlacementState,f.apply.preservationAfter.nativePlacementState,f.after.nativePlacementState]){
  const template=s.internalBookkeeping.unavailableInternals[0];
  s.internalBookkeeping.unavailableInternals=Array.from({length:65},(_,i)=>({...structuredClone(template),elementId:1000+i,uniqueId:'unavailable-'+i}));
 }
 return f;
}
test('more than64 unavailable records do not consume eligible bookkeeping coverage',()=>assert.ok(run(largerUnavailableCohort())));
for(const mode of ['changed','missing','duplicate','physical-alias','modified-last','byte-bound','eligible-bound'])test(`larger negative cohort stays fail closed: ${mode}`,()=>{
 const f=largerUnavailableCohort(),states=[f.apply.preservationBefore.nativePlacementState,f.apply.preservationAfter.nativePlacementState,f.after.nativePlacementState];
 if(mode==='changed')f.after.nativePlacementState.internalBookkeeping.unavailableInternals[64].uniqueId='changed';
 else if(mode==='missing')f.after.nativePlacementState.internalBookkeeping.unavailableInternals.pop();
 else if(mode==='modified-last'){
  for(const xs of [f.apply.transaction.modified_element_ids,f.apply.transaction.affected_element_ids,f.apply.changeTracking.observedModifiedIds])xs.push(1064);
  f.affected.push('element_id:1064');
  for(const s of states.slice(1)){s.requestedChangedIds.push(1064);s.affected.push({elementId:1064,uniqueId:'unavailable-64',exists:true});}
 }else for(const s of states){
  const b=s.internalBookkeeping;
  if(mode==='duplicate')b.unavailableInternals[64]=structuredClone(b.unavailableInternals[0]);
  if(mode==='physical-alias'){b.unavailableInternals[64].elementId=s.owners[0].elementId;b.unavailableInternals[64].uniqueId=s.owners[0].uniqueId;}
  if(mode==='byte-bound')b.unavailableInternals[0].padding='x'.repeat(1048577);
  if(mode==='eligible-bound')b.internals=Array.from({length:65},(_,i)=>({...structuredClone(b.internals[0]),elementId:2000+i,uniqueId:'eligible-'+i,dependentIds:[2000+i]}));
 }
 assert.equal(run(f),null);
});
for(const mode of ['modified','physical-alias','changed-identity','missing','parameters','dependentIds','wrong-error','wrong-class','unknown-stage'])
 test(`unavailable layout cannot grant coverage: ${mode}`,()=>{
 const f=unavailableLayoutExample(),states=[f.apply.preservationBefore.nativePlacementState,f.apply.preservationAfter.nativePlacementState,f.after.nativePlacementState];
 const r=f.after.nativePlacementState.internalBookkeeping.unavailableInternals[0];
 if(mode==='modified'){
  for(const xs of [f.apply.transaction.modified_element_ids,f.apply.transaction.affected_element_ids,f.apply.changeTracking.observedModifiedIds])xs.push(777);
  f.affected.push('element_id:777');for(const s of states.slice(1)){s.requestedChangedIds.push(777);s.affected.push({elementId:777,uniqueId:r.uniqueId,exists:true});}
 }else if(mode==='physical-alias'){
  for(const s of states){s.internalBookkeeping.unavailableInternals[0].elementId=s.owners[0].elementId;s.internalBookkeeping.unavailableInternals[0].uniqueId=s.owners[0].uniqueId;}
 }else if(mode==='changed-identity')r.uniqueId='different';
 else if(mode==='missing')f.after.nativePlacementState.internalBookkeeping.unavailableInternals=[];
 else if(mode==='parameters')for(const s of states)s.internalBookkeeping.unavailableInternals[0].parameters=[];
 else if(mode==='dependentIds')for(const s of states)s.internalBookkeeping.unavailableInternals[0].dependentIds=[777];
 else if(mode==='wrong-error')for(const s of states)s.internalBookkeeping.unavailableInternals[0].parameterObservation.error='forged';
 else if(mode==='wrong-class')for(const s of states)s.internalBookkeeping.unavailableInternals[0].className='Autodesk.Revit.DB.FamilyInstance';
 else for(const s of states)s.internalBookkeeping.unavailableInternals[0].parameterObservation.reason='parameter_values_read_failed';
 assert.equal(run(f),null);
 });
for(const phase of ['baseline','immediate','independent'])for(const stage of ['internal_bounds','bookkeeping_profile','bookkeeping_self_dependency','bookkeeping_dependency_closure','bookkeeping_candidate_identity','bookkeeping_unavailable_profile','bookkeeping_header','bookkeeping_inventory_bound'])test(`incomplete native placement diagnostic never verifies ${phase}/${stage}`,()=>{
 const f=ancillaryExample();
 const failure={schema:'operator.native_accessory_placement_state.v1',complete:false,diagnosticOnly:true,
  reason:'native_observation_unavailable',error:stage==='internal_bounds'?'AccessViolationException':'InvalidOperationException',stage,elementId:378358,diagnosticCode:stage==='internal_bounds'?'native_observation_failed':'bookkeeping_projection_incomplete'};
 if(phase==='baseline')f.apply.preservationBefore.nativePlacementState=failure;
 else if(phase==='immediate')f.apply.preservationAfter.nativePlacementState=failure;
 else f.after.nativePlacementState=failure;
 assert.equal(run(f),null);
});
for(const mode of ['internal','dependent','both'] as const)for(const kind of ['duct','pipe'] as const)
 test(`${kind} preserves exact existing ${mode} public observations at all three stages`,()=>assert.ok(run(ancillaryExample(kind,mode))));
for(const [name,damage] of Object.entries({
 'no internal baseline':(f:any)=>{delete f.apply.preservationBefore.nativePlacementState.internalBookkeeping;},
 'no immediate internal observation':(f:any)=>{delete f.apply.preservationAfter.nativePlacementState.internalBookkeeping;},
 'incomplete scan':(f:any)=>{f.after.nativePlacementState.internalBookkeeping.candidateScanComplete=false;},
 'unobserved dependency closure':(f:any)=>{f.after.nativePlacementState.internalBookkeeping.internals[0].dependentIds.push(888);},
 'wrong class':(f:any)=>{f.after.nativePlacementState.internalBookkeeping.internals[0].className='Foreign';},
 'changed parameter':(f:any)=>{f.after.nativePlacementState.internalBookkeeping.internals[0].parameters[0].value='3';},
 'changed internal UID':(f:any)=>{f.after.nativePlacementState.internalBookkeeping.internals[0].uniqueId='changed';},
 'omitted internal':(f:any)=>{f.after.nativePlacementState.internalBookkeeping.internals.pop();},
 'new internal':(f:any)=>{const r=structuredClone(f.after.nativePlacementState.internalBookkeeping.internals[0]);r.elementId=888;r.uniqueId='new';r.dependentIds=[888];f.after.nativePlacementState.internalBookkeeping.internals.push(r);},
 'immediate only change':(f:any)=>{f.apply.preservationAfter.nativePlacementState.internalBookkeeping.internals[0].parameters[4].value='changed';},
 'unknown dependency excluded from coverage':(f:any)=>{for(const s of [f.apply.preservationBefore.nativePlacementState,f.apply.preservationAfter.nativePlacementState,f.after.nativePlacementState]){const r=s.internalBookkeeping.internals.pop();delete r.dependentIds;r.dependencyObservation={status:'unavailable',reason:'dependency_limit_exceeded',limit:64,observedAtLeast:65};s.internalBookkeeping.unavailableInternals.push(r);}},
 'duplicate candidate':(f:any)=>{f.after.nativePlacementState.internalBookkeeping.internals.push(f.after.nativePlacementState.internalBookkeeping.internals[0]);},
 'missing dependent parent':(f:any)=>{for(const s of [f.apply.preservationBefore.nativePlacementState,f.after.nativePlacementState,f.apply.preservationAfter.nativePlacementState])s.owners.find((o:any)=>o.elementId===40).dependentIds=[];},
 'changed dependent content':(f:any)=>{f.after.nativePlacementState.dependents[0].parameters[0].value='changed';},
 'changed immediate dependent':(f:any)=>{f.apply.preservationAfter.nativePlacementState.dependents[0].parameters[0].value='changed';},
 'incomplete dependent observations':(f:any)=>{for(const s of [f.apply.preservationBefore.nativePlacementState,f.after.nativePlacementState,f.apply.preservationAfter.nativePlacementState])delete s.dependents[0].parameters;},
 'added dependent parent':(f:any)=>{f.after.nativePlacementState.owners.find((o:any)=>o.elementId===100).dependentIds=[actualAncillary133.unchangedFlexDependent.elementId];},
 'changed affected identity':(f:any)=>{f.after.nativePlacementState.affected.at(-1).uniqueId='foreign';},
}))test(`ancillary coverage refuses ${name}`,()=>{const f=ancillaryExample();damage(f);assert.equal(run(f),null);});
test('actual133 after-only internal data never becomes a baseline or a pass',()=>{
 const f=ancillaryExample('duct','internal');delete f.apply.preservationBefore.nativePlacementState.internalBookkeeping;
 f.after.nativePlacementState.internalBookkeeping.internals=structuredClone(actualAncillary133.internals);assert.equal(run(f),null);
});

function largerCompleteInventory(){
 const f=ancillaryExample();
 for(const s of [f.apply.preservationBefore.nativePlacementState,f.apply.preservationAfter.nativePlacementState,f.after.nativePlacementState]){
  const template=s.internalBookkeeping.internals[0];
  s.internalBookkeeping.internals.push(...Array.from({length:65},(_,i)=>({...structuredClone(template),elementId:3000+i,uniqueId:'inventory-'+i,dependentIds:[3000+i]})));
 }
 return f;
}
test('complete inventory above64 preserves actual bounded native placement through independent readback',()=>assert.ok(run(largerCompleteInventory())));
for(const mode of ['changed','missing','duplicate','foreign-dependency','byte-bound','profile','unobserved-modified'])test('large complete inventory refuses '+mode,()=>{
 const f=largerCompleteInventory(),s=f.after.nativePlacementState,b=s.internalBookkeeping,r=b.internals.at(-1);
 if(mode==='changed')r.uniqueId='changed';
 if(mode==='missing')b.internals.pop();
 if(mode==='duplicate')b.internals.push(structuredClone(r));
 if(mode==='foreign-dependency')r.dependentIds.push(99999);
 if(mode==='byte-bound')r.padding='x'.repeat(1048577);
 if(mode==='profile')r.hasBounds=true;
 if(mode==='unobserved-modified'){
  for(const xs of [f.apply.transaction.modified_element_ids,f.apply.transaction.affected_element_ids,f.apply.changeTracking.observedModifiedIds])xs.push(99999);
  f.affected.push('element_id:99999');
 }
 assert.equal(run(f),null);
});
