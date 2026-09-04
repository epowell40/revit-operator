import assert from "node:assert/strict";
import test from "node:test";

import {
  OPERATION_TARGET_SELECTOR_V2_SCHEMA,
  VERIFICATION_CAPABILITY_ADMISSION_V2_SCHEMA,
  operationTargetSelectorV2,
  verificationCapabilityAdmissionV2,
  verificationCapabilityGuidanceV2
} from "../src/verification/verification_capability_admission_v2.js";

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

test("parameter mutation verification requires a reviewed parameter-value readback", () => {
  const genericApply = { capability_id: "revit_call_tool", method: "POST", path: "/revit/set-parameter" };
  const incapable = verificationCapabilityAdmissionV2({
    apply: genericApply,
    verification: { capability_id: "revit_call_tool", method: "POST", path: "/revit/get-element-summary" }
  });
  assert.equal(incapable.admissible, false);
  assert.equal(incapable.reason, "required_semantic_output_unavailable");
  assert.deepEqual(incapable.required_semantic_outputs, ["element.parameter_values"]);

  const genericReadback = verificationCapabilityAdmissionV2({
    apply: genericApply,
    verification: { capability_id: "revit_call_tool", method: "POST", path: "/revit/get-parameters" }
  });
  assert.equal(genericReadback.admissible, true);
  assert.deepEqual(genericReadback.provided_semantic_outputs, ["element.parameter_values"]);

  const typedReadback = verificationCapabilityAdmissionV2({
    apply: { capability_id: "revit_set_parameters" },
    verification: { capability_id: "revit_get_parameters" }
  });
  assert.equal(typedReadback.admissible, true);
  assert.deepEqual(typedReadback.required_semantic_outputs, ["element.parameter_values"]);
  assert.deepEqual(typedReadback.provided_semantic_outputs, ["element.parameter_values"]);

  const arbitraryTypedRead = verificationCapabilityAdmissionV2({
    apply: { capability_id: "revit_set_parameters" },
    verification: { capability_id: "revit_list_elements" }
  });
  assert.equal(arbitraryTypedRead.admissible, false);
  assert.equal(arbitraryTypedRead.reason, "required_semantic_output_unavailable");
});

test("typed TextNote aliases use the same reviewed semantic contract as generic routing", () => {
  const admitted = verificationCapabilityAdmissionV2({
    apply: { capability_id: "revit_replace_text_note" },
    verification: { capability_id: "revit_find_text_notes" }
  });
  assert.equal(admitted.admissible, true);
  assert.deepEqual(admitted.required_semantic_outputs, ["text_note.value"]);
  assert.deepEqual(admitted.provided_semantic_outputs, ["text_note.value"]);
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

test("Candidate 68 separates exact affected TextNote identity from contextual view scope", () => {
  const selected = operationTargetSelectorV2({
    operation: { capability_id: "revit_call_tool", method: "POST", path: "/revit/find-text-notes" },
    value: { elementIds: [1478627], viewId: 1363433, query: "ISSUE 04", matchMode: "exact", max: 1 },
    fallback_target_tokens: ["id:1363433", "id:1478627", "viewid:1363433", "elementid:1478627"]
  });
  assert.equal(selected.schema, OPERATION_TARGET_SELECTOR_V2_SCHEMA);
  assert.equal(selected.source, "reviewed_capability_contract");
  assert.deepEqual(selected.principal_target_tokens, ["elementids:1478627", "id:1478627"]);
  assert.deepEqual(selected.contextual_scope_tokens, ["id:1363433", "viewid:1363433"]);
});

test("reviewed target selection fails closed on a scope-only read and ignores result owner-view identity", () => {
  const scopeOnly = operationTargetSelectorV2({
    operation: { capability_id: "revit_call_tool", path: "/revit/find-text-notes" },
    value: { viewId: 1363433, textContains: "ISSUE 04" },
    fallback_target_tokens: ["id:1363433", "viewid:1363433"]
  });
  assert.deepEqual(scopeOnly.principal_target_tokens, []);
  assert.deepEqual(scopeOnly.contextual_scope_tokens, ["id:1363433", "viewid:1363433"]);

  const result = operationTargetSelectorV2({
    operation: { capability_id: "revit_call_tool", path: "/revit/find-text-notes" },
    value: {
      request: { elementId: 9999, viewId: 9998 },
      items: [{ elementId: 1478627, ownerViewId: 1363433, text: "ISSUE 04" }]
    }
  });
  assert.deepEqual(result.principal_target_tokens, ["elementid:1478627", "id:1478627"]);
  assert.deepEqual(result.contextual_scope_tokens, ["id:1363433", "ownerviewid:1363433"]);
});

test("parameter readback target identity comes from native items, not echoed request metadata", () => {
  const selected = operationTargetSelectorV2({
    operation: { capability_id: "revit_call_tool", path: "/revit/get-parameters" },
    value: {
      request: { body: { elementIds: [99] } },
      metadata: { requestedElementIds: [99] },
      items: [{ id: 42, parameters: { Manufacturer: "WATTS" } }]
    }
  });
  assert.equal(selected.source, "reviewed_capability_contract");
  assert.deepEqual(selected.principal_target_tokens, ["id:42"]);
});

test("unknown capabilities retain bounded fallback identity while verifier guidance names the exact selector", () => {
  const fallback = operationTargetSelectorV2({
    operation: { capability_id: "another.read", path: "/revit/another-read" },
    value: { viewId: 12 },
    fallback_target_tokens: ["id:12", "viewid:12", "id:12"]
  });
  assert.equal(fallback.source, "legacy_generic_fallback");
  assert.deepEqual(fallback.principal_target_tokens, ["id:12", "viewid:12"]);
  assert.match(verificationCapabilityGuidanceV2({
    capability_id: "revit_call_tool",
    path: "/revit/replace-text-note",
    target_id: "id:1478627"
  }) ?? "", /Bind the exact affected subject.*elementId.*1478627.*viewId do not establish affected-target identity/);
});
