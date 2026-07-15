import test from "node:test";
import assert from "node:assert/strict";
import {
  validateBoundedMepRegionCoverageV1,
  type BoundedMepRegionCoverageContext,
  type BoundedMepRegionCoverageV1
} from "../src/existing_conditions/mep_region_coverage.js";

const SOURCE_HASH = "a".repeat(64);
const RENDER_HASH = "b".repeat(64);

function context(): BoundedMepRegionCoverageContext {
  return {
    scope_id: "bounded-room-zeta",
    source_evidence_sha256: SOURCE_HASH,
    registered_render_sha256: RENDER_HASH,
    render_width_px: 1000,
    render_height_px: 800,
    package_discipline: "mixed",
    observations: [
      { observation_id: "pipe-random-31", kind: "pipe_route", discipline: "plumbing" },
      { observation_id: "fixture-random-72", kind: "plumbing_fixture", discipline: "plumbing" },
      { observation_id: "device-random-18", kind: "electrical_device", discipline: "electrical" },
      { observation_id: "circuit-random-44", kind: "electrical_circuit", discipline: "electrical" }
    ]
  };
}

function coverage(): BoundedMepRegionCoverageV1 {
  return {
    schema_version: 1,
    scope_id: "bounded-room-zeta",
    source_evidence_sha256: SOURCE_HASH,
    registered_render_sha256: RENDER_HASH,
    coordinate_space: "registered_render_pixels_top_left",
    region: { min: { x: 100, y: 100 }, max: { x: 900, y: 700 } },
    disciplines: ["plumbing", "electrical"],
    candidates: [
      {
        candidate_id: "trace-random-801",
        primitive: "linear_trace",
        pixel_bounds: { min: { x: 150, y: 200 }, max: { x: 650, y: 230 } },
        visibility: "clear",
        disposition: { status: "resolved", observation_ids: ["pipe-random-31"] }
      },
      {
        candidate_id: "symbol-random-802",
        primitive: "point_symbol",
        pixel_bounds: { min: { x: 140, y: 180 }, max: { x: 175, y: 215 } },
        visibility: "clear",
        disposition: { status: "resolved", observation_ids: ["fixture-random-72"] }
      },
      {
        candidate_id: "symbol-random-803",
        primitive: "point_symbol",
        pixel_bounds: { min: { x: 500, y: 400 }, max: { x: 530, y: 430 } },
        visibility: "clear",
        disposition: { status: "resolved", observation_ids: ["device-random-18"] }
      },
      {
        candidate_id: "annotation-random-804",
        primitive: "circuit_annotation",
        pixel_bounds: { min: { x: 535, y: 390 }, max: { x: 620, y: 430 } },
        visibility: "clear",
        disposition: { status: "resolved", observation_ids: ["circuit-random-44"] }
      }
    ]
  };
}

test("bounded MEP region coverage produces a deterministic complete receipt", () => {
  const first = validateBoundedMepRegionCoverageV1(coverage(), context());
  const second = validateBoundedMepRegionCoverageV1(coverage(), context());
  assert.equal(first.coverage_status, "complete");
  assert.equal(first.candidate_count, 4);
  assert.deepEqual(first.covered_observation_ids, [
    "circuit-random-44",
    "device-random-18",
    "fixture-random-72",
    "pipe-random-31"
  ]);
  assert.equal(first.coverage_contract_sha256, second.coverage_contract_sha256);
  assert.equal(first.region_sha256, second.region_sha256);
});

test("unfamiliar bounded symbols remain spatially explicit and partial", () => {
  const input = coverage();
  input.candidates.push({
    candidate_id: "unknown-random-991",
    primitive: "unknown",
    pixel_bounds: { min: { x: 700, y: 500 }, max: { x: 740, y: 545 } },
    visibility: "partial",
    disposition: {
      status: "unresolved",
      reason: "ambiguous_symbol",
      note: "The mark is visible but does not match an approved plumbing or electrical symbol mapping."
    }
  });
  const result = validateBoundedMepRegionCoverageV1(input, context());
  assert.equal(result.coverage_status, "partial");
  assert.deepEqual(result.unresolved_candidate_ids, ["unknown-random-991"]);
  assert.equal(result.covered_observation_ids.length, 4);
});

test("coverage fails when a proposed observation has no source candidate", () => {
  const input = coverage();
  input.candidates = input.candidates.filter((entry) => entry.candidate_id !== "symbol-random-803");
  assert.throws(
    () => validateBoundedMepRegionCoverageV1(input, context()),
    /observations_without_candidates:device-random-18/
  );
});

test("coverage fails when one observation is linked from multiple candidates", () => {
  const input = coverage();
  input.candidates.push({
    candidate_id: "duplicate-symbol-random-805",
    primitive: "point_symbol",
    pixel_bounds: { min: { x: 600, y: 500 }, max: { x: 630, y: 530 } },
    visibility: "clear",
    disposition: { status: "resolved", observation_ids: ["device-random-18"] }
  });
  assert.throws(
    () => validateBoundedMepRegionCoverageV1(input, context()),
    /observation_linked_multiple_times:device-random-18/
  );
});

test("coverage rejects primitive laundering and resolved unknown marks", () => {
  const wrongPrimitive = coverage();
  wrongPrimitive.candidates[0]!.primitive = "point_symbol";
  assert.throws(
    () => validateBoundedMepRegionCoverageV1(wrongPrimitive, context()),
    /candidate_primitive_mismatch/
  );

  const resolvedUnknown = coverage();
  resolvedUnknown.candidates[0]!.primitive = "unknown";
  assert.throws(
    () => validateBoundedMepRegionCoverageV1(resolvedUnknown, context()),
    /unknown_candidate_cannot_be_resolved/
  );
});

test("coverage binds scope, source, render, discipline, and bounded pixels", () => {
  const wrongScope = coverage();
  wrongScope.scope_id = "other-room";
  assert.throws(() => validateBoundedMepRegionCoverageV1(wrongScope, context()), /scope_mismatch/);

  const wrongSource = coverage();
  wrongSource.source_evidence_sha256 = "c".repeat(64);
  assert.throws(() => validateBoundedMepRegionCoverageV1(wrongSource, context()), /source_hash_mismatch/);

  const wrongRender = coverage();
  wrongRender.registered_render_sha256 = "d".repeat(64);
  assert.throws(() => validateBoundedMepRegionCoverageV1(wrongRender, context()), /render_hash_mismatch/);

  const wrongDiscipline = coverage();
  const plumbingContext = { ...context(), package_discipline: "plumbing" as const };
  assert.throws(() => validateBoundedMepRegionCoverageV1(wrongDiscipline, plumbingContext), /package_discipline_mismatch/);

  const outside = coverage();
  outside.candidates[0]!.pixel_bounds.max.x = 950;
  assert.throws(() => validateBoundedMepRegionCoverageV1(outside, context()), /candidate_outside_region/);
});

test("a clear candidate cannot use occlusion as its unresolved reason", () => {
  const input = coverage();
  input.candidates.push({
    candidate_id: "clear-but-claimed-occluded",
    primitive: "point_symbol",
    pixel_bounds: { min: { x: 700, y: 500 }, max: { x: 740, y: 545 } },
    visibility: "clear",
    disposition: { status: "unresolved", reason: "occluded", note: "contradictory" }
  });
  assert.throws(() => validateBoundedMepRegionCoverageV1(input, context()), /clear_candidate_cannot_be_occluded/);

  input.candidates.at(-1)!.primitive = "unknown";
  assert.throws(() => validateBoundedMepRegionCoverageV1(input, context()), /clear_candidate_cannot_be_occluded/);
});

test("direct validation rejects primitive and unresolved-reason values outside the schema enums", () => {
  const invalidPrimitive = coverage();
  (invalidPrimitive.candidates[0] as { primitive: string }).primitive = "fixture_guess";
  assert.throws(
    () => validateBoundedMepRegionCoverageV1(invalidPrimitive, context()),
    /candidate_primitive_invalid/
  );

  const invalidReason = coverage();
  invalidReason.candidates.push({
    candidate_id: "unsupported-reason",
    primitive: "unknown",
    pixel_bounds: { min: { x: 700, y: 500 }, max: { x: 740, y: 545 } },
    visibility: "partial",
    disposition: {
      status: "unresolved",
      reason: "not_relevant",
      note: "This must not become an implicit ignored bucket."
    }
  } as unknown as BoundedMepRegionCoverageV1["candidates"][number]);
  assert.throws(
    () => validateBoundedMepRegionCoverageV1(invalidReason, context()),
    /candidate_unresolved_reason_invalid/
  );
});
