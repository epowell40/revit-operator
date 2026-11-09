import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/snapshot.js';
import type { OperationV2 } from '../domain/assignment-kernel/operation.js';
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/identity.js';
import {appliedOperationHasVerifiedPostconditionV2} from '../domain/assignment-kernel/outcome.js';
import {nativeProgramEffectStateV2,readNativeProgramEffectObservationV2} from '../verification/native_program_effect_postcondition_v2.js';
import {nativeInspectionTargetIdsV2} from './native_inspection_coverage.js';

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
 const observed=readNativeProgramEffectObservationV2(state,fingerprint,state.documentSessionId,ids);
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
