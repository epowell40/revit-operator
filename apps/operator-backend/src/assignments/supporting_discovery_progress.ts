import { canonicalJsonV2 } from "../domain/assignment-kernel/canonical.js";
import type { OperationV2 } from "../domain/assignment-kernel/operation.js";
import type { AssignmentSnapshotV2 } from "../domain/assignment-kernel/snapshot.js";
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/identity.js';
import { buildProgressEpochV2 } from "../domain/assignment-kernel/progress/controller.js";
import {nativeCommitProgressIdentityV2} from '../domain/assignment-kernel/progress/native_work_progress.js';

/** A pending declared inspection may need the same baseline selectors again
 * after its prerequisite edit. This is discovery progress, not inspection
 * completion or preservation proof. Caller-provided epochs cannot renew it. */
function inspectionPrerequisiteWrites(snapshot:AssignmentSnapshotV2,read:OperationV2):Set<string> {
  const items=snapshot.work_plan?.items??[],writes=new Set<string>();
  if(items.length>512||!Number.isFinite(Date.parse(read.opened_at)))return writes;
  const byId=new Map(items.map(item=>[item.item_id,item]));
  const deferred=(item:typeof items[number])=>Boolean(item.deferrals?.at(-1)&&!item.deferrals.at(-1)?.resumed_at);
  for(const inspection of items){
    if(inspection.kind!=='inspection'||inspection.completed_at||deferred(inspection)
      ||!(Date.parse(inspection.declared_at)<=Date.parse(read.opened_at)))continue;
    const pending=[...(inspection.depends_on??[])],seen=new Set<string>();
    while(pending.length&&seen.size<512){
      const id=pending.pop()!;if(seen.has(id))continue;seen.add(id);
      const item=byId.get(id);if(!item||deferred(item)||!item.completed_at
        ||!(Date.parse(item.completed_at)<=Date.parse(read.opened_at))
        ||!(Date.parse(item.declared_at)<=Date.parse(read.opened_at)))continue;
      if(item.kind==='edit')
        for(const opId of item.operation_ids)writes.add(opId);
      pending.push(...(item.depends_on??[]));
    }
  }
  return writes;
}

function discoveryIdentity(operation: OperationV2, snapshot:AssignmentSnapshotV2): string | null {
  if(snapshot.input_invalidated_operation_ids?.includes(operation.operation_id))return null;
  const route = operation.request_identity?.path ?? operation.input.path;
  if (typeof route !== "string" || !route.startsWith("/revit/")) return null;
  let url: URL;
  try { url = new URL(route, "http://native.invalid"); } catch { return null; }
  let body: unknown = operation.input.body ?? operation.input.arguments ?? operation.input;
  if (typeof body === "string") {
    if (body.length > 100_000) return null;
    try { body = JSON.parse(body); } catch { return null; }
  }
  const fields = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const vectorRead=url.pathname==='/revit/inspect-vector-detail'||url.pathname==='/revit/view-owned-detailing'&&fields.cadTargetOnly===true;
  // Only bounded selectors describe new discovery. Diagnostic timestamps,
  // request IDs, signatures, payload hashes and presentation options cannot
  // buy another reasoning turn. Array selectors are sets, not ordering tokens.
  const selectorKeys = ["action", "id", "ids", "elementId", "elementIds", "viewId", "viewIds", "sheetNumber", "sheetNumbers",
    "levelId", "levelIds", "levelName", "levelNames", "nameContains", "category", "categories", "categoryName", "categoryNames",
    "typeId", "typeIds", "typeNameContains", "familyNameContains", "semanticGroups", "parameterNames", "includeTemplates", "offset",
    ...(vectorRead?["manifestElementId","partIndex","cadElementId","cadGeometryOffset"]:[])];
  const selectors: Record<string, unknown> = {};
  for (const key of selectorKeys) {
    const value = fields[key] ?? url.searchParams.get(key);
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length <= 256 && value.every(item => ["string", "number", "boolean"].includes(typeof item) && String(item).length <= 1000)) {
      selectors[key] = [...new Set(value.map(String))].sort();
    } else if (["string", "number", "boolean"].includes(typeof value) && String(value).length <= 1000) selectors[key] = String(value);
    else return null;
  }
  // A final native check after a retained write is new evidence, while another
  // identical read in that same write interval buys no progress. Select the
  // preceding canonical write, never a caller timestamp or supplied epoch.
  const inspectionWrites=vectorRead?new Set<string>():inspectionPrerequisiteWrites(snapshot,operation);
  const precedingWrite=Object.values(snapshot.operations).filter(op=>(vectorRead||inspectionWrites.has(op.operation_id))
    &&op.requested_effect==='apply'&&op.persistent_effect==='applied'
    &&op.settlement_state==='settled'&&op.result?.authority==='native-host'&&op.result.status==='succeeded'
    &&sameAssignmentBindingV2(op.binding,operation.binding)&&sameAssignmentBindingV2(op.result.binding,op.binding)
    &&Number.isSafeInteger(op.settled_assignment_version)&&Number.isSafeInteger(operation.admitted_assignment_version)
    &&op.settled_assignment_version!<operation.admitted_assignment_version!
    &&Date.parse(op.result.completed_at)<=Date.parse(operation.opened_at)
    &&(vectorRead||nativeCommitProgressIdentityV2(snapshot,op)!==null))
    .sort((a,b)=>b.settled_assignment_version!-a.settled_assignment_version!)[0];
  return canonicalJsonV2({ path: url.pathname,...(vectorRead?{preceding_native_write:precedingWrite?.operation_id??null}:{}),
    ...(!vectorRead&&precedingWrite?{inspection_prerequisite_write:nativeCommitProgressIdentityV2(snapshot,precedingWrite)}:{}),
    target_id: operation.target.target_id ?? null, document: operation.binding.document_fingerprint ?? null, selectors });
}

type HostProgressInput = Omit<Parameters<typeof buildProgressEpochV2>[0], "supporting_discovery_read_identities">;

/** Derive identities exclusively from host-retained operations, never caller maps. */
export function buildHostProgressEpochV2(input: HostProgressInput) {
  const identities = (snapshot:AssignmentSnapshotV2) => Object.fromEntries(
    Object.values(snapshot.operations).flatMap(operation => {
      const identity = discoveryIdentity(operation,snapshot);
      return identity === null ? [] : [[operation.operation_id, identity]];
    }));
  return buildProgressEpochV2({ ...input, supporting_discovery_read_identities: {
    before: identities(input.before), after: identities(input.after)
  } });
}
