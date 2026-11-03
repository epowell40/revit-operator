import type {AssignmentSnapshotV2} from '../domain/assignment-kernel/index.js';
import {deriveTerminalResultV2} from '../assignments/assignment_kernel_v2_terminal_result.js';
import type {WorkReturnV1} from './contract.js';
import {WORK_RETURN_SCHEMA} from './contract.js';
import {verifyWorkReturnHash} from './generator.js';

/** Optional read-only transport of an existing canonical result. The persisted
 * Work Return, criterion status, effect history and terminal outcome do not change. */
export function workReturnTerminalPresentationV2(snapshot:AssignmentSnapshotV2|null,workReturn:WorkReturnV1) {
 if(!snapshot?.terminal||!snapshot.quiescent||!['complete','verified_noop','complete_with_issues','blocked','failed'].includes(snapshot.outcome)
  ||snapshot.unresolved_unknown_operation_ids.length||snapshot.in_flight_operation_ids.length||snapshot.in_flight_provider_call_ids.length
  ||workReturn.schema!==WORK_RETURN_SCHEMA||!verifyWorkReturnHash(workReturn)
  ||workReturn.assignment_id!==snapshot.current_binding.assignment_id||workReturn.run_id!==snapshot.current_binding.run_id
  ||workReturn.generation!==snapshot.current_binding.generation||workReturn.status!==snapshot.outcome
  ||typeof snapshot.finished_at!=='string'||workReturn.created_at!==snapshot.finished_at)return null;
 const result=deriveTerminalResultV2(snapshot);
 if(!result.result_summary.trim()||Buffer.byteLength(result.result_summary,'utf8')>24000)return null;
 return {work_return_id:workReturn.work_return_id,work_return_hash:workReturn.work_return_hash,
  binding:{...snapshot.current_binding},terminal_result_v2:result};
}
