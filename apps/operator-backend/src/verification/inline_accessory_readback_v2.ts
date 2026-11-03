import {inlineSplitParametersMatchV2} from './inline_accessory_parameters_v2.js';
import {inlineBookkeepingTransitionV2} from './inline_accessory_bookkeeping_v2.js';
import { payloadDigestV2 } from '@revitoperator/payload-digest-v2';
import { readCompletePhysicalConnectorGraphV2, reciprocalPhysicalPairMatchesV2 } from './existing_mep_connection_readback_v2.js';
import { preservedScheduleRowsV2 } from './native_annotation_postcondition_v2.js';

type Row = Record<string, any>;
const obj = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const id = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const ids = (v: unknown, max = 128): v is number[] => Array.isArray(v) && v.length <= max && v.every(id) && new Set(v).size === v.length;
const point = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
const near = (a: unknown, b: unknown) => point(a) && point(b) && Math.hypot(...a.map((n,i) => n-b[i]!)) <= 1e-6;
const sameIds = (a: unknown, b: number[]) => ids(a) && a.length === b.length && b.every(n => a.includes(n));
const equal = (a: unknown, b: unknown) => payloadDigestV2(a).digest === payloadDigestV2(b).digest;
const uid = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;
const finitePositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const dot = (a: number[], b: number[]) => a.reduce((s,n,i) => s+n*b[i]!,0);
const subtract = (a: number[], b: number[]) => a.map((n,i) => n-b[i]!);
const distance = (a: number[], b: number[]) => Math.hypot(...subtract(a,b));
const fields = new Set(['expectedModelPath','connectionMode','kind','mainElementId','expectedMainUniqueId',
  'expectedMainStartXyz','expectedMainEndXyz','accessoryTypeId','expectedAccessoryTypeUniqueId','insertionPointXyz','instanceRadiusParameter','dryRun']);

function state(v: unknown, expectedIds: number[]) {
  const s = obj(v);
  if (s.schema !== 'operator.inline_accessory_state.v1' || s.complete !== true || !sameIds(s.requestedElementIds, expectedIds)
      || !Array.isArray(s.owners) || s.owners.length !== expectedIds.length || !sameIds(s.owners.map((x:Row)=>x.elementId),expectedIds)
      || new Set(s.owners.map((x:Row)=>x.uniqueId)).size!==s.owners.length
      || !Array.isArray(s.types) || !ids(s.types.map((x:Row)=>x.elementId),6)) return null;
  for (const o of s.owners) {
    const value = obj(o.state), m = obj(value.metadata);
    if (!uid(o.uniqueId) || !id(o.typeId) || value.UniqueId !== o.uniqueId || m.type !== o.typeId
        || !['Line','FlexDuct','Point'].includes(value.geometryKind) || !Array.isArray(value.points)
        || !value.points.length || value.points.length > 1000 || !value.points.every(point)
        || typeof value.parameters !== 'string' || value.parameters.length > 128_000
        || !Array.isArray(JSON.parse(value.parameters)) || !Array.isArray(value.ports) || value.ports.length > 512) return null;
  }
  for (const t of s.types) if (!uid(t.uniqueId) || typeof t.parameters !== 'string' || t.parameters.length > 128_000
      || !Array.isArray(JSON.parse(t.parameters))) return null;
  const schedule = obj(s.schedulePreservation);
  if (schedule.schema !== 'operator.annotation_schedule_read.v1' || schedule.complete !== true
      || !ids(schedule.requestedElementIds,32) || !preservedScheduleRowsV2(schedule.items,schedule.requestedElementIds)) return null;
  return s;
}

/** Pure desired-state comparison called behind native evidence admission.
 * The caller must retain the existing current native binding, receipt, digest,
 * Pause, unknown and settled-frontier checks. Never call this a trusted observation. */
export function inlineAccessoryReadbackMatchesV2(input: unknown, affected: readonly string[], applied: unknown, payload: unknown): boolean {
  try { return matches(input, affected, applied, payload); } catch { return false; }
}
function matches(input: unknown, affected: readonly string[], applied: unknown, payload: unknown): boolean {
  const request=obj(input), b=obj(request.body), a=obj(applied), read=obj(payload), tx=obj(a.transaction), tracking=obj(a.changeTracking);
  if (request.path!=='/revit/connect-existing-mep-branch' || request.method!=='POST' || b.connectionMode!=='insert_inline_accessory'
      || b.kind!=='duct' || b.dryRun!==false || !id(b.mainElementId) || !id(b.accessoryTypeId) || b.mainElementId===b.accessoryTypeId
      || !uid(b.expectedMainUniqueId) || !uid(b.expectedAccessoryTypeUniqueId) || !uid(b.instanceRadiusParameter)
      || typeof b.expectedModelPath!=='string' || !b.expectedModelPath.trim() || Object.keys(b).some(k=>!fields.has(k))
      || !point(b.expectedMainStartXyz) || !point(b.expectedMainEndXyz) || !point(b.insertionPointXyz)
      || a.applied!==true || a.dryRun!==false || a.mainElementId!==b.mainElementId || a.mainUniqueId!==b.expectedMainUniqueId
      || a.accessoryTypeId!==b.accessoryTypeId || !id(a.createdAccessoryId) || !id(a.createdDuctId)
      || !ids([b.mainElementId,a.createdAccessoryId,a.createdDuctId,b.accessoryTypeId]) || !finitePositive(a.diameterFt)
      || !near(a.originalStart,b.expectedMainStartXyz) || !near(a.originalEnd,b.expectedMainEndXyz)
      || tx.status!=='committed' || tx.committed!==true || tx.pending===true || tx.rolled_back===true
      || !ids(tx.added_element_ids,4)
      || !sameIds(tx.deleted_element_ids,[]) || !ids(tx.modified_element_ids) || !tx.modified_element_ids.includes(b.mainElementId)
      || !ids(tx.affected_element_ids) || !sameIds(tx.affected_element_ids,[...new Set<number>([...tx.added_element_ids,...tx.modified_element_ids])])
      || !sameIds(affected.map(x=>Number(/^element_id:([1-9]\d*)$/.exec(x)?.[1])),tx.affected_element_ids)
      || tracking.documentChangedObserved!==true || tracking.exhaustiveChangeInventory!==true || tracking.captureFailureCount!==0
      || !Number.isSafeInteger(tracking.matchingEventCount) || tracking.matchingEventCount<1 || tracking.distinctWrapperMatchCount!==1) return false;
  const remoteMap=obj(a.preexistingRemoteConnections), remoteIds=Object.keys(remoteMap).map(Number);
  if (!ids(remoteIds,2) || remoteIds.includes(b.mainElementId) || !Array.isArray(a.preexistingMainConnections)) return false;
  const beforeIds=[b.mainElementId,...remoteIds], currentIds=[...beforeIds,a.createdDuctId,a.createdAccessoryId];
  if (!ids(currentIds,5) || currentIds.includes(b.accessoryTypeId)) return false;
  const before=state(a.preservationBefore,beforeIds), after=state(read.inlineAccessoryState,currentIds);
  if (!before || !after || !sameIds(after.types.map((t:Row)=>t.elementId),before.types.map((t:Row)=>t.elementId))) return false;
  const hasBookkeeping=before.bookkeeping!==undefined||after.bookkeeping!==undefined;
  const ancillary=hasBookkeeping?inlineBookkeepingTransitionV2(before,after,b.mainElementId,a.createdDuctId,a.createdAccessoryId):{added:[],covered:[]};
  if(!ancillary||!sameIds(tx.added_element_ids,[a.createdAccessoryId,a.createdDuctId,...ancillary.added]))return false;
  for (const type of before.types) if (!after.types.some((current:Row)=>equal(type,current))) return false;
  const symbol=before.types.find((t:Row)=>t.elementId===b.accessoryTypeId);
  if (!symbol || symbol.uniqueId!==b.expectedAccessoryTypeUniqueId) return false;
  const schedules=before.schedulePreservation.requestedElementIds as number[];
  if (!sameIds(after.schedulePreservation.requestedElementIds,schedules)) return false;
  for (const prior of before.schedulePreservation.items)
    if (!after.schedulePreservation.items.some((current:Row)=>equal(prior,current))) return false;
  const allowed=[...currentIds,b.accessoryTypeId,...schedules,...ancillary.covered];
  if (!ids(allowed) || tx.modified_element_ids.some((n:number)=>!allowed.includes(n))) return false;
  const graph=readCompletePhysicalConnectorGraphV2(read,currentIds,'DomainHvac');
  if (!graph || read.unknownPhysicalConnectorCount!==0 || [...graph.values()].some(e=>e.connectors.some((c:Row)=>
      c.referenceScanComplete!==true || c.referenceReadErrorCount!==0))) return false;
  for (const current of after.owners) {
    const observed=graph.get(current.elementId);
    if (!observed || observed.typeId!==current.typeId || current.state.ports.length!==observed.connectors.length
        || new Set(current.state.ports.map((p:Row)=>p.id)).size!==current.state.ports.length) return false;
    for(const p of current.state.ports) {
      const c=observed.connectors.find((c:Row)=>c.connectorId===p.id);
      if(!c||!near(c.origin,p.origin)||!near(obj(c.coordinateSystem).basisZ,p.direction)||c.shape!==p.shape)return false;
    }
  }
  const original=before.owners.find((o:Row)=>o.elementId===b.mainElementId), originalState=obj(original?.state);
  if (original?.uniqueId!==b.expectedMainUniqueId || originalState.geometryKind!=='Line' || originalState.points.length!==2
      || !near(originalState.points[0],a.originalStart) || !near(originalState.points[1],a.originalEnd)
      || originalState.metadata.diameter!==a.diameterFt) return false;
  const hostNow=after.owners.find((o:Row)=>o.elementId===b.mainElementId);
  if (hostNow.uniqueId!==b.expectedMainUniqueId) return false;
  const accessory=graph.get(a.createdAccessoryId)!;
  if (accessory.category!=='OST_DuctAccessory' || accessory.typeId!==b.accessoryTypeId || accessory.connectors.length!==2) return false;
  const accessoryState=after.owners.find((o:Row)=>o.elementId===a.createdAccessoryId).state;
  if(['phase','demolished','workset','level'].some(k=>accessoryState.metadata[k]!==originalState.metadata[k]))return false;
  const start=a.originalStart as number[], end=a.originalEnd as number[], length=distance(start,end);
  if (!finitePositive(length)) return false;
  const axis=subtract(end,start).map(n=>n/length);
  const ports=[...accessory.connectors].sort((x,y)=>dot(subtract(x.origin,start),axis)-dot(subtract(y.origin,start),axis));
  if (!near(ports[0].origin.map((n:number,i:number)=>(n+ports[1].origin[i])/2),b.insertionPointXyz)
      || distance(ports[0].origin,ports[1].origin)<=1e-6) return false;
  const remaining=new Set([b.mainElementId,a.createdDuctId]);
  for (let i=0;i<2;i++) {
    const port=ports[i], far=i===0?start:end;
    if (port.connectorType!=='End' || port.shape!=='Round' || obj(port.size).kind!=='round'
        || Math.abs(port.size.diameterFt-a.diameterFt)>1e-6 || !Number.isFinite(port.size.diameterFt)
        || !finitePositive(port.size.radiusFt) || Math.abs(port.size.radiusFt*2-port.size.diameterFt)>1e-6
        || !point(obj(port.coordinateSystem).basisZ) || Math.abs(Math.hypot(...port.coordinateSystem.basisZ)-1)>1e-6
        || dot(port.coordinateSystem.basisZ,axis)*(i===0?-1:1)<1-1e-6 || port.physicalConnectedTo.length!==1) return false;
    const station=dot(subtract(port.origin,start),axis);
    if (station<=0 || station>=length || !near(port.origin,start.map((n,j)=>n+axis[j]!*station))) return false;
    const segmentId=port.physicalConnectedTo[0].ownerId, segment=graph.get(segmentId), observed=after.owners.find((o:Row)=>o.elementId===segmentId);
    if (!remaining.delete(segmentId) || !segment || segment.category!=='OST_DuctCurves' || segment.connectors.length!==2
        || !observed || observed.state.geometryKind!=='Line' || observed.state.points.length!==2
        || !equal(observed.state.metadata,originalState.metadata) || !inlineSplitParametersMatchV2(originalState.parameters,observed.state.parameters,segmentId===a.createdDuctId)
        || !(near(observed.state.points[0],far)&&near(observed.state.points[1],port.origin)
          || near(observed.state.points[1],far)&&near(observed.state.points[0],port.origin))) return false;
    const nearPort=segment.connectors.find((c:Row)=>near(c.origin,port.origin)), farPort=segment.connectors.find((c:Row)=>near(c.origin,far));
    if (!nearPort || !farPort || nearPort===farPort || !reciprocalPhysicalPairMatchesV2(segment,nearPort,accessory,port)
        || nearPort.physicalConnectedTo.length!==1 || segment.connectors.some((c:Row)=>c.connectorType!=='End'||c.shape!=='Round'
          || obj(c.size).kind!=='round'||!Number.isFinite(c.size.diameterFt)||Math.abs(c.size.diameterFt-a.diameterFt)>1e-6
          ||!finitePositive(c.size.radiusFt)||Math.abs(c.size.radiusFt*2-c.size.diameterFt)>1e-6)) return false;
    const previous=a.preexistingMainConnections.filter((e:Row)=>near(e.origin,far));
    if (previous.length>1 || farPort.physicalConnectedTo.length!==previous.length) return false;
    for (const edge of previous) {
      const peer=graph.get(edge.connectedOwnerId), c=peer?.connectors.find((c:Row)=>c.connectorId===edge.connectedConnectorId);
      if (!remoteIds.includes(edge.connectedOwnerId) || edge.connectorIdBasis!=='revit_native_connector_id'
          || edge.connectedConnectorIdBasis!=='revit_native_connector_id' || !c || !near(c.origin,edge.connectedOrigin)
          || !reciprocalPhysicalPairMatchesV2(segment,farPort,peer!,c)) return false;
    }
  }
  if (remaining.size || a.preexistingMainConnections.some((e:Row)=>!near(e.origin,start)&&!near(e.origin,end))) return false;
  for (const remoteId of remoteIds) {
    const old=before.owners.find((o:Row)=>o.elementId===remoteId), current=after.owners.find((o:Row)=>o.elementId===remoteId);
    if (!equal(old,current) || !Array.isArray(remoteMap[String(remoteId)])) return false;
    const edges=graph.get(remoteId)!.connectors.flatMap((c:Row)=>c.physicalConnectedTo.map((r:Row)=>({c,r})));
    const prior=remoteMap[String(remoteId)] as Row[];
    if (edges.length!==prior.length) return false;
    for (const edge of prior) {
      if (edge.connectorIdBasis!=='revit_native_connector_id' || edge.connectedConnectorIdBasis!=='revit_native_connector_id') return false;
      const matches=edges.filter(({c,r}:{c:Row;r:Row})=>c.connectorId===edge.connectorId && near(c.origin,edge.origin)&&near(r.origin,edge.connectedOrigin)
        && (edge.connectedOwnerId===b.mainElementId ? [b.mainElementId,a.createdDuctId].includes(r.ownerId)
          : r.ownerId===edge.connectedOwnerId && r.connectorId===edge.connectedConnectorId));
      if (matches.length!==1) return false;
    }
  }
  return true;
}
