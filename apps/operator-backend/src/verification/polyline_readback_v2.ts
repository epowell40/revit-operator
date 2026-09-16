import {polylinePhysicalProof} from './polyline_physical_proof_v2.js';
type Row = Record<string, any>;
import {parseRouteProfileSizeV1} from '../existing_conditions/route_profile.js';
const row=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const id=(v:any)=>Number.isSafeInteger(v)&&v>0;
const near=(a:any,b:number)=>(typeof a==='number'||typeof a==='string'&&a.trim()!=='')&&Number.isFinite(Number(a))&&Math.abs(Number(a)-b)<=1e-6;
const sameIds=(a:any,b:number[])=>Array.isArray(a)&&a.length===b.length&&a.every(id)&&new Set(a).size===a.length&&a.every(x=>b.includes(x));
const allowed=new Set(['kind','viewId','roomNumber','frameId','levelId','levelName','systemType','ductTypeId','ductType','ductShape','ductSize','diameter','segmentSizes','sizePolicy','elevationPolicy','routingMode','points','connectSegments','connectToExisting','requireExistingEndpointConnections','externalConnectionToleranceFt','verify','apply','visualVerify','visualViewId','imageSize','focusPaddingFt']);
export function polylineReadbackMatchesV2(input:unknown,nativeApply:unknown,parameters:unknown,connectors:unknown):boolean{
 const request=row(input),b=row(request.body),apply=row(row(nativeApply).applyResult??nativeApply);
 if(request.path!=='/revit/mep-route-workflow'||b.kind!=='duct'||b.apply!==true||b.verify===false
  ||b.routingMode!=='polyline'||typeof b.connectSegments!=='boolean'||typeof b.connectToExisting!=='boolean'
  ||typeof b.requireExistingEndpointConnections!=='boolean'||b.requireExistingEndpointConnections&&!b.connectToExisting
  ||b.sizePolicy!=='explicit_required'||b.elevationPolicy!=='explicit_required'
  ||(b.levelId===undefined?typeof b.levelName!=='string'||!b.levelName.trim():!id(b.levelId))
  ||(b.levelName!==undefined&&(typeof b.levelName!=='string'||!b.levelName.trim()))
  ||(b.ductTypeId===undefined?typeof b.ductType!=='string'||!b.ductType.trim():!id(b.ductTypeId))
  ||Object.keys(b).some(k=>!allowed.has(k))||!Array.isArray(b.points)||b.points.length<2||b.points.length>65
  ||!['round','rectangular'].includes(b.ductShape))return false;
 const points=b.points.map((p:Row)=>{p=row(p);return Object.keys(p).length===1&&Array.isArray(p.xyz)&&p.xyz.length===3&&p.xyz.every(Number.isFinite)?p.xyz:null;});
 if(points.some((p:unknown)=>!p)||points.length>2&&!b.connectSegments)return false;
 const system=({'Supply Air':'SupplyAir','Return Air':'ReturnAir','Exhaust Air':'ExhaustAir'} as Row)[b.systemType];
 if(!system)return false;
 if(b.ductShape==='rectangular'&&b.diameter!==undefined)return false;
 const base=parseRouteProfileSizeV1(b.ductShape,b.diameter??b.ductSize);
 if(!base)return false;
 if(b.diameter!==undefined&&b.ductSize!==undefined){const alias=parseRouteProfileSizeV1(b.ductShape,b.ductSize);if(!alias||!near(alias.diameter_ft,base.diameter_ft!))return false;}
 if(b.segmentSizes!==undefined&&(!Array.isArray(b.segmentSizes)||b.segmentSizes.length!==points.length-1))return false;
 const profiles=Array.from({length:points.length-1},(_,i)=>b.segmentSizes?parseRouteProfileSizeV1(b.ductShape,b.segmentSizes[i]):base);
 if(profiles.some(p=>!p))return false;
 if(!Array.isArray(apply.segments)||apply.segments.length!==profiles.length||!Array.isArray(apply.createdFittingIds))return false;
 const segments=[...apply.segments].sort((a,b)=>a.index-b.index);
 if(segments.some((s,i)=>s.index!==i||!id(s.id)))return false;
 const segmentIds=segments.map(s=>s.id),fittingIds=apply.createdFittingIds;
 if(!sameIds(apply.createdElementIds,segmentIds)||!fittingIds.every(id))return false;
 const owners=[...segmentIds,...fittingIds],p=row(parameters),c=row(connectors);
 if(new Set(owners).size!==owners.length||!Array.isArray(p.items)||!sameIds(p.items.map((x:Row)=>x.id),owners)
  ||c.status!=='Ok'||c.requestedCount!==owners.length||c.scannedElementCount!==owners.length
  ||c.matchedElementCount!==owners.length||c.failedElementCount!==0||c.connectorScanTruncatedElementCount!==0
  ||!Array.isArray(c.results)||!sameIds(c.results.map((x:Row)=>x.id),owners))return false;
 if(c.totalScannedConnectorCount!==2*owners.length
  ||c.openPhysicalConnectorCount!==c.results.reduce((s:number,r:Row)=>s+r.openPhysicalConnectorCount,0)
  ||c.physicallyConnectedConnectorCount!==2*owners.length-c.openPhysicalConnectorCount)return false;
 let resolvedLevelId:number|undefined=b.levelId;
 for(let i=0;i<segmentIds.length;i++){
  const pr=p.items.find((r:Row)=>r.id===segmentIds[i]),cr=c.results.find((r:Row)=>r.id===segmentIds[i]),values=row(pr.parameters),profile=profiles[i]!;
  // A name is resolved only by independent native ElementId parameter detail,
  // consistently across every duct. The apply response is not level evidence.
  if(b.levelName!==undefined){const levels=Array.isArray(pr.parameterDetails)?pr.parameterDetails.filter((x:Row)=>x.name==='Reference Level'):[];
   if(levels.length!==1||levels[0].storageType!=='ElementId'||!id(Number(levels[0].value))||levels[0].valueString!==b.levelName)return false;
   resolvedLevelId??=Number(levels[0].value);
   if(!near(levels[0].value,resolvedLevelId))return false;}
  if(pr.error||!id(cr.typeId)||b.ductTypeId!==undefined&&cr.typeId!==b.ductTypeId||b.ductType!==undefined&&cr.typeName!==b.ductType
   ||resolvedLevelId===undefined||!near(values['Reference Level'],resolvedLevelId)||values['System Classification']!==b.systemType
   ||(profile.diameter_ft!==null?!near(values.Diameter,profile.diameter_ft):!near(values.Width,profile.width_ft!)||!near(values.Height,profile.height_ft!)))return false;
 }
 if(p.items.some((x:Row)=>x.error))return false;
 return polylinePhysicalProof({points:points as number[][],segmentIds,fittingIds,system,rows:c.results,
  profiles:profiles.map(p=>p!.diameter_ft!==null?{shape:'round',diameter:p!.diameter_ft}:{shape:'rectangular',width:p!.width_ft,height:p!.height_ft}),
  endpointPolicy:b.requireExistingEndpointConnections?'existing_required':b.connectToExisting?'existing_optional':'open'});
}
