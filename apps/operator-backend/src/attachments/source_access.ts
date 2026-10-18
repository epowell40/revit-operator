import path from 'node:path';

export type AttachmentSourceAccess = {
 schema:'operator.attachment-source-access.v1';
 attachment_id:string; filename:string; source_sha256:string;
 original_access_verified:false;
 inspection_hint:{method:'POST';path:'/revit/inspect-excel-source';body:{sourcePath:string;section:'worksheets';expectedSourceSha256:string}};
 guidance:string;
};

/** A source-location hint, never execution authority or an inspection receipt. */
export function buildAttachmentSourceAccess(value:unknown):AttachmentSourceAccess|undefined {
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 const input=value as Record<string,unknown>;
 const id=typeof input.id==='string'?input.id.trim():'';
 const relative=typeof input.relative_path==='string'?input.relative_path.trim().replace(/\\/g,'/'):'';
 const digest=typeof input.sha256==='string'?input.sha256.trim().toLowerCase():'';
 const filename=typeof input.filename==='string'?input.filename.trim():path.posix.basename(relative);
 if(!id||id.length>256||!filename||filename.length>256||!/^artifacts\//.test(relative)||relative.length>520||
  /[:\0\r\n]/.test(relative)||relative.split('/').some(p=>p===''||p==='.'||p==='..')||
  path.posix.extname(relative).toLowerCase()!=='.xlsx'||path.posix.extname(filename).toLowerCase()!=='.xlsx'||!(/^[0-9a-f]{64}$/).test(digest))return undefined;
 return {schema:'operator.attachment-source-access.v1',attachment_id:id,filename,source_sha256:digest,original_access_verified:false,
  inspection_hint:{method:'POST',path:'/revit/inspect-excel-source',body:{sourcePath:relative,section:'worksheets',expectedSourceSha256:digest}},
  guidance:'This is an original-file reference, not proof the current executor has read it. Use the available source inspector to discover actual worksheet names, then inspect the requested output sheet and retain its source hash. A provider-parsed preview does not verify original formulas, cached values, errors or layout. Keep cached empty strings, missing results and error cells distinct. Do not substitute project/model observations for source inspection or claim the original is unavailable without checking this retained reference. This metadata grants no recalculation or model-write authority; current user authorization governs any subsequent requested import or model work.'};
}
