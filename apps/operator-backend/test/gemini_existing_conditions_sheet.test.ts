import assert from "node:assert/strict";
import test from "node:test";
import {
  GEMINI_EXISTING_CONDITIONS_SHEET_RESPONSE_SCHEMA_V1,
  normalizeGeminiExistingConditionsSheetResponseV1,
  type GeminiExistingConditionsSheetRequestV1
} from "../src/vision/gemini_existing_conditions_sheet.js";

function request(): GeminiExistingConditionsSheetRequestV1 {
  return {
    schema_version: 1,
    package_id: "blind-sheet",
    objective: "Inventory the visible mechanical route.",
    views: [{ view_key: "main", image_path: "unused.png", discipline_hint: "mechanical" }]
  };
}

function raw() {
  return {
    schema_version: 1,
    package_id: "blind-sheet",
    coordinate_space: "normalized_uv_top_left",
    view_keys: ["main"],
    source_marks: [{ source_mark_id: "mark-1", source_view_key: "main", disposition_status: "candidate", primitive_ids: ["run-1"], reason: "" }],
    primitives: [{
      primitive_id: "run-1",
      source_view_key: "main",
      source_mark_ids: ["mark-1"],
      kind: "route_segment",
      points: [{ u: 0.1, v: 0.5 }, { u: 0.9, v: 0.5 }],
      endpoints: [
        { endpoint_key: "run-1:start", point: { u: 0.1, v: 0.5 }, outward_direction_uv: [-1, 0], boundary: "internal", continuation_key: "" },
        { endpoint_key: "run-1:end", point: { u: 0.9, v: 0.5 }, outward_direction_uv: [1, 0], boundary: "view_boundary", continuation_key: "" }
      ],
      claims: [
        { attribute: "system", value: "supply air", confidence: 0.98, basis: "legible_source_evidence" },
        { attribute: "elevation", value: "unknown", confidence: 0.2, basis: "unresolved" }
      ],
      confidence: { geometry: 0.98, classification: 0.95, topology: 0.9, visibility: 0.99 }
    }],
    open_questions: ["Route elevation is not visible."]
  };
}

test("strict Gemini sheet output normalizes into provider-neutral pixel observations", () => {
  const result = normalizeGeminiExistingConditionsSheetResponseV1({ request: request(), raw: raw() });

  assert.equal(result.interpretation.coordinate_space, "normalized_uv_top_left");
  assert.equal(result.interpretation.primitives[0]?.claims?.system?.value, "supply air");
  assert.equal(result.interpretation.primitives[0]?.claims?.elevation?.basis, "unresolved");
  assert.equal(result.interpretation.primitives[0]?.endpoints?.[1]?.continuation_key, undefined);
  assert.deepEqual(result.open_questions, ["Route elevation is not visible."]);
});

test("provider cannot add a source view that was not supplied by the host", () => {
  const invalid = raw();
  invalid.view_keys = ["invented"];
  assert.throws(
    () => normalizeGeminiExistingConditionsSheetResponseV1({ request: request(), raw: invalid }),
    /gemini_sheet_response_view_keys_mismatch/
  );
});

test("provider cannot approve its own exclusions", () => {
  const invalid: any = raw();
  invalid.source_marks[0].disposition_status = "approved_exclusion";
  assert.throws(
    () => normalizeGeminiExistingConditionsSheetResponseV1({ request: request(), raw: invalid }),
    /gemini_sheet_mark_disposition_invalid:mark-1/
  );
});

test("structured schema makes all topology and confidence fields explicit", () => {
  const primitive = (GEMINI_EXISTING_CONDITIONS_SHEET_RESPONSE_SCHEMA_V1.properties.primitives.items as any);
  assert.deepEqual(primitive.required, ["primitive_id", "source_view_key", "source_mark_ids", "kind", "points", "endpoints", "claims", "confidence"]);
  assert.equal(primitive.properties.points.items.properties.u.minimum, 0);
  assert.equal(primitive.properties.points.items.properties.u.maximum, 1);
  assert.deepEqual(primitive.properties.endpoints.items.properties.boundary.enum, ["internal", "view_boundary", "sheet_continuation"]);
});

test("provider schema stays inside Gemini's supported OpenAPI subset", () => {
  const serialized = JSON.stringify(GEMINI_EXISTING_CONDITIONS_SHEET_RESPONSE_SCHEMA_V1);
  assert.equal(serialized.includes("additionalProperties"), false);
  assert.deepEqual(GEMINI_EXISTING_CONDITIONS_SHEET_RESPONSE_SCHEMA_V1.properties.schema_version, {
    type: "integer",
    minimum: 1,
    maximum: 1
  });
});

test("a graphical point symbol cannot self-certify its native type", () => {
  const point = raw();
  point.primitives[0]!.kind = "point_symbol";
  point.primitives[0]!.points = [{ u: 0.5, v: 0.5 }];
  point.primitives[0]!.endpoints = [];
  point.primitives[0]!.claims = [
    { attribute: "type", value: "duplex receptacle", confidence: 0.99, basis: "legible_source_evidence" }
  ];

  const result = normalizeGeminiExistingConditionsSheetResponseV1({ request: request(), raw: point });

  assert.equal(result.interpretation.primitives[0]?.claims?.type?.basis, "provider_hypothesis");
  assert.equal(result.interpretation.primitives[0]?.claims?.type?.confidence, 0.5);
  assert.equal(result.interpretation.primitives[0]?.confidence.classification, 0.5);
  assert.ok(result.open_questions.some(value => value.includes("requires a legible annotation or approved project mapping")));
});

test("provider-hypothesis point symbols remain classification-capped", () => {
  const point = raw();
  point.primitives[0]!.kind = "point_symbol";
  point.primitives[0]!.points = [{ u: 0.5, v: 0.5 }];
  point.primitives[0]!.endpoints = [];
  point.primitives[0]!.claims = [
    { attribute: "type", value: "duplex receptacle", confidence: 0.8, basis: "provider_hypothesis" }
  ];

  const result = normalizeGeminiExistingConditionsSheetResponseV1({ request: request(), raw: point });

  assert.equal(result.interpretation.primitives[0]?.claims?.type?.basis, "provider_hypothesis");
  assert.equal(result.interpretation.primitives[0]?.confidence.classification, 0.5);
  assert.ok(result.open_questions.some(value => value.includes("classification remains provisional")));
});
