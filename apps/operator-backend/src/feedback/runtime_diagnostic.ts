/** Diagnostic text reported by the relay, never model/transaction proof. */
export type FeedbackRuntimeDiagnostic = {
  schema:'operator.feedback-runtime-diagnostic.v1';source:'operator_desktop';session_id:string;
  error:string;phase?:string;user_request?:string;assignment_id?:string;run_id?:string;generation?:number;
};
export function feedbackRuntimeDiagnostic(value:unknown,sessionId:string):FeedbackRuntimeDiagnostic|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const r=value as Record<string,unknown>,fields=['schema','source','session_id','error','phase','user_request','assignment_id','run_id','generation'];
  if(Object.keys(r).some(k=>!fields.includes(k))||r.schema!=='operator.feedback-runtime-diagnostic.v1'||r.source!=='operator_desktop'
    ||r.session_id!==sessionId||typeof r.error!=='string'||!r.error.trim()||r.error.length>2000)return null;
  for(const [key,max] of [['phase',160],['user_request',5000],['assignment_id',240],['run_id',240]] as const)
    if(r[key]!==undefined&&(typeof r[key]!=='string'||!r[key].trim()||r[key].length>max))return null;
  if(r.generation!==undefined&&(!Number.isSafeInteger(r.generation)||Number(r.generation)<1))return null;
  return {...r,error:r.error.trim()} as FeedbackRuntimeDiagnostic;
}
