import { parseRouteProfileSizeV1 } from "../existing_conditions/route_profile.js";
type Row = Record<string, any>;
const row=(v:unknown):Row=>v&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};
const id=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const finite=(v:unknown):number|null=>(typeof v==="number"||typeof v==="string"&&v.trim()!=="")&&Number.isFinite(Number(v))?Number(v):null;
const near=(a:unknown,b:number)=>finite(a)!==null&&Math.abs(finite(a)!-b)<=1e-6;
const point=(v:unknown):number[]|null=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==="number"&&Number.isFinite(n))?v:null;
function worldPoint(v:unknown):number[]|null {
  const p=row(v),keys=Object.keys(p);
  if(keys.length===1&&keys[0]==="xyz")return point(p.xyz);
  return keys.length===3&&keys.every(k=>["x","y","z"].includes(k))?point([p.x,p.y,p.z]):null;
}
const samePoint=(a:unknown,b:number[])=>{const p=point(a);return !!p&&p.every((n,i)=>near(n,b[i]!));};

/** Desired-state readback for a single explicit straight duct attached at both
 * ends. It does not certify interpretation of a PDF, visual review, branches,
 * fitting creation, worksets, or any other unverified additional effects. */
export function connectedDuctReadbackMatchesV2(input:unknown,affected:readonly string[],parameters:unknown,connectors:unknown):boolean {
  const request=row(input),b=row(request.body);
  const allowed=new Set(["kind","viewId","roomNumber","levelId","levelName","systemType","ductTypeId","ductType","ductShape","ductSize","diameter",
    "sizePolicy","elevationPolicy","routingMode","points","connectSegments","connectToExisting","requireExistingEndpointConnections",
    "externalConnectionToleranceFt","verify","apply","visualVerify","visualViewId","imageSize","focusPaddingFt"]);
  if(request.path!=="/revit/mep-route-workflow"||b.kind!=="duct"||b.apply!==true||b.routingMode!=="polyline"
    ||b.sizePolicy!=="explicit_required"||b.elevationPolicy!=="explicit_required"||!id(b.levelId)
    ||(b.ductTypeId===undefined?typeof b.ductType!=="string"||!b.ductType.trim():!id(b.ductTypeId))
    ||typeof b.connectSegments!=="boolean"||b.connectToExisting!==true||b.requireExistingEndpointConnections!==true
    ||Object.keys(b).some(k=>!allowed.has(k))||!Array.isArray(b.points)||b.points.length!==2
    ||affected.length!==1||!/^element_id:[1-9][0-9]*$/.test(affected[0]!))return false;
  const start=worldPoint(b.points[0]),end=worldPoint(b.points[1]);
  if(!start||!end||samePoint(start,end))return false;
  const elementId=Number(affected[0]!.slice(11)),system=({"Supply Air":"SupplyAir","Return Air":"ReturnAir","Exhaust Air":"ExhaustAir"} as Row)[b.systemType];
  if(!id(elementId)||!system)return false;
  if(!["round","rectangular"].includes(b.ductShape)||b.ductShape==="rectangular"&&b.diameter!==undefined)return false;
  const profile=parseRouteProfileSizeV1(b.ductShape,b.diameter??b.ductSize);
  if(!profile)return false;
  if(b.ductShape==="round"&&b.ductSize!==undefined&&b.diameter!==undefined) {
    const alias=parseRouteProfileSizeV1("round",b.ductSize);
    if(!alias||alias.diameter_ft===null||profile.diameter_ft===null||!near(alias.diameter_ft,profile.diameter_ft))return false;
  }
  const {diameter_ft:diameter,width_ft:width,height_ft:height}=profile;
  const params=row(parameters).items,c=row(connectors);
  if(!Array.isArray(params)||params.length!==1||row(params[0]).id!==elementId||row(params[0]).error
    ||c.status!=="Ok"||c.requestedCount!==1||c.scannedElementCount!==1||c.failedElementCount!==0||c.matchedElementCount!==1
    ||c.totalScannedConnectorCount!==2||c.physicallyConnectedConnectorCount!==2||c.openPhysicalConnectorCount!==0
    ||c.connectorScanTruncatedElementCount!==0||!Array.isArray(c.results)||c.results.length!==1)return false;
  const p=row(row(params[0]).parameters),r=row(c.results[0]);
  // Aliases are constraints on the same fresh native readback, not a rewrite
  // of the historical operation. A supplied ID and name must both match.
  if(!id(r.typeId)||(b.ductTypeId!==undefined&&r.typeId!==b.ductTypeId)
    ||(b.ductType!==undefined&&(typeof b.ductType!=="string"||!b.ductType.trim()||r.typeName!==b.ductType)))return false;
  if(b.levelName!==undefined) {
    const details=row(params[0]).parameterDetails;
    if(typeof b.levelName!=="string"||!b.levelName.trim()||!Array.isArray(details))return false;
    const levels=details.filter((v:unknown)=>row(v).name==="Reference Level");
    if(levels.length!==1||row(levels[0]).storageType!=="ElementId"
      ||!near(row(levels[0]).value,b.levelId)||row(levels[0]).valueString!==b.levelName)return false;
  }
  if(p["System Classification"]!==b.systemType||!near(p["Reference Level"],b.levelId)
    ||(diameter!==null?!near(p.Diameter,diameter):!near(p.Width,width!)||!near(p.Height,height!))
    ||r.id!==elementId||r.ok!==true||r.category!=="OST_DuctCurves"
    ||r.connectorCount!==2||r.returnedConnectorCount!==2||r.openPhysicalConnectorCount!==0||r.connectorScanTruncated!==false
    ||!Array.isArray(r.connectors)||r.connectors.length!==2)return false;
  const ends=r.connectors.map(row);
  for(const e of ends) {
    if(e.domain!=="DomainHvac"||e.connectorType!=="End"||e.systemClassification!==system||e.isConnected!==true
      ||e.isPhysicallyConnected!==true||e.physicalConnectionCount!==1||!Array.isArray(e.physicalConnectedTo)||e.physicalConnectedTo.length!==1
      ||!Array.isArray(e.connectedTo))return false;
    const ref=row(e.physicalConnectedTo[0]);
    if(!id(ref.ownerId)||ref.ownerId===elementId||ref.isMepSystem!==false||ref.isPhysicalElement!==true
      ||!["OST_DuctCurves","OST_DuctFitting","OST_DuctAccessory","OST_DuctTerminal","OST_MechanicalEquipment","OST_FlexDuctCurves"].includes(ref.ownerCategory))return false;
    const physical=e.connectedTo.filter((v:unknown)=>row(v).isPhysicalElement===true);
    if(physical.length!==1||row(physical[0]).ownerId!==ref.ownerId||row(physical[0]).ownerCategory!==ref.ownerCategory
      ||row(physical[0]).isMepSystem!==false||e.connectedTo.some((v:unknown)=>{const x=row(v);return x.isPhysicalElement!==true&&(x.isMepSystem!==true||x.ownerCategory!=="OST_DuctSystem"||!id(x.ownerId));}))return false;
    const size=row(e.size);
    if(diameter!==null) {if(e.shape!=="Round"||size.kind!=="round"||!near(size.diameterFt,diameter)||!near(size.radiusFt,diameter/2))return false;}
    else if(e.shape!=="Rectangular"||size.kind!=="rect"||!near(size.widthFt,width!)||!near(size.heightFt,height!))return false;
  }
  return samePoint(ends[0].origin,start)&&samePoint(ends[1].origin,end)
    ||samePoint(ends[0].origin,end)&&samePoint(ends[1].origin,start);
}
