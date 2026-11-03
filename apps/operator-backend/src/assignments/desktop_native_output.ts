import type {EvidenceScope} from '../evidence/evidence_ref.js';
import {createHash} from 'node:crypto';
import {storeEvidence} from '../evidence/evidence_store.js';
import {assertBoundedModelEvidencePayload,getEvidenceContextBudget,modelEvidenceEnvelope} from '../evidence/model_context_budget.js';

type NativeOutput = {success:boolean;contentItems:Array<
  {type:'inputText';text:string}|{type:'inputImage';imageUrl:string}>};

/** Only the already validated current catalog lookup calls this producer.
 * Generic MCP/control output retains its untrusted transport classification. */
export function boundDesktopNativeToolContract(contract:unknown,scope:EvidenceScope,callId:string):NativeOutput {
  const raw=JSON.stringify(contract),budget=getEvidenceContextBudget();
  if(Buffer.byteLength(raw,'utf8')<=budget.item_bytes)
    return boundDesktopNativeOutput({success:true,contentItems:[{type:'inputText',text:raw}]},scope,callId);
  const stored=storeEvidence({scope,source:'assignment_kernel_v2:desktop_native_tool_contract',
    media_type:'application/json',trust_level:'host_observed',verification_relevance:'supporting',raw,
    bounded_summary:'Current catalog documentation only; no execution authorization, native facts or completion proof. Read tool_documentation first. Omitted SDK annotations and the original schema remain retrievable by their explicit paths.'},budget.item_bytes);
  const result:NativeOutput={success:true,contentItems:[{type:'inputText',text:JSON.stringify(modelEvidenceEnvelope([stored.projection]))}]};
  assertBoundedModelEvidencePayload({type:'function_call_output',output:result.contentItems.map(item=>({type:'input_text',text:(item as any).text}))},budget);
  return result;
}

/** The native handler projects native evidence, then appends host control
 * context. That context (or documentation/error text) can itself exceed the
 * model item budget. Retain exact oversized text through the existing store;
 * transport retention never upgrades it to native or completion evidence. */
export function boundDesktopNativeOutput(result:NativeOutput,scope:EvidenceScope,callId:string):NativeOutput {
  const budget=getEvidenceContextBudget();
  const contentItems=result.contentItems.map((item,index)=>{
    if(item.type==='inputImage'&&typeof item.imageUrl==='string')return item;
    if(item.type!=='inputText'||typeof item.text!=='string')throw Error('desktop_native_content_invalid');
    const output={type:'function_call_output',output:item.text};
    try {assertBoundedModelEvidencePayload(output,budget);return item;}
    catch(error) {
      // Already valid projection envelopes stay byte-exact. A request-limit
      // failure must not be disguised by wrapping projections in projections.
      if(!(error instanceof Error)||!error.message.startsWith('Raw function_call_output exceeds '))throw error;
    }
    let mediaType='text/plain; charset=utf-8';
    try {JSON.parse(item.text);mediaType='application/json';}catch{}
    const stored=storeEvidence({scope,source:`desktop_native_transport:${callId}:${index}`,
      media_type:mediaType,trust_level:'untrusted_caller',verification_relevance:'supporting',
      bounded_summary:'Complete tool/control text retained. This transport copy is supporting context, not native verification or completion proof. Retrieve missing fields, including pending_verification and next_native_inspection, before acting.',
      raw:item.text},budget.item_bytes);
    // Scalar facts do not expose every nested control field. Explicitly mark
    // this transport presentation partial even when fact traversal succeeded.
    const projection={...stored.projection,truncated:true};
    return {type:'inputText' as const,text:JSON.stringify(modelEvidenceEnvelope([projection]))};
  });
  const deliveredImages=contentItems.filter(i=>i.type==='inputImage').map((i:any)=>{
    const m=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(i.imageUrl);
    const bytes=m?Buffer.from(m[2]!,'base64'):null;
    return bytes?.length&&bytes.toString('base64')===m![2]?{sha256:createHash('sha256').update(bytes).digest('hex'),media_type:m![1]}:null;
  }).filter(Boolean);
  if(deliveredImages.length)contentItems.push({type:'inputText',text:JSON.stringify({visual_inputs:deliveredImages,
    notice:'These pixels accompany this result as image inputs. Hashes identify delivered images, not their interpretation, model freshness or verified completion. Keep reference and model roles distinct.'})});
  // Keep the actual downstream guard and aggregate limits. Images remain
  // images, and raw context is never truncated or silently discarded.
  assertBoundedModelEvidencePayload({type:'function_call_output',output:contentItems.map(item=>
    item.type==='inputText'?{type:'input_text',text:item.text}:{type:'input_image',image_url:item.imageUrl})},budget);
  return {...result,contentItems};
}
