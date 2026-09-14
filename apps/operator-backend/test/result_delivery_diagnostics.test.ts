import assert from "node:assert/strict";
import test from "node:test";
import { validateResultDeliveryV2, renderResultDeliveryV2 } from "../src/domain/assignment-kernel/result_delivery.js";

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
