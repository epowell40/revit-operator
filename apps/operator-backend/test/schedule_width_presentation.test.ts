import test from 'node:test';import assert from 'node:assert/strict';
import {scheduleWidthPresentationV2} from '../src/assignments/verified_change_presentation_v2.js';
const input={body:{scheduleId:41,fieldFormats:[{field:'Number',widthFeet:.09375}]}};
const field={fieldId:0,isHidden:false,semanticHash:'a'.repeat(64),attributes:{fieldId:0,parameterId:-1,isCalculated:false,isCombined:false,
 name:'Number',heading:'Number',fieldType:'Instance',parts:[],gridWidthFeet:.09375,sheetWidthFeet:.09375,style:{preservedStyleHash:'b'.repeat(64)}}};
function payload(){return {schedule:{id:41,uniqueId:'uid'},definition:{schema:'operator.regular_schedule_field_definition.v1',complete:true,
 scheduleId:41,uniqueId:'uid',coverage:'native_field_binding_captured_attributes_filters_sort_defaults_parameters_v1',categoryId:-1,configurationHash:'c'.repeat(64),fieldOrder:[0],fields:[structuredClone(field)]}};}
test('actual typed width supplies display units, never request-only values',()=>{
 assert.deepEqual(scheduleWidthPresentationV2(input,payload()),['Number column width: 1.125 inches']);
 for(const change of [(p:any)=>delete p.definition,(p:any)=>p.definition.complete=false,(p:any)=>p.schedule.id=42,
  (p:any)=>p.definition.fields[0].attributes.sheetWidthFeet=.2,(p:any)=>p.definition.fields[0].attributes.name='Name']){
  const p=payload();change(p);assert.deepEqual(scheduleWidthPresentationV2(input,p),[]);
 }
});
