import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {preservedInternalCandidatesV2,sameCenterlineV2} from './inline_accessory_bookkeeping_v2.js';
type Row=Record<string,any>;
const require=(v:unknown)=>{if(!v)throw Error('Incomplete or changed tee collateral');};
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=(v:any)=>Number.isSafeInteger(v)&&v>0;
const ids=(v:any,max:number):number[]=>{require(Array.isArray(v)&&v.length<=max&&v.every(id)&&new Set(v).size===v.length);return v;};
const equal=(a:unknown,b:unknown)=>payloadDigestV2(a).digest===payloadDigestV2(b).digest;
const point=(v:any)=>Array.isArray(v)&&v.length===3&&v.every((n:any)=>typeof n==='number'&&Number.isFinite(n));
const identity=(v:any,r:Row)=>require(v?.elementId===r.elementId&&v?.uniqueId===r.uniqueId);
function rows(s:any,protectedIds:number[]):Row[]{
 require(object(s)&&s.schema==='operator.tee_collateral.v1'&&s.complete===true&&s.scope==='unchanged_connected_system_public_state'
  &&Buffer.byteLength(JSON.stringify(s),'utf8')<=1048576&&Array.isArray(s.rows));
 const rs=s.rows as Row[];ids(rs.map(r=>r.elementId),10000);
 require(rs.every(r=>typeof r.uniqueId==='string'&&r.uniqueId.trim().length>0&&r.uniqueId.length<=256&&!protectedIds.includes(r.elementId))
  &&new Set(rs.map(r=>r.uniqueId)).size===rs.length);
 for(const r of rs){require(Object.keys(r).length===5&&object(r.state));const p=ids(r.parentIds,64),v=r.state;
  switch(r.role){
   case 'physical':require(!p.length&&Object.keys(v).length===4&&object(v.metadata)&&object(v.geometry)&&Array.isArray(v.parameters)&&Array.isArray(v.connections));
    identity(v.metadata,r);require(['Autodesk.Revit.DB.Mechanical.Duct','Autodesk.Revit.DB.Mechanical.FlexDuct','Autodesk.Revit.DB.FamilyInstance'].includes(v.metadata.className)
     &&v.geometry.UniqueId===r.uniqueId&&['Line','Point','FlexDuct'].includes(v.geometry.geometryKind)
     &&Array.isArray(v.geometry.points)&&v.geometry.points.length>0&&v.geometry.points.every(point)
     &&Array.isArray(v.geometry.ports)&&v.geometry.ports.length===v.connections.length&&v.connections.length>0&&v.connections.length<=512);
    for(const c of v.connections)require(point(c.origin)&&point(c.basisX)&&point(c.basisY)&&point(c.basisZ)&&Array.isArray(c.peers));break;
   case 'centerline':require(p.length===1&&v.parentId===p[0]&&sameCenterlineV2(v,v,false));identity(v,r);break;
   case 'tag':require(p.length>0&&v.complete===true&&Array.isArray(v.head)&&v.head.length===3&&Array.isArray(v.references)&&v.references.length>0
    &&Array.isArray(v.leaders)&&object(v.bounds)&&object(v.metadata)&&typeof v.text==='string'&&point(v.head)
    &&v.metadata.className==='Autodesk.Revit.DB.IndependentTag');identity(v.metadata,r);break;
   case 'system_browser':require(!p.length&&v.viewType==='SystemBrowser'&&v.metadata?.className==='Autodesk.Revit.DB.View');identity(v.metadata,r);break;
   case 'internal':require(!p.length);break;
   default:require(false);
  }
 }
 const internal=rs.filter(r=>r.role==='internal');
 const internalState={schema:'operator.inline_accessory_bookkeeping.v1',complete:true,scope:'public_semantic_projection_not_hidden_state',candidateScanComplete:true,
  internals:internal.map(r=>r.state),unavailableInternals:[]};
 const check=preservedInternalCandidatesV2(internalState,internalState,internalState,protectedIds);
 require(check&&check.length===internal.length&&internal.every(r=>r.state.elementId===r.elementId&&r.state.uniqueId===r.uniqueId));
 return rs;
}
/** Equality of prospective native public observations, never identity-only
 * exemptions. Receipt/source/currentness guards remain at existing admission. */
export function teeCollateralCoverageV2(before:unknown,after:unknown,requested:number[],protectedIds:number[]):number[]|null{
 try{ids(requested,64);ids(protectedIds,128);const b=rows(before,protectedIds),a=rows(after,protectedIds);
  require(b.length===a.length&&b.every(old=>a.some(now=>now.elementId===old.elementId&&equal(old,now)))
   &&requested.every(n=>a.some(r=>r.elementId===n)));return requested;
 }catch{return null;}
}
export function teeCollateralScopeV2(collateral:unknown,network:Row[],junction:number[]):boolean{
 try{const rs=rows(collateral,junction);
  for(const r of rs){
   if(r.role==='physical')require(network.some(n=>n.elementId===r.elementId&&n.uniqueId===r.uniqueId));
   if(r.role==='tag')require(r.parentIds.every((p:number)=>network.some(n=>n.elementId===p)));
   if(r.role==='centerline')require(rs.some(p=>p.role==='physical'&&p.elementId===r.state.parentId&&p.uniqueId===r.state.parentUniqueId));
  }return true;
 }catch{return false;}
}
