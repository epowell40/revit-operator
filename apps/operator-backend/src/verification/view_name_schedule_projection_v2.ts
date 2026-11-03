import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {preservedScheduleRowsV2} from './native_annotation_postcondition_v2.js';

const object=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v)?v:null;
const same=(a:any,b:any)=>payloadDigestV2(a).digest===payloadDigestV2(b).digest;
const text=(s:any):s is string=>typeof s==='string'&&s.trim().length>0&&s.length<=256&&!/[\x00-\x1f\x7f]/.test(s);
const ids=(a:any):a is number[]=>Array.isArray(a)&&a.length<=100&&a.every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(a).size===a.length;
const equalIds=(a:number[],b:number[])=>a.length===b.length&&a.every(n=>b.includes(n));
const VIEW_NAME=-1005112,FAMILY_AND_TYPE=-1139998,VIEWS=-2000279;

export type ViewNameScheduleProjectionV2={expectedRows:any[];afterViews:any[];readNames:string[]};

/** Called only after the existing native receipt/binding/digest/footprint checks.
 * Account for exact requested name cells in a simple native View List. This is
 * not a general schedule-delta waiver, row-index identity heuristic, or evidence
 * of complete view membership. A unique native (family/type, old name) binds
 * each changed row; every other byte in its full snapshot must stay identical. */
export function viewNameScheduleProjectionV2(payload:any,expected:number[],changes:any[]):ViewNameScheduleProjectionV2|null {
 const p=object(payload?.viewNameChanges),scope=object(payload?.schedulePreservation);
 if(!p||p.schema!=='operator.native_view_name_changes.v1'||p.complete!==true
  ||!Array.isArray(changes)||!changes.length||changes.length>100||!ids(changes.map(c=>c?.elementId))
  ||!Array.isArray(p.before)||!Array.isArray(p.after)||p.before.length!==changes.length||p.after.length!==changes.length
  ||!ids(p.before.map((v:any)=>v?.elementId))||!ids(p.after.map((v:any)=>v?.elementId))
  ||!equalIds(p.before.map((v:any)=>v.elementId),changes.map(c=>c.elementId))
  ||!equalIds(p.after.map((v:any)=>v.elementId),changes.map(c=>c.elementId))
  ||new Set(p.before.map((v:any)=>v?.uniqueId)).size!==p.before.length
  ||!scope||scope.schema!=='operator.annotation_schedule_preservation.v1'||scope.complete!==true
  ||!ids(scope.scheduleIds)||!equalIds(scope.scheduleIds,expected))return null;
 const before=preservedScheduleRowsV2(scope.before,expected),after=preservedScheduleRowsV2(scope.after,expected);
 if(!before||!after)return null;
 const pairs:any[]=[],keys=new Set<string>();
 for(const b of p.before){const a=p.after.find((v:any)=>v.elementId===b.elementId),c=changes.find(v=>v.elementId===b.elementId);
  if(!object(b)||!object(a)||!text(b.uniqueId)||b.uniqueId.length<10||a.uniqueId!==b.uniqueId
   ||b.parameterId!==VIEW_NAME||a.parameterId!==VIEW_NAME||b.familyParameterId!==FAMILY_AND_TYPE||a.familyParameterId!==FAMILY_AND_TYPE
   ||!text(b.parameterName)||a.parameterName!==b.parameterName||!text(b.familyParameterName)||a.familyParameterName!==b.familyParameterName
   ||!text(b.name)||!text(a.name)||!text(b.familyAndType)||a.familyAndType!==b.familyAndType
   ||typeof c?.parameterName!=='string'||c.parameterName.trim().toLowerCase()!==b.parameterName.trim().toLowerCase()
   ||typeof c.value!=='string'||a.name!==c.value
   ||c.expectedOldValue!=null&&c.expectedOldValue!==b.name)return null;
  const key=JSON.stringify([b.familyAndType,b.name]);if(keys.has(key))return null;keys.add(key);pairs.push({before:b,after:a});
 }
 let derived=0;const expectedRows:any[]=[];
 for(const b of before){const a=after.find(v=>v.elementId===b.elementId);if(!a)return null;
  if(same(b,a)){expectedRows.push(a);continue;}
  const d=b.definition?.definition,identity=b.definition?.identity;
  if(identity?.kind!=='view_list'||identity.complete!==true||identity.categoryId!==VIEWS||identity.includeLinkedFiles!==false
   ||b.definition.scope!=='flat_definition_without_calculated_fields'||!object(d)||d.IsItemized!==true
   ||!Array.isArray(d.filters)||d.filters.length||!Array.isArray(d.sort)||d.sort.length
   ||!Array.isArray(d.fields)||!d.fields.length||d.fields.length>100
   ||d.fields.some((f:any,i:number)=>f?.index!==i||f.hidden!==false||f.fieldType!=='Instance'||f.combined!==null)
   ||!Array.isArray(d.table)||d.table.length!==2)return null;
  const nameColumns=d.fields.filter((f:any)=>f.parameterId===VIEW_NAME),familyColumns=d.fields.filter((f:any)=>f.parameterId===FAMILY_AND_TYPE);
  if(nameColumns.length!==1||familyColumns.length!==1)return null;
  const expectedRow=structuredClone(b),body=expectedRow.definition.definition.table.filter((s:any)=>s.section==='Body');
  if(body.length!==1||!Array.isArray(body[0].rows)||body[0].rows.length!==body[0].NumberOfRows
   ||body[0].NumberOfColumns!==d.fields.length||body[0].rows.length*d.fields.length>16384)return null;
  const rows=body[0].rows,nameColumn=nameColumns[0].index,familyColumn=familyColumns[0].index;
  if(rows.some((r:any)=>!Number.isSafeInteger(r?.row)||!Array.isArray(r.cells)||r.cells.length!==d.fields.length
   ||r.cells.some((c:any,i:number)=>c?.column!==i||typeof c.text!=='string')))return null;
  let changed=0;
  for(const pair of pairs){const matches=rows.filter((r:any)=>r.cells[nameColumn].text===pair.before.name&&r.cells[familyColumn].text===pair.before.familyAndType);
   if(matches.length>1)return null; // No guessing among duplicates or grouped rows.
   if(matches.length===1&&pair.before.name!==pair.after.name){matches[0].cells[nameColumn].text=pair.after.name;changed++;}
  }
  if(!changed||!same(expectedRow,a))return null;
  derived+=changed;expectedRows.push(a);
 }
 if(!derived)return null;
 return {expectedRows,afterViews:p.after,readNames:[...new Set<string>(p.after.flatMap((v:any)=>[v.parameterName,v.familyParameterName]))].sort()};
}

/** A later independent native read must match the actual expected-after state,
 * including every ancillary schedule field and typed source view identity. */
export function viewNameScheduleReadMatchesV2(projection:ViewNameScheduleProjectionV2,expected:number[],read:any):boolean {
 const scope=object(read?.schedulePreservation);
 if(!scope||scope.schema!=='operator.annotation_schedule_read.v1'||scope.complete!==true
  ||!ids(scope.requestedElementIds)||!equalIds(scope.requestedElementIds,expected))return false;
 const observed=preservedScheduleRowsV2(scope.items,expected);
 if(!observed||!projection.expectedRows.every(e=>{const r=observed.find(x=>x.elementId===e.elementId);return r&&same(e,r);})
  ||!Array.isArray(read.items)||read.items.length!==projection.afterViews.length)return false;
 for(const expected of projection.afterViews){const r=read.items.find((x:any)=>x.id===expected.elementId);
  if(!r||r.uniqueId!==expected.uniqueId||r.categoryId!==VIEWS||!Array.isArray(r.parameterDetails))return false;
  for(const [id,name,value,readOnly]of[[VIEW_NAME,expected.parameterName,expected.name,false],
    [FAMILY_AND_TYPE,expected.familyParameterName,expected.familyAndType,true]]as const){
   const details=r.parameterDetails.filter((d:any)=>d.parameterId===id);
   if(details.length!==1||details[0].name!==name||details[0].storageType!=='String'||details[0].isReadOnly!==readOnly
    ||details[0].value!==value||details[0].valueString!==value||r.parameters?.[name]!==value)return false;
  }
 }
 return true;
}
