import type {EvidenceRefV1} from './evidence_ref.js';

type Row=Record<string,unknown>;
const object=(v:unknown):v is Row=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fields=['id','found','uniqueId','className','category','name','typeId','boundingBox','location'];
const xyz=(v:unknown):v is number[]=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
const ordered=(min:number[],max:number[])=>min.every((n,i)=>n<=max[i]!);
function validExtent(v:any,count:number):boolean{
 return object(v)&&Object.keys(v).length===4&&v.scope==='navigation_only'&&v.source_rows===count
  &&xyz(v.min)&&xyz(v.max)&&ordered(v.min,v.max);
}
// Aggregate ALL returned targets before paging. These bounds only select an
// observation region; they do not establish shape, connectivity or completion.
function spatialExtent(rows:Row[]):Row|null{
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
 for(const row of rows){
  if(row.found!==true||typeof row.uniqueId!=='string'||!row.uniqueId.trim())return null;
  const b=row.boundingBox,l=row.location;let lo:unknown[],hi:unknown[];
  if(object(b)){
   if(!object(b.min)||!object(b.max))return null;
   lo=['x','y','z'].map(k=>(b.min as Row)[k]);hi=['x','y','z'].map(k=>(b.max as Row)[k]);
  }else if(object(l)&&l.type==='point')lo=hi=['x','y','z'].map(k=>l[k]);
  else return null;
  if(!xyz(lo)||!xyz(hi)||!ordered(lo,hi))return null;
  for(let i=0;i<3;i++){min[i]=Math.min(min[i]!,lo[i]!);max[i]=Math.max(max[i]!,hi[i]!);}
 }
 return {scope:'navigation_only',source_rows:rows.length,min,max};
}

/** Repage only the optional correction table in a model-only copy. The raw
 * readback and all native effects/controls remain retained and unchanged.
 * Never infer read-only authority from a null effect or drop unknown fields. */
export function reduceNativeCorrectionPage(p:any):any|null{
 const exact=(v:any,keys:string[])=>object(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
 const v=p?.inline_payload,c=v?.coverage,r=v?.retrieval;
 if(!object(p)||p.schema!=='revit-operator.evidence-projection.v1'
  ||p.source!=='assignment_kernel_v2:revit_call_tool'||p.trust_level!=='authoritative_native'
  ||p.effect_state!==null||p.before_hash!==null||p.after_hash!==null
  ||typeof p.evidence_id!=='string'||!/^ev1_[A-Za-z0-9_-]+$/.test(p.evidence_id)
  ||p.artifact_ref!==p.evidence_id||typeof p.content_hash!=='string'||!/^sha256:[a-f0-9]{64}$/.test(p.content_hash)
  ||!object(p.retrieval)||p.retrieval.tool_name!=='operator_retrieve_evidence'
  ||!exact(v,['scope','native_postcondition_verified','task_verified','rows','coverage','retrieval','guidance',...(Object.hasOwn(v??{},'spatial_extent')?['spatial_extent']:[])])
  ||v.scope!=='requested_element_ids_only'||v.native_postcondition_verified!==false||v.task_verified!==false
  ||typeof v.guidance!=='string'||!Array.isArray(v.rows)||v.rows.length<2||v.rows.length>16
  ||!exact(c,['source_rows','spatial_rows','returned_rows','complete','source_rows_exhausted'])
  ||c.complete!==false||typeof c.source_rows_exhausted!=='boolean'
  ||![c.source_rows,c.spatial_rows,c.returned_rows].every(n=>Number.isSafeInteger(n)&&n>0)
  ||c.source_rows>4096||c.spatial_rows>c.source_rows||c.returned_rows>c.spatial_rows||c.returned_rows!==v.rows.length
  ||(Object.hasOwn(v,'spatial_extent')&&(!validExtent(v.spatial_extent,c.source_rows)||c.spatial_rows!==c.source_rows))
  ||!exact(r,['evidence_id','path','fields','next_start'])||r.evidence_id!==p.evidence_id||r.path!=='result'
  ||JSON.stringify(r.fields)!==JSON.stringify(fields)
  ||(c.source_rows_exhausted?r.next_start!==null:!Number.isSafeInteger(r.next_start)||r.next_start<0||r.next_start>=c.source_rows))return null;
 let previous=-1;const ids=new Set();
 for(const row of v.rows){
  if(!exact(row,['row_index','values','missing_fields'])||!Number.isSafeInteger(row.row_index)
   ||row.row_index<=previous||row.row_index>=c.source_rows||!object(row.values)
   ||!Object.keys(row.values).every(k=>fields.includes(k))||!Array.isArray(row.missing_fields)
   ||JSON.stringify(row.missing_fields)!==JSON.stringify(fields.filter(k=>!Object.hasOwn(row.values,k)))
   ||!Number.isSafeInteger(row.values.id)||row.values.id<=0||ids.has(row.values.id)||typeof row.values.found!=='boolean'
   ||(!object(row.values.boundingBox)&&!object(row.values.location)))return null;
  previous=row.row_index;ids.add(row.values.id);
 }
 if(r.next_start!==null&&r.next_start<=previous)return null;
 const rows=v.rows.slice(0,-1);
 return {...p,truncated:true,additional_evidence:true,inline_payload:{...v,rows,
  coverage:{...c,returned_rows:rows.length,source_rows_exhausted:false},
  retrieval:{...r,next_start:v.rows.at(-1).row_index}}};
}

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
 const extent=spatialExtent(result as Row[]);
 const rows:Row[]=[];let next=0;
 const value=()=>({scope:'requested_element_ids_only',native_postcondition_verified:false,task_verified:false,
  ...(extent?{spatial_extent:extent}:{}),rows,coverage:{source_rows:result.length,spatial_rows:eligible,returned_rows:rows.length,complete:false,
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
