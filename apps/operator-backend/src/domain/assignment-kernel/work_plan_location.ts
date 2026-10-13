import type { AssignmentSnapshotV2 } from './snapshot.js';
import type { AssignmentBindingV2 } from './identity.js';
import type { AssignmentWorkPlanV2 } from './work_plan.js';
import { sameAssignmentBindingV2 } from './identity.js';
import { kernelAssertV2 } from './errors.js';

/** Assistant interpretation for resuming work. Never target authority or proof. */
export type WorkPlanLocationHintV2 = Readonly<{
  status: 'unresolved' | 'ambiguous' | 'candidate';
  reason: string;
  source?: Readonly<{ attachment_id: string; filename: string; sha256: string; page: number; page_count: number;
    sheet_label?: string; view_label?: string;
    region?: Readonly<{ min_u: number; min_v: number; max_u: number; max_v: number }> }>;
  native?: Readonly<{ document_fingerprint: string; view_id: number; view_name: string; sheet_number?: string }>;
}>;
export type WorkPlanLocationRecordV2 = WorkPlanLocationHintV2 & Readonly<{
  recorded_at: string; binding: AssignmentBindingV2; verified: false;
}>;
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0
  && new TextEncoder().encode(v).byteLength <= max && !/[\u0000-\u001f\u007f]/.test(v);
const object = (v: unknown, allowed: readonly string[]) => Boolean(v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).every(k=>allowed.includes(k)));

export function recordWorkPlanLocationV2(snapshot: AssignmentSnapshotV2, itemId: string,
  hint: WorkPlanLocationHintV2, at: string): AssignmentWorkPlanV2 {
  const plan = snapshot.work_plan, item = plan?.items.find(i=>i.item_id===itemId);
  kernelAssertV2(item && object(hint, ['status','reason','source','native'])
    && ['unresolved','ambiguous','candidate'].includes(hint.status) && text(hint.reason,240)
    && new TextEncoder().encode(JSON.stringify(hint)).byteLength<=1200,
    'work_plan_location_invalid', 'Name an existing item and a bounded interpreted location; location never verifies work.');
  const s=hint.source, n=hint.native;
  kernelAssertV2(s===undefined || object(s,['attachment_id','filename','sha256','page','page_count','sheet_label','view_label','region'])
    && text(s.attachment_id,160) && text(s.filename,160) && /^[a-f0-9]{64}$/.test(s.sha256)
    && Number.isSafeInteger(s.page) && Number.isSafeInteger(s.page_count) && s.page>=1 && s.page_count>=s.page && s.page_count<=100000
    && (s.sheet_label===undefined || text(s.sheet_label,120)) && (s.view_label===undefined || text(s.view_label,120)),
    'work_plan_source_location_invalid', 'Retain immutable source identity, page and page count; labels are hints, not native identities.');
  const r=s?.region;
  kernelAssertV2(r===undefined || object(r,['min_u','min_v','max_u','max_v'])
    && [r.min_u,r.min_v,r.max_u,r.max_v].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1)
    && r.min_u<r.max_u && r.min_v<r.max_v,
    'work_plan_crop_location_invalid', 'Use positive normalized full-page crop bounds.');
  kernelAssertV2(n===undefined || object(n,['document_fingerprint','view_id','view_name','sheet_number'])
    && text(n.document_fingerprint,240) && n.document_fingerprint===snapshot.current_binding.document_fingerprint
    && Number.isSafeInteger(n.view_id) && n.view_id>0 && text(n.view_name,120)
    && (n.sheet_number===undefined || text(n.sheet_number,40)),
    'work_plan_native_location_invalid', 'Native view hints must retain the current document fingerprint, ID and name. Revalidate before acting.');
  kernelAssertV2(hint.status!=='candidate' || Boolean(s||n), 'work_plan_location_empty', 'A candidate location needs a source or native address.');
  const history=item!.location_history??[];
  kernelAssertV2(history.length<16, 'work_plan_location_history_limit', 'Location history reached its bounded limit; prior interpretations remain retained.');
  const record:WorkPlanLocationRecordV2={...structuredClone(hint),recorded_at:at,binding:{...snapshot.current_binding},verified:false};
  return {...plan!,items:plan!.items.map(i=>i.item_id===itemId?{...i,location_history:[...history,record]}:i)};
}

export function projectWorkPlanLocationV2(item: { location_history?: readonly WorkPlanLocationRecordV2[] }, snapshot?: AssignmentSnapshotV2) {
  const current=item.location_history?.at(-1);
  return current ? { ...current, binding_current: snapshot ? sameAssignmentBindingV2(current.binding,snapshot.current_binding) : null,
    history_count:item.location_history!.length, notice:'Interpreted navigation only. Reopen the source and verify native identity before editing; no authorization, completion or cleared effects.' } : null;
}
