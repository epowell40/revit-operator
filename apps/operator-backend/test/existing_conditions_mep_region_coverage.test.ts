import test from "node:test";
import assert from "node:assert/strict";
import {
  validateBoundedMepRegionCoverageV1,
  validateBoundedMepRegionCoverageV2,
  type BoundedMepRegionCoverageContext,
  type BoundedMepRegionCoverageV1,
  type BoundedMepRegionCoverageV2
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
      { observation_id: "circuit-random-44", kind: "electrical_circuit", discipline: "electrical", member_observation_ids: ["device-random-18"] }
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

function coverageV2(): BoundedMepRegionCoverageV2 {
  const input = coverage();
  return {
    ...input,
    schema_version: 2,
    candidates: input.candidates.map((candidate) => {
      if (candidate.primitive === "linear_trace") {
        return {
          ...candidate,
          representation: { kind: "linear_model_primitive", role: "pipe_route", evidence: "direct_symbol_geometry", symbol_count: 0, clipped_by_region: false }
        };
      }
      if (candidate.primitive === "circuit_annotation") {
        return {
          ...candidate,
          scope_anchor_candidate_id: "symbol-random-803",
          representation: { kind: "annotation_cluster", role: "electrical_circuit", evidence: "text_only", symbol_count: 0, clipped_by_region: false }
        };
      }
      const role = candidate.candidate_id === "symbol-random-802" ? "plumbing_fixture" : "electrical_device";
      return {
        ...candidate,
        representation: { kind: "single_model_symbol", role, evidence: "direct_symbol_geometry", symbol_count: 1, clipped_by_region: false }
      };
    })
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

test("V2 requires individual model-symbol evidence and preserves a deterministic receipt", () => {
  const first = validateBoundedMepRegionCoverageV2(coverageV2(), context());
  const second = validateBoundedMepRegionCoverageV2(coverageV2(), context());
  assert.equal(first.schema_version, 2);
  assert.equal(first.coverage_status, "complete");
  assert.equal(first.representation_counts.single_model_symbol, 2);
  assert.equal(first.representation_counts.annotation_cluster, 1);
  assert.equal(first.coverage_contract_sha256, second.coverage_contract_sha256);

  const invalidRole = coverageV2();
  (invalidRole.candidates[0]!.representation as { role: string }).role = "invented_role";
  assert.throws(
    () => validateBoundedMepRegionCoverageV2(invalidRole, context()),
    /representation_role_invalid/
  );
});

test("V2 refuses to resolve grouped annotation or multiple plotted symbols as one device", () => {
  const annotationAsDevice = coverageV2();
  annotationAsDevice.candidates[2]!.representation = {
    kind: "annotation_cluster",
    role: "electrical_device",
    evidence: "text_only",
    symbol_count: 0,
    clipped_by_region: false
  };
  assert.throws(
    () => validateBoundedMepRegionCoverageV2(annotationAsDevice, context()),
    /annotation_cluster_invalid/
  );

  const groupedBank = coverageV2();
  groupedBank.candidates[2]!.representation = {
    kind: "multi_symbol_cluster",
    role: "electrical_device",
    evidence: "mixed_or_overlapped",
    symbol_count: 4,
    clipped_by_region: false
  };
  assert.throws(
    () => validateBoundedMepRegionCoverageV2(groupedBank, context()),
    /multi_symbol_cluster_must_be_unresolved/
  );

  groupedBank.candidates[2]!.disposition = {
    status: "unresolved",
    reason: "unresolved_member_classification",
    note: "Four visible marks must be segmented into individual symbols before model observations are proposed."
  };
  groupedBank.candidates[3]!.disposition = {
    status: "unresolved",
    reason: "unresolved_member_classification",
    note: "Circuit text cannot establish membership while the associated device bank is unresolved."
  };
  const result = validateBoundedMepRegionCoverageV2(groupedBank, {
    ...context(),
    observations: context().observations.filter((entry) => !["device-random-18", "circuit-random-44"].includes(entry.observation_id))
  });
  assert.equal(result.coverage_status, "partial");
  assert.deepEqual(result.unresolved_candidate_ids, ["annotation-random-804", "symbol-random-803"]);
});

test("V2 refuses to use one individual symbol as evidence for multiple model observations", () => {
  const input = coverageV2();
  input.candidates[2]!.disposition = {
    status: "resolved",
    observation_ids: ["device-random-18", "device-random-19"]
  };
  const expandedContext = context();
  expandedContext.observations.push({ observation_id: "device-random-19", kind: "electrical_device", discipline: "electrical" });
  assert.throws(
    () => validateBoundedMepRegionCoverageV2(input, expandedContext),
    /resolved_candidate_requires_exactly_one_observation:symbol-random-803/
  );
});

test("V2 separates lighting fixtures from lighting control devices", () => {
  const lightingContext: BoundedMepRegionCoverageContext = {
    scope_id: "bounded-lighting-room",
    source_evidence_sha256: SOURCE_HASH,
    registered_render_sha256: RENDER_HASH,
    render_width_px: 1000,
    render_height_px: 800,
    package_discipline: "electrical",
    observations: [
      { observation_id: "fixture-random-201", kind: "light_fixture", discipline: "electrical" },
      { observation_id: "control-random-202", kind: "lighting_device", discipline: "electrical" }
    ]
  };
  const input: BoundedMepRegionCoverageV2 = {
    schema_version: 2,
    scope_id: lightingContext.scope_id,
    source_evidence_sha256: SOURCE_HASH,
    registered_render_sha256: RENDER_HASH,
    coordinate_space: "registered_render_pixels_top_left",
    region: { min: { x: 100, y: 100 }, max: { x: 900, y: 700 } },
    disciplines: ["electrical"],
    candidates: [
      {
        candidate_id: "fixture-symbol-random-211",
        primitive: "point_symbol",
        pixel_bounds: { min: { x: 200, y: 200 }, max: { x: 235, y: 235 } },
        visibility: "clear",
        representation: { kind: "single_model_symbol", role: "light_fixture", evidence: "direct_symbol_geometry", symbol_count: 1, clipped_by_region: false },
        disposition: { status: "resolved", observation_ids: ["fixture-random-201"] }
      },
      {
        candidate_id: "control-symbol-random-212",
        primitive: "point_symbol",
        pixel_bounds: { min: { x: 300, y: 200 }, max: { x: 325, y: 225 } },
        visibility: "clear",
        representation: { kind: "single_model_symbol", role: "lighting_device", evidence: "direct_symbol_geometry", symbol_count: 1, clipped_by_region: false },
        disposition: { status: "resolved", observation_ids: ["control-random-202"] }
      }
    ]
  };
  assert.throws(
    () => validateBoundedMepRegionCoverageV2(input, lightingContext),
    /lighting_device_native_observation_not_supported:control-symbol-random-212/
  );
  input.candidates[1]!.representation.role = "light_fixture";
  assert.throws(
    () => validateBoundedMepRegionCoverageV2(input, lightingContext),
    /representation_role_mismatch:control-symbol-random-212:control-random-202/
  );
});

test("V2 keeps boundary-clipped air-terminal symbols unresolved until a complete symbol is visible", () => {
  const mechanicalContext: BoundedMepRegionCoverageContext = {
    scope_id: "bounded-terminal-edge",
    source_evidence_sha256: SOURCE_HASH,
    registered_render_sha256: RENDER_HASH,
    render_width_px: 1000,
    render_height_px: 800,
    package_discipline: "mechanical",
    observations: [{ observation_id: "terminal-random-301", kind: "air_terminal", discipline: "mechanical" }]
  };
  const input: BoundedMepRegionCoverageV2 = {
    schema_version: 2,
    scope_id: mechanicalContext.scope_id,
    source_evidence_sha256: SOURCE_HASH,
    registered_render_sha256: RENDER_HASH,
    coordinate_space: "registered_render_pixels_top_left",
    region: { min: { x: 100, y: 100 }, max: { x: 900, y: 700 } },
    disciplines: ["mechanical"],
    candidates: [{
      candidate_id: "terminal-symbol-random-311",
      primitive: "point_symbol",
      pixel_bounds: { min: { x: 100, y: 250 }, max: { x: 125, y: 285 } },
      visibility: "partial",
      representation: { kind: "single_model_symbol", role: "air_terminal", evidence: "direct_symbol_geometry", symbol_count: 1, clipped_by_region: true },
      disposition: { status: "resolved", observation_ids: ["terminal-random-301"] }
    }]
  };
  assert.throws(
    () => validateBoundedMepRegionCoverageV2(input, mechanicalContext),
    /resolved_symbol_must_be_complete_and_clear/
  );
  input.candidates[0]!.disposition = { status: "unresolved", reason: "clipped_by_region", note: "The symbol crosses the frozen source boundary." };
  const partial = validateBoundedMepRegionCoverageV2(input, { ...mechanicalContext, observations: [] });
  assert.equal(partial.coverage_status, "partial");
  input.candidates[0]!.visibility = "clear";
  input.candidates[0]!.representation.clipped_by_region = false;
  input.candidates[0]!.disposition = { status: "resolved", observation_ids: ["terminal-random-301"] };
  assert.equal(validateBoundedMepRegionCoverageV2(input, mechanicalContext).coverage_status, "complete");
});

test("V2 circuit annotations require an explicit individual device-symbol anchor", () => {
  const input = coverageV2();
  delete input.candidates[3]!.scope_anchor_candidate_id;
  assert.throws(
    () => validateBoundedMepRegionCoverageV2(input, context()),
    /circuit_annotation_requires_symbol_anchor/
  );

  input.candidates[3]!.scope_anchor_candidate_id = "symbol-random-803";
  const missingMembership = context();
  delete missingMembership.observations[3]!.member_observation_ids;
  assert.throws(
    () => validateBoundedMepRegionCoverageV2(input, missingMembership),
    /circuit_membership_context_required/
  );

  const wrongMembership = context();
  wrongMembership.observations[3]!.member_observation_ids = ["some-other-device"];
  assert.throws(
    () => validateBoundedMepRegionCoverageV2(input, wrongMembership),
    /circuit_member_unknown_or_unsupported/
  );

  const fabricatedExtraMember = context();
  fabricatedExtraMember.observations[3]!.member_observation_ids = ["device-random-18", "ghost-device"];
  assert.throws(
    () => validateBoundedMepRegionCoverageV2(input, fabricatedExtraMember),
    /circuit_member_unknown_or_unsupported:circuit-random-44:ghost-device/
  );
});

test("V2 circuit annotations may anchor to an individual lighting fixture member", () => {
  const input = coverageV2();
  const lightingContext = context();
  input.candidates[2]!.representation.role = "light_fixture";
  lightingContext.observations[2]!.kind = "light_fixture";
  const result = validateBoundedMepRegionCoverageV2(input, lightingContext);
  assert.equal(result.coverage_status, "complete");
  assert.equal(result.representation_counts.single_model_symbol, 2);
});

test("bounded MEP region coverage supports HVAC routes and air terminals", () => {
  const mechanicalContext: BoundedMepRegionCoverageContext = {
    scope_id: "bounded-hvac-room",
    source_evidence_sha256: SOURCE_HASH,
    registered_render_sha256: RENDER_HASH,
    render_width_px: 1000,
    render_height_px: 800,
    package_discipline: "mechanical",
    observations: [
      { observation_id: "duct-random-11", kind: "duct_route", discipline: "mechanical" },
      { observation_id: "terminal-random-12", kind: "air_terminal", discipline: "mechanical" }
    ]
  };
  const input: BoundedMepRegionCoverageV1 = {
    schema_version: 1,
    scope_id: mechanicalContext.scope_id,
    source_evidence_sha256: SOURCE_HASH,
    registered_render_sha256: RENDER_HASH,
    coordinate_space: "registered_render_pixels_top_left",
    region: { min: { x: 100, y: 100 }, max: { x: 900, y: 700 } },
    disciplines: ["mechanical"],
    candidates: [
      {
        candidate_id: "duct-trace-random-91",
        primitive: "linear_trace",
        pixel_bounds: { min: { x: 150, y: 200 }, max: { x: 650, y: 230 } },
        visibility: "clear",
        disposition: { status: "resolved", observation_ids: ["duct-random-11"] }
      },
      {
        candidate_id: "terminal-symbol-random-92",
        primitive: "point_symbol",
        pixel_bounds: { min: { x: 640, y: 190 }, max: { x: 680, y: 230 } },
        visibility: "clear",
        disposition: { status: "resolved", observation_ids: ["terminal-random-12"] }
      }
    ]
  };

  const result = validateBoundedMepRegionCoverageV1(input, mechanicalContext);
  assert.equal(result.coverage_status, "complete");
  assert.deepEqual(result.disciplines, ["mechanical"]);
  assert.deepEqual(result.covered_observation_ids, ["duct-random-11", "terminal-random-12"]);
});

test("an irregular scope polygon excludes adjacent corridor marks without shrinking annotation bounds", () => {
  const input = coverage();
  input.scope_polygon = [
    { x: 100, y: 100 },
    { x: 700, y: 100 },
    { x: 700, y: 350 },
    { x: 900, y: 350 },
    { x: 900, y: 700 },
    { x: 100, y: 700 }
  ];
  input.candidates[3]!.pixel_bounds = { min: { x: 680, y: 320 }, max: { x: 760, y: 370 } };
  input.candidates[2]!.pixel_bounds = { min: { x: 680, y: 355 }, max: { x: 700, y: 375 } };
  input.candidates[3]!.scope_anchor_candidate_id = "symbol-random-803";
  const result = validateBoundedMepRegionCoverageV1(input, context());
  assert.equal(result.coverage_status, "complete");
  assert.deepEqual(result.scope_polygon, input.scope_polygon);

  delete input.candidates[3]!.scope_anchor_candidate_id;
  assert.throws(
    () => validateBoundedMepRegionCoverageV1(input, context()),
    /candidate_outside_scope_polygon:annotation-random-804/
  );
});

test("scope polygons reject laundering through out-of-bounds anchors and invalid geometry", () => {
  const outsideAnchor = coverage();
  outsideAnchor.scope_polygon = [
    { x: 100, y: 100 },
    { x: 900, y: 100 },
    { x: 900, y: 700 },
    { x: 100, y: 700 }
  ];
  outsideAnchor.candidates[0]!.scope_point = { x: 800, y: 600 };
  assert.throws(
    () => validateBoundedMepRegionCoverageV1(outsideAnchor, context()),
    /candidate_scope_point_outside_bounds:trace-random-801/
  );

  const selfIntersecting = coverage();
  selfIntersecting.scope_polygon = [
    { x: 100, y: 100 },
    { x: 900, y: 700 },
    { x: 900, y: 100 },
    { x: 100, y: 700 }
  ];
  assert.throws(
    () => validateBoundedMepRegionCoverageV1(selfIntersecting, context()),
    /scope_polygon_(has_zero_area|self_intersects)/
  );

  const badAnchor = coverage();
  badAnchor.scope_polygon = outsideAnchor.scope_polygon;
  badAnchor.candidates[3]!.scope_anchor_candidate_id = "trace-random-801";
  assert.throws(
    () => validateBoundedMepRegionCoverageV1(badAnchor, context()),
    /scope_anchor_requires_point_symbol/
  );
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

test("a clear circuit label remains partial when its visible member symbol is not classified", () => {
  const input = coverage();
  input.candidates[3]!.disposition = {
    status: "unresolved",
    reason: "unresolved_member_classification",
    note: "The label is legible, but its leader terminates at a point symbol whose device subtype is unresolved."
  };
  const result = validateBoundedMepRegionCoverageV1(input, {
    ...context(),
    observations: context().observations.filter((entry) => entry.observation_id !== "circuit-random-44")
  });
  assert.equal(result.coverage_status, "partial");
  assert.deepEqual(result.unresolved_candidate_ids, ["annotation-random-804"]);
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

test("repeated printed labels may corroborate one native circuit observation", () => {
  const input = coverage();
  input.candidates.push({
    candidate_id: "repeated-circuit-label-random-806",
    primitive: "circuit_annotation",
    pixel_bounds: { min: { x: 650, y: 450 }, max: { x: 760, y: 485 } },
    visibility: "clear",
    disposition: { status: "resolved", observation_ids: ["circuit-random-44"] }
  });
  const result = validateBoundedMepRegionCoverageV1(input, context());
  assert.equal(result.coverage_status, "complete");
  assert.equal(result.candidate_count, 5);
  assert.equal(result.covered_observation_ids.filter((id) => id === "circuit-random-44").length, 1);
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

test("V2 direct validation fails closed on malformed candidates and context observations", () => {
  const malformedCandidate = coverageV2();
  (malformedCandidate.candidates as unknown[])[0] = null;
  assert.throws(
    () => validateBoundedMepRegionCoverageV2(malformedCandidate, context()),
    /candidate_0_must_be_object/
  );

  const malformedContext = context();
  (malformedContext.observations as unknown[])[0] = null;
  assert.throws(
    () => validateBoundedMepRegionCoverageV2(coverageV2(), malformedContext),
    /context_observation_must_be_object/
  );
});
