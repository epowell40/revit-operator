import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeStructuredExistingConditionsInterpretationV1,
  type StructuredExistingConditionsInterpretationRequestV1
} from "../src/vision/structured_existing_conditions_interpretation.js";

const HASH = "a".repeat(64);

function request(): StructuredExistingConditionsInterpretationRequestV1 {
  return {
    schema_version: 1,
    package_id: "floor-4-east",
    objective: "Reconstruct all visible supply duct in the east work area.",
    views: [
      {
        view_key: "sheet-context",
        analysis_role: "sheet_context",
        source_artifact_sha256: HASH,
        source_page: 4,
        image_sha256: "b".repeat(64),
        page_region: { min_u: 0, min_v: 0, max_u: 1, max_v: 1 },
        discipline_hint: "mechanical"
      },
      {
        view_key: "east-detail",
        analysis_role: "region_detail",
        source_artifact_sha256: HASH,
        source_page: 4,
        image_sha256: "c".repeat(64),
        page_region: { min_u: 0.5, min_v: 0.25, max_u: 0.9, max_v: 0.75 },
        parent_context_view_key: "sheet-context",
        discipline_hint: "mechanical"
      }
    ]
  };
}

function raw() {
  return {
    schema_version: 1,
    package_id: "floor-4-east",
    coordinate_space: "normalized_uv_top_left",
    view_keys: ["sheet-context", "east-detail"],
    source_marks: [{ source_mark_id: "duct-mark-1", source_view_key: "east-detail", disposition_status: "candidate", primitive_ids: ["duct-1"], reason: "" }],
    primitives: [{
      primitive_id: "duct-1",
      source_view_key: "east-detail",
      source_mark_ids: ["duct-mark-1"],
      kind: "route_segment",
      points: [{ u: 0.25, v: 0.2 }, { u: 0.75, v: 0.8 }],
      endpoints: [
        { endpoint_key: "start", point: { u: 0.25, v: 0.2 }, outward_direction_uv: [-1, 0], boundary: "internal", continuation_key: "", continuation_kind: "none" },
        { endpoint_key: "end", point: { u: 0.75, v: 0.8 }, outward_direction_uv: [1, 0], boundary: "view_boundary", continuation_key: "", continuation_kind: "none" }
      ],
      claims: [{ attribute: "system", value: "supply air", confidence: 0.9, basis: "provider_hypothesis" }],
      confidence: { geometry: 0.95, classification: 0.7, topology: 0.85, visibility: 0.98 }
    }],
    open_questions: ["Duct size is not legible in this crop."]
  };
}

test("whole-sheet context and regional detail remain hash-bound and map into canonical page UV", () => {
  const result = normalizeStructuredExistingConditionsInterpretationV1({ request: request(), raw: raw() });

  assert.deepEqual(result.interpretation.view_keys, ["east-detail"]);
  assert.equal(result.receipt.native_write_allowed, false);
  assert.match(result.receipt.source_binding_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.receipt.interpretation_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.receipt.page_primitives[0]?.points, [
    { u: 0.6, v: 0.35 },
    { u: 0.8, v: 0.65 }
  ]);
  assert.deepEqual(result.receipt.page_primitives[0]?.endpoints.map(endpoint => endpoint.endpoint_key), ["duct-1:start", "duct-1:end"]);
  assert.deepEqual(result.open_questions, ["Duct size is not legible in this crop."]);
});

test("context-only images cannot produce reconstruction primitives", () => {
  const invalid = raw();
  invalid.source_marks[0]!.source_view_key = "sheet-context";
  invalid.primitives[0]!.source_view_key = "sheet-context";

  assert.throws(
    () => normalizeStructuredExistingConditionsInterpretationV1({ request: request(), raw: invalid }),
    /structured_sheet_mark_requires_region_detail:duct-mark-1/
  );
});

test("a regional detail must be derived from the declared context page and source hash", () => {
  const invalid = request();
  invalid.views[1] = { ...invalid.views[1]!, source_page: 5 };

  assert.throws(
    () => normalizeStructuredExistingConditionsInterpretationV1({ request: invalid, raw: raw() }),
    /structured_sheet_detail_parent_source_mismatch:east-detail/
  );
});

test("a provider cannot omit a supplied context or detail view from its accounting", () => {
  const invalid = raw();
  invalid.view_keys = ["east-detail"];

  assert.throws(
    () => normalizeStructuredExistingConditionsInterpretationV1({ request: request(), raw: invalid }),
    /structured_sheet_response_view_keys_mismatch/
  );
});
