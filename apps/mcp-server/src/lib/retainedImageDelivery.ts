import {createHash} from 'node:crypto';

// Match the existing native capture limit. This is not a text/context budget.
export const MAX_RETAINED_IMAGE_BYTES = 5 * 1024 * 1024;
type Request = {evidenceId:string;sessionId:string;assignmentId?:string|null;runId?:string|null;attemptId?:string|null;generation?:number|null;maxBytes?:number};
const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};

/** Deliver the exact retained capture, not a recapture or a new verification.
 * Metadata preserves original trust/scope/hash; base64 belongs only in the MCP
 * image block, which the provider adapter turns into an actual image input. */
export function retainedImageDelivery(raw:unknown,request:Request){
 const response=object(raw),r=object(response.result),ref=object(r.evidence_ref),s=object(r.selection);
 const limit=request.maxBytes??MAX_RETAINED_IMAGE_BYTES;
 if(response.ok!==true||r.schema!=='revit-operator.evidence-retrieval.v1'||r.complete!==true
  ||ref.evidence_id!==request.evidenceId||ref.session_id!==request.sessionId||ref.assignment_id!==(request.assignmentId??null)
  ||Object.entries({run_id:request.runId,attempt_id:request.attemptId,generation:request.generation}).some(([k,v])=>v!=null&&ref[k]!==v)
  ||!['image/png','image/jpeg','image/webp','image/gif'].includes(s.media_type)||ref.media_type!==s.media_type
  ||!Number.isSafeInteger(limit)||limit<64||limit>MAX_RETAINED_IMAGE_BYTES
  ||!Number.isSafeInteger(ref.byte_count)||ref.byte_count<1||ref.byte_count>limit
  ||typeof s.data_base64!=='string'||s.data_base64.length>Math.ceil(MAX_RETAINED_IMAGE_BYTES/3)*4
  ||s.data_base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(s.data_base64))
  throw new Error('Retained image response has invalid media, size or evidence ownership. No image delivered.');
 const bytes=Buffer.from(s.data_base64,'base64'),hash='sha256:'+createHash('sha256').update(bytes).digest('hex');
 if(bytes.length!==ref.byte_count||bytes.toString('base64')!==s.data_base64||hash!==ref.content_hash)
  throw new Error('Retained image content hash/byte count does not match its evidence reference. No image delivered.');
 const metadata={ok:true,result:{schema:r.schema,evidence_ref:ref,selection:{media_type:s.media_type,image_delivered:true,decoded_bytes:bytes.length,content_hash:hash},complete:true,
  returned_bytes:r.returned_bytes,image_delivery:{available:true,scope:'exact_retained_pixels_not_current_state_or_verification'}}};
 const text=JSON.stringify(metadata);if(Buffer.byteLength(text)>16384)throw new Error('Retained image provenance exceeds its bounded metadata budget.');
 return {content:[{type:'text' as const,text},{type:'image' as const,data:s.data_base64,mimeType:s.media_type}]};
}
