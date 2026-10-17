export function rowFixture(){
 const field={fieldId:11,isHidden:false,semanticHash:'b'.repeat(64),attributes:{fieldId:11,name:'Description',parameterId:-1,fieldType:'Instance',isCalculated:false,isCombined:false,heading:'Description',gridWidthFeet:.2,sheetWidthFeet:.2,style:{preservedStyleHash:'c'.repeat(64)},parts:[]}};
 const def={schema:'operator.regular_schedule_field_definition.v1',complete:true,scheduleId:41,uniqueId:'view:41',categoryId:-1,coverage:'native_field_binding_captured_attributes_filters_sort_defaults_parameters_v1',configurationHash:'a'.repeat(64),fieldOrder:[11],fields:[field]};
 const before={schema:'operator.regular_schedule_row_heights.v1',complete:true,scheduleId:41,uniqueId:'view:41',sections:['Header','Body','Summary','Footer'].map((section,i)=>({section,validSection:i<2,firstRowNumber:i<2?0:null,rowCount:i<2?2:0,rows:i<2?[{rowNumber:0,heightFeet:.036},{rowNumber:1,heightFeet:.02}]:[]}))};
 const after=structuredClone(before);after.sections[0]!.rows[0]!.heightFeet=.048;
 const presentation={schema:'operator.regular_schedule_presentation.v1',complete:true,fieldOrder:[11],showTitle:true,showHeaders:true};
 const input={method:'POST',path:'/revit/configure-schedule',body:{scheduleId:41,rowHeights:[{section:'Header',rowNumber:0,heightFeet:.048}],dryRun:false}};
 const applied={status:'Success',dryRun:false,schedule:{id:41,uniqueId:'view:41'},transaction:{committed:true,modified_element_ids:[41],added_element_ids:[],deleted_element_ids:[]},changeTracking:{exhaustiveChangeInventory:true},definitionBefore:def,definitionAfter:structuredClone(def),presentationBefore:presentation,presentationReadback:structuredClone(presentation),rowHeightsBefore:before,rowHeightsAfter:after,
  applied:{rowHeights:[{section:'header',rowNumber:0,status:'Applied',beforeHeightFeet:.036,heightFeet:.048,afterHeightFeet:.048}]}};
 const read={status:'Ok',action:'presentation',read_only:true,schedule:{id:41,uniqueId:'view:41',kind:'schedule'},definition:structuredClone(def),presentation:structuredClone(presentation),rowHeights:structuredClone(after)};
 return {input,applied,read};
}
