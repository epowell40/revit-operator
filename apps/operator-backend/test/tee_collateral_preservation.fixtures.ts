export function teeCollateralSnapshot(){return {schema:'operator.tee_collateral.v1',complete:true,scope:'unchanged_connected_system_public_state',rows:[{
 elementId:1402993,uniqueId:'remote-1402993',role:'physical',parentIds:[],state:{
  metadata:{elementId:1402993,uniqueId:'remote-1402993',className:'Autodesk.Revit.DB.Mechanical.Duct'},
  geometry:{UniqueId:'remote-1402993',geometryKind:'Line',points:[[0,0,0],[1,0,0]],ports:[{}]},parameters:[],
  connections:[{origin:[0,0,0],basisX:[1,0,0],basisY:[0,1,0],basisZ:[0,0,1],peers:[]}]}
 }]};}
export function addTeeCollateral(f:any){
 f.apply.transaction.modified_element_ids.push(1402993);f.apply.transaction.affected_element_ids.push(1402993);f.affected.push('element_id:1402993');
 f.apply.preservationBefore.collateral=teeCollateralSnapshot();f.scan.teeReplacementState.collateral=teeCollateralSnapshot();
 for(const s of [f.apply.preservationBefore,f.scan.teeReplacementState])s.system.network.push({elementId:1402993,uniqueId:'remote-1402993'});
 f.apply.preservationAfter=structuredClone(f.scan.teeReplacementState);
}
