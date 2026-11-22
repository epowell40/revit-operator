type RecordValue = Record<string, unknown>;
const record = (v:unknown):RecordValue => v&&typeof v==='object'&&!Array.isArray(v)?v as RecordValue:{};
const positive = (v:unknown):v is number => Number.isSafeInteger(v)&&Number(v)>0;

export const CONNECTOR_READ_CUE = 'For connector facts on known elements, prefer the existing /revit/get-connectors read with elementIds; it guards unavailable dimensions and returns physical references. Its elementLocation gives the insertion point and rotation or location-curve endpoints in document-internal feet (rotation in radians), distinct from connector origins. Read the intended hosts and candidate instances together; reuse these placement facts instead of a separate C# pose inspection. Older or partial location fields remain unknown, and curved endpoints are not the full curve. Reuse these scoped facts instead of rediscovering every connector in C#. If custom C# is needed, filter physical connectors and guard each optional property: Radius is only valid for Round; Width/Height only for Rectangular or Oval. Other shapes and unsupported properties are unavailable, not zero. Return per-connector read errors without losing the rest of the batch. Neither shape nor IsConnected alone proves a reciprocal physical join.';

const NATIVE_TERMINAL_BATCH = 'For several already positioned terminals with known compatible duct hosts, native C# can make a bounded connection batch using Autodesk.Revit.DB.Mechanical.MechanicalUtils.ConnectAirTerminalOnDuct(doc, terminal.Id, duct.Id) for each pair. This is the same native API used by the single-terminal route; a separate model turn per join is unnecessary. Recheck the actual terminals, host placement and current connection state; do not guess IDs or reconnect an existing join. Return each attempted pair and the API boolean result, including false results, plus actual target IDs. Keep uncertain pairs separate so an exception cannot roll back the useful batch. Read back reciprocal physical connections for the batch before claiming attachment; API success alone is not verification.';
export const AIR_TERMINAL_CONNECTION_GUIDANCE = 'Creating or copying an air terminal does not prove connector attachment. For an existing open air terminal or side grille, discover /revit/connect-existing-mep-branch with connectionMode air_terminal_on_duct: this uses Revit native terminal-to-duct attachment. Port shapes alone do not establish family/host incompatibility. Inspect the intended rigid duct, placement and family fit before applying; then read back reciprocal physical connections. '+NATIVE_TERMINAL_BATCH+' This is capability discovery, not fit proof or write/retry authority. Preserve useful work and retain a specific failed or unresolved connection separately.';
export const AIR_TERMINAL_CONNECTION_CUE = 'Open air terminals: /revit/connect-existing-mep-branch, connectionMode air_terminal_on_duct. Placement/copy alone is not connection proof; shapes alone do not decide fit. Inspect host/family and verify physical joins. '+NATIVE_TERMINAL_BATCH;

/** Advice on the existing read path only. Preserve raw data, native evidence,
 * verification, permissions and settlement. Never interpret program text. */
export function projectConnectorWorkGuidance(value:unknown,request:unknown):unknown {
 const data=record(value),body=record(request),settlement=record(data.canonical_attempt_settlement),requested=body.elementIds;
 if(data.status!=='Ok'||!Array.isArray(data.results)||!Array.isArray(requested)||!requested.length
   ||!requested.every(positive)||new Set(requested).size!==requested.length
   ||settlement.method!=='POST'||settlement.path!=='/revit/get-connectors'||settlement.requested_effect!=='read'||settlement.effect_state!=='none'
   ||data.results.some(v=>!requested.some(id=>id===record(v).id)))return value;
 const ids=[...new Set(data.results.filter(v=>{
   const row=record(v);
   return row.ok===true&&positive(row.id)&&row.category==='OST_DuctTerminal'&&row.connectorScanTruncated===false
     &&Array.isArray(row.connectors)&&Number.isSafeInteger(row.connectorCount)&&Number(row.connectorCount)>0
     &&row.returnedConnectorCount===row.connectors.length&&Number(row.returnedConnectorCount)>0&&Number(row.returnedConnectorCount)<=Number(row.connectorCount)
     &&row.connectors.some(v=>{const c=record(v);return c.domain==='DomainHvac'&&c.connectorType==='End'
       &&c.physicalConnectionState==='open'&&c.referenceScanComplete===true&&c.referenceReadErrorCount===0
       &&(c.isPhysicallyConnected===undefined||c.isPhysicallyConnected===false)
       &&Array.isArray(c.physicalConnectedTo)&&c.physicalConnectedTo.length===0;});
 }).map(v=>record(v).id as number))];
 if(!ids.length)return value;
 return {...data,operator_connection_guidance:{authority:'discovery_only',element_ids:ids.slice(0,8),omitted_count:Math.max(0,ids.length-8),
   scope:'Returned complete open HVAC terminal rows only; not a complete inventory or a host match.',compatibility_verified:false,connection_verified:false,message:AIR_TERMINAL_CONNECTION_GUIDANCE}};
}
