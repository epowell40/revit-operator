const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const integer = (v: unknown): v is number => Number.isSafeInteger(v);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown) => typeof v === 'string' && v.length > 0;
export function regularScheduleFieldDefinitionV2(value: unknown, id:number, uid:string) {
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

