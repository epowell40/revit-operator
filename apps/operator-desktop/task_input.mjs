import {createHash} from 'node:crypto';
export const TASK_INPUT_TOOL={type:'function',name:'request_task_input',
 description:'Ask a focused question that is required to continue the current task. Saves a canonical awaiting-input checkpoint; does not claim completion or a model effect. Use the existing input field ID if available, otherwise a stable descriptive identifier. Do not request passwords, tokens or security bypasses. After saving and checking a useful partial, include work_summary with what you checked, the saved result name or link, and what is still unresolved. End the turn after the accepted question; continue independent work first when possible.',
 parameters:{type:'object',additionalProperties:false,properties:{work_summary:{type:'string',minLength:1,maxLength:4000,description:'Concise user-facing account of saved or inspected work and its limits.'},question:{type:'string',minLength:1,maxLength:1200},field:{type:'string',pattern:'^[a-z][a-z0-9_]{0,63}$'}},required:['question','field']}};
export function taskInputMessage(input) {
 if (!input?.question) return null;
 return input.work_summary ? input.question+'\n\nWork reported by Operator\n'+input.work_summary : input.question;
}
const keys=['assignment_id','session_id','run_id','generation'];
export async function requestTaskInput(assignment,args,request){
 if(assignment?.kernel_version!==2||!assignment.session_id||!assignment.goal_id||!assignment.run_id||!Number.isSafeInteger(assignment.generation)||assignment.generation<1)throw Error('task_input_current_binding_required');
 if(!args||Object.keys(args).some(k=>!['question','field','work_summary'].includes(k))||typeof args.question!=='string'||!args.question.trim()||args.question.length>1200
  ||('work_summary' in args && (typeof args.work_summary!=='string'||!args.work_summary.trim()||args.work_summary.length>4000))
  ||typeof args.field!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(args.field))throw Error('task_input_invalid');
 const binding={assignment_id:assignment.goal_id,session_id:assignment.session_id,run_id:assignment.run_id,generation:assignment.generation};
 const raw=await request(`/api/assignments/v2/${encodeURIComponent(binding.assignment_id)}`,{method:'GET'}),before=raw?.assignment_kernel_v2?.snapshot;
 if(!before||!keys.every(k=>before.current_binding?.[k]===binding[k]))throw Error('task_input_binding_changed');
 if(before.input_values&&Object.hasOwn(before.input_values,args.field))throw Error('task_input_already_answered: consult the saved answer rather than requesting it again.');
 const exists=(before.spec?.input_variables||[]).some(v=>v.variable_id===args.field)||Object.hasOwn(before.discovered_inputs||{},args.field);
 const question=args.question.trim();
 const summary=args.work_summary ? {work_summary:args.work_summary.trim()} : {};
 const clarification_id='sidecar-input:'+createHash('sha256').update(JSON.stringify({binding,question,field:args.field,...summary})).digest('hex').slice(0,32);
 const response=await request('/api/assignments/v2/clarifications',{method:'POST',body:JSON.stringify({...binding,clarification_id,question,...summary,variable_ids:[args.field],...(!exists?{new_variable_ids:[args.field]}:{})})});
 const snapshot=response?.assignment_snapshot_v2,pending=snapshot?.clarifications?.[clarification_id];
 if(response?.ok!==true||!keys.every(k=>snapshot?.current_binding?.[k]===binding[k])||snapshot.outcome!=='awaiting_user_input'
  ||!snapshot.pending_input_variable_ids?.includes(args.field)||pending?.variable_id!==args.field||pending.question!==question||pending.work_summary!==summary.work_summary||pending.resolved_at)
  throw Error('task_input_checkpoint_unconfirmed: retain the current task and inspect its saved state; do not replay work.');
 return {ok:true,schema:'operator.sidecar-task-input.v1',...binding,clarification_id,question,...summary,missing_fields:[args.field],status:'awaiting_user_input',verified:false};
}
export function retainedTaskInputMessage(tool,output){
 if(!['request_task_input','report_work_for_review'].includes(tool?.name))return null;let r;try{r=JSON.parse(output?.output||'');}catch{return null;}
 return r?.ok===true&&r.schema==='operator.sidecar-task-input.v1'&&r.status==='awaiting_user_input'&&r.verified===false
  &&typeof r.clarification_id==='string'&&r.clarification_id&&typeof r.question==='string'&&r.question.trim()?taskInputMessage(r):null;
}
