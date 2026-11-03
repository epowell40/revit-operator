import fs from 'node:fs';
export function textMoveScheduleFixture() {
 const f=JSON.parse(fs.readFileSync('test/fixtures/text-move-schedule-preservation-54.json','utf8'));
 const ids=f.native_apply.transaction.modified_element_ids.filter((id:number)=>!f.input.body.ids.includes(id));
 // Hypothetical future observations. The actual retained read/commit stay unchanged.
 const rows=ids.map((id:number)=>({elementId:id,uniqueId:`native-schedule-${id}`,complete:true,scope:'flat_definition_table_parameters',
  definition:{schema:'operator.schedule_definition_snapshot.v1',complete:true,identity:{id,uniqueId:`native-schedule-${id}`,kind:'regular'},definition:{fields:[],table:[],tableStyles:[]}},parameters:[]}));
 const applied=structuredClone(f.native_apply),read=structuredClone(f.actual_reads.find((r:any)=>r.result));
 applied.schedulePreservation={schema:'operator.annotation_schedule_preservation.v1',complete:true,scheduleIds:ids,before:rows,after:structuredClone(rows)};
 read.schedulePreservation={schema:'operator.annotation_schedule_read.v1',complete:true,requestedElementIds:ids,items:structuredClone(rows)};
 for(const r of read.result)if(ids.includes(r.id))r.uniqueId=`native-schedule-${r.id}`;
 return {...f,applied,read,ids};
}
