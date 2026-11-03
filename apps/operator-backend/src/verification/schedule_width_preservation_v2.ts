import {canonicalJsonV2} from '../domain/assignment-kernel/index.js';
const obj=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const equal=(a:unknown,b:unknown)=>canonicalJsonV2(a)===canonicalJsonV2(b);
const id=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
const uid=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=256;
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function isScheduleWidthOnlyRequestV2(input:unknown):boolean {
 const root=obj(input),body=obj(root.body??input),name=Object.hasOwn(body,'columnWidths')?'columnWidths':'fieldFormats',formats=body[name];
 return id(body.scheduleId)&&(body.dryRun===undefined||body.dryRun===false)
  &&Object.keys(body).every(k=>['scheduleId',name,'dryRun'].includes(k))
  &&Array.isArray(formats)&&formats.length>0&&formats.length<=200&&formats.every(f=>{
   const v=obj(f);return Object.keys(v).length===2&&Object.keys(v).every(k=>['field','widthFeet'].includes(k))
    &&typeof v.field==='string'&&v.field.trim().length>0&&v.field.length<=256
    &&typeof v.widthFeet==='number'&&Number.isFinite(v.widthFeet)&&v.widthFeet>0&&v.widthFeet<=100;
  })&&new Set(formats.map(f=>f.field.trim().toLowerCase())).size===formats.length;
}
function snapshot(value:unknown,scheduleId:number,uniqueId:string){
 const v=obj(value),table=obj(v.table);
 if(v.schema!=='operator.schedule_width_preservation.v1'||v.complete!==true
  ||Object.keys(v).some(k=>!['schema','complete','coverage','scheduleId','uniqueId','memberCount','members','placements','table'].includes(k))
  ||v.coverage!=='host_members_table_text_cell_styles_placement_anchors_v1'||v.scheduleId!==scheduleId||v.uniqueId!==uniqueId
  ||!Array.isArray(v.members)||v.members.length>5000||v.memberCount!==v.members.length
  ||!Array.isArray(v.placements)||v.placements.length>128||table.complete!==true
  ||!Number.isSafeInteger(table.totalCells)||table.totalCells<0||table.totalCells>10000
  ||!hash(table.textHash)||!hash(table.unrequestedStyleHash)
  ||Object.keys(table).some(k=>!['complete','totalCells','textHash','unrequestedStyleHash'].includes(k)))return null;
 const memberIds=new Set<number>(),memberUids=new Set<string>();
 for(const row of v.members){const m=obj(row);if(Object.keys(m).some(k=>!['id','uniqueId'].includes(k))||!id(m.id)||!uid(m.uniqueId)||memberIds.has(m.id)||memberUids.has(m.uniqueId))return null;memberIds.add(m.id);memberUids.add(m.uniqueId);}
 const placementIds=new Set<number>(),placementUids=new Set<string>();
 for(const row of v.placements){const p=obj(row);if(!id(p.id)||!uid(p.uniqueId)||!id(p.sheetId)||!uid(p.sheetUniqueId)
  ||Object.keys(p).some(k=>!['id','uniqueId','sheetId','sheetUniqueId','point'].includes(k))
  ||placementIds.has(p.id)||placementUids.has(p.uniqueId)||!Array.isArray(p.point)||p.point.length!==3
  ||p.point.some((n:unknown)=>typeof n!=='number'||!Number.isFinite(n)))return null;placementIds.add(p.id);placementUids.add(p.uniqueId);}
 return {members:[...v.members].sort((a,b)=>a.id-b.id),placements:[...v.placements].sort((a,b)=>a.id-b.id),table};
}
/** Width-only semantic invariants, separate from authorized field changes and legitimate geometric reflow. */
export function scheduleWidthPreservationMatchesV2(input:unknown,applied:unknown,fresh:unknown):boolean {
 if(!isScheduleWidthOnlyRequestV2(input))return false;
 const a=obj(applied),r=obj(fresh),s=obj(a.schedule),body=obj(obj(input).body??input);
 if(s.id!==body.scheduleId||!uid(s.uniqueId)||obj(r.schedule).id!==s.id||obj(r.schedule).uniqueId!==s.uniqueId)return false;
 const before=snapshot(a.targetContentBefore,s.id,s.uniqueId),after=snapshot(a.targetContentAfter,s.id,s.uniqueId),now=snapshot(r.targetContent,s.id,s.uniqueId);
 return !!before&&!!after&&!!now&&equal(before,after)&&equal(after,now);
}
export function scheduleWidthPreservationSummaryV2(input:unknown,applied:unknown,fresh:unknown){
 if(!scheduleWidthPreservationMatchesV2(input,applied,fresh))return undefined;
 const v=obj(obj(fresh).targetContent);
 return {target_id:v.scheduleId,coverage:v.coverage,member_count:v.memberCount,table_cell_count:v.table.totalCells,placement_count:v.placements.length,
  checked:['target_host_member_ids_and_uids','target_table_text','target_cell_styles','target_placement_anchor_ids_and_points'],
  excluded:['row_height_and_bounding_box_reflow','visual_readability_and_clearance','underlying_unscheduled_parameter_values','saved_file_and_task_completion']};
}
