import type {AssignmentSnapshotV2} from '../domain/assignment-kernel/snapshot.js';
import {canonicalJsonV2,sameAssignmentBindingV2} from '../domain/assignment-kernel/index.js';
import {projectCompactWorkPlanLocationV2} from '../domain/assignment-kernel/work_plan_location.js';
import type {EvidenceScope} from '../evidence/evidence_ref.js';
import {getEvidenceContextBudget} from '../evidence/model_context_budget.js';
import {storeEvidence} from '../evidence/evidence_store.js';

type Output={success:boolean;contentItems:Array<{type:'inputText';text:string}|{type:'inputImage';imageUrl:string}>};
/** A successful, newly journaled locate needs its selected area/pass returned,
 * not another task-wide inventory. Status/review/error paths remain unchanged.
 * The full handler output stays retrievable; this acknowledgement is actor
 * tracking only and never native, completion, resource or execution authority. */
export function desktopDraftingLocationOutput(result:Output,input:{tool:string;arguments:unknown;
 snapshot:AssignmentSnapshotV2|null|undefined;beforeVersion:number;scope:EvidenceScope;callId:string}):Output|null {
 const {snapshot:s,scope}=input,a=input.arguments as any;
 if(input.tool!=='operator_manage_work_plan'||result.success!==true||a?.action!=='locate'
   ||typeof a.itemId!=='string'||!a.locationHint?.drafting||!s||s.terminal||s.outcome!=='active'
   ||s.execution_control?.state!=='running'||s.unresolved_unknown_operation_ids.length
   ||s.provider_usage_hold||s.pending_input_variable_ids.length||s.pending_review_ids.length
   ||s.assignment_version<=input.beforeVersion
   ||!['session_id','assignment_id','run_id','generation'].every(k=>(s.current_binding as any)[k]===(scope as any)[k])
   ||!result.contentItems.length||result.contentItems.some(i=>i.type!=='inputText'||typeof i.text!=='string'))return null;
 const item=s.work_plan?.items.find(i=>i.item_id===a.itemId),record=item?.location_history?.at(-1);
 if(!item||!record?.drafting||!sameAssignmentBindingV2(record.binding,s.current_binding)
   ||record.native?.document_fingerprint!==s.current_binding.document_fingerprint
   ||canonicalJsonV2(record.drafting)!==canonicalJsonV2(a.locationHint.drafting))return null;
 const ack={ok:true,item_id:item.item_id,assignment_version:s.assignment_version,outcome:s.outcome,
  binding:{session_id:scope.session_id,assignment_id:scope.assignment_id,run_id:scope.run_id,generation:scope.generation},
  location_hint:projectCompactWorkPlanLocationV2(item,s),projection_only:true,whole_task_verified:false,
  notice:'Area/pass tracking retained. Checked covers only its linked subset/pass. Continue the next unfinished pass or ready area using current host feedback. Full work-plan status and the exact original handler output remain available; this acknowledgement grants no authority or completion.'};
 // Reserve the actual reference envelope before retaining anything. An unusual
 // oversized area keeps the existing complete-output path, not clipped proof.
 const placeholder={...ack,retained_output:{evidence_id:'ev1_'+'x'.repeat(32),content_hash:'sha256:'+'0'.repeat(64),
  retrieval:{tool_name:'operator_retrieve_evidence',max_bytes:16384}}};
 if(Buffer.byteLength(JSON.stringify(placeholder))>getEvidenceContextBudget().item_bytes)return null;
 const stored=storeEvidence({scope,source:'desktop_drafting_location_ack',trust_level:'host_observed',
  verification_relevance:'supporting',media_type:'application/json',raw:result,
  bounded_summary:'Exact original work-plan handler output retained; actor tracking and supporting context, not native or task completion proof.'});
 return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({...ack,retained_output:{
  evidence_id:stored.ref.evidence_id,content_hash:stored.ref.content_hash,
  retrieval:{tool_name:'operator_retrieve_evidence',max_bytes:16384}}})}]};
}
