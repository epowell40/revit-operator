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
  drafting?: DraftingProgressV1;
}>;
export type DraftingProgressV1=Readonly<{
  pass:'geometry'|'sizes_properties'|'connections'|'elevation'|'annotations'|'coverage';
  stage:'attempted'|'drafted'|'checked'|'blocked';
  element_ids:readonly number[]; read_operation_ids:readonly string[];
  source_image_sha256?:string;model_image_sha256?:string;
  next_action:string;remaining:string;boundary_context?:string;
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
  kernelAssertV2(item && object(hint, ['status','reason','source','native','drafting'])
    && ['unresolved','ambiguous','candidate'].includes(hint.status) && text(hint.reason,240)
    && new TextEncoder().encode(JSON.stringify(hint)).byteLength<=(hint.drafting?3000:1200),
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
  const d=hint.drafting;
  if(d){
    kernelAssertV2(object(d,['pass','stage','element_ids','read_operation_ids','source_image_sha256','model_image_sha256','next_action','remaining','boundary_context'])
      &&['geometry','sizes_properties','connections','elevation','annotations','coverage'].includes(d.pass)
      &&['attempted','drafted','checked','blocked'].includes(d.stage)&&Boolean(s?.region&&n)
      &&Array.isArray(d.element_ids)&&d.element_ids.length<=64&&new Set(d.element_ids).size===d.element_ids.length
      &&d.element_ids.every(id=>Number.isSafeInteger(id)&&id>0)
      &&Array.isArray(d.read_operation_ids)&&d.read_operation_ids.length<=8&&new Set(d.read_operation_ids).size===d.read_operation_ids.length
      &&d.read_operation_ids.every(id=>text(id,240))&&text(d.next_action,240)&&text(d.remaining,400)
      &&(d.boundary_context===undefined||text(d.boundary_context,400))
      &&[d.source_image_sha256,d.model_image_sha256].every(h=>h===undefined||/^[a-f0-9]{64}$/.test(h)),
      'drafting_progress_invalid','Use a bounded source crop, native view, drafting pass/stage, linked elements, remaining discrepancy and next useful action.');
    if(d.stage==='checked'){
      kernelAssertV2(Boolean(d.source_image_sha256&&d.model_image_sha256&&d.read_operation_ids.length)
        &&d.source_image_sha256!==d.model_image_sha256,'drafting_check_evidence_required','Backchecking needs distinct reference/model images and native readback; execution success alone is not a check.');
      const lastEdit=Math.max(0,...Object.values(snapshot.operations).filter(o=>o.requested_effect==='apply'&&o.persistent_effect!=='none')
        .map(o=>Date.parse(o.result?.completed_at??o.opened_at)));
      kernelAssertV2(!snapshot.unresolved_unknown_operation_ids.length&&!snapshot.in_flight_operation_ids.length
        &&d.read_operation_ids.every(id=>{
          const op=snapshot.operations[id];return op?.requested_effect==='read'&&op.persistent_effect==='none'&&op.settlement_state==='settled'
            &&op.result?.authority==='native-host'&&op.result.status==='succeeded'&&sameAssignmentBindingV2(op.binding,snapshot.current_binding)
            &&sameAssignmentBindingV2(op.result.binding,snapshot.current_binding)&&!snapshot.input_invalidated_operation_ids?.includes(id)
            &&Date.parse(op.opened_at)>lastEdit&&Date.parse(op.result.completed_at)<=Date.parse(at);
        }),'drafting_check_readback_required','Keep drafted work, but obtain current same-document native readback before recording an actor backcheck. This does not certify the whole assignment.');
    }
  }
  const history=item!.location_history??[];
  kernelAssertV2(history.length<(d?128:16), 'work_plan_location_history_limit', 'Location history reached its bounded limit; prior interpretations remain retained.');
  const record:WorkPlanLocationRecordV2={...structuredClone(hint),recorded_at:at,binding:{...snapshot.current_binding},verified:false};
  return {...plan!,items:plan!.items.map(i=>i.item_id===itemId?{...i,location_history:[...history,record]}:i)};
}

export function projectCompactWorkPlanLocationV2(item: { location_history?: readonly WorkPlanLocationRecordV2[] }, snapshot?: AssignmentSnapshotV2) {
  const current=item.location_history?.at(-1);
  if(current?.drafting){
    const d=current.drafting,s=current.source!,n=current.native!;
    return {status:current.status,recorded_at:current.recorded_at,verified:false,
      source:{...s},
      native:{view_id:n.view_id,view_name:n.view_name},
      binding_current:snapshot?sameAssignmentBindingV2(current.binding,snapshot.current_binding):null,
      drafting:{pass:d.pass,stage:d.stage,element_ids:d.element_ids.slice(0,16),element_count:d.element_ids.length,
        next_action:d.next_action,remaining:d.remaining},
      drafting_passes:projectDraftingPasses(item,snapshot).map(p=>({pass:p.pass,stage:p.stage,needs_recheck:p.needs_recheck})),
      history_count:item.location_history!.length,projection_only:true,
      notice:'Compact actor tracking; full records retained in journal. First 16 element IDs shown. Not host completion proof. Refresh source/model imagery and reconcile on recovery.'};
  }
  return projectWorkPlanLocationV2(item,snapshot);
}

export function projectWorkPlanLocationV2(item: { location_history?: readonly WorkPlanLocationRecordV2[] }, snapshot?: AssignmentSnapshotV2) {
  const current=item.location_history?.at(-1);
  return current ? { ...current, binding_current: snapshot ? sameAssignmentBindingV2(current.binding,snapshot.current_binding) : null,
    drafting_passes: projectDraftingPasses(item,snapshot),
    history_count:item.location_history!.length, notice:'Source-linked actor work tracking, not host certification. checked records an evidence-linked actor backcheck, not complete drawing coverage. Reopen source/model imagery and reconcile linked elements after recovery or relevant changes; no authorization or cleared effects.' } : null;
}

export function projectDraftingPasses(item:{location_history?:readonly WorkPlanLocationRecordV2[]},snapshot?:AssignmentSnapshotV2){
  const passes=new Map<string,WorkPlanLocationRecordV2>();
  const current=item.location_history?.at(-1);
  for(const record of item.location_history??[])if(record.drafting)passes.set(record.drafting.pass,record);
  return [...passes.values()].map(record=>{
    const d=record.drafting!,ids=new Set([...d.element_ids.map(id=>'element_id:'+id),'element_id:'+record.native?.view_id]);
    const laterChange=snapshot&&Object.values(snapshot.operations).some(op=>{
      if(op.requested_effect!=='apply'||op.persistent_effect==='none'||Date.parse(op.result?.completed_at??op.opened_at)<=Date.parse(record.recorded_at))return false;
      const targets=op.result?.affected_target_identities;
      return !targets?.length||targets.some(t=>ids.has(t)||!t.startsWith('element_id:')&&!t.startsWith('artifact_path:'));
    });
    const regionChanged=JSON.stringify(record.source)!==JSON.stringify(current?.source)||record.native?.view_id!==current?.native?.view_id;
    const needs_recheck=d.stage==='checked'&&(regionChanged||!snapshot||!sameAssignmentBindingV2(record.binding,snapshot.current_binding)
      ||!!snapshot.unresolved_unknown_operation_ids.length||!!laterChange);
    return {pass:d.pass,stage:d.stage,needs_recheck,recorded_at:record.recorded_at,
      checked_by:'execution_actor',host_certified:false};
  });
}
