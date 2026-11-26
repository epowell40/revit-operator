import path from 'node:path';
import {pathToFileURL} from 'node:url';
import type {ChatRequest} from '../contracts.js';
import type {AssignmentBindingV2} from '../domain/assignment-kernel/index.js';
import type {AssignmentKernelBindingInputV2} from './assignment_kernel_v2_lifecycle.js';
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/index.js';
import {getAssignmentKernelSnapshotV2} from './assignment_kernel_v2_store.js';
import {desktopExecutorOwnsAssignmentV2,desktopHelperScopeForSnapshotV1,desktopHelperScopeFromContextV1} from './desktop_executor_owner.js';
import {appendMessage} from '../session_store.js';
import {conversationDisplay} from '../conversation_history.js';
import {getConversationTurn,type ConversationEntry} from '../memory/sqlite_store.js';
import {deriveTerminalResultV2} from './assignment_kernel_v2_terminal_result.js';
import {modelSavedProjectCheckpointV1,savedProjectBeforeInterruptionV2,savedProjectCheckpointV2} from './saved_copy_handoff_v2.js';
import {requestMatchesAssignmentPrincipalId} from '../request_context.js';
import {workReportPresentation} from './work_report_presentation.js';

function savedProjectMessage(assignmentId:string,saved:Pick<NonNullable<ReturnType<typeof savedProjectCheckpointV2>>,
 'file'|'observation_id'|'created_at'>,checked:boolean):ConversationEntry{
 const folder=pathToFileURL(path.win32.dirname(saved.file),{windows:true}).href.replaceAll('(','%28').replaceAll(')','%29');
 return {role:'assistant',message_id:`saved-checkpoint:${assignmentId}:${saved.observation_id}`,created_at:saved.created_at,
  text:`${checked?'Operator saved and checked this review copy. Final model checks may still be open.'
   :'Operator saved this project before the interruption. Later work still needs checking.'}\n\nSaved file: ${path.win32.basename(saved.file)}\n[Open its folder](${folder})`};
}

/** Browser display and an optional current-call file check for the actor. */
export function liveDesktopCheckedCopyV1(binding:AssignmentKernelBindingInputV2,nativeResult:unknown){
 const snapshot=getAssignmentKernelSnapshotV2(binding.assignment_id);
 if(!snapshot||!desktopExecutorOwnsAssignmentV2(snapshot)
  ||snapshot.current_binding.session_id!==binding.session_id||snapshot.current_binding.run_id!==binding.run_id
  ||snapshot.current_binding.generation!==binding.generation
  ||!requestMatchesAssignmentPrincipalId(snapshot.current_binding.principal_id,undefined,binding.session_id))return null;
 const saved=savedProjectCheckpointV2(snapshot);
 if(!saved)return null;
 return {copy:{binding,message:savedProjectMessage(binding.assignment_id,saved,true)},
  modelCheckpoint:modelSavedProjectCheckpointV1(snapshot,nativeResult,saved)};
}

/** Restore the selected task's evidence-backed result after reconnecting. */
export function desktopConversationResultV1(sessionId:string,assignmentId:string):ConversationEntry|null{
 const snapshot=getAssignmentKernelSnapshotV2(assignmentId);
 if(!snapshot||snapshot.current_binding.session_id!==sessionId||!desktopExecutorOwnsAssignmentV2(snapshot))return null;
 if(!snapshot.terminal&&requestMatchesAssignmentPrincipalId(snapshot.current_binding.principal_id,undefined,sessionId)){
  const checked=savedProjectCheckpointV2(snapshot);
  const saved=checked??savedProjectBeforeInterruptionV2(snapshot);
  if(saved)return savedProjectMessage(assignmentId,saved,Boolean(checked));
 }
 if(!snapshot.terminal||!snapshot.quiescent||!snapshot.finished_at
  ||snapshot.spec.requested_effect!=='read'||!snapshot.result_delivery
  ||!['complete','complete_with_issues','verified_noop'].includes(snapshot.outcome))return null;
 const text=deriveTerminalResultV2(snapshot).result_summary;
 if(!text.trim()||Buffer.byteLength(text,'utf8')>24000)return null;
 return {role:'assistant',message_id:`terminal-result:${assignmentId}:${snapshot.assignment_version}`,text,created_at:snapshot.finished_at};
}

/** Presentation provenance only. Never changes task authority or verification.
 * The exact authenticated helper still has its raw turn/run and evidence logs,
 * but its delegated prompt is neither a human message nor a new pinned goal. */
export function requestConversationPersistenceV1(request:Partial<ChatRequest>,text:string,attachments?:unknown):Parameters<typeof appendMessage>[2]{
 if(typeof request.session_id!=='string'||!request.session_id||typeof request.message_id!=='string'||!request.message_id)
  throw Error('Conversation session and message identity are required.');
 const snapshot=request.assignment_id?getAssignmentKernelSnapshotV2(request.assignment_id):null;
 const helper=snapshot&&snapshot.current_binding.session_id===request.session_id
  &&snapshot.current_binding.run_id===request.assignment_run_id&&snapshot.current_binding.generation===request.assignment_generation
  &&desktopHelperScopeForSnapshotV1(snapshot,desktopHelperScopeFromContextV1(request.context));
 return helper?{pinGoal:false}:{display:conversationDisplay(request.message_id,text,attachments)};
}

function appendDisplay(binding:AssignmentBindingV2,messageId:string,role:'user'|'assistant',text:string):void{
 const existing=getConversationTurn(binding.session_id,messageId).find(m=>m.role===role);
 if(existing){if(existing.text!==text)throw Error('Desktop conversation message identity conflict.');return;}
 appendMessage(binding.session_id,{role,text},{display:{...conversationDisplay(messageId,text),source:'desktop_executor'},pinGoal:false,requirePersistence:true});
}

/** Called only after the ordinary kernel has created the desktop-owned task.
 * Derive human wording from its immutable source, never a helper instruction. */
export function retainDesktopInitialConversationV1(binding:AssignmentBindingV2):void{
 const snapshot=getAssignmentKernelSnapshotV2(binding.assignment_id);
 if(!snapshot||!desktopExecutorOwnsAssignmentV2(snapshot)
  ||!sameAssignmentBindingV2(snapshot.current_binding,binding))return;
 const messageId=snapshot.spec.interpreted_scope?.source_message_id;
 if(messageId)appendDisplay(binding,messageId,'user',snapshot.spec.source_user_request);
}

/** Records an already-retained whole-parent review proposal, not a helper's
 * scoped return. Canonical reports/unfinished items remain in task Details.
 * Rendering never promotes these claims into facts or completion. */
export function retainDesktopReviewConversationV1(binding:AssignmentBindingV2):void{
 const snapshot=getAssignmentKernelSnapshotV2(binding.assignment_id);
 if(!snapshot||!desktopExecutorOwnsAssignmentV2(snapshot)
  ||!sameAssignmentBindingV2(snapshot.current_binding,binding)||!snapshot.completion_proposal)return;
 const proposal=snapshot.completion_proposal;
 const presentation=workReportPresentation(snapshot)!;
 appendDisplay(binding,proposal.review_id,'assistant',presentation.summary+'\n\n## Details\n\n'+presentation.details);
}
