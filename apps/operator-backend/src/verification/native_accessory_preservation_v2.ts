import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {nativeAccessoryTopologyV2, type NativeAccessoryTopology} from './native_accessory_topology_v2.js';
import {inlineSplitParametersMatchV2} from './inline_accessory_parameters_v2.js';
import {sameCenterlineV2,preservedNativePlacementInternalsV2} from './inline_accessory_bookkeeping_v2.js';
import {preservedScheduleRowsV2} from './native_annotation_postcondition_v2.js';
import {assignedConnectorInputsPreservedV2,terminalCalculatedFlowChangeV2,type NativeCalculatedFlowChange} from './native_accessory_flow_v2.js';
type Row=Record<string,any>;
const equal=(a:unknown,b:unknown)=>payloadDigestV2(a).digest===payloadDigestV2(b).digest;
const id=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0;
const uid=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=256;
const require=(condition:unknown)=>{if(!condition)throw new Error('Incomplete native placement preservation');};
const ids=(v:any,max=5000):number[]=>{require(Array.isArray(v)&&v.length<=max&&v.every(id)&&new Set(v).size===v.length);return v;};
const sameIds=(a:any,b:any,max=5000)=>{const x=ids(a,max),y=ids(b,max);return x.length===y.length&&x.every(n=>y.includes(n));};
const rows=(v:any,max=5000):Row[]=>{require(Array.isArray(v)&&v.length<=max&&v.every(r=>id(r?.elementId)&&uid(r.uniqueId))
  &&new Set(v.map((r:Row)=>r.elementId)).size===v.length&&new Set(v.map((r:Row)=>r.uniqueId)).size===v.length);return v;};
const point=(p:any)=>Array.isArray(p)&&p.length===3&&p.every((n:any)=>typeof n==='number'&&Number.isFinite(n));
const near=(a:any,b:any)=>point(a)&&point(b)&&Math.hypot(...a.map((n:number,i:number)=>n-b[i]))<=1e-6;
function writable(v:any){
 require(typeof v==='string'&&v.length<=128000);const ps=JSON.parse(v);require(Array.isArray(ps)&&ps.length<=2048);let prior=-Infinity;
 for(const p of ps){require(Number.isSafeInteger(p?.id)&&p.id!==0&&p.id>prior&&['String','Double','Integer','ElementId','None'].includes(p.storage)
   &&Object.keys(p).length===3&&(p.value===null||typeof p.value==='string'));prior=p.id;}return ps;
}
function state(scan:Row){
 const s=scan?.nativePlacementState;require(s?.schema==='operator.native_accessory_placement_state.v1'&&s.complete===true);
 require(sameIds(s.requestedElementIds,scan.results.map((r:Row)=>r.id))&&s.requestedElementIds.length>0);
 rows(s.owners);require(sameIds(s.owners.map((o:Row)=>o.elementId),s.requestedElementIds));
 rows(s.types,5001);rows(s.systems,50);rows(s.dependents,10000);ids(s.requestedChangedIds,1024);
 require(Array.isArray(s.affected)&&sameIds(s.affected.map((r:Row)=>r.elementId),s.requestedChangedIds,1024));
 require(sameIds(s.systems.map((r:Row)=>r.elementId),s.requestedSystemIds,50)&&ids(s.requestedTypeIds,1).length===1);
 for(const o of s.owners){
  const st=o.state;require(id(o.typeId)&&st?.UniqueId===o.uniqueId&&st.metadata?.type===o.typeId
    &&['Line','FlexDuct','FlexPipe','Point'].includes(st.geometryKind)&&Array.isArray(st.points)&&st.points.length>0&&st.points.length<=1000
    &&st.points.every(point)&&Array.isArray(st.ports)&&st.ports.length<=512&&Array.isArray(o.parameters)&&o.parameters.length<=512);
  ids(o.dependentIds,512);writable(st.parameters);
  const e=scan.results.find((r:Row)=>r.id===o.elementId);require(e?.typeId===o.typeId&&st.ports.length===e.connectors.length
    &&new Set(st.ports.map((p:Row)=>p.id)).size===st.ports.length);
  for(const p of st.ports){const c=e.connectors.find((c:Row)=>c.connectorId===p.id);require(c&&near(p.origin,c.origin)
    &&near(p.direction,c.coordinateSystem?.basisZ)&&p.shape===c.shape);}
 }
 for(const t of s.types)writable(t.parameters);
 require(s.owners.every((o:Row)=>s.types.some((t:Row)=>t.elementId===o.typeId))&&s.requestedTypeIds.every((n:number)=>s.types.some((t:Row)=>t.elementId===n)));
 for(const system of s.systems){require(id(system.typeId)&&uid(system.typeUniqueId)
   &&['Autodesk.Revit.DB.Mechanical.MechanicalSystem','Autodesk.Revit.DB.Plumbing.PipingSystem'].includes(system.className));
  writable(system.parameters);writable(system.typeParameters);rows(system.members);rows(system.network);
 }
 const sch=s.schedulePreservation;require(sch?.schema==='operator.annotation_schedule_read.v1'&&sch.complete===true
   &&preservedScheduleRowsV2(sch.items,ids(sch.requestedElementIds,32)));
 return s as Row;
}
function center(s:Row,d:Row):Row|null{
 const parents=s.owners.filter((o:Row)=>o.dependentIds.includes(d.elementId));
 if(parents.length!==1||d.className!=='Autodesk.Revit.DB.Element'||![-2008001,-2008066,-2008045].includes(d.categoryId)
   ||!Array.isArray(d.schemaGuids)||d.schemaGuids.length||d.exists!==true||!Array.isArray(d.parameters)||!d.parameters.length
   ||!parents[0].parameters.length)return null;
 const p=parents[0];return {...d,parentId:p.elementId,parentUniqueId:p.uniqueId,parentParameters:p.parameters};
}
function pipeCenterPreserved(before:Row,after:Row,immediate:Row,scan:Row){
 if(after.categoryId!==-2008045)return;
 require(scan.results.some((r:Row)=>r.id===after.parentId&&r.category==='OST_PipeCurves'));
 completeDependent(before);completeDependent(after);completeDependent(immediate);
 require(equal(after,immediate));
 for(const p of after.parameters){const old=before.parameters.find((r:Row)=>r.id===p.id);require(old);
  if(!equal(old,p)){
   require([-1114120,-1004005].includes(p.id)&&p.readOnly===true&&old.readOnly===true&&p.storage==='Double'&&old.storage==='Double');
   for(const [c,v] of [[before,old],[after,p]]){const parent=c.parentParameters.find((r:Row)=>r.id===v.id);
    require(parent?.readOnly===true&&parent.storage==='Double'&&parent.value===v.value&&typeof v.value==='string'
      &&v.value.trim().length>0&&Number.isFinite(Number(v.value))&&Number(v.value)>=0);}
  }
 }
}
function completeDependent(d:Row){
 require(d.exists===true&&typeof d.className==='string'&&d.className.length>0
  &&(d.categoryId===null||Number.isSafeInteger(d.categoryId))&&Number.isSafeInteger(d.typeId)&&Number.isSafeInteger(d.ownerViewId)
  &&typeof d.hasLocation==='boolean'&&typeof d.hasBounds==='boolean'&&Array.isArray(d.schemaGuids)&&d.schemaGuids.every((s:any)=>typeof s==='string')
  &&Array.isArray(d.parameters)&&d.parameters.length<=512);
 ids(d.dependentIds,512);let prior=-Infinity;
 for(const p of d.parameters){require(Number.isSafeInteger(p?.id)&&p.id!==0&&p.id>prior&&typeof p.readOnly==='boolean'
  &&['String','Double','Integer','ElementId','None'].includes(p.storage)&&(p.value===null||typeof p.value==='string'));prior=p.id;}
}
// Only complete native public observations of this exact non-printable view
// class can cover it. Legacy absent snapshots grant no coverage. No hidden
// state, arbitrary View exemption, or after-only inference is introduced.
function systemBrowsers(s:Row):Row[]{
 const b=s.systemBrowserViews;if(b===undefined)return [];
 require(b?.schema==='operator.native_system_browser_state.v1'&&b.complete===true
   &&b.scope==='system_browser_public_state_not_hidden_state'&&Object.keys(b).length===4);
 const items=rows(b.items,8);
 for(const r of items){require(Object.keys(r).length===6&&r.viewType==='SystemBrowser'&&r.isTemplate===false
   &&typeof r.name==='string'&&r.name.length>0&&r.name.length<=1024);
  const d=r.metadata;require(d?.elementId===r.elementId&&d.uniqueId===r.uniqueId&&d.className==='Autodesk.Revit.DB.View'
   &&d.categoryId===null&&d.typeId===-1&&d.ownerViewId===-1&&d.hasLocation===false&&d.schemaGuids?.length===0);
  completeDependent(d);require(Object.keys(d).sort().join(',')==='categoryId,className,dependentIds,elementId,exists,hasBounds,hasLocation,ownerViewId,parameters,schemaGuids,typeId,uniqueId'
    &&d.dependentIds.includes(d.elementId));
  for(const p of d.parameters){require(Object.keys(p).sort().join(',')==='id,readOnly,storage,value');
   if(p.storage==='Double')require(typeof p.value==='string'&&p.value.trim().length>0&&Number.isFinite(Number(p.value)));}
 }
 return items;
}

/** Desired-state/effect-coverage comparison only. All source, current binding,
 * receipt, digest, freshness, Pause and unknown guards belong to admission.
 * A positive result preserves exposed physical/prescribed data, not computed
 * flow equality, hidden Revit state, engineering correctness or task delivery. */
export function nativeAccessoryPreservationV2(input:unknown,affected:readonly string[],applied:unknown,observed:unknown):(NativeAccessoryTopology&{calculatedFlowChanges:NativeCalculatedFlowChange[]})|null{
 try{return compare(input as Row,affected,applied as Row,observed as Row);}catch{return null;}
}
function compare(request:Row,affected:readonly string[],a:Row,read:Row){
 const p=request?.body,tx=a?.transaction,tracking=a?.changeTracking;
 require(request?.path==='/revit/place-mep-accessory-interactively'&&request.method==='POST'
   &&p&&Object.keys(p).length===7&&['expectedModelPath','viewId','expectedViewUniqueId','accessoryTypeId','expectedAccessoryTypeUniqueId','maximumPlacements','targetHosts'].every(k=>Object.hasOwn(p,k))
   &&typeof p.expectedModelPath==='string'&&p.expectedModelPath.trim()&&p.expectedModelPath.length<=1024&&id(p.viewId)&&uid(p.expectedViewUniqueId)
   &&id(p.accessoryTypeId)&&uid(p.expectedAccessoryTypeUniqueId)&&Number.isInteger(p.maximumPlacements)&&p.maximumPlacements>=1&&p.maximumPlacements<=50);
 rows(p.targetHosts,50);require(p.targetHosts.length>0&&p.targetHosts.every((h:Row)=>Object.keys(h).length===2));
 require(a.applied===true&&a.success===true&&a.sourceTypeId===p.accessoryTypeId&&a.sourceTypeUniqueId===p.expectedAccessoryTypeUniqueId
   &&a.nativeInvocationReturned===true&&a.readbackError==null&&a.error==null&&a.placementCountCaptureFailed===false
   &&a.maximumPlacements===p.maximumPlacements&&tx?.status==='committed'&&tx.committed===true&&tx.pending!==true&&tx.rolled_back!==true
   &&tracking?.scope==='synchronous_native_placement_invocation'&&tracking.closed===true&&Array.isArray(tracking.problems)&&tracking.problems.length===0
   &&Number.isInteger(tracking.eventCount)&&tracking.eventCount>0&&tracking.eventCount<=256&&tracking.committedEventCount===tracking.eventCount);
 const added=ids(tx.added_element_ids,1024),modified=ids(tx.modified_element_ids,1024),deleted=ids(tx.deleted_element_ids,1024);
 require(deleted.length===0&&sameIds(tx.affected_element_ids,[...new Set([...added,...modified])],1024)
   &&sameIds(tx.affected_element_ids,affected.map(x=>Number(/^element_id:([1-9]\d*)$/.exec(x)?.[1])),1024)
   &&sameIds(tracking.observedAddedIds,added,1024)&&sameIds(tracking.observedModifiedIds,modified,1024)&&sameIds(tracking.observedDeletedIds,deleted,1024));
 const placed=rows(a.placedInstances,50);require(placed.length>0&&placed.length===a.placementCount&&placed.length<=p.maximumPlacements
   &&placed.every(r=>added.includes(r.elementId)));
 const b=state(a.preservationBefore),n=state(read),immediate=state(a.preservationAfter);
 const browsers=systemBrowsers(n),oldBrowsers=systemBrowsers(b),commitBrowsers=systemBrowsers(immediate);
 require(equal(oldBrowsers,browsers)&&equal(oldBrowsers,commitBrowsers));
 const otherIdentities=[b,n,immediate].flatMap(s=>[...s.owners,...s.types,...s.systems,...s.dependents,...s.schedulePreservation.items]);
 require(browsers.every(r=>!otherIdentities.some(o=>o.elementId===r.elementId||o.uniqueId===r.uniqueId)));
 require(sameIds(b.requestedChangedIds,[],0)&&sameIds(n.requestedChangedIds,tx.affected_element_ids,1024)
   &&sameIds(immediate.requestedChangedIds,n.requestedChangedIds,1024)&&sameIds(n.requestedElementIds,immediate.requestedElementIds)
   &&sameIds(n.requestedTypeIds,[p.accessoryTypeId],1)&&sameIds(b.requestedTypeIds,n.requestedTypeIds,1)
   &&sameIds(b.requestedSystemIds,n.requestedSystemIds,50));
 const symbol=b.types.find((t:Row)=>t.elementId===p.accessoryTypeId);
 require(symbol?.uniqueId===p.expectedAccessoryTypeUniqueId&&equal(b.types,n.types));
 for(const h of p.targetHosts)require(b.owners.some((o:Row)=>o.elementId===h.elementId&&o.uniqueId===h.uniqueId&&o.state.geometryKind==='Line'));
 const host=b.owners.find((o:Row)=>o.elementId===p.targetHosts[0].elementId),oldRow=a.preservationBefore.results.find((r:Row)=>r.id===host.elementId);
 const kind=oldRow?.category==='OST_DuctCurves'?'duct':oldRow?.category==='OST_PipeCurves'?'pipe':null;require(kind);
 const newPhysical=n.owners.filter((o:Row)=>!b.owners.some((r:Row)=>r.elementId===o.elementId));
 require(newPhysical.every((o:Row)=>added.includes(o.elementId))&&placed.every(r=>newPhysical.some((o:Row)=>o.elementId===r.elementId&&o.uniqueId===r.uniqueId)));
 const topology=nativeAccessoryTopologyV2(a.preservationBefore,read,p.targetHosts.map((h:Row)=>h.elementId),placed.map(r=>r.elementId),newPhysical.map((o:Row)=>o.elementId),p.accessoryTypeId,kind!);
 require(topology);
 const segmentHost=new Map<number,Row>(),accessoryHost=new Map<number,Row>();
 for(const run of topology!.runs){const old=b.owners.find((o:Row)=>o.elementId===run.hostId);
   for(const id of run.segmentIds)segmentHost.set(id,old);for(const id of run.accessoryIds)accessoryHost.set(id,old);}
 const calculatedFlowChanges:NativeCalculatedFlowChange[]=[];
 for(const current of n.owners){
   const old=b.owners.find((o:Row)=>o.elementId===current.elementId),origin=segmentHost.get(current.elementId);
   if(origin){require(current.typeId===origin.typeId&&equal(current.state.metadata,origin.state.metadata)&&current.state.geometryKind==='Line'
     &&current.state.points.length===2&&current.state.ports.length===2
     &&current.state.points.every((p:number[])=>current.state.ports.some((c:Row)=>near(p,c.origin)))
     &&inlineSplitParametersMatchV2(origin.state.parameters,current.state.parameters,!old)&&(!old||old.uniqueId===current.uniqueId));}
   else if(accessoryHost.has(current.elementId)){
     const parent=accessoryHost.get(current.elementId)!;
     require(['phase','demolished','workset','level'].every(k=>current.state.metadata[k]===parent.state.metadata[k])
       &&current.typeId===p.accessoryTypeId&&equal(current.state,immediate.owners.find((o:Row)=>o.elementId===current.elementId)?.state));
   }else{
    const immediateOwner=immediate.owners.find((o:Row)=>o.elementId===current.elementId);
    require(old&&old.uniqueId===current.uniqueId&&sameIds(old.dependentIds,current.dependentIds,512)
     &&assignedConnectorInputsPreservedV2(old,current,immediateOwner));
    if(!equal(old.state,current.state)){
     const change=terminalCalculatedFlowChangeV2(old,current,immediateOwner,
      a.preservationBefore.results.find((r:Row)=>r.id===current.elementId),read.results.find((r:Row)=>r.id===current.elementId),
      a.preservationAfter.results.find((r:Row)=>r.id===current.elementId));
     require(change);calculatedFlowChanges.push(change!);
    }
   }
 }
 if(calculatedFlowChanges.length){
  for(const [s,scan] of [[b,a.preservationBefore],[n,read],[immediate,a.preservationAfter]]){
   const d=s.flowDisplayBindings;
   require(d?.schema==='operator.native_terminal_tag_display.v1'&&d.complete===true
    &&sameIds(d.terminalIds,scan.results.filter((r:Row)=>r.category==='OST_DuctTerminal').map((r:Row)=>r.id))
    &&Array.isArray(d.tags)&&d.tags.length<=10000);
   rows(d.tags,10000);
   for(const tag of d.tags)require(id(tag.typeId)&&id(tag.ownerViewId)&&typeof tag.text==='string'&&tag.text.length<=32000
    &&ids(tag.targetIds,512).some(n=>d.terminalIds.includes(n)));
  }
  require(equal(b.flowDisplayBindings,n.flowDisplayBindings)&&equal(b.flowDisplayBindings,immediate.flowDisplayBindings));
 }
 require(equal(b.schedulePreservation,n.schedulePreservation));
 for(const system of b.systems){
   const now=n.systems.find((s:Row)=>s.elementId===system.elementId);require(now);
   for(const k of ['elementId','uniqueId','className','typeId','typeUniqueId','parameters','typeParameters','members','baseEquipmentId'])require(equal(system[k],now[k]));
   const expected=[...system.network];
   for(const run of topology!.runs)if(system.network.some((r:Row)=>r.elementId===run.hostId))for(const id of [...run.segmentIds,...run.accessoryIds])
     if(!expected.some((r:Row)=>r.elementId===id)){const owner=n.owners.find((o:Row)=>o.elementId===id);expected.push({elementId:id,uniqueId:owner.uniqueId});}
   require(equal(expected.sort((x:Row,y:Row)=>x.elementId-y.elementId),[...now.network].sort((x:Row,y:Row)=>x.elementId-y.elementId)));
 }
 // An unavailable internal observation cannot stand in for any affected or
 // separately observed model owner, even if its claimed identity aliases one.
 const excludedInternalIds=[...tx.affected_element_ids,...[b,n,immediate].flatMap(s=>
  [...s.owners,...s.types,...s.systems,...s.dependents,...s.schedulePreservation.items,...systemBrowsers(s)].map((r:Row)=>r.elementId))];
 const internals=preservedNativePlacementInternalsV2(b.internalBookkeeping,n.internalBookkeeping,immediate.internalBookkeeping,excludedInternalIds,p.accessoryTypeId,placed.map(r=>r.elementId));require(internals);
 const qualifiedCenters:number[]=[],newCenters:number[]=[],unchangedDependents:number[]=[];
 for(const prior of b.dependents){const now=n.dependents.find((d:Row)=>d.elementId===prior.elementId);require(now&&now.uniqueId===prior.uniqueId);
   const bc=center(b,prior),ac=center(n,now);
   if(bc&&ac){require(sameCenterlineV2(bc,ac,false)&&['typeId','ownerViewId','hasLocation','hasBounds','dependentIds'].every(k=>equal(prior[k],now[k])));
    pipeCenterPreserved(bc,ac,center(immediate,immediate.dependents.find((d:Row)=>d.elementId===now.elementId))!,read);
    qualifiedCenters.push(now.elementId);}
   else {
    const atCommit=immediate.dependents.find((d:Row)=>d.elementId===prior.elementId);
    completeDependent(prior);
    const parents=(s:Row)=>s.owners.filter((o:Row)=>o.dependentIds.includes(prior.elementId)).map((o:Row)=>({elementId:o.elementId,uniqueId:o.uniqueId}));
    require(equal(prior,now)&&equal(prior,atCommit)&&parents(b).length>0
      &&equal(parents(b),parents(n))&&equal(parents(b),parents(immediate)));
    unchangedDependents.push(prior.elementId);
   }
 }
 for(const now of n.dependents.filter((d:Row)=>!b.dependents.some((x:Row)=>x.elementId===d.elementId))){
   const ac=center(n,now),parent=ac&&segmentHost.get(ac.parentId);require(ac&&parent&&!b.owners.some((o:Row)=>o.elementId===ac.parentId));
   const candidates=b.dependents.map((d:Row)=>center(b,d)).filter((d:Row|null)=>d&&d.parentId===parent!.elementId&&d.categoryId===ac!.categoryId);
   require(candidates.length===1&&sameCenterlineV2(candidates[0],ac!,true)
     &&['typeId','ownerViewId','hasLocation','hasBounds'].every(k=>equal(candidates[0][k],ac![k]))
     &&sameIds(now.dependentIds,candidates[0].dependentIds.map((id:number)=>id===candidates[0].elementId?now.elementId:id===candidates[0].parentId?ac!.parentId:id),512));
   pipeCenterPreserved(candidates[0],ac!,center(immediate,immediate.dependents.find((d:Row)=>d.elementId===now.elementId))!,read);
   newCenters.push(now.elementId);qualifiedCenters.push(now.elementId);
 }
 require(sameIds(added,[...newPhysical.map((o:Row)=>o.elementId),...newCenters],1024));
 const covered=[...n.requestedElementIds,...n.types.map((t:Row)=>t.elementId),...n.requestedSystemIds,...n.schedulePreservation.requestedElementIds,...qualifiedCenters,...unchangedDependents,...internals!.map(r=>r.elementId),...browsers.map(r=>r.elementId)];
 require(modified.every(n=>covered.includes(n)));
 const identities=[...n.owners,...n.types,...n.systems,...n.schedulePreservation.items,...n.dependents,...internals!,...browsers];
 require(internals!.every(r=>identities.filter(i=>i.elementId===r.elementId||i.uniqueId===r.uniqueId).length===1));
 for(const changed of n.affected){const identity=identities.find((r:Row)=>r.elementId===changed.elementId);
   require(changed.exists===true&&identity?.uniqueId===changed.uniqueId);
   const browser=browsers.find(r=>r.elementId===changed.elementId);if(browser)require(equal(changed,browser.metadata));}
 return {...topology!,calculatedFlowChanges};
}
