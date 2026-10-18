import {readAuthoritativeEvidence,readEvidenceRef} from './evidence_store.js';
import type {EvidenceScope} from './evidence_ref.js';

/** Scoped host retrieval, not a verifier verdict. The desktop must also bind
 * this id/hash to its own successful review tool receipt before using pixels.
 * Caller-submitted source labels alone do not confer review provenance. */
export function readVisualReviewBaseline(input: {scope:EvidenceScope;evidence_id:string;content_hash:string}) {
  const scope=input?.scope;
  if(!scope?.session_id||!scope.assignment_id||!scope.run_id||!Number.isSafeInteger(scope.generation)||(scope.generation??0)<1)throw Error('visual_review_baseline_scope_required');
  const ref=readEvidenceRef(input.evidence_id);
  if(ref.source!=='operator_desktop.function.review_current_work'||ref.content_hash!==input.content_hash||ref.byte_count>8*1024*1024)throw Error('visual_review_baseline_receipt_invalid');
  const bytes=readAuthoritativeEvidence(ref,scope),raw=JSON.parse(bytes.toString('utf8'));
  if(raw?.schema!=='operator.visual_work_review.v1'||raw.ok!==true||!['matched','mismatch','uncertain'].includes(raw.state)
    ||raw.authority!=='supporting_visual_assessment'||raw.native_postcondition_verified!==false||raw.whole_task_verified!==false)throw Error('visual_review_baseline_not_accepted');
  const image=(expected:any)=>{
    const r=readEvidenceRef(expected?.evidence_id);
    if(!['image/png','image/jpeg'].includes(r.media_type)||r.byte_count<1||r.byte_count>5*1024*1024||r.content_hash!==expected.content_hash)throw Error('visual_review_baseline_image_invalid');
    const pixels=readAuthoritativeEvidence(r,scope);
    return {evidence_ref:r,image_url:`data:${r.media_type};base64,${pixels.toString('base64')}`,...(expected.filename?{filename:expected.filename}:{})};
  };
  const review=Object.fromEntries(['schema','ok','state','authority','native_postcondition_verified','whole_task_verified','owner','request','location','capture','reference','capture_resolution'].map(k=>[k,raw[k]]));
  if(Buffer.byteLength(JSON.stringify(review),'utf8')>24000)throw Error('visual_review_baseline_metadata_too_large');
  return {evidence_ref:ref,review,capture:image(raw.capture),reference:raw.reference?image(raw.reference):null};
}
