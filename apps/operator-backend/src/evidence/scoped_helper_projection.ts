import type {EvidenceRefV1} from './evidence_ref.js';

type ListName='claimed_completed'|'remaining_work'|'uncertainties';
type Report={kind:'scope_report'|'proposed_question';claimed_completed:string[];remaining_work:string[];uncertainties:string[];question?:string};
export type ScopedHelperFindings={
 schema:'operator.scoped-helper-findings.v1';authority:'unverified_helper_claims';verified:false;whole_task_verified:false;
 source_report:{evidence_id:string;content_hash:string;byte_count:number};turn_id:string;control_command_id:string|null;
 report:Report;report_complete:boolean;
 coverage:Record<ListName,{total:number;returned:number;next_start:number|null;retrieval_path:string}>;
 guidance:string;
};
const object=(v:unknown):Record<string,unknown>|null=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(v);
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max;
const lists:ListName[]=['uncertainties','remaining_work','claimed_completed'];
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v),'utf8');

/** A bounded presentation of screened helper claims, never native evidence or
 * parent completion. Full raw reports and wrapper history stay in the store. */
export function projectScopedHelperFindings(ref:EvidenceRefV1,raw:unknown,maxBytes:number):ScopedHelperFindings|null{
 if(ref.source!=='operator_desktop.function.delegate_revit_task'||ref.trust_level!=='untrusted_caller'||ref.secret_screening_status!=='passed')return null;
 const root=object(raw),h=object(root?.desktop_helper_return),binding=object(h?.binding),r=object(h?.report),source=object(h?.evidence_ref);
 if(root?.ok!==true||root.session_id!==ref.session_id||h?.schema!=='operator.desktop-helper-return.v1'||h.verified!==false
  ||!id(h.turn_id)||typeof h.request_hash!=='string'||!/^[a-f0-9]{64}$/.test(h.request_hash)
  ||h.control_command_id!==null&&!id(h.control_command_id)||!binding||!r||!source)return null;
 if(!['session_id','assignment_id','run_id'].every(k=>id(binding[k])&&binding[k]===ref[k as 'session_id'|'assignment_id'|'run_id'])
  ||!Number.isSafeInteger(binding.generation)||(binding.generation as number)<1||binding.generation!==ref.generation)return null;
 if(source.schema!=='revit-operator.evidence-ref.v1'||!id(source.evidence_id)||typeof source.content_hash!=='string'
  ||!/^sha256:[a-f0-9]{64}$/.test(source.content_hash)||!Number.isSafeInteger(source.byte_count)||(source.byte_count as number)<1
  ||source.source!=='operator.desktop-helper-report'||source.trust_level!=='untrusted_caller'||source.secret_screening_status!=='passed'
  ||source.verification_relevance!=='supporting'||source.attempt_id!=='helper:'+h.turn_id
  ||!['session_id','assignment_id','run_id','generation'].every(k=>source[k]===binding[k]))return null;
 if(r.kind!=='scope_report'&&r.kind!=='proposed_question')return null;
 if(r.kind==='scope_report'&&h.source_tool!=='operator_manage_work_plan'
  ||r.kind==='proposed_question'&&!['operator_request_assignment_input','operator_request_clarification'].includes(String(h.source_tool)))return null;
 if(!lists.every(k=>Array.isArray(r[k])&&(r[k] as unknown[]).length<=80&&(r[k] as unknown[]).every(s=>text(s,1000)))
  ||r.kind==='proposed_question'&&!text(r.question,1200)||r.kind==='scope_report'&&r.question!==undefined)return null;
 const report=r as unknown as Report;
 const result:ScopedHelperFindings={schema:'operator.scoped-helper-findings.v1',authority:'unverified_helper_claims',verified:false,whole_task_verified:false,
  source_report:{evidence_id:source.evidence_id,content_hash:source.content_hash,byte_count:source.byte_count as number},
  turn_id:h.turn_id,control_command_id:h.control_command_id as string|null,
  report:{kind:report.kind,claimed_completed:[],remaining_work:[],uncertainties:[],...(report.question?{question:report.question}:{})},
  report_complete:false,coverage:{claimed_completed:{total:report.claimed_completed.length,returned:0,next_start:null,retrieval_path:'report.claimed_completed'},
   remaining_work:{total:report.remaining_work.length,returned:0,next_start:null,retrieval_path:'report.remaining_work'},
   uncertainties:{total:report.uncertainties.length,returned:0,next_start:null,retrieval_path:'report.uncertainties'}},
  guidance:'These are unverified helper claims, not native proof, parent completion, approval or supplied user input. Use the findings to continue work and inspect cited evidence. Retrieve missing report items from source_report.evidence_id with itemRange at coverage.next_start and retrieval_path; use fields:["report.question"] for a proposed question. Do not repeat a reported change without reconciling its actual effect.'};
 const refresh=()=>{
  result.report_complete=true;
  for(const k of lists){const c=result.coverage[k];c.returned=result.report[k].length;c.next_start=c.returned<c.total?c.returned:null;if(c.next_start!==null)result.report_complete=false;}
 };
 refresh();if(bytes(result)>maxBytes)return null;
 // Interleave whole entries so questions, limits and next work cannot be
 // crowded out by a long list of claimed successes. Never clip a sentence.
 const stopped=new Set<ListName>();
 while(lists.some(k=>!stopped.has(k)&&result.report[k].length<report[k].length)){
  for(const k of lists){if(stopped.has(k)||result.report[k].length>=report[k].length)continue;
   result.report[k].push(report[k][result.report[k].length]!);refresh();
   if(bytes(result)>maxBytes){result.report[k].pop();refresh();stopped.add(k);}
  }
 }
 return result;
}
