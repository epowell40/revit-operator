/** Native response shape retained from a disposable sample-model load.
 * Only the request's workstation path is replaced with a generic workspace. */
export function familyFileLoadVerificationFixtureV2(){
 const familyId=1545058,symbolId=1545319,otherIds=[1545291,1545320],name='Operator Air Terminal Seed339';
 const added=[familyId,...otherIds.slice(0,1),symbolId,...otherIds.slice(1)];
 const input={method:'POST',path:'/revit/load-family',body:{filePath:'C:\\OperatorWorkspace\\artifacts\\families\\Seed.rfa',overwriteParameterValues:false}};
 const apply={loaded:true,familyId,familyName:name,success:true,transaction:{status:'committed',committed:true,
  modified_element_ids:[],affected_element_ids:added,added_element_ids:added,deleted_element_ids:[]},
  changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,eventCount:1,matchingEventCount:1,distinctWrapperMatchCount:1,captureFailureCount:0},
  applied:true,verified:true,ok:true,symbols:[{id:symbolId,name}],status:'Loaded'};
 const uid=(id:number)=>'93c2aa60-7f62-4be8-87ad-23faf7992181-'+id.toString(16).padStart(8,'0');
 const payload={result:[{id:familyId,found:true,uniqueId:uid(familyId),className:'Family',fullClassName:'Autodesk.Revit.DB.Family',category:null,name},
  {id:symbolId,found:true,uniqueId:uid(symbolId),className:'FamilySymbol',fullClassName:'Autodesk.Revit.DB.FamilySymbol',category:'Air Terminal Tags',name},
  ...otherIds.map(id=>({id,found:true,uniqueId:uid(id),className:'Element',fullClassName:'Autodesk.Revit.DB.Element',category:null,name}))]};
 return {input,apply,read:{method:'POST',path:'/revit/get-element-summary',body:{elementIds:added}},payload};
}
