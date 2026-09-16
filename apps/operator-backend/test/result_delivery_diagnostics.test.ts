import assert from "node:assert/strict";
import test from "node:test";
import { validateResultDeliveryV2, renderResultDeliveryV2 } from "../src/domain/assignment-kernel/result_delivery.js";

test("navigation presents eligible sheet values while current-context control evidence remains ineligible", () => {
  const binding={session_id:"session",assignment_id:"assignment",run_id:"run",generation:1,principal_id:"principal",document_fingerprint:"model"};
  const snapshot:any={spec:{result_delivery_required:true,requested_effect:"read"},current_binding:binding,
    observations:{context:{binding,operation_id:"context-read",authority:"native-host",evidence_class:"control",raw_payload_ref:"evidence:context",raw_payload_hash:"context-hash"},
      capture:{binding,operation_id:"sheet-capture",authority:"native-host",evidence_class:"task_result",raw_payload_ref:"evidence:capture",raw_payload_hash:"capture-hash"}},
    operations:{"context-read":{requested_effect:"read",settlement_state:"settled",result:{status:"succeeded",persistent_effect:"none"}},
      "sheet-capture":{requested_effect:"read",settlement_state:"settled",result:{status:"succeeded",persistent_effect:"none"}}}};
  const context:any={label:"Active Revit view",observation_id:"context",path:["document","activeView","name"],value:"HVAC L2 - Team Review",evidence_ref:"evidence:context",payload_hash:"context-hash"};
  const sheet:any={label:"Sheet",observation_id:"capture",path:["sheetNumber"],value:"M102",evidence_ref:"evidence:capture",payload_hash:"capture-hash"};
  const title={...sheet,label:"Title",path:["export","viewName"],value:"HVAC L2 - Team Review"};
  for(const items of [[context],[sheet,context]])
    assert.throws(()=>validateResultDeliveryV2(snapshot,{items}),/assignment_result_observation_ineligible/);
  validateResultDeliveryV2(snapshot,{items:[sheet,title]});
  assert.equal(renderResultDeliveryV2({items:[sheet,title]}),"- Sheet: M102\n- Title: HVAC L2 - Team Review");
  assert.equal(snapshot.observations.context.evidence_class,"control", "presentation cannot promote native context into task evidence");
});

test("failed read diagnostics are reportable with explicit failure labels, while fabricated success, writes and foreign evidence remain ineligible", () => {
  const binding={session_id:"session",assignment_id:"assignment",run_id:"run",generation:1,principal_id:"principal",document_fingerprint:"model"};
  const snapshot:any={spec:{result_delivery_required:true,requested_effect:"read"},current_binding:binding,
    observations:{o:{binding,operation_id:"operation",authority:"dynamic-runtime",evidence_class:"task_result",raw_payload_ref:"evidence:e",raw_payload_hash:"hash"}},
    operations:{operation:{requested_effect:"read",settlement_state:"settled",result:{status:"failed_after_dispatch",persistent_effect:"none"}}}};
  const delivery:any={items:[{label:"Exception line",observation_id:"o",path:["diagnostics",0,"line"],value:8,evidence_ref:"evidence:e",payload_hash:"hash",presentation_kind:"diagnostic"}]};
  validateResultDeliveryV2(snapshot,delivery);
  assert.equal(renderResultDeliveryV2(delivery),"- Exception line (failed run): 8");
  for(const variant of ["success-label","report-field","write","unknown-effect","unsettled","foreign","control","native","hash","fake-diagnostic"]) {
    const s=structuredClone(snapshot), d=structuredClone(delivery);
    if(variant==="success-label") delete d.items[0].presentation_kind;
    if(variant==="report-field") d.items[0].path=["report"];
    if(variant==="write") s.operations.operation.requested_effect="apply";
    if(variant==="unknown-effect") s.operations.operation.result.persistent_effect="unknown";
    if(variant==="unsettled") s.operations.operation.settlement_state="retaining_observation";
    if(variant==="foreign") s.observations.o.binding={...binding,session_id:"other"};
    if(variant==="control") s.observations.o.evidence_class="control";
    if(variant==="native") s.observations.o.authority="native-host";
    if(variant==="hash") d.items[0].payload_hash="forged";
    if(variant==="fake-diagnostic") s.operations.operation.result.status="succeeded";
    assert.throws(()=>validateResultDeliveryV2(s,d),/ineligible|invalid/,variant);
  }
});
