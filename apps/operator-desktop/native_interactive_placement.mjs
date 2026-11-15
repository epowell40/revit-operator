import {assertSavedComputerBinding} from './saved_computer_assignment.mjs';

const refuse=code=>{throw new Error(code);};
const fingerprint=value=>String(value??'').trim().toLowerCase().replace(/^sha256:/,'');

/** Preserve the reason for an internal dispatch stop. This only presents the
 * existing stopped execution; it never resumes work or settles native effects. */
export function describeComputerRunFailure(state,error,aborted=false) {
  const internal=typeof state?.controlFailureReason==='string'&&state.controlFailureReason.trim();
  const stopped=Boolean((state?.stopRequested||aborted)&&!internal);
  return {stopped,message:internal|| (stopped?'Stopped by user.':error instanceof Error?error.message:String(error))};
}

/** Local continuity only. The authenticated backend rechecks its live native
 * invocation before every input; this object grants no native authority. */
export function retainNativeInteractivePlacement(response,assignment,context,now=Date.now()) {
  const binding={assignment_id:assignment.goal_id||assignment.assignment_id,session_id:assignment.session_id,
    run_id:assignment.run_id,generation:assignment.generation};
  if(response?.schema!=='operator.desktop-native-pending.v1')refuse('native_interactive_pending_response_required');
  assertSavedComputerBinding({current_binding:response.binding},binding);
  const processId=context?.revit?.process_id;
  if(!Number.isSafeInteger(processId)||processId<=0||context.revit.source?.live!==true
    ||!fingerprint(response.binding.document_fingerprint)
    ||fingerprint(context.revit.document?.projectIdentity?.fingerprint)!==fingerprint(response.binding.document_fingerprint)
    ||typeof response.operation_id!=='string'||!response.operation_id
    ||!Number.isFinite(Date.parse(response.deadline_at))||Date.parse(response.deadline_at)<=now)
    refuse('native_interactive_target_or_deadline_unverified');
  return Object.freeze({binding,operationId:response.operation_id,processId,deadline:response.deadline_at,
    controlCommandId:assignment.control_command_id||null});
}

export function assertNativeInteractiveFunction(pending,call) {
  if(pending&&call?.name!=='native__await_interactive_placement')refuse('native_interactive_only_ui_or_await_allowed');
}

/** Release only idle UI continuity after the canonical native operation has
 * settled. This does not consume a model response or certify its effects. */
export function assertNativeInteractiveIdleRelease(pending,state) {
  if(state?.schema!=='operator.desktop-native-interaction.v1')refuse('native_interactive_control_unavailable');
  const snapshot=state.publication?.snapshot;
  assertSavedComputerBinding(snapshot,pending.binding);
  const operation=snapshot.operations?.[pending.operationId];
  if(!operation||operation.request_identity?.path!=='/revit/place-mep-accessory-interactively'
    ||operation.deadline_at!==pending.deadline||!operation.result||!operation.settled_at
    ||operation.settlement_state!=='settled'||snapshot.provider_usage_hold
    ||!['in_flight_operation_ids','unresolved_unknown_operation_ids','in_flight_provider_call_ids']
      .every(key=>Array.isArray(snapshot[key])&&snapshot[key].length===0))
    refuse('native_interactive_prior_result_unsettled');
}

export function assertNativeInteractiveAction(pending,publication,inputOperationId,action,now=Date.now()) {
  const snapshot=publication?.snapshot;
  assertSavedComputerBinding(snapshot,pending.binding);
  if((snapshot.execution_control!==undefined&&snapshot.execution_control.state!=='running')||(snapshot.execution_control?.command_id||null)!==pending.controlCommandId
    ||snapshot.terminal||snapshot.outcome!=='active'||snapshot.provider_usage_hold||snapshot.provider_budget_exhausted
    ||snapshot.completion_proposal||!['pending_review_ids','pending_input_variable_ids','unresolved_unknown_operation_ids','in_flight_provider_call_ids']
      .every(key=>Array.isArray(snapshot[key])&&snapshot[key].length===0))refuse('native_interactive_control_not_current');
  // Even when native input has just finished, only consume the original result;
  // do not reinterpret the last click as a new ordinary UI edit.
  if(inputOperationId!==pending.operationId)refuse('native_interactive_result_required');
  const op=snapshot.operations?.[pending.operationId];
  if(snapshot.quiescent!==false||snapshot.in_flight_operation_ids?.length!==1
    ||snapshot.in_flight_operation_ids[0]!==pending.operationId||op?.deadline_at!==pending.deadline
    ||Date.parse(pending.deadline)<=now||op?.request_identity?.path!=='/revit/place-mep-accessory-interactively'
    ||op.settlement_state!=='awaiting_result')refuse('native_interactive_operation_not_current');
  if(!['screenshot','wait','move','click','scroll','keypress'].includes(action?.type))refuse('native_interactive_input_not_allowed');
  if(action.type==='click'&&action.button&&action.button!=='left')refuse('native_interactive_input_not_allowed');
  if(action.type==='keypress'&&(!Array.isArray(action.keys)||action.keys.length!==1
    ||!['ESC','ESCAPE','SPACE'].includes(String(action.keys[0]).toUpperCase())))refuse('native_interactive_input_not_allowed');
  return ['screenshot','wait'].includes(action.type)?[]:['-ExpectedRevitProcessId',String(pending.processId)];
}

/** Host Stop cancels its own still-pending native prompt, even though Pause
 * correctly forbids ordinary model input. This permits only Escape, never a
 * user/model-supplied key or another edit. Check the original operation before
 * each of at most two Escapes; the native result still decides effects. */
export async function cancelNativeInteractivePlacement(pending,{readControl,sendEscape}) {
  let sent=0;
  for(let i=0;i<2;i++) {
    const current=await readControl(pending.binding),snapshot=current?.publication?.snapshot;
    if(current?.schema!=='operator.desktop-native-interaction.v1'||current.pending_result!==true)
      return {escapeInputs:sent,nativeResultRequired:true};
    assertSavedComputerBinding(snapshot,pending.binding);
    const op=snapshot.operations?.[pending.operationId];
    if(!snapshot.in_flight_operation_ids?.includes(pending.operationId)||op?.settlement_state!=='awaiting_result')
      return {escapeInputs:sent,nativeResultRequired:true};
    if(op.request_identity?.path!=='/revit/place-mep-accessory-interactively'||op.deadline_at!==pending.deadline)
      refuse('native_interactive_cancel_binding_changed');
    await sendEscape(['-Action','cancel_native_placement','-ExpectedRevitProcessId',String(pending.processId)]);
    sent++;
  }
  return {escapeInputs:sent,nativeResultRequired:true};
}
