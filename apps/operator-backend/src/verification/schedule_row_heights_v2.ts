import { canonicalJsonV2 } from '../domain/assignment-kernel/index.js';
import { regularScheduleFieldDefinitionV2 as definition } from './regular_schedule_field_definition_v2.js';
const obj=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const equal=(a:unknown,b:unknown)=>canonicalJsonV2(a)===canonicalJsonV2(b);
const sections=['header','body','summary','footer'];
export type ScheduleRowHeightV2={section:string;rowNumber:number;heightFeet:number};
/** Explicit rows only. Body overrides have different native semantics. */
export function boundedScheduleRowHeightsV2(value:unknown):ScheduleRowHeightV2[]|null{
 if(!Array.isArray(value)||!value.length||value.length>200)return null;
 const seen=new Set<string>(),rows:ScheduleRowHeightV2[]=[];
 for(const raw of value){const r=obj(raw),s=typeof r.section==='string'?r.section.trim().toLowerCase():'';
  if(!['header','summary','footer'].includes(s)||Object.keys(r).length!==3||Object.keys(r).some(k=>!['section','rowNumber','heightFeet'].includes(k))
   ||!Number.isSafeInteger(r.rowNumber)||r.rowNumber<0||r.rowNumber>100000||typeof r.heightFeet!=='number'||!Number.isFinite(r.heightFeet)||r.heightFeet<=0||r.heightFeet>10)return null;
  const key=s+':'+r.rowNumber;if(seen.has(key))return null;seen.add(key);rows.push({section:s,rowNumber:r.rowNumber,heightFeet:r.heightFeet});
 }
 return rows;
}
function census(value:unknown,id:number,uid:string){
 const v=obj(value);if(v.schema!=='operator.regular_schedule_row_heights.v1'||v.complete!==true||v.scheduleId!==id||v.uniqueId!==uid
  ||!Array.isArray(v.sections)||v.sections.length!==4)return null;
 const rows=new Map<string,number>(),shape:any[]=[];let total=0;
 for(let i=0;i<4;i++){const s=obj(v.sections[i]),name=String(s.section).toLowerCase();
  if(name!==sections[i]||typeof s.validSection!=='boolean'||(s.validSection?!Number.isSafeInteger(s.firstRowNumber):s.firstRowNumber!==null||s.rowCount!==0)
   ||!Number.isSafeInteger(s.rowCount)||s.rowCount<0||s.rowCount>0&&s.firstRowNumber<0
   ||!Array.isArray(s.rows)||s.rowCount!==s.rows.length||(total+=s.rowCount)>4096)return null;
  shape.push([name,s.validSection,s.firstRowNumber,s.rowCount]);
  for(let n=0;n<s.rowCount;n++){const r=obj(s.rows[n]);if(r.rowNumber!==s.firstRowNumber+n||typeof r.heightFeet!=='number'||!Number.isFinite(r.heightFeet)||r.heightFeet<0)return null;
   rows.set(name+':'+r.rowNumber,r.heightFeet);
  }
 }
 return {rows,shape};
}
/** Requested-value diagnostics only; collateral and commit proof stay separate. */
export function scheduleRowHeightComparisonV2(input:unknown,readInput:unknown,raw:unknown){
 const a=obj(input),b=obj(a.body),r=obj(readInput),rb=obj(r.body),p=obj(raw),wanted=boundedScheduleRowHeightsV2(b.rowHeights);
 if(a.method!=='POST'||a.path!=='/revit/configure-schedule'||!Object.hasOwn(b,'rowHeights'))return null;
 const empty=(state:'unsupported'|'unavailable'|'incomplete')=>({state,differences:[],omitted:0});
 if(!wanted||!Number.isSafeInteger(b.scheduleId)||b.scheduleId<=0||(b.dryRun!==undefined&&b.dryRun!==false)
  ||Object.keys(b).some(k=>!['scheduleId','rowHeights','dryRun'].includes(k)))return empty('unsupported');
 if(r.method!=='POST'||r.path!=='/revit/schedules'||rb.action!=='presentation'||rb.scheduleId!==b.scheduleId
  ||Object.keys(rb).some(k=>!['action','scheduleId'].includes(k))||p.status!=='Ok'||p.read_only!==true||p.action!=='presentation'
  ||p.schedule?.id!==b.scheduleId||p.schedule?.kind!=='schedule'||typeof p.schedule?.uniqueId!=='string'||!p.schedule.uniqueId||p.error)return empty('unavailable');
 const actual=census(p.rowHeights,b.scheduleId,p.schedule.uniqueId);if(!actual)return empty('incomplete');
 const differences=wanted.flatMap(w=>{const value=actual.rows.get(w.section+':'+w.rowNumber);
  return value!==undefined&&Math.abs(value-w.heightFeet)<=1e-8?[]:[{subject:'schedule_row_height:'+b.scheduleId+':'+w.section+':'+w.rowNumber,expected:['heightFeet:'+w.heightFeet],observed:value===undefined?[]:['heightFeet:'+value]}];
 });
 const state=differences.some(d=>!d.observed.length)?'incomplete' as const:differences.length?'mismatch' as const:'matched' as const;
 return {state,differences:differences.slice(0,8),omitted:Math.max(0,differences.length-8)};
}
/** Old success receipts without complete before/after census remain unverified. */
export function scheduleRowHeightsMatchV2(wanted:ScheduleRowHeightV2[],id:number,uid:string,applied:Record<string,any>,fresh:Record<string,any>):boolean{
 const before=census(applied.rowHeightsBefore,id,uid),after=census(applied.rowHeightsAfter,id,uid),now=census(fresh.rowHeights,id,uid);
 const b=definition(applied.definitionBefore,id,uid),p=definition(applied.definitionAfter,id,uid),n=definition(fresh.definition,id,uid);
 if(!before||!after||!now||!b||!p||!n||!equal(before.shape,after.shape)||!equal(after.shape,now.shape)
  ||!equal(b.value,p.value)||!equal(p.value,n.value)||!equal(applied.presentationBefore,applied.presentationReadback)
  ||!equal(applied.presentationReadback,fresh.presentation))return false;
 const target=new Map(wanted.map(r=>[r.section+':'+r.rowNumber,r.heightFeet]));
 if([...target.keys()].some(k=>!before.rows.has(k)))return false;
 for(const [key,old]of before.rows){const height=target.get(key)??old;
  if(Math.abs(after.rows.get(key)!-height)>1e-8||Math.abs(now.rows.get(key)!-height)>1e-8)return false;
 }
 const receipts=obj(applied.applied).rowHeights;if(!Array.isArray(receipts)||receipts.length!==wanted.length)return false;
 const seen=new Set<string>();
 return receipts.every(raw=>{const r=obj(raw),key=String(r.section).toLowerCase()+':'+r.rowNumber,w=target.get(key);
  if(seen.has(key)||w===undefined||r.status!=='Applied'||typeof r.beforeHeightFeet!=='number'||!Number.isFinite(r.beforeHeightFeet)||Math.abs(r.beforeHeightFeet-before.rows.get(key)!)>1e-8
   ||typeof r.heightFeet!=='number'||typeof r.afterHeightFeet!=='number'||!Number.isFinite(r.heightFeet)||!Number.isFinite(r.afterHeightFeet)
   ||Math.abs(r.heightFeet-w)>1e-8||Math.abs(r.afterHeightFeet-w)>1e-8)return false;seen.add(key);return true;
 });
}
