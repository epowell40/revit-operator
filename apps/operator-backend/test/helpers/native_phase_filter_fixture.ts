const GET='method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)';
const CREATE='method:Autodesk.Revit.DB.PhaseFilter.Create(Autodesk.Revit.DB.Document,System.String)';
const SET='method:Autodesk.Revit.DB.PhaseFilter.SetPhaseStatusPresentation(Autodesk.Revit.DB.ElementOnPhaseStatus,Autodesk.Revit.DB.PhaseStatusPresentation)';
const READ='method:Autodesk.Revit.DB.PhaseFilter.GetPhaseStatusPresentation(Autodesk.Revit.DB.ElementOnPhaseStatus)';
const statuses=['New','Existing','Demolished','Temporary'];
export function phaseFilterFixtureV2(){
 const input:any={method:'POST',path:'/revit/native-api-mutation-ops',body:{operations:[
  {id:'document',op:'get_property',target:'uidoc',property:'Document'},
  {id:'f',op:'call',memberId:CREATE,args:[{$ref:'document'},'New only']},
  ...statuses.map(s=>({id:s.toLowerCase(),op:'call',target:'$f',memberId:SET,args:[s,s==='New'?'ShowByCategory':'DontShow']}))],
  returns:['$f'],transaction:{mode:'commit',allowCreate:true,allowedExistingElementIds:[11],maxAffectedElements:16}}};
 const read:any={method:'POST',path:'/revit/native-api-ops',body:{operations:[{id:'filter',op:'call',target:'doc',memberId:GET,args:[51]},
  ...statuses.map(s=>({id:s.toLowerCase(),op:'call',target:'$filter',memberId:READ,args:[s]}))],returns:['$filter',...statuses.map(s=>'$'+s.toLowerCase())]}};
 const identity={id:51,unique_id:'phase-filter-native-unique-51',name:'New only',category:null};
 const receiver={schema:'operator.native_element_receiver.v1',element_id:51,unique_id:identity.unique_id,type_name:'Autodesk.Revit.DB.PhaseFilter',active_document:true};
 const applied:any={version:'operator.native_api_mutation_ops.v1',ok:true,read_only:false,geometry_cleanup_errors:[],operation_count:6,mutation_operation_count:5,
  operations:input.body.operations.map((op:any,i:number)=>({id:op.id,op:op.op,member_id:op.memberId??null,property:op.property??null,
   target_type:i===0?'Autodesk.Revit.UI.UIDocument':i===1?null:'Autodesk.Revit.DB.PhaseFilter',target_identity:i>1?structuredClone(receiver):null,
   result_preview:i===0?{title:'Fixture'}:i===1?structuredClone(identity):null})),results:{f:structuredClone(identity)},transaction:{mode:'commit',status:'committed',committed:true,dry_run:false,
   scope_enforcement:'failure_processing_allowed_commit',scope_observer_executions:1,scope_baseline:'complete_native_document_ids_before_transaction',scope_baseline_element_count:1000,
   max_affected_elements:16,allow_create:true,allowed_existing_element_ids:[11],existing_scope_matched:true,scope_discovery_only:false,unexpected_existing_element_ids:[],
   commit_allowed_existing_element_ids:[11],added_element_ids:[51],modified_element_ids:[11],deleted_element_ids:[],affected_element_count:2,transient_created_ids:[]}};
 const readback:any={version:'operator.native_api_ops.v2',ok:true,read_only:true,geometry_cleanup_errors:[],operation_count:5,
  operations:read.body.operations.map((op:any,i:number)=>({id:op.id,op:op.op,member_id:op.memberId,target_type:i===0?'Autodesk.Revit.DB.Document':'Autodesk.Revit.DB.PhaseFilter',
   target_identity:i===0?null:structuredClone(receiver),result_preview:i===0?structuredClone(identity):op.args[0]==='New'?'ShowByCategory':'DontShow'})),
  results:{filter:structuredClone(identity),new:'ShowByCategory',existing:'DontShow',demolished:'DontShow',temporary:'DontShow'}};
 return {input,read,applied,readback,affected:['element_id:11','element_id:51']};
}
