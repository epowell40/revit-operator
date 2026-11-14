import type {EvidenceRefV1} from './evidence_ref.js';

type Row=Record<string,unknown>;
const object=(v:unknown):v is Row=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fields=['id','found','uniqueId','className','category','name','typeId','boundingBox','location'];

/** Convenient selected fields from the existing native readback, not another
 * read, a geometry matcher, a complete inventory or task-verification fact. */
export function projectNativeCorrectionTargets(ref:EvidenceRefV1,payload:unknown,maxBytes:number):Row|null{
 if(ref.source!=='assignment_kernel_v2:revit_call_tool'||ref.trust_level!=='authoritative_native'||!object(payload)
  ||!Array.isArray(payload.result)||!payload.result.length||payload.result.length>4096
  ||!object(payload.nativeProgramEffectState)||payload.nativeProgramEffectState.scope!=='native_drafting_effect_state_v1')return null;
 const result=payload.result,state=payload.nativeProgramEffectState,ids=state.requestedElementIds;
 if(!Array.isArray(ids)||ids.length!==result.length||new Set(ids).size!==ids.length
  ||!ids.every(id=>Number.isSafeInteger(id)&&id>0)
  ||result.some(r=>!object(r)||!Number.isSafeInteger(r.id)||!ids.includes(r.id)||typeof r.found!=='boolean')
  ||new Set(result.map(r=>r.id)).size!==result.length)return null;
 const spatial=(r:Row)=>object(r.boundingBox)||object(r.location);
 const eligible=result.filter(spatial).length;if(!eligible)return null;
 const rows:Row[]=[];let next=0;
 const value=()=>({scope:'requested_element_ids_only',native_postcondition_verified:false,task_verified:false,
  rows,coverage:{source_rows:result.length,spatial_rows:eligible,returned_rows:rows.length,complete:false,
   source_rows_exhausted:next===result.length},
  retrieval:{evidence_id:ref.evidence_id,path:'result',fields,next_start:next===result.length?null:next},
  guidance:'Native identities, bounds and locations for correction only; omitted fields and all source rows remain in this same evidence. Use existing itemRange paging or typed scalar filters on the original result array. Coincident locations may have several valid identities: inspect all matches and use the intended observed UniqueId; do not assume one match or delete an arbitrary one. This table is not a whole-view census, complete curve-shape proof or execution authority.'});
 for(let i=0;i<result.length;i++){
  const row=result[i] as Row;next=i+1;if(!spatial(row))continue;
  const values=Object.fromEntries(fields.filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]]));
  rows.push({row_index:i,values,missing_fields:fields.filter(k=>!Object.hasOwn(row,k))});
  if(rows.length>16||Buffer.byteLength(JSON.stringify(value()),'utf8')>maxBytes){rows.pop();next=i;break;}
 }
 const projected=value();return rows.length&&Buffer.byteLength(JSON.stringify(projected),'utf8')<=maxBytes?projected:null;
}
