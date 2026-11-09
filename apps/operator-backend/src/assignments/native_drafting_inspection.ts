import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/snapshot.js';
import type { OperationV2 } from '../domain/assignment-kernel/operation.js';
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/identity.js';
import {appliedOperationHasVerifiedPostconditionV2} from '../domain/assignment-kernel/outcome.js';
import {nativeProgramEffectStateV2,readNativeProgramEffectObservationV2} from '../verification/native_program_effect_postcondition_v2.js';
import {nativeInspectionTargetIdsV2} from './native_inspection_coverage.js';

/** A mixed inspection can include surviving objects with identity-only coverage.
 * Unsupported native public state is NOT proof of those objects' preservation.
 * Validate every complete row normally and keep the original partial receipt.
 * The caller separately checks ordinary identity coverage and verified deletions.
 */
function inspectionState(state:any,fingerprint:string,ids:number[],rows:any[]){
 const exact=readNativeProgramEffectObservationV2(state,fingerprint,state.documentSessionId,ids);
 if(exact)return exact;
 if(state.complete!==false||!Array.isArray(state.requestedElementIds)||state.requestedElementIds.length!==ids.length
   ||state.requestedElementIds.some((id:any,index:number)=>id!==ids[index])
   ||!Array.isArray(state.items)||state.items.length!==ids.length
   ||new Set(state.items.map((i:any)=>i?.elementId)).size!==ids.length)return null;
 const complete:any[]=[],unsupported=new Set<number>();
 for(const item of state.items){
  const row=rows.find(r=>r.id===item?.elementId);
  if(!row)return null;
  if(item.complete===true){complete.push(item);continue;}
  // Only an explicit unsupported-class observation may use identity coverage.
  // Read exceptions, limits, omitted rows and unavailable deletions fail closed.
  if(item.complete!==false||row.found!==true||item.found!==null||item.stateJson!==null||item.stateHash!==null
    ||typeof row.className!=='string'||!row.className
    ||item.reason!=='unsupported_native_effect_class:'+row.className)return null;
  unsupported.add(item.elementId);
 }
 if(!unsupported.size||!complete.length)return null;
 const selected=ids.filter(id=>!unsupported.has(id));
 const observed=readNativeProgramEffectObservationV2({...state,complete:true,requestedElementIds:selected,items:complete},fingerprint,state.documentSessionId,selected);
 if(!observed)return null;
 // Only the inspection's found/identity union uses the surviving ordinary row.
 // No synthetic state hash or complete effect observation is returned or stored.
 return {version:observed.version,items:[...observed.items,...rows.filter(r=>unsupported.has(r.id)).map(r=>({elementId:r.id,found:true}))]};
}

/** Read coverage of surviving drafting targets AND explicitly verified native
 * deletions. Called only after retained read authority/binding/hash validation.
 * No desired state is inferred, no expected target is removed, and no edit is
 * newly verified here. Ordinary missing-element reads still cannot qualify.
 */
export function nativeDraftingInspectionTargetsV2(snapshot:AssignmentSnapshotV2,op:OperationV2,data:any):number[]|null {
 const body=op.input?.body as any,ids=body?.elementIds,rows=data?.result,state=data?.nativeProgramEffectState;
 if(op.input?.method!=='POST'||op.input.path!=='/revit/get-element-summary'||body?.includeNativeProgramEffectState!==true
   ||Object.keys(body).some(k=>!['elementIds','includeNativeProgramEffectState','viewId','includeTagReferences'].includes(k))
   ||!Array.isArray(ids)||!ids.length||ids.length>4096||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<1)
   ||!Array.isArray(rows)||rows.length!==ids.length||new Set(rows.map(r=>r?.id)).size!==ids.length
   ||rows.some(r=>!ids.includes(r?.id)||typeof r.found!=='boolean')||data.error||data.success===false||data.ok===false||data.truncated===true
   ||!op.result?.receipt_id||!op.result.native_correlation_id||!op.request_identity?.request_signature
   ||op.result.request_identity?.request_signature!==op.request_identity.request_signature
   ||snapshot.input_invalidated_operation_ids?.includes(op.operation_id)||snapshot.unresolved_unknown_operation_ids.length
   ||typeof state?.documentSessionId!=='string'||!state.documentSessionId||state.documentSessionId.length>200)return null;
 const fingerprint='sha256:'+String(snapshot.current_binding.document_fingerprint??'').replace(/^sha256:/,'');
 const observed=inspectionState(state,fingerprint,ids,rows);
 if(!observed||!observed.version||rows.some(r=>observed.items.find(i=>i.elementId===r.id)?.found!==r.found))return null;
 const writes=Object.values(snapshot.operations).filter(o=>o.requested_effect==='apply'&&o.persistent_effect!=='none');
 const lastEdit=Math.max(0,...writes.map(o=>Date.parse(o.result?.completed_at??'')));
 if(!Number.isFinite(lastEdit)||!Number.isFinite(Date.parse(op.opened_at))||Date.parse(op.opened_at)<=lastEdit)return null;
 const present=rows.filter(r=>r.found);
 if(new Set(present.map(r=>r.uniqueId)).size!==present.length
   ||rows.some(r=>!r.found&&r.error!=='Element not found'))return null;
 // Keep the existing per-row identity/type/tag-reference checks and their
 // 500-row contract. Large host state reads are validated in bounded chunks.
 for(let start=0;start<present.length;start+=500){const chunk=present.slice(start,start+500);
  if(!nativeInspectionTargetIdsV2({...op.input,body:{...body,elementIds:chunk.map(r=>r.id)}},{result:chunk}))return null;
 }
 const states=new Map<string,ReturnType<typeof nativeProgramEffectStateV2>>();
 for(const r of rows.filter(r=>!r.found)){
  const latest=writes.filter(w=>w.result?.affected_target_identities?.includes('element_id:'+r.id))
    .sort((a,b)=>Date.parse(b.result!.completed_at)-Date.parse(a.result!.completed_at))[0];
  if(!latest||!sameAssignmentBindingV2(latest.binding,snapshot.current_binding)||!appliedOperationHasVerifiedPostconditionV2(snapshot,latest.operation_id))return null;
  if(!states.has(latest.operation_id))states.set(latest.operation_id,nativeProgramEffectStateV2(snapshot,latest));
  const prior=states.get(latest.operation_id)?.items.find(i=>i.elementId===r.id);
  if(!prior||prior.found!==false)return null;
 }
 return [...ids].sort((a,b)=>a-b);
}
