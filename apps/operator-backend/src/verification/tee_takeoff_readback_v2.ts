import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {inlineSplitParametersMatchV2} from './inline_accessory_parameters_v2.js';
import {centerlineInputsV2,sameCenterlineV2,isCenterlineCategoryV2} from './inline_accessory_bookkeeping_v2.js';
import {preservedScheduleRowsV2} from './native_annotation_postcondition_v2.js';
import {readCompletePhysicalConnectorGraphV2,reciprocalPhysicalPairMatchesV2} from './existing_mep_connection_readback_v2.js';
import {teeCollateralCoverageV2,teeCollateralScopeV2} from './tee_collateral_preservation_v2.js';
type Row=Record<string,any>;
const obj=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const id=(v:any)=>Number.isSafeInteger(v)&&v>0;
const uid=(v:any)=>typeof v==='string'&&v.length>0&&v.length<=256;
const ids=(v:any,max=128):v is number[]=>Array.isArray(v)&&v.length<=max&&v.every(id)&&new Set(v).size===v.length;
const equal=(a:any,b:any)=>payloadDigestV2(a).digest===payloadDigestV2(b).digest;
const sameIds=(a:any,b:any)=>ids(a)&&ids(b)&&a.length===b.length&&a.every(n=>b.includes(n));
const point=(v:any):v is number[]=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='number'&&Number.isFinite(n));
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]!));
const near=(a:any,b:any,t=1e-6)=>point(a)&&point(b)&&distance(a,b)<=t;
const must=(v:any)=>{if(!v)throw Error('Incomplete or changed tee replacement state');};
function rows(v:any,max:number):Row[]{must(Array.isArray(v)&&ids(v.map(r=>obj(r).elementId),max)&&v.every(r=>uid(r.uniqueId))
  &&new Set(v.map(r=>r.uniqueId)).size===v.length);return v;}
function state(value:any){
  const s=obj(value);must(s.schema==='operator.tee_takeoff_replacement_state.v1'&&s.complete===true&&s.scope==='active_document_public_semantic_projection');
  const owners=rows(s.owners,8);must(owners.length>0&&sameIds(s.requestedElementIds,owners.map(o=>o.elementId)));
  for(const o of owners){const v=obj(o.state);must(v.UniqueId===o.uniqueId&&id(o.typeId)&&v.metadata?.type===o.typeId
    &&['Line','FlexDuct','Point'].includes(v.geometryKind)&&Array.isArray(v.points)&&v.points.length>0&&v.points.length<=1000&&v.points.every(point)
    &&typeof v.parameters==='string'&&v.parameters.length<=128000&&Array.isArray(JSON.parse(v.parameters))
    &&Array.isArray(v.ports)&&v.ports.length>0&&v.ports.length<=512&&v.ports.every((p:Row)=>Number.isSafeInteger(p.id)&&p.id>=0&&point(p.origin)&&point(p.direction)&&p.shape==='Round')
    &&new Set(v.ports.map((p:Row)=>p.id)).size===v.ports.length);}
  const types=rows(s.types,16);for(const t of types)must(typeof t.parameters==='string'&&t.parameters.length<=128000&&Array.isArray(JSON.parse(t.parameters)));
  must(owners.every(o=>types.some(t=>t.elementId===o.typeId)));
  const centers=rows(s.centerlines,10);
  for(const c of centers){must(c.className==='Autodesk.Revit.DB.Element'&&isCenterlineCategoryV2(c.categoryId)
    &&owners.some(o=>o.elementId===c.parentId&&o.uniqueId===c.parentUniqueId)&&Array.isArray(c.schemaGuids)&&c.schemaGuids.length===0);centerlineInputsV2(c);}
  const system=obj(s.system);must(id(system.elementId)&&uid(system.uniqueId)&&id(system.typeId)&&uid(system.typeUniqueId)
    &&system.className==='Autodesk.Revit.DB.Mechanical.MechanicalSystem');rows(system.members,5000);const network=rows(system.network,5000);
  for(const k of ['parameters','typeParameters'])must(typeof system[k]==='string'&&system[k].length<=128000&&Array.isArray(JSON.parse(system[k])));
  must(owners.every(o=>network.some(n=>n.elementId===o.elementId&&n.uniqueId===o.uniqueId)));
  const schedules=obj(s.schedulePreservation);must(schedules.schema==='operator.annotation_schedule_read.v1'&&schedules.complete===true
    &&ids(schedules.requestedElementIds,32)&&preservedScheduleRowsV2(schedules.items,schedules.requestedElementIds));
  must(ids([...owners,...centers,system,...types].map(o=>o.elementId),64)&&!schedules.requestedElementIds.some((n:number)=>[...owners,...centers,system,...types].some(o=>o.elementId===n)));
  return {s,owners,types,centers,system,network,schedules};
}

/** Public semantic transition only; native receipt/binding/currentness and
 * independent physical topology must be established by the surrounding paths. */
export function teeTakeoffTransitionV2(before:any,after:any,tee:number,bridge:number,fitting:number,retained:number[],modified:number[]=[]){
  try{
    must(ids([...retained,tee,bridge,fitting],6)&&retained.length===3);
    const b=state(before),a=state(after);
    must(sameIds(b.s.requestedElementIds,[...retained,tee])&&sameIds(a.s.requestedElementIds,[...retained,bridge,fitting]));
    for(const n of retained){const old=b.owners.find(o=>o.elementId===n)!,current=a.owners.find(o=>o.elementId===n)!;
      must(old.uniqueId===current.uniqueId&&old.typeId===current.typeId&&equal(old.state.metadata,current.state.metadata)
        &&old.state.geometryKind===current.state.geometryKind&&inlineSplitParametersMatchV2(old.state.parameters,current.state.parameters,false));}
    must(equal(b.types,a.types)&&equal(b.schedules,a.schedules));
    for(const k of ['elementId','uniqueId','className','typeId','typeUniqueId','parameters','typeParameters','members'])must(equal(b.system[k],a.system[k]));
    must(b.network.some(o=>o.elementId===tee)&&!b.network.some(o=>[bridge,fitting].includes(o.elementId))&&!a.network.some(o=>o.elementId===tee)
      &&a.network.length===b.network.length+1&&b.network.filter(o=>o.elementId!==tee).every(o=>a.network.some(n=>equal(n,o)))
      &&sameIds(a.network.filter(o=>!b.network.some(n=>n.elementId===o.elementId)).map(o=>o.elementId),[bridge,fitting]));
    const deleted=[tee,...b.centers.filter(c=>c.parentId===tee).map(c=>c.elementId)];
    const added=[bridge,fitting,...a.centers.filter(c=>[bridge,fitting].includes(c.parentId)).map(c=>c.elementId)];
    must(ids(deleted,12)&&ids(added,12)&&!deleted.some(n=>added.includes(n))
      &&b.centers.filter(c=>!deleted.includes(c.elementId)).every(c=>a.centers.some(n=>n.elementId===c.elementId&&sameCenterlineV2(c,n,false)))
      &&a.centers.filter(c=>!added.includes(c.elementId)).every(c=>b.centers.some(n=>n.elementId===c.elementId))
      &&!a.centers.some(c=>deleted.includes(c.elementId))&&sameIds(a.s.requestedRemovedIds,deleted)
      &&Array.isArray(a.s.removed)&&sameIds(a.s.removed.map((r:Row)=>r.elementId),deleted)&&a.s.removed.every((r:Row)=>r.exists===false&&r.uniqueId===null));
    const covered=[...retained,...added,...a.centers.filter(c=>!added.includes(c.elementId)).map(c=>c.elementId),a.system.elementId,...a.schedules.requestedElementIds];
    if(before.collateral!==undefined||after.collateral!==undefined){
      must(ids(modified,64));
      must(teeCollateralScopeV2(before.collateral,[...b.network,...b.system.members],b.s.requestedElementIds)
        &&teeCollateralScopeV2(after.collateral,[...a.network,...a.system.members],a.s.requestedElementIds));
      const extra=teeCollateralCoverageV2(before.collateral,after.collateral,modified.filter(n=>!covered.includes(n)),[...new Set([...covered,...deleted])]);
      must(extra);covered.push(...extra!);
    }
    must(ids(covered,64)&&!covered.some(n=>deleted.includes(n)));
    return {added,deleted,covered,physical:[...retained,bridge,fitting].sort((a,b)=>a-b),types:b.types.map(t=>t.elementId),schedules:b.schedules.requestedElementIds as number[]};
  }catch{return null;}
}

const fields=new Set(['expectedModelPath','connectionMode','kind','mainElementId','secondMainElementId','branchElementId','teeElementId',
  'branchConnectorId','expectedBranchOriginXyz','originToleranceFt','expectedTakeoffTypeId','expectedTakeoffFamilyName','expectedTakeoffTypeName','dryRun','verify']);
export function teeTakeoffReadbackMatchesV2(input:unknown,affected:readonly string[],applied:unknown,payload:unknown):boolean{
  try{return matches(input,affected,applied,payload);}catch{return false;}
}
function matches(input:unknown,affected:readonly string[],applied:unknown,payload:unknown):boolean{
  const request=obj(input),b=obj(request.body),a=obj(applied),scan=obj(payload),tx=obj(a.transaction),tracking=obj(a.changeTracking);
  const retained=[b.mainElementId,b.secondMainElementId,b.branchElementId],before=obj(a.preservationBefore),after=obj(scan.teeReplacementState);
  const tolerance=b.originToleranceFt??0.001;
  if(request.method!=='POST'||request.path!=='/revit/connect-existing-mep-branch'||b.connectionMode!=='replace_tee_with_takeoff'||b.kind!=='duct'
    ||b.dryRun!==false||(b.verify!==undefined&&b.verify!==true)||!ids([...retained,b.teeElementId],4)||!id(b.expectedTakeoffTypeId)
    ||Object.keys(b).some(k=>!fields.has(k))||typeof tolerance!=='number'||!Number.isFinite(tolerance)||tolerance<=0||tolerance>0.01
    ||a.connectionMode!==b.connectionMode||a.applied!==true||a.dryRun!==false||a.postChildCommitVerified!==true
    ||['mainElementId','secondMainElementId','branchElementId','teeElementId'].some(k=>a[k]!==b[k])
    ||!ids([...retained,b.teeElementId,a.createdBridgeId,a.createdFittingId],6)
    ||tx.status!=='committed'||tx.committed!==true||tx.pending===true||tx.rolled_back===true
    ||!ids(tx.added_element_ids,12)||!ids(tx.deleted_element_ids,12)||!ids(tx.modified_element_ids,64)
    ||!sameIds(tx.affected_element_ids,[...new Set<number>([...tx.added_element_ids,...tx.deleted_element_ids,...tx.modified_element_ids])])
    ||!sameIds(affected.map(v=>Number(/^element_id:([1-9]\d*)$/.exec(v)?.[1])),tx.affected_element_ids)
    ||tracking.documentChangedObserved!==true||tracking.exhaustiveChangeInventory!==true||tracking.captureFailureCount!==0
    ||!Number.isSafeInteger(tracking.matchingEventCount)||tracking.matchingEventCount<1||tracking.distinctWrapperMatchCount!==1)return false;
  const closure=teeTakeoffTransitionV2(before,after,b.teeElementId,a.createdBridgeId,a.createdFittingId,retained,tx.modified_element_ids);
  if(before.collateral!==undefined&&!equal(a.preservationAfter?.collateral,after.collateral))return false;
  if(!closure||!sameIds(tx.added_element_ids,closure.added)||!sameIds(tx.deleted_element_ids,closure.deleted)
    ||tx.modified_element_ids.some((n:number)=>!closure.covered.includes(n)))return false;
  const graph=readCompletePhysicalConnectorGraphV2(scan,closure.physical,'DomainHvac');
  if(!graph||scan.unknownPhysicalConnectorCount!==0)return false;
  const old=(id:number)=>before.owners.find((o:Row)=>o.elementId===id).state;
  const now=(id:number)=>after.owners.find((o:Row)=>o.elementId===id).state;
  for(const o of after.owners){const e=graph.get(o.elementId)!;if(e.typeId!==o.typeId||e.connectors.length!==o.state.ports.length)return false;
    for(const p of o.state.ports){const c=e.connectors.find((c:Row)=>c.connectorId===p.id);
      if(!c||!near(c.origin,p.origin)||!near(c.coordinateSystem?.basisZ,p.direction)||c.shape!==p.shape
        ||c.referenceScanComplete!==true||c.referenceReadErrorCount!==0||c.shape!=='Round'||c.size?.kind!=='round'
        ||typeof c.size.diameterFt!=='number'||!Number.isFinite(c.size.diameterFt)||c.size.diameterFt<=0
        ||typeof c.size.radiusFt!=='number'||!Number.isFinite(c.size.radiusFt)||Math.abs(c.size.radiusFt*2-c.size.diameterFt)>1e-6)return false;}}
  const selected=[a.mainConnectorId,a.secondMainConnectorId,a.branchConnectorId];
  if(selected.some(n=>!Number.isSafeInteger(n)||n<0)||b.branchConnectorId!==undefined&&b.branchConnectorId!==a.branchConnectorId)return false;
  const oldPorts=retained.map((n,i)=>old(n).ports.find((p:Row)=>p.id===selected[i]));if(oldPorts.some(p=>!p))return false;
  const [start,end,branchOrigin]=oldPorts.map(p=>p.origin) as number[][];
  if(!near(start,a.bridgeStart)||!near(end,a.bridgeEnd)||!near(branchOrigin,a.branchConnector?.origin)
    ||a.branchConnector?.connectorId!==a.branchConnectorId||a.branchConnector?.connectorIdBasis!=='revit_native_connector_id'
    ||b.expectedBranchOriginXyz!==undefined&&!near(branchOrigin,b.expectedBranchOriginXyz,tolerance))return false;
  const length=distance(start!,end!);if(length<=1e-6)return false;
  const axis=end!.map((x,i)=>(x-start![i]!)/length),station=branchOrigin!.reduce((s,x,i)=>s+(x-start![i]!)*axis[i]!,0);
  const projection=start!.map((x,i)=>x+axis[i]!*station),offset=distance(branchOrigin!,projection);
  if(station<=0||station>=length||offset<=tolerance||typeof a.branchOffsetFt!=='number'||Math.abs(a.branchOffsetFt-offset)>1e-6)return false;
  for(let i=0;i<3;i++){
    const n=retained[i]!,prior=old(n),current=now(n),e=graph.get(n)!,selectedId=selected[i];
    if(!['OST_DuctCurves',...(i===2?['OST_FlexDuctCurves']:[])].includes(e.category)||!['Line',...(i===2?['FlexDuct']:[])].includes(prior.geometryKind)
      ||prior.points.length!==current.points.length||!sameIds(prior.ports.map((p:Row)=>p.id+1),current.ports.map((p:Row)=>p.id+1)))return false;
    if(typeof prior.metadata.diameter!=='number'||!Number.isFinite(prior.metadata.diameter)||prior.metadata.diameter<=0
      ||e.connectors.filter((c:Row)=>c.connectorType==='End').some((c:Row)=>Math.abs(c.size.diameterFt-prior.metadata.diameter)>1e-6))return false;
    for(let j=0;j<prior.points.length;j++){
      const moving=i===2&&(j===0||j===prior.points.length-1)&&near(prior.points[j],branchOrigin,tolerance);
      if(moving?distance(current.points[j],branchOrigin!)>offset+tolerance:!near(prior.points[j],current.points[j],tolerance))return false;
    }
    for(const p of prior.ports){const q=current.ports.find((q:Row)=>q.id===p.id);
      if(!q||!(i===2&&p.id===selectedId)&&(!near(p.origin,q.origin,tolerance)||!near(p.direction,q.direction)))return false;}
    const priorEdges=a.retainedConnections?.[String(n)];if(!Array.isArray(priorEdges)||priorEdges.length>512)return false;
    const actual=e.connectors.flatMap((c:Row)=>c.physicalConnectedTo.filter((r:Row)=>![a.createdBridgeId,a.createdFittingId].includes(r.ownerId)).map((r:Row)=>({c,r})));
    if(actual.length!==priorEdges.length||new Set(priorEdges.map((p:Row)=>`${p.connectorId}:${p.connectedOwnerId}:${p.connectedConnectorId}`)).size!==priorEdges.length)return false;
    for(const p of priorEdges)if(p.connectorIdBasis!=='revit_native_connector_id'||p.connectedConnectorIdBasis!=='revit_native_connector_id'
      ||!actual.some(({c,r}:Row)=>c.connectorId===p.connectorId&&r.ownerId===p.connectedOwnerId&&r.connectorId===p.connectedConnectorId&&near(c.origin,p.origin,tolerance)&&near(r.origin,p.connectedOrigin,tolerance)))return false;
    const port=e.connectors.find((c:Row)=>c.connectorId===selectedId),target=i<2?a.createdBridgeId:a.createdFittingId;
    if(!port||port.physicalConnectedTo.length!==1||port.physicalConnectedTo[0].ownerId!==target||e.connectors.some((c:Row)=>c!==port&&c.physicalConnectedTo.some((r:Row)=>[a.createdBridgeId,a.createdFittingId].includes(r.ownerId))))return false;
  }
  const bridge=graph.get(a.createdBridgeId)!,fitting=graph.get(a.createdFittingId)!,bridgeState=now(a.createdBridgeId),fittingState=now(a.createdFittingId);
  if(bridge.category!=='OST_DuctCurves'||bridge.connectors.length!==3||fitting.category!=='OST_DuctFitting'||fitting.connectors.length!==2
    ||fitting.typeId!==b.expectedTakeoffTypeId||bridgeState.geometryKind!=='Line'||bridgeState.points.length!==2
    ||!near(bridgeState.points[0],start,tolerance)||!near(bridgeState.points[1],end,tolerance)||!equal(bridgeState.metadata,old(b.mainElementId).metadata)
    ||['phase','demolished','workset','level'].some(k=>fittingState.metadata[k]!==old(b.mainElementId).metadata[k]))return false;
  const symbol=after.types.find((t:Row)=>t.elementId===b.expectedTakeoffTypeId);
  for(const [requestKey,key] of [['expectedTakeoffFamilyName','familyName'],['expectedTakeoffTypeName','typeName']])
    if(b[requestKey!]!=null&&(typeof b[requestKey!]!=='string'||b[requestKey!].trim()&&String(symbol?.[key!]).trim().toLowerCase()!==b[requestKey!].trim().toLowerCase()))return false;
  for(const [owner,peers] of [[bridge,[...retained.slice(0,2),a.createdFittingId]],[fitting,[a.createdBridgeId,b.branchElementId]]] as [Row,number[]][]){
    if(!sameIds(owner.connectors.flatMap((c:Row)=>c.physicalConnectedTo.map((r:Row)=>r.ownerId)),peers))return false;
    for(const c of owner.connectors){if(c.physicalConnectedTo.length!==1)return false;const r=c.physicalConnectedTo[0],peer=graph.get(r.ownerId)!,p=peer?.connectors.find((p:Row)=>p.connectorId===r.connectorId);
      if(!p||!reciprocalPhysicalPairMatchesV2(owner,c,peer,p)||Math.abs(c.size.diameterFt-p.size.diameterFt)>1e-6)return false;}
  }
  const curve=bridge.connectors.filter((c:Row)=>c.connectorType==='Curve'),ends=bridge.connectors.filter((c:Row)=>c.connectorType==='End');
  return curve.length===1&&ends.length===2&&near(curve[0].origin,projection,tolerance)
    &&ends.every((c:Row)=>Math.abs(c.size.diameterFt-old(b.mainElementId).metadata.diameter)<=1e-6)
    &&fitting.connectors.every((c:Row)=>c.connectorType==='End');
}
