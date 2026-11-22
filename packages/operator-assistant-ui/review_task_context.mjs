const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const scope=['assignment_id','session_id','run_id','generation'];

// Context for a supporting reviewer, never authorization or completion proof.
// The caller obtains this snapshot through the existing authenticated,
// owner-validated publication; transient chat pages are not objective storage.
export function canonicalReviewTaskContext(snapshot,owner){
 const binding={...owner,assignment_id:owner?.assignment_id??owner?.goal_id};
 if(snapshot?.schema!=='revit-operator.assignment-snapshot/v2'||!Number.isSafeInteger(snapshot.assignment_version)
  ||snapshot.assignment_version<1||!scope.every(k=>binding[k]===snapshot.current_binding?.[k])
  ||!scope.slice(0,3).every(k=>typeof binding[k]==='string'&&binding[k].trim())
  ||!Number.isSafeInteger(binding.generation)||binding.generation<1
  ||['principal_id','document_fingerprint'].some(k=>binding[k]!=null&&binding[k]!==snapshot.current_binding?.[k]))throw Error('review_task_context_owner_mismatch');
 const source=snapshot.spec?.source_user_request;
 if(typeof source!=='string'||!source.trim()||source.length>12000)throw Error('review_task_context_objective_unavailable');
 if(!object(snapshot.input_values)||!object(snapshot.clarifications))throw Error('review_task_context_inputs_unavailable');
 const answered=Object.values(snapshot.clarifications).filter(c=>object(c)&&Number.isFinite(Date.parse(c.resolved_at))
  &&typeof c.variable_id==='string'&&Object.hasOwn(snapshot.input_values,c.variable_id))
  .sort((a,b)=>Date.parse(b.resolved_at)-Date.parse(a.resolved_at));
 if(!answered.length)return source;
 const rows=[];let omitted=0;
 for(const c of answered){
  const row={question:typeof c.question==='string'?c.question.slice(0,300):c.variable_id,value:snapshot.input_values[c.variable_id]};
  const text=JSON.stringify(row);
  if(text.length>2000||rows.length>=32){omitted++;continue;}rows.push(text);
 }
 const prefix='\n\nResolved task inputs (retained context, not independent authorization):\n';
 const suffix=()=>omitted?`\n${omitted} resolved input record(s) omitted from this bounded review context. Do not infer their contents; affected questions remain uncertain.`:'';
 while(rows.length&&source.length+prefix.length+rows.join('\n').length+suffix().length>12000){rows.pop();omitted++;}
 const text=source+prefix+rows.reverse().join('\n')+suffix();
 if(text.length>12000)throw Error('review_task_context_budget_exceeded');
 return text;
}
