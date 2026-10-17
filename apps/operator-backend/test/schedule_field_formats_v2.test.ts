import test from 'node:test';import assert from 'node:assert/strict';
import {regularSchedulePresentationRequestV2,regularSchedulePresentationReadbackMatchesV2} from '../src/verification/regular_schedule_presentation_v2.js';
import {boundedScheduleFieldFormatsV2} from '../src/verification/schedule_field_formats_v2.js';
function fixture(){
 const field=(id:number,name:string)=>({fieldId:id,isHidden:false,semanticHash:'b'.repeat(64),attributes:{fieldId:id,name,parameterId:-1,parameterUniqueId:null,fieldType:'Instance',isCalculated:false,isCombined:false,heading:name,headingOrientation:'Horizontal',horizontalAlignment:'Center',gridWidthFeet:.2,sheetWidthFeet:.2,style:{preservedStyleHash:'c'.repeat(64)},parts:[]}});
 const before={schema:'operator.regular_schedule_field_definition.v1',complete:true,scheduleId:41,uniqueId:'view:41',categoryId:-2008013,coverage:'native_field_binding_captured_attributes_filters_sort_defaults_parameters_v1',configurationHash:'a'.repeat(64),fieldOrder:[11,12,13],fields:[field(11,'Description'),field(12,'Count'),field(13,'Remarks')]};
 const after=structuredClone(before);after.fields[0]!.attributes.heading='DESCRIPTION';after.fields[0]!.attributes.gridWidthFeet=.3;after.fields[0]!.attributes.sheetWidthFeet=.3;after.fields[0]!.semanticHash='d'.repeat(64);after.fields[1]!.isHidden=true;
 const presentation={schema:'operator.regular_schedule_presentation.v1',complete:true,fieldOrder:[11,12,13]};
 const input={method:'POST',path:'/revit/configure-schedule',body:{scheduleId:41,fieldFormats:[{field:'Description',heading:'DESCRIPTION',widthFeet:.3,horizontalAlignment:'center'},{field:'Count',hidden:true}],dryRun:false}};
 const applied={status:'Success',dryRun:false,schedule:{id:41,uniqueId:'view:41'},transaction:{committed:true,modified_element_ids:[41],added_element_ids:[],deleted_element_ids:[]},changeTracking:{exhaustiveChangeInventory:true},definitionBefore:before,definitionAfter:after,presentationReadback:presentation};
 const read={status:'Ok',action:'presentation',read_only:true,schedule:{id:41,uniqueId:'view:41',kind:'schedule'},definition:structuredClone(after),presentation:structuredClone(presentation)};
 return {input,applied,read};
}
test('headings, width and hidden display require separate full native read and preserved bindings',()=>{
 const f=fixture();assert(regularSchedulePresentationRequestV2(f.input));assert(regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read));
 const missing=structuredClone(f);delete (missing.applied as any).definitionBefore;
 assert.equal(regularSchedulePresentationReadbackMatchesV2(missing.input,missing.applied,missing.read),false,'Older receipts without census remain unverified; never retrofit proof');
});
for(const [name,mutate] of Object.entries({
 heading:(f:any):void=>{f.read.definition.fields[0].attributes.heading='wrong';},
 stale_width:(f:any):void=>{f.read.definition.fields[0].attributes.sheetWidthFeet=.2;},
 hidden:(f:any):void=>{f.read.definition.fields[1].isHidden=false;},
 foreign_binding:(f:any):void=>{f.applied.definitionBefore.fields[0].attributes.parameterId=-2;},
 collateral:(f:any)=>{f.applied.definitionAfter.fields[2].attributes.heading='changed';f.read.definition.fields[2].attributes.heading='changed';},
 style:(f:any)=>{f.applied.definitionAfter.fields[0].attributes.style.preservedStyleHash='f'.repeat(64);f.read.definition.fields[0].attributes.style.preservedStyleHash='f'.repeat(64);},
 configuration:(f:any)=>{f.applied.definitionAfter.configurationHash='f'.repeat(64);f.read.definition.configurationHash='f'.repeat(64);},
 field_removed:(f:any)=>{f.applied.definitionAfter.fields.pop();f.read.definition.fields.pop();},
 duplicate_name:(f:any):void=>{f.applied.definitionBefore.fields[2].attributes.name='Description';},
 unknown_inventory:(f:any):void=>{f.applied.transaction.modified_element_ids.push(100);},
 incomplete:(f:any):void=>{f.read.definition.complete=false;},
 wrong_target:(f:any):void=>{f.read.schedule.uniqueId='different';},
 pending:(f:any):void=>{f.applied.transaction.pending=true;},
 echo:(f:any)=>{f.read={...f.input.body,status:'Ok'};}
}))test('format check refuses '+name,()=>{const f=fixture();mutate(f);assert.equal(regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read),false);});
test('format requests refuse ambiguous/unsupported/mixed shapes before automatic proof',()=>{
 for(const value of [[],[{field:'Count'}],[{field:'Count',hidden:'true'}],[{field:'Count',hidden:null}],[{field:'Count',hidden:true},{field:' count ',hidden:false}],
  [{field:'Description',widthFeet:0}],[{field:'Description',horizontalAlignment:'diagonal'}],[{field:'Description',headingOrientation:'diagonal'}],
  [{field:'Description',heading:null}],[{field:'Description',textColorRgb:[0,0,0]}]])assert.equal(boundedScheduleFieldFormatsV2(value),null);
 for(const extra of [{filters:[]},{fieldOrder:[11,12,13]},{appearance:{}},{columnWidths:[]},{dryRun:true}]){
  const f=fixture();assert.equal(regularSchedulePresentationRequestV2({body:{...f.input.body,...extra}}),null);
 }
});
