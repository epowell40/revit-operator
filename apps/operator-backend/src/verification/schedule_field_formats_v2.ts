import {canonicalJsonV2} from '../domain/assignment-kernel/index.js';
import {regularScheduleFieldDefinitionV2 as definition} from './regular_schedule_field_definition_v2.js';
const obj=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const equal=(a:unknown,b:unknown)=>canonicalJsonV2(a)===canonicalJsonV2(b);
const keys=['field','heading','hidden','widthFeet','horizontalAlignment','headingOrientation'];
export function boundedScheduleFieldFormatsV2(value:unknown):Record<string,any>[]|null{
 if(!Array.isArray(value)||!value.length||value.length>200)return null;
 const names=new Set<string>();
 for(const raw of value){const f=obj(raw),name=typeof f.field==='string'?f.field.trim().toLowerCase():'';
  if(!name||f.field.length>256||names.has(name)||Object.keys(f).length<2||Object.keys(f).some(k=>!keys.includes(k)))return null;
  names.add(name);
  if(Object.hasOwn(f,'heading')&&(typeof f.heading!=='string'||f.heading.length>1024))return null;
  if(Object.hasOwn(f,'hidden')&&typeof f.hidden!=='boolean')return null;
  if(Object.hasOwn(f,'widthFeet')&&(typeof f.widthFeet!=='number'||!Number.isFinite(f.widthFeet)||f.widthFeet<=0||f.widthFeet>100))return null;
  for(const [key,values] of [['horizontalAlignment',['left','center','right']],['headingOrientation',['horizontal','vertical']]] as const)
   if(Object.hasOwn(f,key)&&(typeof f[key]!=='string'||!(values as readonly string[]).includes(f[key].toLowerCase())))return null;
 }
 return value;
}
/** Compare the full native field definition; only explicitly requested scalar attributes may differ. */
export function scheduleFieldFormatsMatchV2(formats:Record<string,any>[],id:number,uid:string,applied:Record<string,any>,fresh:Record<string,any>):boolean{
 const b=definition(applied.definitionBefore,id,uid),p=definition(applied.definitionAfter,id,uid),n=definition(fresh.definition,id,uid);
 if(!b||!p||!n||!equal(p.value,n.value)||!equal(b.value.fieldOrder,p.value.fieldOrder)||b.value.configurationHash!==p.value.configurationHash
  ||b.value.categoryId!==p.value.categoryId||b.fields.size!==p.fields.size)return false;
 const targets=new Map<number,Record<string,any>>();
 for(const f of formats){const found=[...b.fields.values()].filter(x=>x.attributes.name.trim().toLowerCase()===f.field.trim().toLowerCase());
  if(found.length!==1||targets.has(found[0]!.fieldId))return false;targets.set(found[0]!.fieldId,f);
 }
 for(const [fieldId,old] of b.fields){const post=p.fields.get(fieldId),f=targets.get(fieldId);if(!post)return false;
  if(!f){if(!equal(old,post))return false;continue;}
  if(post.isHidden!==(f.hidden??old.isHidden))return false;
  const expected={...old.attributes};
  if(Object.hasOwn(f,'heading'))expected.heading=f.heading;
  for(const key of ['horizontalAlignment','headingOrientation'])if(Object.hasOwn(f,key))expected[key]=f[key][0].toUpperCase()+f[key].slice(1).toLowerCase();
  if(Object.hasOwn(f,'widthFeet')){expected.gridWidthFeet=post.attributes.gridWidthFeet;expected.sheetWidthFeet=post.attributes.sheetWidthFeet;
   if(Math.abs(expected.gridWidthFeet-f.widthFeet)>1e-8||Math.abs(expected.sheetWidthFeet-f.widthFeet)>1e-8)return false;
  }
  // Includes parameter bindings, combined parts and the full preserved native style hash.
  // An unexplained style change remains unverified, even when a scalar matches.
  if(!equal(expected,post.attributes))return false;
 }
 return true;
}
