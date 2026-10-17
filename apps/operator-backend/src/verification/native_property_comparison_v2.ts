import {expectedPostconditionValuesV2,observedPostconditionValuesV2}from '../postcondition_verification_v2.js';

export const NATIVE_PROPERTY_COMPARISON_FACT_V2='control.native_property_comparison';
type Difference={subject:string;expected:string[];observed:string[];values_clipped?:boolean};
export type NativePropertyComparisonV2={state:'matched'|'mismatch'|'incomplete'|'unavailable'|'unsupported';differences:Difference[];omitted:number};
const record=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
function tokenParts(token:string):[string,string]|null {
 const m=/^(target_property:"(?:[^"\\]|\\.)*":[^:]+|native_view_property:\d+:[^:]+|native_view_phasing:\d+:(?:phase|phaseFilter):(?:id|name)|native_category_property:\d+:(?:OST_[A-Za-z0-9_]+|label:"(?:[^"\\]|\\.)*"):(?:halftone|lineWeight|color)):(.*)$/.exec(token);
 return m?[m[1]!,m[2]!]:null;
}

/** Bounded explanation of the existing scalar comparison, never authority or
 * completion proof. The settlement owner must bind an independently obtained,
 * fresh native result before exposing this as actual mismatch feedback. */
export function nativePropertyComparisonV2(input:unknown,readInput:unknown,raw:unknown):NativePropertyComparisonV2 {
 const apply=record(input),read=record(readInput),body=record(apply.body),rb=record(read.body),payload=record(raw);
 const empty=(state:NativePropertyComparisonV2['state']):NativePropertyComparisonV2=>({state,differences:[],omitted:0});
 if(apply.method!=='POST'||!['/revit/set-parameter','/revit/visibility'].includes(apply.path))return empty('unsupported');
 const expected=expectedPostconditionValuesV2(input,true,{path:apply.path});
 if(!expected.length||expected.some(t=>!tokenParts(t)))return empty('unsupported');
 if(read.method!=='POST'||payload.error||payload.isError===true||payload.success===false||payload.ok===false||payload.truncated===true
   ||payload.status!==undefined&&!['Ok','Success'].includes(payload.status))return empty('unavailable');
 let native:unknown=raw;
 if(apply.path==='/revit/visibility'){
  if(read.path!=='/revit/visibility'||rb.action!=='get'||rb.viewId!==body.viewId||payload.view?.id!==body.viewId)return empty('unavailable');
 }else{
  const changes=body.changes as Record<string,any>[],excluded=body.excludeElementIds??[];
  const wanted=changes.filter(c=>!excluded.includes(c.elementId)),ids=[...new Set(wanted.map(c=>c.elementId))];
  const selected=rb.elementIds??(rb.elementId!==undefined?[rb.elementId]:[]);
  if(read.path!=='/revit/get-parameters'||!Array.isArray(selected)||selected.length!==ids.length
    ||new Set(selected).size!==ids.length||!ids.every(id=>selected.includes(id)))return empty('unavailable');
  if(!Array.isArray(payload.items)||payload.items.length!==ids.length)return empty('incomplete');
  const seen=new Set<number>(),items=[];
  for(const item of payload.items){
   if(!ids.includes(item?.id)||seen.has(item.id)||typeof item.uniqueId!=='string'||!item.uniqueId.trim()||item.found===false||item.error)return empty('incomplete');
   seen.add(item.id);
   // Keep only the actual returned parameter projection for requested owners
   // and names. Request echoes or another owner's values cannot fill a gap.
   const names=new Set(wanted.filter(c=>c.elementId===item.id).map(c=>String(c.parameterName).trim().toLowerCase()));
   const parameters=Object.fromEntries(Object.entries(record(item.parameters)).filter(([k])=>names.has(k.trim().toLowerCase())));
   const parameterDetails=Array.isArray(item.parameterDetails)?item.parameterDetails.filter((p:any)=>names.has(String(p?.name??'').trim().toLowerCase())):[];
   items.push({id:item.id,parameters,parameterDetails});
  }
  native={items};
 }
 const observed=observedPostconditionValuesV2(native,{path:apply.path,apply_input:input,verification_input:readInput});
 const rows=new Map<string,Difference>();
 for(const token of expected){const [subject,value]=tokenParts(token)!;const row=rows.get(subject)??{subject,expected:[],observed:[]};row.expected.push(value);rows.set(subject,row);}
 for(const token of observed){const parts=tokenParts(token);if(parts&&rows.has(parts[0]))rows.get(parts[0])!.observed.push(parts[1]);}
 const differences=[...rows.values()].filter(r=>!r.expected.every(v=>r.observed.includes(v)));
 const state=differences.some(r=>!r.observed.length)?'incomplete':differences.length?'mismatch':'matched';
 // Inspect all requested values above before bounding presentation. A late
 // discrepancy must not vanish because the first displayed rows matched.
 return {state,differences:differences.slice(0,8).map(r=>({...r,expected:r.expected.slice(0,3).map(v=>v.slice(0,256)),observed:r.observed.slice(0,3).map(v=>v.slice(0,256)),
   ...(r.expected.length>3||r.observed.length>3||[...r.expected,...r.observed].some(v=>v.length>256)?{values_clipped:true}:{})})),omitted:Math.max(0,differences.length-8)};
}
