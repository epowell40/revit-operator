import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {inlineSplitParametersMatchV2} from './inline_accessory_parameters_v2.js';
type Row=Record<string,any>;
const obj=(v:any):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
const equal=(a:any,b:any)=>payloadDigestV2(a).digest===payloadDigestV2(b).digest;
const id=(n:any)=>Number.isSafeInteger(n)&&n>0;
const uid=(s:any)=>typeof s==='string'&&s.length>0&&s.length<=256;
const require=(ok:any)=>{if(!ok)throw new Error('Incomplete or changed inline bookkeeping');};
const ids=(xs:any,cap:number)=>Array.isArray(xs)&&xs.length<=cap&&xs.every(id)&&new Set(xs).size===xs.length;
function rows(v:any,cap:number):Row[]{
  require(Array.isArray(v)&&v.length<=cap&&v.every((r:any)=>id(obj(r).elementId)&&uid(r.uniqueId))
    &&new Set(v.map((r:Row)=>r.elementId)).size===v.length&&new Set(v.map((r:Row)=>r.uniqueId)).size===v.length);
  return v;
}
function parameters(v:any):Row[]{
  require(Array.isArray(v)&&v.length<=128);let previous=-Infinity;
  for(const r of v){require(Number.isSafeInteger(r?.id)&&r.id!==0&&r.id>previous&&typeof r.readOnly==='boolean'
    &&['String','Double','Integer','ElementId','None'].includes(r.storage)&&(r.value===null||typeof r.value==='string'));
    if(r.storage==='Double')require(typeof r.value==='string'&&r.value.trim().length>0&&Number.isFinite(Number(r.value)));previous=r.id;}
  return v;
}
export const isCenterlineCategoryV2=(category:unknown)=>[-2008001,-2008066,-2008021,-2008045].includes(category as number);
function centerInputs(c:Row):string{
  // Match native single-row validation even when called from collateral checks.
  // Category alone never grants coverage: source, parent, shape, inputs and
  // exhaustive before/after footprint checks remain required by the caller.
  require(id(c.elementId)&&uid(c.uniqueId)&&c.className==='Autodesk.Revit.DB.Element'&&isCenterlineCategoryV2(c.categoryId)
    &&id(c.parentId)&&uid(c.parentUniqueId)&&Array.isArray(c.schemaGuids)&&c.schemaGuids.length===0);
  const ps=parameters(c.parameters),parent=parameters(c.parentParameters);
  require(ps.every(p=>parent.some(q=>p.id===q.id&&p.storage===q.storage)));
  return JSON.stringify(ps.filter(p=>!p.readOnly&&!parent.find(q=>q.id===p.id)!.readOnly)
    .map(p=>({id:p.id,storage:p.storage,value:p.value})));
}
const shape=(c:Row,k:string)=>parameters(c[k]).map(p=>({id:p.id,storage:p.storage,readOnly:p.readOnly}));
function sameCenter(b:Row,a:Row,isNew:boolean){
  return ['className','categoryId','schemaGuids',...isNew?[]:['elementId','uniqueId','parentId','parentUniqueId']].every(k=>equal(b[k],a[k]))
    &&equal(shape(b,'parameters'),shape(a,'parameters'))&&equal(shape(b,'parentParameters'),shape(a,'parentParameters'))
    &&inlineSplitParametersMatchV2(centerInputs(b),centerInputs(a),isNew);
}
// Reuse only the existing strict proxy shape/input rules. A native parent-bound
// observation and route-specific effect coverage are still required by callers.
export {centerInputs as centerlineInputsV2,sameCenter as sameCenterlineV2};
function validateInternalCandidates(s:Row){
  // Unavailable identities never authorize a changed owner. Retain the full
  // candidate inventory within native scan/byte budgets, independently of
  // the legacy transition64 limit. No truncation or inferred empty observation.
  require(Buffer.byteLength(JSON.stringify(s),'utf8')<=1048576);
  require(s.schema==='operator.inline_accessory_bookkeeping.v1'&&s.complete===true&&s.candidateScanComplete===true
    &&s.scope==='public_semantic_projection_not_hidden_state');
  const internal=rows(s.internals,50000),internalIds=new Set(internal.map(r=>r.elementId));
  const unavailable=rows(Object.hasOwn(s,'unavailableInternals')?s.unavailableInternals:[],50000);
  require(internal.length+unavailable.length<=50000);
  const unavailableSet=new Set(unavailable);
  const builtin=[-1140363,-1140362,-1013201,-1002002,-1002001];
  for(const r of [...internal,...unavailable]){
    const metadata=r.className==='Autodesk.Revit.DB.Element'&&r.categoryId===null&&r.typeId===-1&&r.hasLocation===false&&r.hasBounds===false
      &&Array.isArray(r.schemaGuids)&&r.schemaGuids.length===0;
    if(Object.hasOwn(r,'parameterObservation')){
      const p=obj(r.parameterObservation);
      require(unavailableSet.has(r)&&metadata&&!Object.hasOwn(r,'parameters')&&!Object.hasOwn(r,'dependentIds')&&!Object.hasOwn(r,'dependencyObservation')
        &&Object.keys(p).length===3&&p.status==='unavailable'&&p.reason==='parameter_layout_read_failed'&&p.error==='AccessViolationException');
      continue;
    }
    const ps=parameters(r.parameters);
    require(r.className==='Autodesk.Revit.DB.Element'&&r.categoryId===null&&r.typeId===-1&&r.hasLocation===false&&r.hasBounds===false
      &&Array.isArray(r.schemaGuids)&&r.schemaGuids.length===0&&ps.length===5
      &&ps.every((p,i)=>p.id===builtin[i]&&p.readOnly===true&&p.storage===(i<3?'ElementId':'String')
        &&(i<3?p.value==='-1':p.value===null||p.value==='')));
    if(unavailableSet.has(r)){
      const d=obj(r.dependencyObservation);
      if(d.reason==='dependency_closure_not_eligible'){
        require(!Object.hasOwn(r,'dependentIds')&&Object.keys(d).length===3&&d.status==='unavailable'
          &&ids(d.observedDependentIds,64)
          &&(!d.observedDependentIds.includes(r.elementId)||d.observedDependentIds.some((n:number)=>n!==r.elementId&&!internalIds.has(n))));
        continue;
      }
      require(!Object.hasOwn(r,'dependentIds')&&d.status==='unavailable'&&d.reason==='dependency_limit_exceeded'&&d.limit===64&&d.observedAtLeast===65);
    }else require(!Object.hasOwn(r,'dependencyObservation')&&ids(r.dependentIds,64)&&r.dependentIds.includes(r.elementId)&&r.dependentIds.every((n:number)=>internalIds.has(n)));
  }
  rows([...internal,...unavailable],50000);
  return {internal,unavailable};
}
/** Shared existing public-projection contract, not hidden-state equality.
 * Missing snapshots confer no coverage. Unknown candidates never qualify. */
export function preservedInternalCandidatesV2(before:unknown,after:unknown,immediate:unknown,excludedIds:readonly number[]=[]):Row[]|null{
  if(before===undefined&&after===undefined&&immediate===undefined)return [];
  try{
    const b=validateInternalCandidates(obj(before)),a=validateInternalCandidates(obj(after)),i=validateInternalCandidates(obj(immediate));
    const excluded=new Set(excludedIds);
    require(equal(b,a)&&equal(b,i)&&!a.unavailable.some(r=>excluded.has(r.elementId)));return a.internal;
  }catch{return null;}
}
/** Native insertion only: an unmodified public metadata record already tied to
 * the selected symbol may acquire edges to verified new instances of that symbol.
 * This never qualifies that unavailable record as a covered modified owner. */
export function preservedNativePlacementInternalsV2(before:unknown,after:unknown,immediate:unknown,excludedIds:readonly number[],sourceTypeId:number,placedIds:readonly number[]):Row[]|null{
 const exact=preservedInternalCandidatesV2(before,after,immediate,excludedIds);if(exact!==null)return exact;
 try{
  require(id(sourceTypeId)&&ids(placedIds,50)&&placedIds.length>0&&!placedIds.includes(sourceTypeId));
  const b=validateInternalCandidates(obj(before)),a=validateInternalCandidates(obj(after)),i=validateInternalCandidates(obj(immediate));
  require(equal(a,i)&&equal(b.internal,a.internal)&&b.unavailable.length===a.unavailable.length);
  const excluded=new Set(excludedIds);require(!a.unavailable.some(r=>excluded.has(r.elementId)));
  for(let index=0;index<b.unavailable.length;index++){
   const old=b.unavailable[index],now=a.unavailable[index];if(equal(old,now))continue;
   const bd=obj(old.dependencyObservation),nd=obj(now.dependencyObservation);
   require(bd.reason==='dependency_closure_not_eligible'&&nd.reason===bd.reason
    &&ids(bd.observedDependentIds,64)&&ids(nd.observedDependentIds,64)
    &&bd.observedDependentIds.includes(sourceTypeId)&&!placedIds.some(n=>bd.observedDependentIds.includes(n)));
   const added=nd.observedDependentIds.filter((n:number)=>!bd.observedDependentIds.includes(n));
   require(added.length>0&&added.every((n:number)=>placedIds.includes(n))
    &&bd.observedDependentIds.every((n:number)=>nd.observedDependentIds.includes(n))
    &&equal({...now,dependencyObservation:old.dependencyObservation},old));
  }
  return a.internal;
 }catch{return null;}
}
function validate(s:Row,physical:Row[]){
  const {internal,unavailable}=validateInternalCandidates(s),centers=rows(s.centerlines,10),system=obj(s.system);
  require(internal.length<=64); // Existing manual-split transition contract is unchanged.
  for(const c of centers){
    require(c.className==='Autodesk.Revit.DB.Element'&&isCenterlineCategoryV2(c.categoryId)
      &&id(c.parentId)&&uid(c.parentUniqueId)&&physical.some(o=>o.elementId===c.parentId&&o.uniqueId===c.parentUniqueId)
      &&Array.isArray(c.schemaGuids)&&c.schemaGuids.length===0);
    centerInputs(c);
  }
  require(id(system.elementId)&&uid(system.uniqueId)&&id(system.typeId)&&uid(system.typeUniqueId)
    &&system.className==='Autodesk.Revit.DB.Mechanical.MechanicalSystem'
    &&typeof system.parameters==='string'&&system.parameters.length<=128000
    &&typeof system.typeParameters==='string'&&system.typeParameters.length<=128000
    &&Array.isArray(JSON.parse(system.parameters))&&Array.isArray(JSON.parse(system.typeParameters)));
  rows(system.members,5000);rows(system.network,5000);
  for(const p of physical)require(system.network.some((r:Row)=>r.elementId===p.elementId&&r.uniqueId===p.uniqueId));
  const covered=[...internal,...centers,system].map(r=>r.elementId);
  require(ids(covered,75)&&!covered.some(n=>physical.some(p=>p.elementId===n)));
  const all=[...internal,...unavailable,...centers,system,...physical];require(new Set(all.map(r=>r.uniqueId)).size===all.length&&new Set(all.map(r=>r.elementId)).size===all.length);
  return {internal,unavailable,centers,system,covered};
}

/** Only a desired-state comparison. The caller must validate native source,
 * binding/currentness/receipt/digest and the exhaustive transaction footprint.
 * Internal records preserve their public projection, not invisible state. */
export function inlineBookkeepingTransitionV2(before:Row,after:Row,host:number,duct:number,accessory:number):{added:number[];covered:number[]}|null{
  try{
    require(ids([host,duct,accessory],3));
    const b=validate(obj(before.bookkeeping),rows(before.owners,5)),a=validate(obj(after.bookkeeping),rows(after.owners,5));
    require(equal(b.internal,a.internal));
    require(equal(b.unavailable,a.unavailable)); // Unknown owners never enter covered; the exhaustive footprint must exclude their changes.
    for(const k of ['elementId','uniqueId','className','typeId','typeUniqueId','parameters','typeParameters','members'])require(equal(b.system[k],a.system[k]));
    const bn=b.system.network as Row[],an=a.system.network as Row[];
    require(bn.some(r=>r.elementId===host)&&!bn.some(r=>[duct,accessory].includes(r.elementId))
      &&an.length===bn.length+2&&bn.every(r=>an.some(n=>equal(r,n)))
      &&equal(an.filter(r=>!bn.some(n=>n.elementId===r.elementId)).map(r=>r.elementId).sort((x,y)=>x-y),[duct,accessory].sort((x,y)=>x-y)));
    require(b.centers.every(r=>a.centers.some(n=>n.elementId===r.elementId&&sameCenter(r,n,false))));
    const added=a.centers.filter(r=>!b.centers.some(n=>n.elementId===r.elementId));
    require(added.length<=1&&added.every(r=>r.parentId===duct&&r.categoryId===-2008001
      &&b.centers.some(n=>n.parentId===host&&n.categoryId===r.categoryId&&sameCenter(n,r,true))));
    return {added:added.map(r=>r.elementId),covered:a.covered};
  }catch{return null;}
}
