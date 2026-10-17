// Synthetic native-contract fixture, not a recorded Revit success.
export const identity=(id=42,name='Equipment Review')=>({schema:'operator.schedule_definition_identity.v1',complete:true,id,uniqueId:'schedule-'+id,name,kind:'regular',categoryId:-123,isTemplate:false,includeLinkedFiles:false});
export const definition=()=>({
 fields:[{index:0,name:'Mark',parameterId:-1,fieldType:'Instance',heading:'Mark',hidden:false,gridWidth:1,sheetWidth:1,horizontalAlignment:'Left',headingOrientation:'Horizontal',combined:null,format:{useDefault:true}}],
 filters:[],sort:[],
 table:[{section:'Header',NumberOfRows:1,NumberOfColumns:1,rows:[{row:0,heightFeet:0.1,cells:[{column:0,text:'$native-schedule-title$',styleIndex:0,Top:0,Left:0,Bottom:0,Right:0}]}]},{section:'Body',NumberOfRows:0,NumberOfColumns:1,rows:[]}],
 tableStyles:[{values:{FontName:'Arial',TextSize:0.0078125},overrides:{Font:false}}],
 IsItemized:true,phaseId:21,phaseFilterId:51,templateId:-1,
 appearance:{showTitle:true,showHeaders:true,showGrandTotal:false,showGrandTotalTitle:false,showGrandTotalCount:false,grandTotalTitle:'Grand total',filterBySheet:false,includeLinkedFiles:false,titleTextTypeId:1,headerTextTypeId:2,bodyTextTypeId:3}
});
export const signature=(id=42,name='Equipment Review')=>({schema:'operator.schedule_definition_snapshot.v1',complete:true,scope:'flat_definition_without_calculated_fields',identity:identity(id,name),definition:definition()});
