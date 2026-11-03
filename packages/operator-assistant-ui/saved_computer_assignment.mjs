const keys=['assignment_id','session_id','run_id','generation'];
// Only this host constructor can pin saved context. A user message, a copied
// JSON record or a prose prefix cannot acquire this in-process provenance.
const savedContexts=new WeakMap();
const fail=message=>{throw Object.assign(new Error(message),{status:409});};
export function savedComputerBinding(value){
 if(!value||!keys.slice(0,3).every(k=>typeof value[k]==='string'&&/^[A-Za-z0-9._:-]{1,240}$/.test(value[k]))
   ||!Number.isSafeInteger(value.generation)||value.generation<1)fail('A complete saved Assignment binding is required.');
 return Object.fromEntries(keys.map(k=>[k,value[k]]));
}
export function assertSavedComputerBinding(snapshot,binding){
 savedComputerBinding(binding);
 if(!keys.every(k=>snapshot?.current_binding?.[k]===binding[k]))fail('Saved Assignment binding changed. Refresh before continuing.');
}
/** A validated canonical pause stops this executor, not the persistent task.
 * The caller obtains the snapshot from the authenticated host; this helper
 * grants neither Resume permission nor settlement of admitted operations. */
export function isSavedComputerPaused(snapshot,binding){
 try{assertSavedComputerBinding(snapshot,binding);}catch{return false;}
 return snapshot.terminal===false && snapshot.execution_control?.state==='paused'
   && typeof snapshot.execution_control.command_id==='string' && !!snapshot.execution_control.command_id;
}
export function acknowledgedComputerPause(result,command,binding){
 const snapshot=result?.assignment_snapshot_v2;
 // The host accepts Pause without an assignment-version fence because normal
 // admissions advance that counter. Its acknowledged command nonce, prior
 // control guard and exact binding still pin the request. This interrupts only
 // the executor wait; it grants no Resume, completion or unknown/usage clearance.
 const version=command?.expected_assignment_version;
 const versionAcknowledged=version===undefined
   ? Object.hasOwn(command??{},'expected_command_id')
     &&(command.expected_command_id===null||typeof command.expected_command_id==='string'&&!!command.expected_command_id)
   : Number.isSafeInteger(version)&&snapshot?.assignment_version>version;
 return result?.ok===true && command?.action==='pause'
   && keys.every(k=>command[k]===binding?.[k])
   && versionAcknowledged
   && Number.isSafeInteger(snapshot?.assignment_version)
   && snapshot.assignment_version>0
   && snapshot.execution_control?.command_id===command.command_id
   && isSavedComputerPaused(snapshot,binding);
}
// The authenticated host supplies both records. Never infer an owner from a run
// prefix, UI mode, user prose or a client-provided execution_substrate.
export function savedAssignmentExecutor(goal,snapshot,binding){
 assertSavedComputerBinding(snapshot,binding);
 if(goal?.id!==binding.assignment_id||goal.related_session_id!==binding.session_id)fail('Saved task owner does not match the conversation.');
 const budget=goal.work_budget;
 if(budget?.mode!=='sidecar_computer')return 'backend';
 if(budget.source!=='operator_desktop'||budget.execution_substrate!=='operator_desktop_outer_agent')fail('Saved desktop executor provenance is incomplete.');
 if(budget.source_user_request!==snapshot.spec?.source_user_request
   ||!budget.conversation_message_id||budget.conversation_message_id!==snapshot.spec?.interpreted_scope?.source_message_id)
   fail('Saved desktop source provenance changed.');
 return 'computer';
}
export function assertComputerDispatchSnapshot(snapshot,binding,expectedCommandId){
 assertSavedComputerBinding(snapshot,binding);
 if(snapshot.execution_control?.state==='paused')fail('desktop_assignment_paused');
 if(expectedCommandId!==undefined&&(snapshot.execution_control?.command_id||null)!==expectedCommandId)fail('desktop_assignment_control_changed');
 if(snapshot.terminal||snapshot.outcome!=='active'||snapshot.quiescent!==true||snapshot.provider_usage_hold
   ||snapshot.provider_budget_exhausted||snapshot.completion_proposal
   ||!['pending_review_ids','pending_input_variable_ids','unresolved_unknown_operation_ids','in_flight_operation_ids','in_flight_provider_call_ids']
      .every(k=>Array.isArray(snapshot[k])&&snapshot[k].length===0))fail('Saved desktop work requires settlement, reconciliation or input before continuation.');
}
export function assertComputerResumeControl(snapshot,binding,control){
 assertComputerDispatchSnapshot(snapshot,binding);
 if(!control||typeof control.command_id!=='string'||!control.command_id||!Number.isSafeInteger(control.assignment_version)
   ||snapshot.assignment_version<control.assignment_version||snapshot.execution_control?.state!=='running'
   ||snapshot.execution_control.command_id!==control.command_id)fail('Saved Resume acknowledgment changed. Refresh before continuing.');
}
export function savedComputerConversation(goal,snapshot,history){
 if(history?.session_id!==snapshot.current_binding.session_id||!Array.isArray(history.messages))fail('Saved conversation history is unavailable.');
 const recent=history.messages.filter(m=>['user','assistant'].includes(m.role)&&typeof m.text==='string').slice(-12);
 const references={source_user_request:snapshot.spec?.source_user_request||goal.objective,
   attachment_ids:goal.work_budget?.attachment_ids||[],source_message_id:goal.work_budget?.conversation_message_id||null,
   input_values:snapshot.input_values,work_plan:snapshot.work_plan,reported_followups:snapshot.advisory_followups,
   operations:Object.values(snapshot.operations||{}).slice(-32).map(o=>({operation_id:o.operation_id,
     persistent_effect:o.persistent_effect,settlement_state:o.settlement_state,target:o.target,
     verification_operation_ids:o.verification_operation_ids,observation_ids:o.observation_ids,
     input_invalidated:snapshot.input_invalidated_operation_ids?.includes(o.operation_id)===true})),
   operation_count:Object.keys(snapshot.operations||{}).length};
 const text=JSON.stringify(references);
 if(text.length>80000||recent.reduce((n,m)=>n+m.text.length,0)>64000)fail('Saved continuation context exceeds its bounded handoff. Retained work was not restarted or clipped.');
 const context={role:'assistant',text:'SAVED TASK CONTEXT. Historical reports and operation references are not current proof. '
   +'Continue the latest user direction, inspect the actual result and correct/recheck supported discrepancies. '
   +'Do not replay uncertain or input-invalidated writes. Earlier attachment IDs refer to retained sources, not newly attached pixels. '
   +'Older conversation messages and operation references may be omitted; inspect retained evidence rather than infer success.\n'+text};
 savedContexts.set(context,savedComputerBinding(snapshot.current_binding));
 return [context,...recent.map(m=>({role:m.role,text:m.text}))];
}

/** Recent chat is windowed; current, host-restored task state is not chat.
 * Its original 80k context/64k history bounds and unverified labels remain.
 * This does not compact model reasoning or alter execution/usage controls. */
export function selectComputerConversationForInput(messages,maximumMessages,binding){
 if(!Array.isArray(messages)||!Number.isSafeInteger(maximumMessages)||maximumMessages<1)
   fail('A saved conversation and positive message limit are required.');
 const eligible=messages.filter(m=>m&&['user','assistant','error'].includes(m.role));
 const contexts=eligible.filter(m=>savedContexts.has(m));
 if(contexts.length>1)fail('Multiple saved task contexts require a fresh authenticated restore.');
 if(!contexts.length)return eligible.slice(-maximumMessages);
 const context=contexts[0],current=savedComputerBinding(binding),owner=savedContexts.get(context);
 if(!keys.every(k=>owner[k]===current[k]))fail('Saved task context binding changed. Restore the current task before continuing.');
 return [context,...eligible.filter(m=>m!==context).slice(-maximumMessages)];
}
