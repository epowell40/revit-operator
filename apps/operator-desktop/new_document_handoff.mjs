/** The actor supplies no target identity. The host reads protected native
 * context and passes it to the authenticated document-phase controller. */
export async function continueNewDocument({assignment,response,call,readContext,request,validatePublication}) {
  const args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
  if(call.name!=='native__continue_in_new_revit_model'||!args||typeof args!=='object'||Array.isArray(args)
    ||Object.keys(args).length||response.output.filter(v=>v?.type==='function_call'||v?.type==='computer_call').length!==1)
    throw Error('The document handoff must be a single call with no model-supplied identity.');
  const raw=await readContext();
  if(!raw?.ok||!raw.data?.document)throw Error('The new project is not ready. Preserve it and wait for native context.');
  const parent={assignment_id:assignment.goal_id,session_id:assignment.session_id,run_id:assignment.run_id,generation:assignment.generation};
  const result=await request('/api/assignments/v2/document-handoff',{method:'POST',body:JSON.stringify({...parent,
    message_id:response.desktop_message_id,response_id:response.id,call_id:call.call_id,native_context:raw.data})});
  if(result?.schema!=='operator.new-document-handoff.v1'||!Object.keys(parent).every(k=>result.parent_binding?.[k]===parent[k]))
    throw Error('The document handoff response has the wrong owner. Do not repeat model creation.');
  const goal=result.goal,b=result.publication?.snapshot?.current_binding;
  if(!goal||!b||b.assignment_id!==goal.id||b.session_id!==parent.session_id||b.assignment_id===parent.assignment_id)
    throw Error('The document phase binding is invalid.');
  const publication=validatePublication(result.publication,b),snapshot=publication.snapshot;
  if(!Object.keys(parent).every(k=>snapshot.spec.document_parent_binding?.[k]===parent[k])
    ||b.document_fingerprint!==raw.data.document.projectIdentity?.fingerprint?.replace(/^sha256:/,'')
    ||goal.work_budget?.revit_process_id!==raw.data.process_id||goal.work_budget?.document_session_id!==raw.data.document.sessionId)
    throw Error('The document phase does not match the observed new project.');
  return {assignment:{session_id:b.session_id,goal_id:b.assignment_id,run_id:b.run_id,generation:b.generation,
    kernel_version:2,control_command_id:null,title:goal.title,objective:goal.objective,work_budget:goal.work_budget},
    rawContext:raw.data,message:result.message};
}
