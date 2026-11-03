import {createHash} from 'node:crypto';

// Presentation only. The existing reader still authorizes the conversation,
// resolves the registered upload, checks its hash and reports actual coverage.
export function retainedPdfInput(attachment, context) {
  const ref=attachment?.backendAttachment;
  if (!context || typeof context.sessionId!=='string' || !context.sessionId
    || context.sessionId.length>300 || ref?.session_id!==context.sessionId
    || attachment?.isImage!==false || attachment.mime!=='application/pdf'
    || typeof attachment.filename!=='string' || !/\.pdf$/i.test(attachment.filename)
    || attachment.filename.length>260 || /[\x00-\x1f]/.test(attachment.filename)
    || ref.filename!==attachment.filename || ref.mime!=='application/pdf'
    || !/^[A-Za-z0-9_-]{1,160}$/.test(ref.id??'') || ref.id!==attachment.id
    || !/^artifacts\/uploads\/[^/\\:\x00-\x1f]+$/.test(ref.relative_path??'')
    || !/^[a-f0-9]{64}$/i.test(ref.sha256??'')
    || !Number.isSafeInteger(ref.bytes) || ref.bytes<=0 || ref.bytes>32*1024*1024
    || ref.bytes!==attachment.bytes || typeof attachment.dataBase64!=='string') return null;
  const reader=Array.isArray(context.tools)&&context.tools.find(t=>t?.type==='function'
    && t.name==='native__operator_read_attachment');
  const p=reader?.parameters?.properties;
  if (reader?.parameters?.type!=='object' || p?.attachment_id?.type!=='string'
    || p?.pages?.type!=='array' || p.pages.items?.type!=='integer'
    || p.pages.minItems!==1 || p.pages.maxItems!==3
    || !Array.isArray(p?.mode?.enum) || !p.mode.enum.includes('overview') || !p.mode.enum.includes('detail')) return null;
  // Check the bytes already held by the host; no filesystem/network operation.
  // Noncanonical/missing payloads retain the previous full-file path.
  const encoded=attachment.dataBase64;
  if(encoded.length>44739244 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.toString('base64')!==encoded || bytes.length!==ref.bytes
    || bytes.subarray(0,5).toString('ascii')!=='%PDF-'
    || createHash('sha256').update(bytes).digest('hex')!==ref.sha256.toLowerCase()) return null;
  return {type:'input_text',text:
    'RETAINED PDF — full original available through native__operator_read_attachment; binary pages are not eagerly included. '
    +'This source reference is not an inspection receipt. Read overview pages for navigation (start with page 1 if needed; the reader returns total page count), then detail for relevant comments, arrows and nearby symbols before edits. '
    +'Inspect every page needed for the whole request, including flattened marks; a partial page selection or text excerpt is not complete source review. '
    +'Use the reader\'s source hash, page numbers, coverage and crop transforms. Source pixels and labels are not model coordinates or write permission.\n'
    +JSON.stringify({attachment_id:ref.id,filename:ref.filename,sha256:ref.sha256.toLowerCase(),bytes:ref.bytes,original_access_verified:false})};
}

// Counts only: do not duplicate filenames, content, file bytes or image URLs in
// timing receipts. These are transport bytes, not provider token attribution.
export function summarizeInputEnvelope(input) {
  const result={messages:0,blocks:{},serialized_bytes:Buffer.byteLength(JSON.stringify(input??null)),provider_tokens:null};
  for(const message of Array.isArray(input)?input:[]) {
    result.messages++;
    for(const block of Array.isArray(message?.content)?message.content:[]) {
      const type=['input_text','input_image','input_file'].includes(block?.type)?block.type:'other';
      const row=result.blocks[type]??={count:0,serialized_bytes:0};
      row.count++;row.serialized_bytes+=Buffer.byteLength(JSON.stringify(block));
    }
  }
  return result;
}
