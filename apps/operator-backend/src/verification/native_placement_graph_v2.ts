import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
type Row=Record<string,any>;
const id=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>0;
const cid=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
const point=(p:unknown):p is number[]=>Array.isArray(p)&&p.length===3&&p.every(n=>typeof n==='number'&&Number.isFinite(n));
const near=(a:unknown,b:unknown)=>point(a)&&point(b)&&Math.hypot(...a.map((n,i)=>n-b[i]!))<=1e-6;
const equal=(a:unknown,b:unknown)=>payloadDigestV2(a).digest===payloadDigestV2(b).digest;
const categories=new Set(['OST_DuctCurves','OST_DuctFitting','OST_DuctAccessory','OST_DuctTerminal','OST_MechanicalEquipment',
  'OST_FlexDuctCurves','OST_PipeCurves','OST_PipeFitting','OST_PipeAccessory','OST_FlexPipeCurves','OST_PlumbingFixtures','OST_PlumbingEquipment','OST_Sprinklers']);
const domains=new Set(['DomainHvac','DomainPiping','DomainElectrical','DomainCableTrayConduit']);
const refs=(v:Row[])=>v.map(r=>payloadDigestV2(r).digest).sort();

/** Complete raw physical observation for preservation, not a connection verdict.
 * An existing side tap may have separated native origins and equipment may also
 * have electrical ports. Retain those facts unchanged. The insertion comparator
 * separately requires coincident reciprocal ports on EVERY new connection. */
export function readNativePlacementGraphV2(payload:unknown):Map<number,Row>|null {
 try{
  const s=payload as Row;
  if(s?.status!=='Ok'||s.filter!=='allConnectors'||s.failedElementCount!==0||s.unknownPhysicalConnectorCount!==0
    ||s.connectorScanTruncatedElementCount!==0||!Array.isArray(s.results)||!s.results.length||s.results.length>5000
    ||[s.requestedCount,s.scannedElementCount,s.matchedElementCount].some(n=>n!==s.results.length))return null;
  const graph=new Map<number,Row>();let total=0,open=0;
  for(const e of s.results){
    if(!id(e?.id)||graph.has(e.id)||!id(e.typeId)||e.ok!==true||!categories.has(e.category)||e.connectorScanTruncated!==false
      ||!Array.isArray(e.connectors)||!e.connectors.length||e.connectors.length>512||e.connectorCount!==e.connectors.length
      ||e.returnedConnectorCount!==e.connectors.length||new Set(e.connectors.map((c:Row)=>c.connectorId)).size!==e.connectors.length)return null;
    let eo=0;
    for(const c of e.connectors){
      if(!cid(c.connectorId)||c.connectorIdBasis!=='revit_native_connector_id'||!['End','Curve'].includes(c.connectorType)
        ||!domains.has(c.domain)||!point(c.origin)||!point(c.coordinateSystem?.basisZ)
        ||c.referenceScanComplete!==true||c.referenceReadErrorCount!==0||!Array.isArray(c.physicalConnectedTo)
        ||c.physicalConnectedTo.length>64||!Array.isArray(c.connectedTo)||c.connectedTo.length>128
        ||c.physicalConnectionCount!==c.physicalConnectedTo.length||c.isPhysicallyConnected!==(c.physicalConnectedTo.length>0)
        ||c.isConnected!==(c.physicalConnectedTo.length>0))return null;
      for(const r of c.physicalConnectedTo)if(!id(r?.ownerId)||r.ownerId===e.id||!categories.has(r.ownerCategory)
        ||!cid(r.connectorId)||r.connectorIdBasis!=='revit_native_connector_id'||!['End','Curve'].includes(r.connectorType)
        ||r.domain!==c.domain||!point(r.origin)||r.isMepSystem!==false||r.isPhysicalElement!==true||r.isConnectedTo!==true)return null;
      if(c.connectedTo.some((r:Row)=>!r||typeof r!=='object'||![true,false].includes(r.isPhysicalElement))
        ||!equal(refs(c.physicalConnectedTo),refs(c.connectedTo.filter((r:Row)=>r.isPhysicalElement===true)))
        ||new Set(c.physicalConnectedTo.map((r:Row)=>`${r.ownerId}:${r.connectorId}`)).size!==c.physicalConnectedTo.length)return null;
      if(!c.physicalConnectedTo.length)eo++;total++;
    }
    if(e.openPhysicalConnectorCount!==eo)return null;open+=eo;graph.set(e.id,e);
  }
  if(s.totalScannedConnectorCount!==total||s.openPhysicalConnectorCount!==open||s.physicallyConnectedConnectorCount!==total-open)return null;
  for(const e of graph.values())for(const c of e.connectors)for(const r of c.physicalConnectedTo){
    const peer=graph.get(r.ownerId);if(!peer)continue; // Exact external edge is preserved by the caller; no external-owner claim.
    const p=peer.connectors.find((x:Row)=>x.connectorId===r.connectorId);
    if(!p||peer.category!==r.ownerCategory||p.domain!==r.domain||p.connectorType!==r.connectorType||!near(p.origin,r.origin)
      ||p.physicalConnectedTo.filter((x:Row)=>x.ownerId===e.id&&x.connectorId===c.connectorId&&x.ownerCategory===e.category
        &&x.connectorType===c.connectorType&&x.domain===c.domain&&near(x.origin,c.origin)).length!==1)return null;
  }
  return graph;
 }catch{return null;}
}
