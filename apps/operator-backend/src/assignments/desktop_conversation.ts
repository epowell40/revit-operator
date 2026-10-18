import type {ChatRequest} from '../contracts.js';
import type {AssignmentBindingV2} from '../domain/assignment-kernel/index.js';
import {sameAssignmentBindingV2} from '../domain/assignment-kernel/index.js';
import {getAssignmentKernelSnapshotV2} from './assignment_kernel_v2_store.js';
import {desktopExecutorOwnsAssignmentV2,desktopHelperScopeForSnapshotV1,desktopHelperScopeFromContextV1} from './desktop_executor_owner.js';
import {appendMessage} from '../session_store.js';
import {conversationDisplay} from '../conversation_history.js';
import {getConversationTurn} from '../memory/sqlite_store.js';

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
 const groups=[['Reported work',proposal.claimed_completed],['Remaining work',proposal.remaining_work],['Uncertainties',proposal.uncertainties]] as const;
 const lines=groups.filter(([,items])=>items.length).map(([label,items])=>{
  const first=items[0]!;return first.length<=280?`${label}: ${first}${items.length>1?` (${items.length-1} more in Details.)`:''}`:`${label}: ${items.length} items in Details.`;
 });
 appendDisplay(binding,proposal.review_id,'assistant',['Ready for review (not independently verified).',...lines,'See task Details for the full retained report and earlier unfinished items.'].join('\n\n'));
}
