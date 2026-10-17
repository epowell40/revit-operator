import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {readAuthoritativeEvidence,readEvidenceRef} from '../evidence/evidence_store.js';
import {canonicalJsonV2,sameAssignmentBindingV2,type AssignmentSnapshotV2,type OperationV2,type OperationResultV2} from '../domain/assignment-kernel/index.js';
import {nativePropertyReadIsFreshNativeV2} from '../assignments/native_observation_inputs_v2.js';

type Row=Record<string,any>;
const row=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const id=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const label=(v:unknown)=>typeof v==='string'?v.trim().toLowerCase():'';
const body=(v:unknown)=>{const r=row(v);return row(r.body??v);};
const kinds:Record<string,string>={regular:'regular',material_takeoff:'material_takeoff',material:'material_takeoff',takeoff:'material_takeoff',key:'key',key_schedule:'key',keynote_legend:'keynote_legend',keynote:'keynote_legend',legend:'keynote_legend',multi_category:'multi_category',multicategory:'multi_category',sheet_list:'sheet_list',view_list:'view_list',clone:'clone'};
const allowed=['name','scheduleName','category','categoryName','kind','sourceScheduleId','sourceQuery','sourceExact','fields','addFields','includeLinkedFiles','reuseIfExists','dryRun','filterBySheet','placeOnActiveSheet','placeOnActiveSheetX','placeOnActiveSheetY','placeOnSheet'];
function request(v:unknown){
 let b=body(v);const path=row(v).path;
 if(path==='/revit/duplicate-view'){
  if(!id(b.viewId)||b.withDetailing===true||b.withDetailing!==undefined&&typeof b.withDetailing!=='boolean'
   ||Object.keys(b).some(k=>!['viewId','newName','withDetailing'].includes(k)))return null;
  b={name:b.newName,kind:'clone',sourceScheduleId:b.viewId};
 }else if(path!==undefined&&path!=='/revit/create-schedule')return null;
 const kind=kinds[label(b.kind??'regular').replace(/[- ]/g,'_')],name=b.name??b.scheduleName,fields=b.addFields??b.fields??[];
 if(!kind||typeof name!=='string'||!name.trim()||name.length>240||Object.keys(b).some(k=>!allowed.includes(k))
  ||b.dryRun===true||!Array.isArray(fields)||fields.length>200||fields.some(f=>typeof f!=='string'||!f.trim()||f.length>240)
  ||['category','categoryName','sourceQuery'].some(k=>b[k]!==undefined&&(typeof b[k]!=='string'||!b[k].trim()))
  ||kind==='clone'&&(b.sourceScheduleId!==undefined&&!id(b.sourceScheduleId)||b.sourceScheduleId===undefined&&!label(b.sourceQuery))
  ||kind!=='clone'&&['sourceScheduleId','sourceQuery','sourceExact'].some(k=>b[k]!==undefined)
  ||['includeLinkedFiles','filterBySheet','reuseIfExists','sourceExact','placeOnActiveSheet','dryRun'].some(k=>b[k]!==undefined&&typeof b[k]!=='boolean'))return null;
 return {body:b,kind,name:name.trim(),fields:[...new Map(fields.map(f=>[label(f),String(f).trim()])).values()]};
}
function identity(v:unknown){const r=row(v);return r.schema==='operator.schedule_definition_identity.v1'&&r.complete===true&&id(r.id)
 &&typeof r.uniqueId==='string'&&!!r.uniqueId&&typeof r.name==='string'&&!!r.name&&r.isTemplate===false
 &&Number.isSafeInteger(r.categoryId)&&Object.values(kinds).includes(r.kind)&&r.kind!=='clone'?r:null;}
function signature(v:unknown){const r=row(v),d=row(r.definition);return r.schema==='operator.schedule_definition_snapshot.v1'&&r.complete===true
 &&r.scope==='flat_definition_without_calculated_fields'&&identity(r.identity)
 &&Array.isArray(d.fields)&&d.fields.length<=200&&d.fields.every((f:any,i:number)=>f.index===i&&typeof f.name==='string'&&typeof f.hidden==='boolean'
  &&Number.isSafeInteger(f.parameterId)&&Number.isFinite(f.gridWidth)&&Number.isFinite(f.sheetWidth)&&row(f.format).useDefault!==undefined)
 &&Array.isArray(d.filters)&&d.filters.length<=8&&d.filters.every((f:any)=>Number.isSafeInteger(f.fieldIndex)&&f.fieldIndex>=0&&f.fieldIndex<d.fields.length&&typeof f.op==='string'&&Object.hasOwn(f,'value'))
 &&Array.isArray(d.sort)&&d.sort.length<=4&&d.sort.every((f:any)=>Number.isSafeInteger(f.fieldIndex)&&f.fieldIndex>=0&&f.fieldIndex<d.fields.length&&typeof f.order==='string')
 &&Array.isArray(d.tableStyles)&&d.tableStyles.length<=256&&d.tableStyles.every((style:any)=>Object.keys(row(style.values)).length>0&&Object.keys(row(style.overrides)).length>0)
 &&Array.isArray(d.table)&&d.table.length===2&&d.table.every((s:any,i:number)=>s.section===['Header','Body'][i]
  &&Number.isSafeInteger(s.NumberOfRows)&&s.NumberOfRows>=0&&Number.isSafeInteger(s.NumberOfColumns)&&s.NumberOfColumns>=0&&s.NumberOfRows*s.NumberOfColumns<=16384
  &&Array.isArray(s.rows)&&s.rows.length===s.NumberOfRows&&s.rows.every((r:any)=>Number.isSafeInteger(r.row)&&Number.isFinite(r.heightFeet)&&r.heightFeet>=0
   &&Array.isArray(r.cells)&&r.cells.length===s.NumberOfColumns&&r.cells.every((c:any)=>Number.isSafeInteger(c.column)&&typeof c.text==='string'
    &&Number.isSafeInteger(c.styleIndex)&&c.styleIndex>=0&&c.styleIndex<d.tableStyles.length
    &&['Top','Left','Bottom','Right'].every(k=>Number.isSafeInteger(c[k])))))
 &&typeof d.IsItemized==='boolean'&&Number.isSafeInteger(d.templateId)&&Object.hasOwn(d,'phaseId')&&Object.hasOwn(d,'phaseFilterId')&&Object.keys(row(d.appearance)).length===11?r:null;}
function committed(input:unknown,payload:unknown,affected:readonly string[]){
 const wanted=request(input),a=row(payload),tx=row(a.transaction),meta=identity(a.definitionIdentity);
 if(!wanted||!meta||a.status!=='Success'||a.success!==true||a.applied!==true||a.created!==true||a.viewId!==meta.id
  ||row(input).path==='/revit/duplicate-view'&&(a.sourceViewType!=='Schedule'||a.sourceViewId!==wanted.body.sourceScheduleId)
  ||tx.status!=='committed'||tx.committed!==true||tx.pending===true||tx.rolled_back===true||a.dryRun===true
  ||!Array.isArray(tx.added_element_ids)||!tx.added_element_ids.includes(meta.id)||!Array.isArray(tx.deleted_element_ids)||tx.deleted_element_ids.length
  ||!affected.includes('element_id:'+meta.id))return null;
 return {wanted,applied:a,meta};
}
export type CreatedScheduleComparisonV2={state:'matched'|'mismatch'|'incomplete'|'unavailable';reason:string;differences:{subject:string;expected:string[];observed:string[];values_clipped?:boolean}[];omitted:number};
function definitionDifferences(expected:unknown,observed:unknown){
 const differences:CreatedScheduleComparisonV2['differences']=[];let count=0;
 const equal=(a:unknown,b:unknown)=>canonicalJsonV2([a])===canonicalJsonV2([b]);
 function visit(a:unknown,b:unknown,path:string,depth:number){
  if(equal(a,b))return;
  if(depth<12&&a!==null&&b!==null&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){
   const left=a as Row,right=b as Row;for(const key of [...new Set([...Object.keys(left),...Object.keys(right)])].sort())visit(left[key],right[key],path+'.'+key,depth+1);return;
  }
  count++;if(differences.length>=8)return;
  const text=(v:unknown)=>typeof v==='object'?JSON.stringify(v):String(v),left=text(a),right=text(b);
  differences.push({subject:'schedule.clone'+path,expected:[left.slice(0,256)],observed:[right.slice(0,256)],
   ...(left.length>256||right.length>256?{values_clipped:true}:{})});
 }
 visit(expected,observed,'',0);return {differences,omitted:Math.max(0,count-differences.length)};
}
/** A finite native definition check, never an apply echo or a placement claim. */
export function createdScheduleReadbackComparisonV2(input:unknown,applied:unknown,readInput:unknown,payload:unknown,affected:readonly string[]):CreatedScheduleComparisonV2 {
 const empty=(state:CreatedScheduleComparisonV2['state'],reason:string):CreatedScheduleComparisonV2=>({state,reason,differences:[],omitted:0});
 const c=committed(input,applied,affected);if(!c)return empty('unavailable','native_created_schedule_receipt_unavailable');
 const {wanted,meta}=c,b=wanted.body,r=row(payload),read=row(readInput),rb=body(readInput),actual=identity(r.definitionIdentity),schedule=row(r.schedule);
 if(read.method!=='POST'||read.path!=='/revit/schedules'||rb.action!=='detail'||rb.scheduleId!==meta.id||rb.includeFields===false
  ||r.status!=='Ok'||r.action!=='detail'||r.error||r.ok===false||r.isError===true||r.truncated===true||r.dryRun===true||!actual
  ||schedule.id!==meta.id||actual.id!==meta.id||schedule.uniqueId!==actual.uniqueId||schedule.name!==actual.name||schedule.isTemplate!==false||schedule.viewType!=='Schedule')return empty('unavailable','exact_native_schedule_detail_required');
 const differences:CreatedScheduleComparisonV2['differences']=[];
 let omitted=0;
 const compare=(subject:string,expected:unknown,observed:unknown)=>{if(canonicalJsonV2([expected])!==canonicalJsonV2([observed]))differences.push({subject,expected:[String(expected)],observed:[String(observed)]});};
 compare('schedule.uniqueId',meta.uniqueId,actual.uniqueId);compare('schedule.name',wanted.name,actual.name);compare('schedule.categoryId',meta.categoryId,actual.categoryId);
 if(!Array.isArray(r.fields)||r.fields.length!==schedule.fieldCount||r.fields.length>200||r.fields.some((f:any,i:number)=>f.index!==i||f.readable===false||typeof f.name!=='string'||typeof f.isHidden!=='boolean'))return empty('incomplete','complete_native_field_inventory_required');
 if(wanted.kind==='clone'){
  if(rb.includeDefinitionSnapshot!==true)return empty('incomplete','explicit_definition_snapshot_read_required');
  const source=signature(c.applied.sourceDefinitionBefore),created=signature(r.definitionSnapshot);
  if(!source||!created)return empty('incomplete','complete_preclone_source_and_independent_definition_required');
  if(canonicalJsonV2(created.identity)!==canonicalJsonV2(actual))return empty('unavailable','inconsistent_native_definition_identity');
  if(created.definition.fields.length!==r.fields.length||created.definition.fields.some((f:any,i:number)=>label(f.name)!==label(r.fields[i].name)||f.hidden!==r.fields[i].isHidden))return empty('unavailable','inconsistent_native_field_inventory');
  if(source.identity.kind==='view_list')return empty('incomplete','view_list_clone_membership_requires_separate_check');
  if(source.identity.id===meta.id||source.identity.uniqueId===meta.uniqueId||id(b.sourceScheduleId)&&source.identity.id!==b.sourceScheduleId
   ||b.sourceQuery!==undefined&&(typeof b.sourceQuery!=='string'||!b.sourceQuery.trim()||(b.sourceExact?label(source.identity.name)!==label(b.sourceQuery):!label(source.identity.name).includes(label(b.sourceQuery)))))return empty('unavailable','clone_source_identity_mismatch');
  compare('schedule.kind',source.identity.kind,actual.kind);compare('schedule.categoryId',source.identity.categoryId,actual.categoryId);
  if(wanted.fields.some(name=>!source.definition.fields.some((f:any)=>label(f.name)===label(name)))
   ||b.includeLinkedFiles!==undefined&&b.includeLinkedFiles!==source.identity.includeLinkedFiles
   ||b.filterBySheet!==undefined&&b.filterBySheet!==source.definition.appearance.filterBySheet)return empty('incomplete','clone_plus_definition_changes_require_separate_scoped_checks');
  const cloned=definitionDifferences(source.definition,created.definition);differences.push(...cloned.differences);omitted+=cloned.omitted;
 }else{
  compare('schedule.kind',wanted.kind,actual.kind);
  const resolution=row(c.applied.categoryResolution);if(!Number.isSafeInteger(resolution.categoryId)||resolution.error)return empty('unavailable','native_requested_category_resolution_required');
  compare('schedule.resolved_categoryId',resolution.categoryId,actual.categoryId);
  if(r.filterDefinitionsComplete!==true||r.sortGroupDefinitionsComplete!==true||!Array.isArray(r.filterDefinitions)||!Array.isArray(r.sortGroupDefinitions))return empty('incomplete','complete_filter_and_sort_inventory_required');
  if(r.filterDefinitions.length||r.sortGroupDefinitions.length)return empty('incomplete','unexpected_new_schedule_filters_or_sort_need_inspection');
  let previous=-1;
  for(const name of wanted.fields){const matches=r.fields.filter((f:any)=>label(f.name)===label(name));
   if(matches.length!==1)differences.push({subject:'schedule.field:'+name,expected:['One requested field'],observed:[String(matches.length)+' matches']});
   else{if(matches[0].index<=previous||matches[0].isHidden)differences.push({subject:'schedule.field:'+name,expected:['Visible in requested order'],observed:['Hidden or out of order']});previous=matches[0].index;}}
 }
 if(b.includeLinkedFiles!==undefined)compare('schedule.includeLinkedFiles',b.includeLinkedFiles,actual.includeLinkedFiles);
 if(b.filterBySheet!==undefined)compare('schedule.filterBySheet',b.filterBySheet,row(r.settings).filterBySheet);
 if(differences.length)return {state:'mismatch',reason:'native_definition_does_not_match',differences:differences.slice(0,8),omitted:omitted+Math.max(0,differences.length-8)};
 if(b.placeOnActiveSheet===true||b.placeOnSheet!=null)return empty('incomplete','sheet_placement_requires_separate_native_readback');
 return empty('matched','requested_native_definition_matches');
}
function retained(snapshot:AssignmentSnapshotV2,op:OperationV2){for(const id of op.observation_ids){const o=snapshot.observations[id];
 if(!o||o.authority!=='native-host'||o.operation_id!==op.operation_id||o.raw_payload_hash!==op.result?.raw_payload_hash||!sameAssignmentBindingV2(o.binding,op.binding))continue;
 try{const ref=readEvidenceRef(o.raw_payload_ref.replace(/^evidence:/,''));if(ref.byte_count>2_000_000)continue;const p=JSON.parse(readAuthoritativeEvidence(ref,{...op.binding,attempt_id:op.operation_id}).toString('utf8'));if(payloadDigestV2(p).digest===op.result?.raw_payload_hash)return p;}catch{/* Never replay a write to replace missing evidence. */}
 }return null;}
/** Route from retained native type, never a model-supplied schedule assertion. */
export function isNativeScheduleDuplicateV2(s:AssignmentSnapshotV2,op:OperationV2){
 return op.request_identity?.path==='/revit/duplicate-view'&&row(retained(s,op)).sourceViewType==='Schedule';
}
/** Diagnostics only; normal settlement still owns proof, freshness and scope. */
export function retainedCreatedScheduleComparisonV2(s:AssignmentSnapshotV2,op:OperationV2,read:OperationV2,payload:unknown){
 return createdScheduleReadbackComparisonV2(op.input,retained(s,op),read.input,payload,op.result?.affected_target_identities??[]);
}
export function committedCreatedScheduleReadbackPlanV2(s:AssignmentSnapshotV2,op:OperationV2){
 if(s.terminal||s.outcome!=='active'||s.completion_proposal||s.execution_control?.state==='paused'||s.unresolved_unknown_operation_ids.length
  ||s.input_invalidated_operation_ids?.includes(op.operation_id)||!sameAssignmentBindingV2(s.current_binding,op.binding)
  ||!op.request_identity||!['/revit/create-schedule','/revit/duplicate-view'].includes(op.request_identity.path??'')||op.input.method!=='POST'||op.input.path!==op.request_identity.path
  ||op.persistent_effect!=='applied'||op.settlement_state!=='settled'||op.result?.authority!=='native-host'||op.result.native_transaction_state!=='committed'
  ||op.verification_operation_ids.length)return null;
 const c=committed(op.input,retained(s,op),op.result.affected_target_identities??[]);
 return c?{method:'POST',path:'/revit/schedules',body:{action:'detail',scheduleId:c.meta.id,includeFields:true,includeData:false,
  ...(c.wanted.kind==='clone'?{includeDefinitionSnapshot:true}:{})}}:null;
}
export function createdSchedulePostconditionSatisfiedV2(s:AssignmentSnapshotV2,op:OperationV2,result:OperationResultV2,payload:unknown):boolean {
 const read=s.operations[result.operation_id],commit=op.result;
 if(!read||!commit||!op.request_identity||!['/revit/create-schedule','/revit/duplicate-view'].includes(op.request_identity.path??'')||op.input.path!==op.request_identity.path||op.input.method!=='POST'
  ||op.requested_effect!=='apply'||op.admission_state!=='admitted'||op.dispatch_state!=='dispatched'||op.settlement_state!=='settled'||op.persistent_effect!=='applied'
  ||s.unresolved_unknown_operation_ids.length||s.input_invalidated_operation_ids?.some(id=>id===op.operation_id||id===read.operation_id)
  ||!sameAssignmentBindingV2(op.binding,s.current_binding)||!sameAssignmentBindingV2(commit.binding,op.binding)||commit.operation_id!==op.operation_id
  ||commit.request_identity?.request_signature!==op.request_identity.request_signature||!commit.receipt_id||!commit.native_correlation_id
  ||read.verification_of_operation_id!==op.operation_id||read.purpose!=='verification'||read.fulfillment_role!=='verification'
  ||!sameAssignmentBindingV2(read.binding,s.current_binding)||!nativePropertyReadIsFreshNativeV2(op,read,result,'/revit/schedules')
  ||result.native_transaction_state!=='not_applicable'||!result.receipt_id||!result.native_correlation_id||payloadDigestV2(payload).digest!==result.raw_payload_hash)return false;
 return createdScheduleReadbackComparisonV2(op.input,retained(s,op),read.input,payload,commit.affected_target_identities??[]).state==='matched';
}
