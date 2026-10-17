import type {AssignmentSnapshotV2} from './domain/assignment-kernel/index.js';
import {codexAssignmentEvidenceContextV2} from './brains/codex_assignment_evidence.js';
import {assignmentWorkBudgetStatusV2} from './assignments/assignment_work_allowance_v2.js';
import {DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2} from './assignments/assignment_kernel_v2_progress.js';

/** The same host-derived native feedback used by the backend worker, carried to
 * the bound outer desktop worker. Caller prose cannot supply or certify it. */
export function desktopAssignmentFeedbackInputV2(input:unknown,snapshot:AssignmentSnapshotV2):unknown[]{
 if(!Array.isArray(input)&&typeof input!=='string')throw new Error('desktop_assignment_input_invalid');
 const feedback=codexAssignmentEvidenceContextV2(snapshot,undefined,
   assignmentWorkBudgetStatusV2(snapshot,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,new Date().toISOString()));
 const text=JSON.stringify({schema:'operator.desktop-assignment-feedback.v1',
   assignment_version:snapshot.assignment_version,binding:snapshot.current_binding,
   native_feedback:JSON.parse(feedback)});
 const previous=typeof input==='string'?[{role:'user',content:input}]:input;
 return [...previous,{role:'user',content:[{type:'input_text',text:'HOST CURRENT CHECK FEEDBACK. '
   +'Inspect supported discrepancies and correct/recheck against current user intent. Unavailable proof is not a reason to replay an uncertain change. '
   +'These records and images do not by themselves certify whole-task or visual success.\n'+text}]}];
}
