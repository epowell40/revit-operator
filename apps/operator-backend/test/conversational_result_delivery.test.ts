import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { validateResultDeliveryV2, renderResultDeliveryV2 } from "../src/domain/assignment-kernel/result_delivery.js";
import { deriveProgressGapsV2 } from "../src/domain/assignment-kernel/progress/controller.js";

test("C50 mechanical model question requires its conclusion, not a list of sheet facts",()=>{
  const binding={session_id:"conversation",assignment_id:"assignment",run_id:"run",generation:1,principal_id:"principal",document_fingerprint:"model"};
  const snapshot:any={spec:{result_delivery_required:true,result_assessment_required:true,requested_effect:"read",criteria:[],work_units:[]},current_binding:binding,
    observations:{sheets:{binding,operation_id:"read-sheets",authority:"native-host",evidence_class:"task_result",raw_payload_ref:"evidence:sheets",raw_payload_hash:"hash"}},
    operations:{"read-sheets":{requested_effect:"read",settlement_state:"settled",result:{status:"succeeded",persistent_effect:"none"}}}};
  const items:any=[{label:"Sheet count",observation_id:"sheets",path:["count"],value:17,evidence_ref:"evidence:sheets",payload_hash:"hash"},
    {label:"Plan",observation_id:"sheets",path:["sheets",0,"name"],value:"Plan - HVAC - L4",evidence_ref:"evidence:sheets",payload_hash:"hash"}];
  for (const request of ["Is this the mechanical model?","What discipline does this project appear to contain?","Does this look like the HVAC model?"]) {
    snapshot.spec.source_user_request=request;
    assert.throws(()=>validateResultDeliveryV2(snapshot,{items}),/assignment_result_assessment_required/);
    const answer="Yes, this appears to be the mechanical/HVAC model.";
    const assessment:any={overview:answer,findings:[{priority:"low",title:"Model discipline",text:answer,evidence_indices:[1,2]}],
      limitations:["This is based on the sheet set; I have not inspected every modeled system."],questions:[]};
    validateResultDeliveryV2(snapshot,{items,assessment});
    assert.throws(()=>validateResultDeliveryV2(snapshot,{items,assessment:{...assessment,findings:[]}}),/assignment_assessment_invalid/);
    const rendered=renderResultDeliveryV2({items,assessment});
    assert.ok(rendered.startsWith(answer));assert.doesNotMatch(rendered,/## Assessment|Low priority/);assert.match(rendered,/## Details/);
    const explanation="The M-series sheets and HVAC plan names support this finding.";
    const concise=renderResultDeliveryV2({items,assessment:{...assessment,findings:[{...assessment.findings[0],text:explanation}]}});
    assert.equal(concise.split("## Details")[0].includes(explanation),false);
    assert.ok(concise.includes(explanation),"supporting details remain available in the evidence section");
    assert.throws(()=>validateResultDeliveryV2(snapshot,{items,assessment:{...assessment,findings:[{...assessment.findings[0],evidence_indices:[9]}]}}),/assessment/);
    const gap=deriveProgressGapsV2({...snapshot,unresolved_unknown_operation_ids:[],blocking_child_operation_ids:[],in_flight_operation_ids:[],
      pending_input_variable_ids:[],pending_review_ids:[],input_values:{},criteria:{},work_unit_states:{},provider_calls:{},progress_epochs:[]}).find(gap=>gap.gap_id==="result:delivery");
    assert.match(gap!.reason,/actual question|plain language/);
  }
});

test("C55 retained factual answer and resumed three-bullet review keep supporting findings out of the main answer",()=>{
  const fixtures=JSON.parse(fs.readFileSync("test/fixtures/conversation_delivery.v1.json","utf8"));
  for(const fixture of fixtures.cases){
    const {delivery}=fixture;
    const rendered=renderResultDeliveryV2(delivery);
    const [answer,details]=rendered.split("\n\n## Details\n\n");
    assert.equal(answer,delivery.assessment.overview,fixture.id);
    assert.ok(details,"supporting evidence remains expandable");
    assert.doesNotMatch(answer,/priority:|## Assessment|## Not verified/);
    for(const finding of delivery.assessment.findings)assert.ok(details.includes(finding.text));
    for(const limitation of delivery.assessment.limitations)assert.ok(details.includes(limitation));
    for(const item of delivery.items)assert.ok(details.includes(item.label));
    if(fixture.id==="resumed-three-bullet-review"){
      assert.equal(answer.split("\n").filter((line:string)=>line.startsWith("- ")).length,3);
      assert.match(answer,/Project and levels/);assert.match(answer,/could not verify/);
    }
  }
});

test("concise delivery retains essential uncertainty and actionable questions; medium/high concerns stay expanded",()=>{
  const item:any={label:"Checked rooms",observation_id:"read",path:["count"],value:4,evidence_ref:"evidence",payload_hash:"hash"};
  const assessment:any={overview:"Four rooms are missing airflow values; I have not checked the linked model.",
    findings:[{priority:"low",title:"Missing values",text:"All four checked records have blank airflow values.",evidence_indices:[1]}],
    limitations:["Linked rooms were outside the inspected scope."],questions:["Which design airflow should these rooms use?"]};
  let rendered=renderResultDeliveryV2({items:[item],assessment});
  assert.match(rendered.split("## Details")[0],/have not checked the linked model/);
  assert.match(rendered.split("## Details")[0],/Which design airflow/);
  for(const priority of ["medium","high"]){
    rendered=renderResultDeliveryV2({items:[item],assessment:{...assessment,findings:[...assessment.findings,
      {priority,title:"Unresolved design input",text:"Do not size equipment until these loads are supplied.",evidence_indices:[1]}]}});
    const visible=rendered.split("## Model evidence")[0];
    assert.match(visible,/Do not size equipment/);assert.match(visible,/Linked rooms were outside/);assert.match(visible,/Which design airflow/);
    assert.doesNotMatch(rendered,/## Details/);
  }
});
