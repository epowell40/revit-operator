import {parseEvidenceRetrievalSelectorV1,assertScalarEvidencePageV1,assertEvidenceTextRangePageV1} from './index.js';

const fieldsSchema={type:'array',minItems:1,maxItems:64,items:{type:'string',minLength:1,maxLength:512}};
const scalarFiltersSchema={type:'array',minItems:1,maxItems:8,items:{type:'object',additionalProperties:false,required:['field','op','value'],properties:{field:{type:'string',minLength:1,maxLength:512},op:{type:'string',enum:['eq','ne','lt','lte','gt','gte']},value:{anyOf:[{type:'string',maxLength:512},{type:'number'},{type:'boolean'},{type:'null'}]}}}};
const numericOrderSchema={type:'object',additionalProperties:false,required:['field','direction'],properties:{field:{type:'string',minLength:1,maxLength:512},direction:{type:'string',enum:['asc','desc']}}};
// Preserve omitted selector alternatives through Responses schema normalization.
// Host validation below still enforces exactly one bounded selector.
export const FOCUSED_EVIDENCE_TOOL_V1={type:'function',strict:false,name:'operator_retrieve_evidence',description:
  'Read a focused, byte-bounded selection from one retained evidence_id in the current task. The host supplies session, assignment, run and generation; never supply scope. '+
  'Use fields:["assistant_message"] to read a complete narrative helper handoff when only its diagnostic prefix was shown. Read structured helper_findings first when present; do not repeat model work just to recover clipped findings. '+
  'Supply exactly one of fields, itemRange, textRange or targetSubset; omit the other selector properties entirely. Never fill unused selectors with placeholders. Field selections use exact paths as selection keys; missing_fields distinguishes absence from null. complete is artifact-wide and false does not mean a selected field was clipped. '+
  'For array pages continue at pagination.next_start; selected-field rows use row_index, values and missing_fields. Targets must be exact reviewed identities. The byte budget counts JSON-encoded UTF-8, including escaping, so a textRange shorter than maxBytes can still exceed it. On refusal use the recommended shorter length at the same start, or narrower leaf fields/selected-field array pages; do not repeat the unchanged request. '+
  'Optional itemRange.filters (1..8 AND typed scalar eq/ne/lt/lte/gt/gte predicates) and orderBy (finite numeric field, asc/desc, unavailable last, stable original ties) require fields and at most5000 retained rows. Non-null comparisons require matching scalar types; missing/nonfinite values never match. eq:null/ne:null test actual null/non-null scalars, not missing fields. These discovery projections remain complete:false/source_rows_exhausted:false. row_index is the original index; start/next_start count selected ranks. pagination.selection_query separates source/match counts, unavailable values and selected_rows_exhausted. Confirm candidate size/identity with current native reads; selection is not native collection/absence proof. '+
  'For a long text leaf such as native_outcome.program_result use textRange:{path:"native_outcome.program_result",start:0,length:4096}. Its offsets count decoded UTF-8 bytes within that string; continue at text_pagination.next_start. This avoids rerunning C# merely to recover already stored results. Field pages always have complete:false; field_complete concerns only that text, never model/collection completeness. Omit path to retain raw-artifact textRange behavior. '+
  'This text/JSON read does not dispatch Revit work, change task status, prove a native postcondition or certify completion. Use the retained content as supporting findings; perform required native and visual checks.',
  parameters:{type:'object',additionalProperties:false,required:['evidenceId','purpose'],properties:{
    evidenceId:{type:'string',pattern:'^ev1_[A-Za-z0-9_-]{32}$'},purpose:{type:'string',minLength:1,maxLength:300},
    fields:fieldsSchema,
    itemRange:{type:'object',additionalProperties:false,required:['path','start','count'],properties:{path:{type:'string',minLength:1,maxLength:512},start:{type:'integer',minimum:0},count:{type:'integer',minimum:1,maximum:256},fields:fieldsSchema,filters:scalarFiltersSchema,orderBy:numericOrderSchema}},
    textRange:{type:'object',additionalProperties:false,required:['start','length'],properties:{path:{type:'string',minLength:1,maxLength:512},start:{type:'integer',minimum:0},length:{type:'integer',minimum:1,maximum:4096}}},
    targetSubset:{type:'array',minItems:1,maxItems:64,items:{type:'string',minLength:1,maxLength:160}},
    maxBytes:{type:'integer',minimum:64,maximum:4096,description:'Focused text/JSON selection budget; defaults to4096. The full model-facing result must fit the existing8192-byte item limit.'}
  }}};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(v);
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)).byteLength;
/** Preserve a bounded read refusal instead of projecting its recovery hint
 * into a clipped diagnostic. Call after retaining the ordinary error evidence.
 * This does not retry the read or turn an error into evidence of model state. */
export function focusedEvidenceFailureOutputV1(toolCall,functionOutput){
  if(toolCall?.name!=='operator_retrieve_evidence'||functionOutput?.type!=='function_call_output'
    ||typeof toolCall.call_id!=='string'||toolCall.call_id!==functionOutput.call_id||typeof functionOutput.output!=='string')return null;
  let result;try{result=JSON.parse(functionOutput.output);}catch{return null;}
  if(!object(result)||Object.keys(result).some(k=>!['ok','error','recoverable'].includes(k))
    ||result.ok!==false||result.recoverable!==true||typeof result.error!=='string'||!result.error
    ||bytes(result)>4096)return null;
  return {type:'function_call_output',call_id:functionOutput.call_id,output:JSON.stringify({...result,
    read_only:true,native_postcondition_verified:false,whole_task_verified:false})};
}
function owner(value){
  if(!object(value)||value.kernel_version!==undefined&&value.kernel_version!==2)throw Error('focused_evidence_current_binding_required');
  const assignment=value.assignment_id??value.goal_id;
  if(value.assignment_id&&value.goal_id&&value.assignment_id!==value.goal_id)throw Error('focused_evidence_binding_changed');
  if(![assignment,value.session_id,value.run_id].every(id)||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('focused_evidence_current_binding_required');
  return {assignment_id:assignment,session_id:value.session_id,run_id:value.run_id,generation:value.generation,
    principal_id:value.principal_id??null,document_fingerprint:value.document_fingerprint??null};
}
const scopeKeys=['assignment_id','session_id','run_id','generation'];
const sameOwner=(a,b)=>[...scopeKeys,'principal_id','document_fingerprint'].every(k=>a[k]===b[k]);


/** Only the host's current-owner callback supplies scope. Storage performs its
 * ordinary immutable-byte/hash and selector checks; the client additionally
 * refuses a foreign or late response. No native dispatch or task-state write. */
export async function retrieveFocusedEvidenceV1(currentOwner,args,request){
  if(typeof currentOwner!=='function'||typeof request!=='function')throw Error('focused_evidence_host_required');
  const binding=owner(currentOwner());
  if(!object(args)||Object.keys(args).some(k=>!['evidenceId','purpose','fields','itemRange','textRange','targetSubset','maxBytes'].includes(k))
    ||typeof args.evidenceId!=='string'||!/^ev1_[A-Za-z0-9_-]{32}$/.test(args.evidenceId)
    ||typeof args.purpose!=='string'||!args.purpose.trim()||args.purpose.length>300||/[\u0000-\u001f]/.test(args.purpose)
    ||/^(?:all|all evidence|everything|dump all evidence)$/i.test(args.purpose.trim())
    ||args.maxBytes!==undefined&&(!Number.isSafeInteger(args.maxBytes)||args.maxBytes<64||args.maxBytes>4096))throw Error('focused_evidence_request_invalid');
  for(const [key,keys]of [['itemRange',['path','start','count','fields','filters','orderBy']],['textRange',['path','start','length']]]){
    if(Object.hasOwn(args,key)&&(!object(args[key])||Object.keys(args[key]).some(k=>!keys.includes(k))))throw Error('focused_evidence_selector_invalid');
  }
  const names={fields:'fields',itemRange:'item_range',textRange:'text_range',targetSubset:'target_subset'};
  const input=Object.fromEntries(Object.entries(names).filter(([k])=>Object.hasOwn(args,k)).map(([k,v])=>[v,args[k]]));
  const {kind:_kind,...selector}=parseEvidenceRetrievalSelectorV1(input);
  const maxBytes=args.maxBytes??4096;
  if(selector.text_range?.length>maxBytes)throw Error('focused_evidence_text_range_exceeds_budget');
  const body={schema:'revit-operator.evidence-retrieval.v1',evidence_id:args.evidenceId,
    scope:Object.fromEntries(scopeKeys.map(k=>[k,binding[k]])),purpose:args.purpose.trim(),...selector,max_bytes:maxBytes};
  const response=await request('/evidence/retrieve',{method:'POST',body:JSON.stringify(body)});
  if(!sameOwner(binding,owner(currentOwner())))throw Error('focused_evidence_binding_changed');
  if(response?.ok!==true)throw Error(typeof response?.error==='string'?response.error:'focused_evidence_read_failed');
  assertScalarEvidencePageV1(selector,response);
  const result=response.result,ref=result?.evidence_ref;
  if(!object(result)||result.schema!=='revit-operator.evidence-retrieval.v1'||!object(ref)
    ||ref.schema!=='revit-operator.evidence-ref.v1'||ref.evidence_id!==body.evidence_id
    ||!scopeKeys.every(k=>ref[k]===binding[k])||ref.secret_screening_status!=='passed'
    ||typeof ref.content_hash!=='string'||!/^sha256:[a-f0-9]{64}$/.test(ref.content_hash)
    ||!Number.isSafeInteger(ref.byte_count)||ref.byte_count<0||typeof result.complete!=='boolean'
    ||!Object.hasOwn(result,'selection')||result.selection===undefined||!Number.isSafeInteger(result.returned_bytes)
    ||result.returned_bytes!==bytes(result.selection)||result.returned_bytes>maxBytes)throw Error('focused_evidence_response_invalid');
  // The full ref can carry a large derived fact index. Retain it for the host's
  // audit, but do not resend that index to read one selected field. The model
  // gets the exact source identity and explicit metadata omissions, not a
  // different or shortened selected value masquerading as the original.
  assertEvidenceTextRangePageV1(selector,response);
  const {evidence_ref:_ref,...selected}=result;
  const identityKeys=['evidence_id','content_hash','byte_count','media_type','source','trust_level','session_id',
    'assignment_id','run_id','attempt_id','generation','redaction_status','secret_screening_status','created_at_utc','verification_relevance'];
  const source_identity={schema:'operator.evidence-source-identity.v1',...Object.fromEntries(identityKeys.filter(k=>Object.hasOwn(ref,k)).map(k=>[k,ref[k]])),
    omitted_metadata_fields:Object.keys(ref).filter(k=>k!=='schema'&&!identityKeys.includes(k))};
  const output={ok:true,schema:'operator.focused-evidence-read.v1',authority:'supporting_retained_evidence',read_only:true,
    native_postcondition_verified:false,whole_task_verified:false,source_identity,result:selected};
  if(bytes(output)>8192)throw Error('focused_evidence_output_budget_exceeded: select fewer fields/rows or a shorter text range.');
  return {model_output:output,evidence_ref:ref};
}
