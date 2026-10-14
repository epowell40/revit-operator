import test from "node:test";
import assert from "node:assert/strict";
import { projectParameterTable } from "../src/evidence/parameter_table_projection.js";
import { projectEvidence } from "../src/evidence/evidence_projection.js";
import { EVIDENCE_REF_SCHEMA, type EvidenceRefV1 } from "../src/evidence/evidence_ref.js";
import { assembleBoundedEvidenceContext, modelEvidenceEnvelope } from "../src/evidence/model_context_budget.js";

const ref: EvidenceRefV1 = { schema:EVIDENCE_REF_SCHEMA,evidence_id:"evidence:synthetic",content_hash:"sha256:synthetic",
  byte_count:1,media_type:"application/json",source:"native:parameter-page",trust_level:"authoritative_native",
  assignment_id:"a",run_id:"r",attempt_id:"t",generation:1,session_id:"s",target_scope:[],bounded_summary:"",
  key_typed_facts:{},artifact_location:"synthetic",redaction_status:"not_needed",secret_screening_status:"passed",
  created_at_utc:"2026-10-13T00:00:00Z",verification_relevance:"supporting",relationships:[] };
function fixture(count:number, value="General load description") {
  return { selector:"categories",hostModelOnly:true,instanceOnly:true,categories:[{name:"Electrical Circuits",id:-2008037}],
    offset:10,returnedCount:count,totalMatched:447,hasMore:true,nextOffset:10+count,includeEmpty:true,
    items:Array.from({length:count},(_,i)=>({id:10000+i,uniqueId:`unique-${i}-00000000-0000-0000-0000-000000000000`,
      name:String(i),category:"Electrical Circuits",categoryId:-2008037,parameters:{"Load Name":value},
      parameterDetails:[{name:"Load Name",value,valueString:value,storageType:"String",isReadOnly:false,parameterId:-1140105}] })) };
}
function reconstruct(table:any) {
  return {...table.native_query,items:table.rows.map((row:any)=>({...row.identity,parameters:row.parameters,
    parameterDetails:row.values.map(([index,hasValue,value,hasString,valueString]:any[])=>({
      ...table.parameter_metadata[index],...(hasValue?{value}:{}),...(hasString?{valueString}:{}) })) }))};
}
test("complete parameter page retains exact values and metadata in bounded provider context",()=>{
  const raw=fixture(18,"General receptacle load");
  const p=projectEvidence(ref,raw,8192);
  const table=p.inline_payload as any;
  assert.equal(table.schema,"revit-operator.parameter-table-presentation/v1");
  assert.deepEqual(reconstruct(table),raw);assert.equal(table.coverage.page_rows_complete,true);
  assert.equal(table.coverage.query_has_more,true);assert.equal(p.truncated,false);assert(p.projected_bytes<=8192);
  const context=assembleBoundedEvidenceContext({projections:[p],session_id:"s",assignment_id:"a"});
  const delivered=modelEvidenceEnvelope(context.projections,context.omitted);
  assert.deepEqual(delivered.evidence_projections[0]!.inline_payload,table);
  assert.equal(delivered.evidence_projections[0]!.trust_level,"authoritative_native");
  assert.equal(delivered.evidence_projections[0]!.content_hash,ref.content_hash);
});
test("byte-limited rows have explicit retained-evidence cursor and never imply complete page or query",()=>{
  const raw=fixture(100,"長い項目 αβγ ".repeat(8));
  const p=projectEvidence(ref,raw,8192),table=p.inline_payload as any;
  assert.equal(table.schema,"revit-operator.parameter-table-presentation/v1");
  assert(table.rows.length>0&&table.rows.length<100);assert.equal(p.truncated,true);
  assert.equal(table.coverage.page_rows_complete,false);assert.equal(table.coverage.native_returned_rows,100);
  assert.equal(table.remaining_rows.start,table.rows.length);assert.equal(table.remaining_rows.path,"payload.items");
  assert.equal(table.native_query.offset,10);assert.equal(table.native_query.nextOffset,110);
  assert.deepEqual(reconstruct(table).items,raw.items.slice(0,table.rows.length));assert(p.projected_bytes<=8192);
});
test("null, empty, absent and duplicate-named parameter entries retain distinct native metadata",()=>{
  const raw:any=fixture(1);raw.items[0].parameterDetails=[
    {name:"X",storageType:"String",isReadOnly:false,parameterId:1,value:null,valueString:""},
    {name:"X",storageType:"String",isReadOnly:true,parameterId:2,value:""},
    {name:"Y",storageType:"None",isReadOnly:true,parameterId:3}];
  const table=projectParameterTable(raw,8192);assert(table);assert.deepEqual(reconstruct(table),raw);
});
test("malformed, untrusted or oversized native values are not silently promoted or cut",()=>{
  for(const raw of [{...fixture(1),returnedCount:2},{...fixture(1),hostModelOnly:false},
    {...fixture(1),items:[fixture(1).items[0],fixture(1).items[0]]}, {...fixture(1),selector:"invented"}])
    assert.equal(projectParameterTable(raw,8192),null);
  const raw=fixture(18);
  assert.equal(projectEvidence({...ref,trust_level:"untrusted_caller"},raw,8192).inline_payload,undefined);
  const huge=fixture(1,"a".repeat(12000));const p=projectEvidence(ref,huge,8192);
  assert.equal(p.inline_payload,undefined);assert.equal(p.truncated,true);assert(p.projected_bytes<=8192);
});
