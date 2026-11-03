export const GET_LINE_OWNER='method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)';
export const BOUND_LINE='method:Autodesk.Revit.DB.Line.CreateBound(Autodesk.Revit.DB.XYZ,Autodesk.Revit.DB.XYZ)';
export const NEW_DETAIL_LINE='method:Autodesk.Revit.Creation.ItemFactoryBase.NewDetailCurve(Autodesk.Revit.DB.View,Autodesk.Revit.DB.Curve)';
export function detailLineGraphFixture(){
 const operations:any[]=[{id:'factory',op:'get_property',target:'doc',property:'Create'},
  {id:'owner',op:'call',target:'doc',memberId:GET_LINE_OWNER,args:[41]},
  {id:'a',op:'call',memberId:BOUND_LINE,args:[{x:1,y:2,z:0},{x:11,y:2,z:0}]},
  {id:'b',op:'call',memberId:BOUND_LINE,args:[{x:2,y:3,z:0},{x:10,y:3,z:0}]},
  {id:'lineA',op:'call',target:'$factory',memberId:NEW_DETAIL_LINE,args:[{$ref:'owner'},{$ref:'a'}]},
  {id:'lineB',op:'call',target:'$factory',memberId:NEW_DETAIL_LINE,args:[{$ref:'owner'},{$ref:'b'}]}];
 const input={method:'POST',path:'/revit/native-api-mutation-ops',body:{operations,returns:['$lineA','$lineB'],transaction:{mode:'commit',name:'Two detail lines',maxAffectedElements:16,allowCreate:true,allowedExistingElementIds:[41]}}};
 const preview=(s:any)=>s.id==='factory'?{type:'Autodesk.Revit.Creation.Document',text:'Autodesk.Revit.Creation.Document'}:s.id==='owner'?{id:41,unique_id:'fixture-view-41',name:'Working detail',category:'Views'}:
  ['a','b'].includes(s.id)?{type:'Autodesk.Revit.DB.Line',text:'Autodesk.Revit.DB.Line'}:{id:s.id==='lineA'?101:102,unique_id:s.id==='lineA'?'fixture-line-101':'fixture-line-102',name:'Detail Lines',category:'Lines'};
 const applied:any={version:'operator.native_api_mutation_ops.v1',ok:true,read_only:false,operation_count:6,mutation_operation_count:2,geometry_cleanup_errors:[],
  operations:operations.map(s=>({id:s.id,op:s.op,member_id:s.memberId??null,property:s.property??null,target_type:s.target==='doc'?'Autodesk.Revit.DB.Document':s.target==='$factory'?'Autodesk.Revit.Creation.Document':null,result_preview:preview(s)})),
  results:{lineA:preview(operations[4]),lineB:preview(operations[5])},
  transaction:{mode:'commit',status:'committed',committed:true,dry_run:false,scope_observation:'dynamic_model_updater_then_failure_preprocessor_at_transaction_boundary',scope_enforcement:'failure_processing_allowed_commit',scope_baseline:'complete_native_document_ids_before_transaction',scope_baseline_element_count:100,scope_observer_executions:1,existing_scope_matched:true,scope_discovery_only:false,allow_create:true,max_affected_elements:16,allowed_existing_element_ids:[41],commit_allowed_existing_element_ids:[41],unexpected_existing_element_ids:[],added_element_ids:[101,102],modified_element_ids:[],deleted_element_ids:[],affected_element_count:2,transient_created_ids:[]}};
 const readInput={method:'POST',path:'/revit/view-owned-detailing',body:{viewId:41,limit:5000}};
 const fresh:any={schema:'revit-operator.view-owned-detailing/v1',scope:'exact_owner_view',requestedViewIds:[41],viewsComplete:true,views:[{
  view:{id:41,uniqueId:'fixture-view-41',name:'Working detail',viewType:'DraftingView',scale:100},limit:5000,totalOwnedCount:2,returnedCount:2,truncated:false,unreadableCount:0,unreadableElementIds:[],unclassifiedCount:0,incompleteTextCount:0,incompleteSignatureCount:0,itemsComplete:true,
  items:[101,102].map((id,i)=>({elementId:id,uniqueId:'fixture-line-'+id,ownerViewId:41,className:'DetailLine',builtInCategory:'OST_Lines',comparisonExcluded:false,semanticSignatureComplete:true,curve:{kind:'Line',start:structuredClone(operations[2+i].args[0]),end:structuredClone(operations[2+i].args[1])}}))}]};
 return {input,applied,readInput,fresh};
}
