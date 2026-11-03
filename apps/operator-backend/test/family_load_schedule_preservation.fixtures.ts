import fs from 'node:fs';
export function retainedFamilyLoad509(){return JSON.parse(fs.readFileSync('test/fixtures/family-load-collateral-509.json','utf8'));}
/** Prospective synthetic observations: never backfilled into retained evidence. */
export function withFamilySchedulePreservation(f:any){
 const ids=[1420970,1422218,1488968,1521719,1521731,1543793];
 f.apply.transaction.modified_element_ids=ids;
 f.apply.transaction.affected_element_ids=[...f.apply.transaction.added_element_ids,...ids];
 const rows=ids.map(id=>({elementId:id,uniqueId:`native-schedule-${id}`,complete:true,scope:'flat_definition_table_parameters',
  definition:{schema:'operator.schedule_definition_snapshot.v1',complete:true,identity:{id,uniqueId:`native-schedule-${id}`,kind:'regular'},definition:{fields:[],table:[],tableStyles:[]}},parameters:[]}));
 f.apply.schedulePreservation={schema:'operator.annotation_schedule_preservation.v1',complete:true,scheduleIds:ids,before:rows,after:structuredClone(rows)};
 f.read.body={elementIds:[...f.apply.transaction.affected_element_ids],preservationScheduleIds:ids};
 f.payload.result=f.payload.result.filter((r:any)=>!ids.includes(r.id)).concat(ids.map(id=>({id,found:true,uniqueId:`native-schedule-${id}`,className:'ViewSchedule',fullClassName:'Autodesk.Revit.DB.ViewSchedule',name:'Schedule'})));
 f.payload.schedulePreservation={schema:'operator.annotation_schedule_read.v1',complete:true,requestedElementIds:ids,items:structuredClone(rows)};
 return f;
}
export function familyScheduleFixture(){const r=retainedFamilyLoad509();return withFamilySchedulePreservation({input:r.input,apply:r.apply,read:r.reads[0].input,payload:r.reads[0].payload});}
