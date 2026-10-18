/** Filter postconditions are bound to one native schedule detail. A matching
 * table row, request echo, commit response or second schedule is not evidence.
 * Lifecycle freshness and payload custody are enforced separately by the kernel. */
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
function parsed(v:unknown):Record<string,unknown>{
  if(typeof v==='string'&&v.length<=1_000_000){try{return record(JSON.parse(v));}catch{return {};}}
  return record(v);
}
function body(v:unknown){const r=parsed(v);return parsed(r.body??r.arguments??v);}
const id=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0?Number(v):null;
const fieldId=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0?Number(v):null;
const label=(v:unknown)=>typeof v==='string'?v.trim().replace(/[A-Z]/g,c=>c.toLowerCase()):'';
type Rule={fieldId?:number;field?:string;op:string;value:string|null};
function rule(v:unknown):Rule|null{
  const r=record(v), fid=fieldId(r.fieldId), field=label(r.field);
  if(Object.hasOwn(r,'fieldId')&&fid===null)return null;
  if(fid===null&&!field)return null;
  const op=typeof r.op==='string'?r.op.trim().toLowerCase().replace(/[ -]/g,'_'):'equals';
  if(!['equals','not_equals','contains','not_contains','begins_with','ends_with','has_value','has_no_value'].includes(op))return null;
  const noValue=op==='has_value'||op==='has_no_value';
  // Native string filters preserve labels such as "004" and case exactly.
  // Numeric/display-unit/ElementId values need a typed native value projection;
  // do not guess their storage class from a string or a bare numeric readback.
  if(!noValue&&((r.valueType!==undefined&&label(r.valueType)!=='string')||typeof r.value!=='string'))return null;
  return {...(fid!==null?{fieldId:fid}:{field}),op,value:noValue?null:r.value as string};
}
function request(v:unknown){
  const b=body(v),sid=id(b.scheduleId);
  if(!sid||b.dryRun===true||!Array.isArray(b.filters)||b.filters.length>8
    ||(b.replaceFilters!==undefined&&typeof b.replaceFilters!=='boolean'))return null;
  const rules=b.filters.map(rule);
  if(rules.some(r=>!r))return null;
  return {scheduleId:sid,replace:b.replaceFilters!==false,rules:rules as Rule[]};
}
function token(r:NonNullable<ReturnType<typeof request>>){
  // Preserve multiplicity. Duplicate AND rules must not disappear in a Set.
  return `native_schedule_filters:${r.scheduleId}:${r.replace}:${JSON.stringify(r.rules.map(x=>JSON.stringify(x)).sort())}`;
}
export function scheduleFilterExpectedValuesV2(v:unknown):readonly string[]{
  if(!Object.hasOwn(body(v),'filters'))return [];
  const r=request(v);
  return [r?token(r):'native_schedule_filters:invalid_request'];
}
function nativePayload(v:unknown){
  const r=parsed(v);
  if(r.isError===true||r.error||r.success===false||r.ok===false)return {};
  if(!('status'in r)&&Array.isArray(r.content)&&r.content.length===1){
    const block=record(r.content[0]);return block.type==='text'?parsed(block.text):{};
  }
  return r;
}
export function scheduleFilterObservedValuesV2(v:unknown,apply:unknown,read?:unknown):readonly string[]{
  const wanted=request(apply);if(!wanted)return [];
  // The exact read selector is mandatory when the caller has one; no other
  // capability or requested schedule may lend its payload to this check.
  if(read!==undefined){
    const r=parsed(read),b=body(read);
    if(r.path!=='/revit/schedules'||b.action!=='detail'||id(b.scheduleId)!==wanted.scheduleId)return [];
  }
  const r=nativePayload(v),schedule=record(r.schedule);
  if(r.status!=='Ok'||r.action!=='detail'||r.isError===true||r.error||r.success===false||r.ok===false
    ||r.truncated===true||r.dryRun===true||id(schedule.id)!==wanted.scheduleId
    ||r.filterDefinitionsComplete!==true||!Array.isArray(r.filterDefinitions)||r.filterDefinitions.length>8)return [];
  const observed=r.filterDefinitions.map((v,index)=>{
    const x=record(v);
    if(x.readable!==true||x.index!==index||fieldId(x.fieldId)===null||typeof x.op!=='string')return null;
    return rule(x);
  });
  if(observed.some(x=>!x))return [];
  const fields=Array.isArray(r.fields)?r.fields.map(record):[];
  const resolved=wanted.rules.map(x=>{
    if(x.fieldId!==undefined)return x;
    // Native name-based writes resolve the field name, not the heading. Require
    // the full field inventory so duplicate names cannot masquerade as unique.
    if(fields.length!==schedule.fieldCount||fields.some(f=>fieldId(f.fieldId)===null||!label(f.name))
      ||new Set(fields.map(f=>f.fieldId)).size!==fields.length)return null;
    const matches=fields.filter(f=>label(f.name)===x.field);
    return matches.length===1?{fieldId:Number(matches[0].fieldId),op:x.op,value:x.value}:null;
  });
  if(resolved.some(x=>!x))return [];
  const remaining=observed.map(x=>JSON.stringify(x));
  for(const x of resolved){const at=remaining.indexOf(JSON.stringify(x));if(at<0)return [];remaining.splice(at,1);}
  if(wanted.replace&&remaining.length)return [];
  return [token(wanted)];
}
