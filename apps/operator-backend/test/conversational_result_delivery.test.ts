import assert from "node:assert/strict";
import test from "node:test";
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
    const rendered=renderResultDeliveryV2({items,assessment});
    assert.ok(rendered.startsWith(answer));assert.doesNotMatch(rendered,/## Assessment|Low priority/);assert.match(rendered,/## Model evidence/);
    assert.throws(()=>validateResultDeliveryV2(snapshot,{items,assessment:{...assessment,findings:[{...assessment.findings[0],evidence_indices:[9]}]}}),/assessment/);
    const gap=deriveProgressGapsV2({...snapshot,unresolved_unknown_operation_ids:[],blocking_child_operation_ids:[],in_flight_operation_ids:[],
      pending_input_variable_ids:[],pending_review_ids:[],input_values:{},criteria:{},work_unit_states:{},provider_calls:{},progress_epochs:[]}).find(gap=>gap.gap_id==="result:delivery");
    assert.match(gap!.reason,/actual question|plain language/);
  }
});
