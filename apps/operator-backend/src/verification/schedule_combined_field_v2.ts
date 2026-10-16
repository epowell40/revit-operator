import { canonicalJsonV2 } from '../domain/assignment-kernel/index.js';
import { regularSchedulePresentationScopeMatchesV2 } from './regular_schedule_presentation_scope_v2.js';

const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const equal = (a: unknown, b: unknown) => canonicalJsonV2(a) === canonicalJsonV2(b);
const integer = (v: unknown): v is number => Number.isSafeInteger(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown) => typeof v === 'string' && v.length > 0;
export function scheduleCombinedFieldRequestV2(input: unknown) {
  const wrapper=obj(input), b=obj(wrapper.body??input), c=obj(b.combinedField);
  if (!integer(b.scheduleId) || b.scheduleId<=0 || (b.dryRun!==undefined&&b.dryRun!==false)
      || Object.keys(b).some(k=>!['scheduleId','combinedField','dryRun'].includes(k))
      || Object.keys(c).some(k=>!['name','sourceFieldIds','index','separator','hideSourceFields','widthFeet'].includes(k))
      || typeof c.name!=='string' || !c.name.trim() || c.name.length>128
      || !Array.isArray(c.sourceFieldIds) || c.sourceFieldIds.length<2 || c.sourceFieldIds.length>8
      || c.sourceFieldIds.some((id:unknown)=>!integer(id)||id<0) || new Set(c.sourceFieldIds).size!==c.sourceFieldIds.length
      || (c.index!==undefined&&(!integer(c.index)||c.index<0||c.index>200))
      || (c.separator!==undefined&&(typeof c.separator!=='string'||c.separator.length>32))
      || (c.hideSourceFields!==undefined&&typeof c.hideSourceFields!=='boolean')
      || (c.widthFeet!==undefined&&(typeof c.widthFeet!=='number'||!Number.isFinite(c.widthFeet)||c.widthFeet<0.01||c.widthFeet>5))) return null;
  return {scheduleId:b.scheduleId,name:c.name.trim(),sourceFieldIds:c.sourceFieldIds as number[],index:c.index as number|undefined,
    separator:c.separator??' / ',hideSourceFields:c.hideSourceFields??true,widthFeet:c.widthFeet as number|undefined};
}

function definition(value: unknown, id:number, uid:string) {
  const v=obj(value);
  if(v.schema!=='operator.regular_schedule_field_definition.v1'||v.complete!==true||v.scheduleId!==id||v.uniqueId!==uid
      ||v.coverage!=='native_field_binding_captured_attributes_filters_sort_defaults_parameters_v1'||!integer(v.categoryId)||!hash(v.configurationHash)
      ||!Array.isArray(v.fieldOrder)||v.fieldOrder.length>200||new Set(v.fieldOrder).size!==v.fieldOrder.length
      ||v.fieldOrder.some((n:unknown)=>!integer(n)||n<0)||!Array.isArray(v.fields)||v.fields.length!==v.fieldOrder.length) return null;
  const fields=new Map<number,Record<string,any>>();
  for(let i=0;i<v.fields.length;i++){
    const f=obj(v.fields[i]),a=obj(f.attributes);
    if(f.fieldId!==v.fieldOrder[i]||fields.has(f.fieldId)||typeof f.isHidden!=='boolean'||!hash(f.semanticHash)
        ||a.fieldId!==f.fieldId||!integer(a.parameterId)||typeof a.isCalculated!=='boolean'||typeof a.isCombined!=='boolean'
        ||typeof a.name!=='string'||typeof a.heading!=='string'||typeof a.fieldType!=='string'||!Array.isArray(a.parts)
        ||!Number.isFinite(a.gridWidthFeet)||!Number.isFinite(a.sheetWidthFeet)||!hash(obj(a.style).preservedStyleHash)) return null;
    if(a.parameterId>0&&!text(a.parameterUniqueId))return null;
    fields.set(f.fieldId,f);
  }
  return {value:v,fields};
}

/** Native bindings plus a separate bound host read; does not certify rendered appearance or engineering. */
export function scheduleCombinedFieldReadbackMatchesV2(input:unknown, applied:unknown, fresh:unknown):boolean {
  const w=scheduleCombinedFieldRequestV2(input),a=obj(applied),r=obj(fresh),s=obj(a.schedule),rs=obj(r.schedule),tx=obj(a.transaction);
  if(!w||a.status!=='Success'||a.dryRun!==false||r.status!=='Ok'||r.action!=='presentation'||r.read_only!==true
      ||s.id!==w.scheduleId||rs.id!==w.scheduleId||!text(s.uniqueId)||rs.uniqueId!==s.uniqueId||rs.kind!=='schedule'
      ||tx.committed!==true||tx.pending===true||tx.rolledBack===true||obj(a.changeTracking).exhaustiveChangeInventory!==true
      ||!regularSchedulePresentationScopeMatchesV2(w.scheduleId,s.uniqueId,a,r))return false;
  const b=definition(a.definitionBefore,w.scheduleId,s.uniqueId),p=definition(a.definitionAfter,w.scheduleId,s.uniqueId),n=definition(r.definition,w.scheduleId,s.uniqueId);
  if(!b||!p||!n||!equal(p.value,n.value)||p.value.configurationHash!==b.value.configurationHash||p.value.categoryId!==b.value.categoryId
      ||!integer(a.createdScheduleFieldId)||a.createdScheduleFieldId<0||b.fields.has(a.createdScheduleFieldId)
      ||p.fields.size!==b.fields.size+1||!equal(a.sourceFieldIds,w.sourceFieldIds))return false;
  const index=w.index??b.value.fieldOrder.indexOf(w.sourceFieldIds[0]),order=[...b.value.fieldOrder];
  if(index<0||index>order.length||a.requestedIndex!==index)return false;
  order.splice(index,0,a.createdScheduleFieldId);
  if(!equal(order,p.value.fieldOrder))return false;
  for(const [id,old] of b.fields){
    const post=p.fields.get(id);
    if(!post||post.semanticHash!==old.semanticHash||!equal(post.attributes,old.attributes)
        ||post.isHidden!==(w.sourceFieldIds.includes(id)&&w.hideSourceFields?true:old.isHidden))return false;
  }
  const parameters:number[]=[];
  for(const id of w.sourceFieldIds){
    const f=b.fields.get(id),v=obj(f?.attributes);
    if(!f||v.isCalculated||v.isCombined||v.parameterId===-1||v.parts.length)return false;
    parameters.push(v.parameterId);
  }
  if(new Set(parameters).size!==parameters.length)return false;
  const added=p.fields.get(a.createdScheduleFieldId),v=obj(added?.attributes);
  if(!added||added.isHidden||!v.isCombined||v.isCalculated||v.name!==w.name||v.heading!==w.name||v.parts.length!==parameters.length
      ||(w.widthFeet!==undefined&&(Math.abs(v.gridWidthFeet-w.widthFeet)>1e-8||Math.abs(v.sheetWidthFeet-w.widthFeet)>1e-8)))return false;
  return v.parts.every((raw:unknown,i:number)=>{const part=obj(raw);return part.parameterId===parameters[i]&&integer(part.categoryId)
    &&part.prefix===''&&part.suffix===''&&part.separator===(i+1<parameters.length?w.separator:'');});
}
