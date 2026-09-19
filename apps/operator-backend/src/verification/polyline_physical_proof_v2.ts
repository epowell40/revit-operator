// Pure geometry and physical-owner proof. The assignment adapter establishes
// native authority, immutable apply identities and fresh same-assignment reads.
type Row = Record<string, any>;
const point = (p: any): p is number[] => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const sub = (a:number[],b:number[]) => a.map((v,i)=>v-b[i]);
const dot = (a:number[],b:number[]) => a.reduce((s,v,i)=>s+v*b[i],0);
const norm = (a:number[]) => Math.sqrt(dot(a,a));
const same = (a:any,b:any) => point(a)&&point(b)&&norm(sub(a,b))<=1e-6;
const opposing = (a:any,b:any) => point(a)&&point(b)&&norm(a)>1e-6&&norm(b)>1e-6&&dot(a,b)/(norm(a)*norm(b))<=-1+1e-8;
const onLine = (p:number[],origin:number[],axis:any) => point(axis)&&norm(axis)>1e-6
  &&same(p,origin.map((v,i)=>v+axis[i]*dot(sub(p,origin),axis)/dot(axis,axis)));
const id = (n:any) => Number.isSafeInteger(n)&&n>0;
const physicalCategories = new Set(['OST_DuctCurves','OST_DuctFitting','OST_DuctAccessory','OST_DuctTerminal','OST_MechanicalEquipment','OST_FlexDuctCurves']);
function projection(p:any,a:number[],b:number[]) {
  if(!point(p)||!point(a)||!point(b))return null;
  const v=sub(b,a), length=norm(v);
  if(length<=1e-6)return null;
  const along=dot(sub(p,a),v)/length;
  const nearest=a.map((x,i)=>x+along*v[i]/length);
  return same(p,nearest)&&along>=-1e-6&&along<=length+1e-6?along:null;
}
function refs(c:Row): Row[] | null {
  if(!Array.isArray(c.connectedTo)||!Array.isArray(c.physicalConnectedTo))return null;
  const a=c.physicalConnectedTo;
  if(a.length>1||c.physicalConnectionCount!==a.length||c.isPhysicallyConnected!==(a.length===1)||c.isConnected!==(a.length===1))return null;
  if(a.some((r:Row)=>!id(r.ownerId)||r.isMepSystem!==false||r.isPhysicalElement!==true||!physicalCategories.has(r.ownerCategory)||r.isConnectedTo!==true||r.connectorIdBasis!=='revit_native_connector_id'||!Number.isSafeInteger(r.connectorId)||r.connectorId<0||r.connectorType!=='End'||r.domain!=='DomainHvac'||!same(r.origin,c.origin)))return null;
  const b=c.connectedTo.filter((r:Row)=>r.isPhysicalElement===true);
  if(JSON.stringify(a)!==JSON.stringify(b))return null;
  if(c.connectedTo.some((r:Row)=>r.isPhysicalElement!==true&&(r.isMepSystem!==true||r.isPhysicalElement!==false||r.ownerCategory!=='OST_DuctSystem'||!id(r.ownerId))))return null;
  return a;
}
function size(c:Row,profile:Row) {
  return profile.shape==='round'
    ? c.shape==='Round'&&c.size?.kind==='round'&&Math.abs(c.size.diameterFt-profile.diameter)<1e-6&&Math.abs(c.size.radiusFt-profile.diameter/2)<1e-6
    : c.shape==='Rectangular'&&c.size?.kind==='rect'&&Math.abs(c.size.widthFt-profile.width)<1e-6&&Math.abs(c.size.heightFt-profile.height)<1e-6;
}
/** Every segment and internal joint is proved. External references are allowed
 * only at the two explicit route endpoints. No fit/route can be silently lost. */
export function polylinePhysicalProof({ points, segmentIds, fittingIds, profiles, system, endpointPolicy, rows }: {points:number[][];segmentIds:number[];fittingIds:number[];profiles:Row[];system:string;endpointPolicy:string;rows:Row[]}):boolean {
  if(!Array.isArray(points)||points.length<2||points.length>65||!points.every(point)
    ||!Array.isArray(segmentIds)||segmentIds.length!==points.length-1||!Array.isArray(profiles)||profiles.length!==segmentIds.length
    ||!Array.isArray(fittingIds)||fittingIds.length>segmentIds.length+1||![...segmentIds,...fittingIds].every(id)
    ||new Set([...segmentIds,...fittingIds]).size!==segmentIds.length+fittingIds.length
    ||!Array.isArray(rows)||rows.length!==segmentIds.length+fittingIds.length
    ||!['open','existing_required','existing_optional'].includes(endpointPolicy))return false;
  const all=new Map(rows.map(r=>[r.id,r]));
  if(all.size!==rows.length||[...segmentIds,...fittingIds].some(id=>!all.has(id)))return false;
  for(const r of rows) {
    if(r.ok!==true||r.connectorScanTruncated!==false||r.connectorCount!==2||r.returnedConnectorCount!==2
      ||!Array.isArray(r.connectors)||r.connectors.length!==2||new Set(r.connectors.map((c:Row)=>c.connectorId)).size!==2
      ||r.connectors.some((c:Row)=>!Number.isSafeInteger(c.connectorId)||c.connectorId<0||c.connectorIdBasis!=='revit_native_connector_id'
        ||!point(c.origin)||c.domain!=='DomainHvac'||c.connectorType!=='End'||c.systemClassification!==system||refs(c)===null)
      ||r.openPhysicalConnectorCount!==r.connectors.filter((c:Row)=>refs(c)!.length===0).length)return false;
    if(segmentIds.includes(r.id)?r.category!=='OST_DuctCurves':r.category!=='OST_DuctFitting')return false;
  }
  const ordered:Row[][]=[];
  for(let i=0;i<segmentIds.length;i++) {
    const r=all.get(segmentIds[i])!, endpoints: {c:Row;t:number|null}[]=r.connectors.map((c:Row)=>({c,t:projection(c.origin,points[i],points[i+1])}));
    if(endpoints.some(e=>e.t===null||!size(e.c,profiles[i])))return false;
    endpoints.sort((a,b)=>a.t!-b.t!);
    if(endpoints[1].t!-endpoints[0].t!<=1e-6)return false;
    ordered.push(endpoints.map(e=>e.c));
  }
  const paired=(aOwner:number,a:Row,bOwner:number,b:Row)=>refs(a)!.length===1&&refs(b)!.length===1
    &&refs(a)![0].ownerId===bOwner&&refs(b)![0].ownerId===aOwner
    &&refs(a)![0].ownerCategory===all.get(bOwner)?.category&&refs(b)![0].ownerCategory===all.get(aOwner)?.category
    &&refs(a)![0].connectorId===b.connectorId&&refs(b)![0].connectorId===a.connectorId
    &&same(a.origin,b.origin);
  const used=new Set();
  for(let i=0;i<segmentIds.length-1;i++) {
    const left=ordered[i][1],right=ordered[i+1][0];
    if(paired(segmentIds[i],left,segmentIds[i+1],right)) {
      if(!same(left.origin,points[i+1])||!opposing(sub(points[i],points[i+1]),sub(points[i+2],points[i+1]))
        ||!size(left,profiles[i+1])||!size(right,profiles[i]))return false;
      continue;
    }
    const candidates=fittingIds.filter(fid=>!used.has(fid)&&refs(left)![0]?.ownerId===fid&&refs(right)![0]?.ownerId===fid);
    if(candidates.length!==1)return false;
    const fid=candidates[0],fit=all.get(fid)!;
    const from=fit.connectors.find((c:Row)=>paired(segmentIds[i],left,fid,c));
    const to=fit.connectors.find((c:Row)=>paired(segmentIds[i+1],right,fid,c));
    if(!from||!to||from===to||!size(from,profiles[i])||!size(to,profiles[i+1]))return false;
    used.add(fid);
  }
  for(const [owner,c,p,profile] of ([[segmentIds[0],ordered[0][0],points[0],profiles[0]],[segmentIds.at(-1),ordered.at(-1)![1],points.at(-1),profiles.at(-1)]] as [number,Row,number[],Row][])) {
    let external=refs(c)!;
    let terminal=c;
    const fid=external[0]?.ownerId;
    if(fittingIds.includes(fid)&&!used.has(fid)) {
      if(endpointPolicy==='open')return false;
      const fit=all.get(fid)!;
      const inside=fit.connectors.find((f:Row)=>paired(owner,c,fid,f));
      const outside=fit.connectors.find((f:Row)=>f!==inside);
      if(!inside||!outside||!size(inside,profile)||!size(outside,profile)
        ||!opposing(c.coordinateSystem?.basisZ,inside.coordinateSystem?.basisZ)
        ||!onLine(p,outside.origin,outside.coordinateSystem?.basisZ))return false;
      external=refs(outside)!; terminal=outside;
      if(external.length!==1||all.has(external[0].ownerId))return false;
      used.add(fid);
    } else if(!same(c.origin,p)||external.length&&all.has(fid))return false;
    // A native direct ConnectTo can still be an unfitted bend. Require the
    // independently read peer axis/size for external rigid-duct connections.
    if(external[0]?.ownerCategory==='OST_DuctCurves'
      &&(!opposing(terminal.coordinateSystem?.basisZ,external[0].coordinateSystem?.basisZ)||!size(external[0],profile)))return false;
    if(endpointPolicy==='open'&&external.length!==0||endpointPolicy==='existing_required'&&external.length!==1)return false;
  }
  return used.size===fittingIds.length;
}
