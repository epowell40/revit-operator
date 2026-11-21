import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";
import { sameAssignmentBindingV2, type AssignmentSnapshotV2, type OperationV2, type OperationResultV2 } from "../domain/assignment-kernel/index.js";
import { combinedReadFollowsSettledChanges } from "./open_duct_postcondition_v2.js";
import {nativeChangeInventoryCompleteV2} from './native_change_inventory_v2.js';

const route = "/revit/connect-existing-mep-branch";
type Row = Record<string, any>;
const row = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const id = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const connectorId = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const point = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === "number" && Number.isFinite(n));
const near = (a: unknown, b: unknown, tolerance = 1e-6): boolean => point(a) && point(b)
  && Math.hypot(...a.map((n, i) => n - b[i]!)) <= tolerance;
const nativeId = (r: Row) => connectorId(r.connectorId) && r.connectorIdBasis === "revit_native_connector_id";
const key = (c: number, owner: number, peer: number) => `${c}:${owner}:${peer}`;
const physicalCategories = new Set(["OST_DuctCurves", "OST_DuctFitting", "OST_DuctAccessory", "OST_DuctTerminal",
  "OST_MechanicalEquipment", "OST_FlexDuctCurves", "OST_PipeCurves", "OST_PipeFitting", "OST_PipeAccessory",
  "OST_FlexPipeCurves", "OST_PlumbingFixtures", "OST_Sprinklers"]);
const sameSet = (a: readonly string[], b: readonly string[]) => new Set(a).size === a.length && new Set(b).size === b.length
  && a.length === b.length && a.every(value => b.includes(value));

// Revit reports a duct Curve connector on its centerline and a directly hosted
// terminal connector on the duct surface. Native reciprocal IDs still own the
// connection; this exception cannot establish a connection from proximity.
function surfaceReferenceFits(owner: Row, c: Row, peer: Row): boolean {
  const main = owner.category==='OST_DuctCurves' && c.connectorType==='Curve'
    && peer.ownerCategory==='OST_DuctTerminal' && peer.connectorType==='End' ? c
    : owner.category==='OST_DuctTerminal' && c.connectorType==='End'
      && peer.ownerCategory==='OST_DuctCurves' && peer.connectorType==='Curve' ? peer : null;
  if(!main || typeof row(main.size).diameterFt!=='number')return false;
  const radius=row(main.size).diameterFt/2;
  return Boolean(main.shape==='Round' && Number.isFinite(radius) && radius>0
    && point(c.origin) && point(peer.origin) && c.referenceScanComplete===true && c.referenceReadErrorCount===0
    && Math.hypot(...c.origin.map((v:number,i:number)=>v-peer.origin[i]))<=radius+1e-6);
}

/** Complete native scan, including occupied connectors. AllRefs alone is not a
 * physical edge: native IsConnectedTo, exact peer IDs and reciprocal rows own
 * the new connection proof. Existing external edges retain their exact native
 * pair and origin through the independently read IsConnectedTo reference. */
function graph(payload: unknown, ids: number[], domain: string, surfaceAttachment = false): Map<number, Row> | null {
  const scan = row(payload);
  if (scan.status !== "Ok" || scan.filter !== "allConnectors" || scan.requestedCount !== ids.length
      || scan.scannedElementCount !== ids.length || scan.matchedElementCount !== ids.length
      || scan.failedElementCount !== 0 || scan.connectorScanTruncatedElementCount !== 0
      || !Array.isArray(scan.results) || !sameSet(scan.results.map((r: unknown) => String(row(r).id)), ids.map(String))) return null;
  const result = new Map<number, Row>();
  let total = 0, open = 0;
  for (const e of scan.results) {
    if (!e || e.ok !== true || !physicalCategories.has(e.category) || e.connectorScanTruncated !== false
        || !Array.isArray(e.connectors) || e.connectors.length < 1 || e.connectors.length > 512
        || e.connectorCount !== e.connectors.length || e.returnedConnectorCount !== e.connectors.length
        || new Set(e.connectors.map((c: unknown) => row(c).connectorId)).size !== e.connectors.length) return null;
    let elementOpen = 0;
    for (const c of e.connectors) {
      if (!c || !nativeId(c) || !point(c.origin) || c.domain !== domain || !["End", "Curve"].includes(c.connectorType)
          || !Array.isArray(c.physicalConnectedTo) || !Array.isArray(c.connectedTo)
          || c.physicalConnectedTo.length > 64 || c.physicalConnectionCount !== c.physicalConnectedTo.length
          || c.isPhysicallyConnected !== (c.physicalConnectedTo.length > 0)
          || c.isConnected !== (c.physicalConnectedTo.length > 0)) return null;
      const refs = c.physicalConnectedTo as Row[];
      if (refs.some(r => !r || !id(r.ownerId) || r.ownerId === e.id || !nativeId(r) || r.domain !== domain
          || !["End", "Curve"].includes(r.connectorType) || !physicalCategories.has(r.ownerCategory)
          || r.isMepSystem !== false || r.isPhysicalElement !== true || r.isConnectedTo !== true
          || !near(r.origin, c.origin) && !(surfaceAttachment && surfaceReferenceFits(e,c,r)))) return null;
      if (c.connectedTo.some((r: unknown) => !r || typeof r !== "object")) return null;
      const physical = c.connectedTo.filter((r: Row) => r.isPhysicalElement === true);
      if (!sameSet(refs.map(r => JSON.stringify(r)), physical.map((r: Row) => JSON.stringify(r)))
          || new Set(refs.map(r => `${r.ownerId}:${r.connectorId}`)).size !== refs.length
          || c.connectedTo.some((r: Row) => r.isPhysicalElement !== true && r.isPhysicalElement !== false)) return null;
      if (!refs.length) elementOpen++;
    }
    if (e.openPhysicalConnectorCount !== elementOpen) return null;
    total += e.connectors.length; open += elementOpen; result.set(e.id, e);
  }
  return scan.totalScannedConnectorCount === total && scan.openPhysicalConnectorCount === open
    && scan.physicallyConnectedConnectorCount === total - open ? result : null;
}

function paired(a: Row, c: Row, b: Row, peer: Row, surfaceAttachment = false): boolean {
  const matches = (from: Row, owner: Row, to: Row) => from.physicalConnectedTo.filter((r: Row) =>
    r.ownerId === owner.id && r.ownerCategory === owner.category && r.connectorId === to.connectorId
      && r.connectorType === to.connectorType && near(r.origin, to.origin)).length === 1;
  const surface=surfaceAttachment && surfaceReferenceFits(a,c,{...peer,ownerCategory:b.category});
  return (near(c.origin, peer.origin)||surface) && matches(c, b, peer) && matches(peer, a, c);
}

function directScopeIds(input: unknown, native: Row, affected: readonly string[]): Set<number> | null {
  const request=row(input),body=row(request.body);
  if(request.path!==route || request.method!=='POST' || body.connectionMode!=='air_terminal_on_duct'
    || !id(body.mainElementId)||!id(body.branchElementId)||body.mainElementId===body.branchElementId
    || native.mainElementId!==body.mainElementId || native.terminalElementId!==body.branchElementId) return null;
  const allowed=new Set<number>([body.mainElementId,body.branchElementId]);
  for(const token of affected){if(!/^element_id:[1-9][0-9]*$/.test(token))return null;const n=Number(token.slice(11));if(!id(n))return null;allowed.add(n);}
  for(const edges of [native.preexistingMainPhysicalConnections,native.preexistingTerminalPhysicalConnections]){
    if(!Array.isArray(edges)||edges.length>256)return null;
    for(const edge of edges){if(!id(row(edge).connectedOwnerId))return null;allowed.add(edge.connectedOwnerId);}
  }
  return allowed;
}

/** Select principal graph rows from a complete related read. The original raw
 * payload and its counts remain unchanged; contextual peers are not certified
 * as deliverables. Failed/truncated broad scans must be narrowed and reread. */
function directPrincipalGraph(payload: unknown, ids: number[], allowed: Set<number>): Map<number,Row>|null {
  const scan=row(payload),rows=scan.results;
  if(scan.status!=='Ok'||scan.filter!=='allConnectors'||!Array.isArray(rows)||!rows.length||rows.length>64
    ||scan.requestedCount!==rows.length||scan.scannedElementCount!==rows.length||scan.matchedElementCount!==rows.length
    ||scan.failedElementCount!==0||scan.connectorScanTruncatedElementCount!==0
    ||new Set(rows.map(r=>row(r).id)).size!==rows.length
    ||rows.some(r=>!id(row(r).id)||!allowed.has(r.id)||r.ok!==true||r.connectorScanTruncated!==false
      ||!Array.isArray(r.connectors)||r.connectorCount!==r.connectors.length||r.returnedConnectorCount!==r.connectors.length
      ||!Number.isSafeInteger(r.openPhysicalConnectorCount)||r.openPhysicalConnectorCount<0||r.openPhysicalConnectorCount>r.connectors.length)
    ||ids.some(id=>!rows.some(r=>r.id===id)))return null;
  const total=rows.reduce((n,r)=>n+r.connectors.length,0),open=rows.reduce((n,r)=>n+r.openPhysicalConnectorCount,0);
  if(scan.totalScannedConnectorCount!==total||scan.openPhysicalConnectorCount!==open||scan.physicallyConnectedConnectorCount!==total-open)return null;
  const principal=rows.filter(r=>ids.includes(r.id)),principalTotal=principal.reduce((n,r)=>n+r.connectors.length,0),principalOpen=principal.reduce((n,r)=>n+r.openPhysicalConnectorCount,0);
  return graph({...scan,results:principal,requestedCount:ids.length,scannedElementCount:ids.length,matchedElementCount:ids.length,
    totalScannedConnectorCount:principalTotal,openPhysicalConnectorCount:principalOpen,physicallyConnectedConnectorCount:principalTotal-principalOpen},ids,'DomainHvac',true);
}

// Reuse the same strict native graph reader; no legacy desired-state rule changes.
export { graph as readCompletePhysicalConnectorGraphV2, paired as reciprocalPhysicalPairMatchesV2 };

function retainedEdges(e: Row, prior: unknown, added: string[], tolerance: number): boolean {
  if (!Array.isArray(prior)) return false;
  const expected: string[] = [];
  for (const edge of prior) {
    if (!edge || !nativeId(edge) || !id(edge.connectedOwnerId) || edge.connectedOwnerId === e.id
        || !connectorId(edge.connectedConnectorId) || edge.connectedConnectorIdBasis !== "revit_native_connector_id"
        || !point(edge.origin) || !point(edge.connectedOrigin)) return false;
    const c = e.connectors.find((c: Row) => c.connectorId === edge.connectorId);
    if (!c || !near(c.origin, edge.origin, tolerance) || !c.physicalConnectedTo.some((r: Row) =>
      r.ownerId === edge.connectedOwnerId && r.connectorId === edge.connectedConnectorId
        && near(r.origin, edge.connectedOrigin, tolerance))) return false;
    expected.push(key(edge.connectorId, edge.connectedOwnerId, edge.connectedConnectorId));
  }
  return sameSet([...expected, ...added], e.connectors.flatMap((c: Row) =>
    c.physicalConnectedTo.map((r: Row) => key(c.connectorId, r.ownerId, r.connectorId))));
}

/** Physical desired state only; apply-local success booleans never prove it.
 * Optional family/workset constraints need another reviewed atomic read shape
 * and deliberately remain unverified here. */
export function existingMepConnectionReadbackMatchesV2(input: unknown, affected: readonly string[], applied: unknown, payload: unknown,
  scope?:Readonly<{complete_native_footprint:readonly string[]}>): boolean {
  const request = row(input), body = row(request.body), native = row(applied);
  const mode = String(body.connectionMode ?? "takeoff_fitting").trim().toLowerCase();
  const kind = String(body.kind ?? "duct").trim().toLowerCase(), direct = mode === "air_terminal_on_duct";
  const tolerance = body.originToleranceFt ?? 0.001;
  const allowed = new Set(["expectedModelPath", "connectionMode", "kind", "mainElementId", "branchElementId", "branchConnectorId",
    "expectedBranchOriginXyz", "originToleranceFt", "expectedTakeoffTypeId", "expectedTakeoffTypeName", "dryRun", "verify"]);
  if (request.path !== route || request.method !== "POST" || body.dryRun !== false
      || !["takeoff_fitting", "air_terminal_on_duct"].includes(mode) || !["duct", "pipe"].includes(kind)
      || direct && kind !== "duct" || !id(body.mainElementId) || !id(body.branchElementId) || body.mainElementId === body.branchElementId
      || typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 0.25
      || Object.keys(body).some(k => !allowed.has(k)) || body.verify !== undefined && typeof body.verify !== "boolean"
      || body.branchConnectorId !== undefined && !connectorId(body.branchConnectorId)
      || body.expectedBranchOriginXyz !== undefined && !point(body.expectedBranchOriginXyz)
      || native.dryRun !== false || native.applied !== true || native.mainElementId !== body.mainElementId
      || (native.connectionMode ?? "takeoff_fitting") !== mode
      || (direct ? native.terminalElementId : native.branchElementId) !== body.branchElementId) return false;
  const ids = [body.mainElementId, body.branchElementId];
  if (!direct) {
    if (!id(native.createdFittingId) || ids.includes(native.createdFittingId)) return false;
    ids.push(native.createdFittingId);
  } else if (native.createdFittingId != null || body.expectedTakeoffTypeId != null || body.expectedTakeoffTypeName != null) return false;
  if (!sameSet(affected, ids.map(id => `element_id:${id}`))) {
    const tx=row(native.transaction);
    if(!direct||!scope||!Array.isArray(scope.complete_native_footprint)||!sameSet(scope.complete_native_footprint,affected)
      ||!ids.every(id=>affected.includes(`element_id:${id}`))
      ||tx.committed!==true||tx.status!=='committed'||!Array.isArray(tx.affected_element_ids)
      ||!sameSet(tx.affected_element_ids.map((n:unknown)=>`element_id:${n}`),affected)
      ||!Array.isArray(tx.added_element_ids)||tx.added_element_ids.length
      ||!Array.isArray(tx.deleted_element_ids)||tx.deleted_element_ids.length)return false;
  }
  const allowedReadIds=direct?directScopeIds(input,native,affected):null;
  const all = direct ? allowedReadIds&&directPrincipalGraph(payload,ids,allowedReadIds) : graph(payload, ids, kind === "duct" ? "DomainHvac" : "DomainPiping");
  if (!all) return false;
  const main = all.get(body.mainElementId)!, branch = all.get(body.branchElementId)!;
  if (main.category !== (kind === "duct" ? "OST_DuctCurves" : "OST_PipeCurves")
      || !(direct ? ["OST_DuctTerminal"] : kind === "duct" ? ["OST_DuctCurves", "OST_FlexDuctCurves"]
        : ["OST_PipeCurves", "OST_FlexPipeCurves"]).includes(branch.category)) return false;
  const before = row(direct ? native.terminalConnector : native.branchConnector);
  if (!nativeId(before) || !point(before.origin) || !Array.isArray(before.physicalConnectedOwnerIds) || before.physicalConnectedOwnerIds.length
      || body.branchConnectorId !== undefined && before.connectorId !== body.branchConnectorId
      || body.expectedBranchOriginXyz !== undefined && !near(before.origin, body.expectedBranchOriginXyz, tolerance)) return false;
  const terminal = branch.connectors.find((c: Row) => c.connectorId === before.connectorId);
  if (!terminal || terminal.connectorType !== "End" || !near(terminal.origin, before.origin, Math.max(tolerance, 0.01))
      || terminal.physicalConnectedTo.length !== 1) return false;
  let mainConnector: Row | undefined, mainAdded: string, branchAdded: string;
  if (direct) {
    mainConnector = main.connectors.find((c: Row) => paired(branch, terminal, main, c,true));
    if (!mainConnector) return false;
    mainAdded = key(mainConnector.connectorId, branch.id, terminal.connectorId);
    branchAdded = key(terminal.connectorId, main.id, mainConnector.connectorId);
  } else {
    const fitting = all.get(native.createdFittingId)!;
    if (fitting.category !== (kind === "duct" ? "OST_DuctFitting" : "OST_PipeFitting") || fitting.connectors.length !== 2
        || fitting.connectors.some((c: Row) => c.physicalConnectedTo.length !== 1)
        || body.expectedTakeoffTypeId !== undefined && (!id(body.expectedTakeoffTypeId) || fitting.typeId !== body.expectedTakeoffTypeId)
        || body.expectedTakeoffTypeName !== undefined && (typeof body.expectedTakeoffTypeName !== "string"
          || String(fitting.typeName).trim().toLowerCase() !== body.expectedTakeoffTypeName.trim().toLowerCase())) return false;
    const from = fitting.connectors.find((c: Row) => paired(branch, terminal, fitting, c));
    const to = fitting.connectors.find((c: Row) => c !== from && main.connectors.some((m: Row) => paired(main, m, fitting, c)));
    if (!from || !to) return false;
    mainConnector = main.connectors.find((c: Row) => paired(main, c, fitting, to));
    mainAdded = key(mainConnector!.connectorId, fitting.id, to.connectorId);
    branchAdded = key(terminal.connectorId, fitting.id, from.connectorId);
  }
  // An interior attachment must not silently replace a main endpoint.
  if (!mainConnector || mainConnector.connectorType !== "Curve"
      || !Number.isInteger(native.mainConnectorCountBefore) || native.mainConnectorCountBefore < 2
      || main.connectorCount !== native.mainConnectorCountBefore + 1) return false;
  return retainedEdges(main, native.preexistingMainPhysicalConnections, [mainAdded], Math.max(tolerance, 0.01))
    && retainedEdges(branch, direct ? native.preexistingTerminalPhysicalConnections : native.preexistingBranchPhysicalConnections,
      [branchAdded], Math.max(tolerance, 0.01));
}

function* retainedNativeConnectionPayloads(snapshot:AssignmentSnapshotV2,subject:OperationV2):Generator<Row> {
  const applied=subject.result;
  if(!applied||subject.requested_effect!=='apply'||subject.persistent_effect!=='applied'
    ||applied.persistent_effect!=='applied'||applied.authority!=='native-host'||applied.status!=='succeeded'
    ||applied.native_transaction_state!=='committed'||subject.settlement_state!=='settled'
    ||!sameAssignmentBindingV2(subject.binding,snapshot.current_binding)
    ||!sameAssignmentBindingV2(applied.binding,snapshot.current_binding))return;
  for(const oid of subject.observation_ids){
    const observation=snapshot.observations[oid];
    if(!observation||observation.operation_id!==subject.operation_id||observation.authority!=='native-host'
      ||observation.raw_payload_hash!==applied.raw_payload_hash||!sameAssignmentBindingV2(observation.binding,snapshot.current_binding))continue;
    try{
      const ref=readEvidenceRef(observation.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;
      const payload=JSON.parse(readAuthoritativeEvidence(ref,{...snapshot.current_binding,attempt_id:subject.operation_id}).toString('utf8'));
      if(payloadDigestV2(payload).digest===applied.raw_payload_hash)yield row(payload);
    }catch{/* Missing, foreign or corrupt native evidence grants no scope. */}
  }
}

/** Existing operation-specific read admission. The main and terminal are
 * mandatory; extra peers must come from the actual native commit, never a
 * model's proposed preservation list. This grants no write authority. */
export function existingMepConnectionReadRequestMatchesV2(snapshot:AssignmentSnapshotV2,subject:OperationV2,args:unknown):boolean {
  const request=row(args),body=row(request.body),applied=subject.result;
  if(subject.request_identity?.path!==route||row(subject.input.body).connectionMode!=='air_terminal_on_duct'
    ||request.method!=='POST'||request.path!=='/revit/get-connectors'||body.includeAllRefs===false||body.onlyOpenPhysicalConnectors===true
    ||!Array.isArray(body.elementIds)||!body.elementIds.length||body.elementIds.length>64||!body.elementIds.every(id)
    ||new Set(body.elementIds).size!==body.elementIds.length||!applied)return false;
  const principal=[row(subject.input.body).mainElementId,row(subject.input.body).branchElementId];
  if(!principal.every(id)||!principal.every(n=>body.elementIds.includes(n)))return false;
  for(const native of retainedNativeConnectionPayloads(snapshot,subject)){
    if(!sameSet(applied.affected_target_identities??[],principal.map(n=>`element_id:${n}`))
      && !nativeChangeInventoryCompleteV2(subject,applied,native))continue;
    const allowed=directScopeIds(subject.input,native,applied.affected_target_identities??[]);
    if(allowed&&body.elementIds.every((n:number)=>allowed.has(n)))return true;
  }
  return false;
}

/** Exact current assignment, native committed effect, retained native apply
 * bytes, and one fresh atomic read after the document's settled commit frontier. */
export function existingMepConnectionPostconditionSatisfiedV2(snapshot: AssignmentSnapshotV2, subject: OperationV2,
  current: OperationResultV2, payload: unknown): boolean {
  const applied = subject.result, read = snapshot.operations[current.operation_id], input = row(read?.input), body = row(input.body);
  if (subject.request_identity?.path !== route || subject.requested_effect !== "apply" || subject.persistent_effect !== "applied"
      || subject.settlement_state !== "settled" || applied?.authority !== "native-host" || applied.status !== "succeeded"
      || applied.native_transaction_state !== "committed" || !sameAssignmentBindingV2(subject.binding, snapshot.current_binding)
      || !sameAssignmentBindingV2(applied.binding, snapshot.current_binding)
      || current.authority !== "native-host" || current.status !== "succeeded" || current.persistent_effect !== "none"
      || current.dispatch_state !== "dispatched" || current.request_identity?.method !== "POST" || current.request_identity.path !== "/revit/get-connectors"
      || !sameAssignmentBindingV2(current.binding, snapshot.current_binding) || !read || read.requested_effect !== "read"
      || read.purpose !== "verification" || read.fulfillment_role !== "verification" || read.verification_of_operation_id !== subject.operation_id
      || !sameAssignmentBindingV2(read.binding, snapshot.current_binding) || input.method !== "POST" || input.path !== "/revit/get-connectors"
      || body.includeAllRefs === false || body.onlyOpenPhysicalConnectors === true || !Array.isArray(body.elementIds)
      || !body.elementIds.every(id)
      || !(row(subject.input.body).connectionMode==='air_terminal_on_duct'
        ? existingMepConnectionReadRequestMatchesV2(snapshot,subject,input)
          && Array.isArray(row(payload).results)&&sameSet(row(payload).results.map((r:Row)=>String(r.id)),body.elementIds.map(String))
        : sameSet(body.elementIds.map((id: number) => `element_id:${id}`), applied.affected_target_identities ?? []))
      || payloadDigestV2(payload).digest !== current.raw_payload_hash || !combinedReadFollowsSettledChanges(snapshot, current)) return false;
  for (const native of retainedNativeConnectionPayloads(snapshot,subject)) {
    const scope=nativeChangeInventoryCompleteV2(subject,applied,native)
      ?{complete_native_footprint:applied.affected_target_identities??[]}:undefined;
    if(existingMepConnectionReadbackMatchesV2(subject.input,applied.affected_target_identities??[],native,payload,scope))return true;
  }
  return false;
}
