import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFICATION_CAPABILITY_ADMISSION_V2_SCHEMA,
  verificationCapabilityAdmissionV2
} from "../src/domain/assignment-kernel/verification_admission.js";

test("reviewed TextNote verification requires a result schema that exposes TextNote value", () => {
  const apply = { capability_id: "revit_call_tool", method: "POST", path: "/revit/replace-text-note" };
  const incapable = verificationCapabilityAdmissionV2({
    apply,
    verification: { capability_id: "revit_call_tool", method: "POST", path: "/revit/get-element-summary" }
  });
  assert.equal(incapable.schema, VERIFICATION_CAPABILITY_ADMISSION_V2_SCHEMA);
  assert.equal(incapable.admissible, false);
  assert.equal(incapable.reason, "text_note_value_unavailable");
  assert.deepEqual(incapable.required_semantic_outputs, ["text_note.value"]);
  assert.deepEqual(incapable.provided_semantic_outputs,
    ["element.identity", "element.classification", "element.location"]);

  const capable = verificationCapabilityAdmissionV2({
    apply,
    verification: { capability_id: "revit_call_tool", method: "POST", path: "/revit/find-text-notes" }
  });
  assert.equal(capable.admissible, true);
  assert.deepEqual(capable.provided_semantic_outputs, ["text_note.value"]);
});

test("unrelated and named typed capabilities keep their own verifier contracts", () => {
  assert.equal(verificationCapabilityAdmissionV2({
    apply: { capability_id: "revit_call_tool", path: "/revit/configure-schedule" },
    verification: { capability_id: "revit_call_tool", path: "/revit/schedules" }
  }).reason, "no_reviewed_semantic_output_constraint");
  assert.equal(verificationCapabilityAdmissionV2({
    apply: { capability_id: "element.update" },
    verification: { capability_id: "element.read" }
  }).admissible, true);
});
