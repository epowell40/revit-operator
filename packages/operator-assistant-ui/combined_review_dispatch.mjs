import {normalizeVisualReviewRequest} from './visual_work_review.mjs';
import {normalizeCodeEvidenceIds,parseNativeCodeReview} from './native_code_review.mjs';

const argsOf=call=>typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// Only adjacent, explicitly requested reviews in one response are eligible.
// No persistent cache, native dispatch, new reviewer or completion authority.
export function createCombinedReviewDispatcher(outputs,{execute,assertControl,owner}) {
  const plans=new Map();
  const unique=id=>typeof id==='string'&&id.length>0&&outputs.filter(c=>c.call_id===id).length===1;
  for(let i=0;i<outputs.length-1;i++) {
    const visual=outputs[i],code=outputs[i+1];
    if(visual?.type!=='function_call'||code?.type!=='function_call'
      ||visual.name!=='review_current_work'||code.name!=='review_current_work'
      ||!unique(visual.call_id)||!unique(code.call_id))continue;
    try {
      const a=argsOf(visual),b=argsOf(code);
      if(!a||!b||!['independent',undefined].includes(a.review_mode)
        ||a.recheck_evidence_id!==undefined||a.complete_inspection_item_id!==undefined
        ||b.review_mode!=='code_execution'||Object.keys(b).some(k=>!['review_mode','code_evidence_ids'].includes(k)))continue;
      normalizeVisualReviewRequest(a);
      normalizeCodeEvidenceIds(b.code_evidence_ids);
      const ids=[...new Set([...(a.code_evidence_ids??[]),...b.code_evidence_ids])];
      normalizeCodeEvidenceIds(ids);
      const plan={visual,code,a:structuredClone(a),b:structuredClone(b),ids,result:null,binding:null};
      plans.set(visual.call_id,plan);plans.set(code.call_id,plan);i++;
    } catch {} // Malformed or oversized requests follow their original validators.
  }
  return async call=>{
    const plan=plans.get(call.call_id);
    if(!plan)return execute(call);
    const isVisual=call.call_id===plan.visual.call_id;
    // Do not apply a plan to changed provider arguments or a repeated dispatch.
    if(call.name!=='review_current_work'||!same(argsOf(call),isVisual?plan.a:plan.b))return execute(call);
    await assertControl();
    if(isVisual) {
      plans.delete(call.call_id);
      plan.binding=structuredClone(owner());
      const output=await execute({...call,arguments:JSON.stringify({...plan.a,code_evidence_ids:plan.ids})});
      const result=output.host_visual_work_review;
      if(result) {
        // Keep the same object: the existing image-delivery WeakMap owns it.
        result.request_composition={kind:'adjacent_requested_reviews',
          original_calls:[plan.visual,plan.code].map(c=>({call_id:c.call_id,arguments:argsOf(c)})),
          reviewed_code_evidence_ids:plan.ids};
        output.output=JSON.stringify(result);
        if(output.raw_evidence)output.raw_evidence.request_composition=result.request_composition;
      }
      plan.result=result;
      return output;
    }
    plans.delete(call.call_id);
    if(!same(plan.binding,owner()))throw Error('combined_review_owner_changed');
    const r=plan.result,packet=r?.raw_review_evidence?.executed_code;
    const base={schema:'operator.native_code_review.v1',authority:'supporting_code_assessment',
      request:plan.b,owner:plan.binding,native_postcondition_verified:false,whole_task_verified:false,
      request_composition:r?.request_composition,
      guidance:'Same combined observation as the adjacent visual review; no second reviewer call. The code verdict covers ALL listed reviewed calls together, not this subset separately. Native verification, persistence and task completion remain separate.'};
    let result;
    try {
      if(r?.ok!==true||!r.reviewer_response_id||!same(r.request?.code_evidence_ids,plan.ids)
        ||!Array.isArray(packet?.executions)||!same(packet.executions.map(x=>x.evidence_id),plan.ids))
        throw Error(r?.reason||'combined_review_unavailable');
      const codeReview=parseNativeCodeReview(r.code_review);
      result={...base,ok:true,state:codeReview.status,code_review:codeReview,reviewer_response_id:r.reviewer_response_id,
        reviewed_calls:packet.executions.map(({call_id,evidence_id,content_hash,source_sha256})=>({call_id,evidence_id,content_hash,source_sha256})),
        coverage:packet.coverage,raw_review_evidence:{packet,reviewer_response:r.raw_review_evidence.reviewer_response,
          shared_visual_call_id:plan.visual.call_id}};
    }catch(error){result={...base,ok:false,state:'unavailable',reason:error.message,
      raw_review_evidence:{shared_visual_call_id:plan.visual.call_id}};}
    const output={type:'function_call_output',call_id:call.call_id,output:JSON.stringify(result)};
    Object.defineProperties(output,{raw_evidence:{value:result},host_code_work_review:{value:result}});
    return output;
  };
}
