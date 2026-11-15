// Relay-observed diagnostic text only. Neither messages nor errors prove effects.
export function sidecarFeedbackDiagnostic(sessionId,state){
  if(typeof sessionId!=='string'||!sessionId||state?.backendSessionId!==sessionId
    ||typeof state.error!=='string'||!state.error.trim())return null;
  const bounded=(v,n)=>typeof v==='string'&&v.trim()?v.trim().length<=n?v.trim():v.trim().slice(0,n-16)+' ...[truncated]':undefined;
  const user=Array.isArray(state.messages)?[...state.messages].reverse().find(m=>m?.role==='user'&&typeof m.text==='string'&&m.text.trim()):null;
  const assignment=state.sidecarAssignment?.session_id===sessionId?state.sidecarAssignment:null;
  const phase=bounded(state.progress?.phase,160),request=bounded(user?.text,5000);
  return {schema:'operator.feedback-runtime-diagnostic.v1',source:'operator_desktop',session_id:sessionId,error:bounded(state.error,2000),
    ...(phase?{phase}:{}),...(request?{user_request:request}:{}),
    ...(assignment?.goal_id?{assignment_id:assignment.goal_id}:{}),...(assignment?.run_id?{run_id:assignment.run_id}:{}),
    ...(Number.isSafeInteger(assignment?.generation)&&assignment.generation>0?{generation:assignment.generation}:{})};
}
