import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {reciprocalPhysicalPairMatchesV2} from './existing_mep_connection_readback_v2.js';
import {readNativePlacementGraphV2} from './native_placement_graph_v2.js';

type Row = Record<string, any>;
type Endpoint = {ownerId:number; connectorId:number};
export type NativeAccessoryRun = {hostId:number; segmentIds:number[]; accessoryIds:number[]; endpoints:Endpoint[]};
export type NativeAccessoryTopology = {runs:NativeAccessoryRun[]; untouchedHostIds:number[]};
const id=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0;
const list=(v:unknown,max:number):v is number[]=>Array.isArray(v)&&v.length<=max&&v.every(id)&&new Set(v).size===v.length;
const point=(p:unknown):p is number[]=>Array.isArray(p)&&p.length===3&&p.every(n=>typeof n==='number'&&Number.isFinite(n));
const near=(a:unknown,b:unknown)=>point(a)&&point(b)&&Math.hypot(...a.map((n,i)=>n-b[i]!))<=1e-6;
const same=(a:unknown,b:unknown)=>payloadDigestV2(a).digest===payloadDigestV2(b).digest;
const key=(owner:number,connector:number)=>`${owner}:${connector}`;
const dimensions=(c:Row):unknown=>{
  const s=c.size;
  if(c.shape==='Round'&&s?.kind==='round'&&Number.isFinite(s.radiusFt)&&s.radiusFt>0
    &&Number.isFinite(s.diameterFt)&&Math.abs(s.radiusFt*2-s.diameterFt)<=1e-6)return ['Round',s.diameterFt];
  if(['Rectangular','Oval'].includes(c.shape)&&s?.kind===(c.shape==='Rectangular'?'rect':'oval')
    &&Number.isFinite(s.widthFt)&&s.widthFt>0&&Number.isFinite(s.heightFt)&&s.heightFt>0)return [c.shape,s.widthFt,s.heightFt];
  return null;
};
const sameSize=(a:Row,b:Row)=>{
  const x=dimensions(a),y=dimensions(b);
  return Array.isArray(x)&&Array.isArray(y)&&x.length===y.length&&x[0]===y[0]
    &&x.slice(1).every((n,i)=>Math.abs(n-y[i+1])<=1e-6);
};

/** Pure physical topology projection only. Not evidence admission, parameter /
 * schedule preservation, effect coverage or a verification certificate. Native
 * IDs can survive on either segment or neither; endpoints and reciprocal ports
 * establish the replacement run. Calculated flow is deliberately not projected. */
export function nativeAccessoryTopologyV2(before:unknown,after:unknown,hostIds:unknown,placedIds:unknown,
  addedPhysicalIds:unknown,typeId:number,kind:'duct'|'pipe'):NativeAccessoryTopology|null {
  try{return compare(before as Row,after as Row,hostIds,placedIds,addedPhysicalIds,typeId,kind);}catch{return null;}
}
function compare(before:Row,after:Row,hosts:unknown,placed:unknown,added:unknown,typeId:number,kind:'duct'|'pipe'):NativeAccessoryTopology|null {
  if(!list(hosts,50)||!hosts.length||!list(placed,50)||!placed.length||!list(added,150)||!id(typeId)
    ||!['duct','pipe'].includes(kind)||placed.some(n=>!added.includes(n)))return null;
  const beforeIds=before?.results?.map((r:Row)=>r.id),afterIds=after?.results?.map((r:Row)=>r.id);
  if(!list(beforeIds,5000)||!list(afterIds,5000)||hosts.some(n=>!beforeIds.includes(n))
    ||added.some(n=>beforeIds.includes(n))||!same([...afterIds.filter(n=>!beforeIds.includes(n))].sort((a,b)=>a-b),[...added].sort((a,b)=>a-b))
    ||beforeIds.some(n=>!afterIds.includes(n)&&!hosts.includes(n)))return null;
  const domain=kind==='duct'?'DomainHvac':'DomainPiping',curve=kind==='duct'?'OST_DuctCurves':'OST_PipeCurves';
  const accessory=kind==='duct'?'OST_DuctAccessory':'OST_PipeAccessory';
  const b=readNativePlacementGraphV2(before),a=readNativePlacementGraphV2(after);
  if(!b||!a||before.unknownPhysicalConnectorCount!==0||after.unknownPhysicalConnectorCount!==0)return null;
  for(const graph of [b,a])for(const e of graph.values())for(const c of e.connectors){
    if(c.referenceScanComplete!==true||c.referenceReadErrorCount!==0||!point(c.coordinateSystem?.basisZ))return null;
  }
  const consumed=new Set<number>(),boundaries=new Map<string,Endpoint>(),runs:NativeAccessoryRun[]=[],untouchedHostIds:number[]=[];
  for(const hostId of hosts){
    const old=b.get(hostId)!;
    if(old.category!==curve||old.connectors.length!==2||old.connectors.some((c:Row)=>c.connectorType!=='End'||c.physicalConnectedTo.length>1)
      ||!sameSize(old.connectors[0],old.connectors[1]))return null;
    const [start,end]=old.connectors as Row[],axis=end.origin.map((n:number,i:number)=>n-start.origin[i]);
    const length=Math.hypot(...axis);if(length<=1e-6)return null;
    const unit=axis.map((n:number)=>n/length);
    const station=(p:number[])=>p.reduce((v,n,i)=>v+(n-start.origin[i])*unit[i]!,0);
    const onLine=(p:number[])=>near(p,start.origin.map((n:number,i:number)=>n+unit[i]*station(p)));
    const eligible=(e:Row)=>e.id===hostId||added.includes(e.id);
    const starts=[...a.values()].filter(e=>eligible(e)&&e.category===curve)
      .flatMap(e=>e.connectors.filter((c:Row)=>near(c.origin,start.origin)).map((c:Row)=>({e,c})));
    if(starts.length!==1)return null;
    let {e,c}=starts[0]!;const first:Endpoint={ownerId:e.id,connectorId:c.connectorId};
    const seen=new Set<number>(),segments:number[]=[],accessories:number[]=[];let last:Endpoint|undefined;
    for(let step=0;step<=added.length+1;step++){
      if(seen.has(e.id)||consumed.has(e.id)||!eligible(e)||e.connectors.length!==2||!e.connectors.includes(c))return null;
      seen.add(e.id);
      const exit=e.connectors.find((p:Row)=>p!==c)!;
      const isAccessory=placed.includes(e.id);
      if(isAccessory?(e.category!==accessory||e.typeId!==typeId):(e.category!==curve||e.typeId!==old.typeId))return null;
      for(const p of e.connectors){
        if(p.domain!==domain||p.connectorType!=='End'||!sameSize(p,start)||!onLine(p.origin)||station(p.origin)<-1e-6||station(p.origin)>length+1e-6
          ||Math.abs(Math.hypot(...p.coordinateSystem.basisZ)-1)>1e-6)return null;
      }
      const travel=station(exit.origin)-station(c.origin);
      if(travel<(isAccessory?-1e-6:1e-6))return null;
      if(c.coordinateSystem.basisZ.reduce((s:number,n:number,i:number)=>s+n*unit[i],0)>-1+1e-6
        ||exit.coordinateSystem.basisZ.reduce((s:number,n:number,i:number)=>s+n*unit[i],0)<1-1e-6)return null;
      (isAccessory?accessories:segments).push(e.id);
      if(near(exit.origin,end.origin)){
        if(isAccessory)return null;last={ownerId:e.id,connectorId:exit.connectorId};break;
      }
      if(exit.physicalConnectedTo.length!==1)return null;
      const r=exit.physicalConnectedTo[0],next=a.get(r.ownerId),entry=next?.connectors.find((p:Row)=>p.connectorId===r.connectorId);
      if(!next||!entry||entry.physicalConnectedTo.length!==1||!reciprocalPhysicalPairMatchesV2(e,exit,next,entry))return null;
      e=next;c=entry;
    }
    if(!last||segments.length!==accessories.length+1)return null;
    // Reject adjacent accessories/segments: this slice covers native inline insertion,
    // not an unobserved coupling, reducer or arbitrary network reconstruction.
    const sequence=[...seen];for(let i=0;i<sequence.length;i++)if(placed.includes(sequence[i]!)!==(i%2===1))return null;
    boundaries.set(key(hostId,start.connectorId),first);boundaries.set(key(hostId,end.connectorId),last);
    for(const n of seen)consumed.add(n);
    if(accessories.length)runs.push({hostId,segmentIds:segments,accessoryIds:accessories,endpoints:[first,last]});
    else if(segments.length===1&&segments[0]===hostId)untouchedHostIds.push(hostId);else return null;
  }
  if(placed.some(n=>!consumed.has(n))||added.some(n=>!consumed.has(n)))return null;
  const remap=(owner:number,connector:number)=>boundaries.get(key(owner,connector))??{ownerId:owner,connectorId:connector};
  const edges=(c:Row,transform:boolean)=>c.physicalConnectedTo.map((r:Row)=>{
    const to=transform?remap(r.ownerId,r.connectorId):r;
    return {...r,ownerId:to.ownerId,connectorId:to.connectorId};
  }).sort((x:Row,y:Row)=>x.ownerId-y.ownerId||x.connectorId-y.connectorId);
  for(const old of b.values()){
    if(hosts.includes(old.id)){
      for(const oldPort of old.connectors){const mapped=remap(old.id,oldPort.connectorId),current=a.get(mapped.ownerId)?.connectors.find((p:Row)=>p.connectorId===mapped.connectorId);
        if(!current||!same(edges(oldPort,true),edges(current,false)))return null;}
      continue;
    }
    const current=a.get(old.id);
    if(!current||current.typeId!==old.typeId||current.category!==old.category||current.connectors.length!==old.connectors.length)return null;
    for(const p of old.connectors){const n=current.connectors.find((c:Row)=>c.connectorId===p.connectorId);
      if(!n||p.domain!==n.domain||!near(p.origin,n.origin)||!same(p.size,n.size)||p.shape!==n.shape||p.connectorType!==n.connectorType
        ||!same(p.coordinateSystem,n.coordinateSystem)||!same(edges(p,true),edges(n,false)))return null;}
  }
  return {runs,untouchedHostIds};
}
