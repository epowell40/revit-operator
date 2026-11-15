import {getAssignmentKernelSnapshotV2} from '../assignments/assignment_kernel_v2_store.js';

export type FeedbackTaskBinding={assignment_id:string;session_id:string;run_id:string;generation:number};
/** Missing binding is explicitly legacy/session feedback, never inferred from the latest task. */
export function validateFeedbackTaskBinding(session:string, value:unknown):FeedbackTaskBinding|null {
 if(value==null)return null;
 const b=value as Partial<FeedbackTaskBinding>;
 const invalid=()=>{const e=new Error('The task changed or is unavailable. Reopen it before submitting feedback.');(e as any).code='feedback_binding_conflict';return e;};
 if(!b||typeof b!=='object'||!['assignment_id','session_id','run_id'].every(k=>typeof (b as any)[k]==='string'&&!['.','..'].includes((b as any)[k])&&/^[A-Za-z0-9._:-]{1,200}$/.test((b as any)[k]))
   ||!Number.isSafeInteger(b.generation)||b.generation!<1||b.session_id!==session)throw invalid();
 const current=getAssignmentKernelSnapshotV2(b.assignment_id!)?.current_binding;
 if(!current||!['assignment_id','session_id','run_id','generation'].every(k=>(b as any)[k]===(current as any)[k]))throw invalid();
 return {assignment_id:current.assignment_id,session_id:current.session_id,run_id:current.run_id,generation:current.generation};
}
