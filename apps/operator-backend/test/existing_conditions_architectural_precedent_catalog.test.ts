import assert from "node:assert/strict";
import test from "node:test";
import {
  compileArchitecturalPlanGeometryPreview,
  type ArchitecturalPlanGeometryPreviewPackage,
  type ArchitecturalPlanGeometryPromotionGate
} from "../src/existing_conditions/architectural_plan_geometry_preview.js";
import {
  scoreArchitecturalPlanGeometryPreview
} from "../src/existing_conditions/architectural_plan_geometry_score.js";
import type { ExistingConditionsGroundTruth } from "../src/benchmark/existing_conditions_reconstruction.js";
import {
  promoteArchitecturalPlanGeometryWithCatalog,
  resolveArchitecturalPrecedentMappings,
  type ArchitecturalPrecedentCatalog,
  type ArchitecturalPrecedentSignal
} from "../src/existing_conditions/architectural_precedent_catalog.js";

const SOURCE_HASH = "a".repeat(64);
const REDACTED_MODEL_HASH = "b".repeat(64);
const CLASSIFICATION_HASH = "c".repeat(64);
const RETENTION_HASH = "d".repeat(64);

function inputPackage(): ArchitecturalPlanGeometryPreviewPackage {
  return {
    schema_version: 1,
    fixture_id: "architectural-precedent-independent-v1",
    scope_id: "snowdon-l4-room406-target",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: [
      { role: "source_pdf", sha256: SOURCE_HASH },
      { role: "opening_classification_receipt", sha256: CLASSIFICATION_HASH },
      { role: "redacted_model", sha256: REDACTED_MODEL_HASH },
      { role: "precedent_retention_receipt", sha256: RETENTION_HASH }
    ],
    registration: {
      source_evidence_sha256: SOURCE_HASH,
      control_points: [
        { source: { x: 0, y: 0 }, model: { x: 100, y: 200 } },
        { source: { x: 10, y: 0 }, model: { x: 110, y: 200 } },
        { source: { x: 0, y: 10 }, model: { x: 100, y: 210 } }
      ],
      max_rms_error_ft: 0.01,
      max_point_error_ft: 0.01
    },
    level_name: "L4",
    level_elevation_ft: 32.166667,
    maximum_created_elements: 4,
    observations: [
      {
        kind: "wall",
        discipline: "architectural",
        observation_id: "wall-measured-1",
        visibility: "clear",
        confidence: 0.98,
        supported_attributes: ["location"],
        points: [{ x: 0, y: 0 }, { x: 12, y: 0 }],
        measured_thickness_ft: 0.41
      },
      {
        kind: "door",
        discipline: "architectural",
        observation_id: "door-measured-1",
        visibility: "clear",
        confidence: 0.97,
        supported_attributes: ["location", "host"],
        point: { x: 3, y: 0 },
        host_wall_observation_id: "wall-measured-1",
        measured_width_ft: 3.125
      },
      {
        kind: "window",
        discipline: "architectural",
        observation_id: "window-measured-1",
        visibility: "clear",
        confidence: 0.96,
        supported_attributes: ["location", "host"],
        point: { x: 8, y: 0 },
        host_wall_observation_id: "wall-measured-1",
        measured_width_ft: 4.37
      }
    ]
  };
}

function catalog(): ArchitecturalPrecedentCatalog {
  return {
    schema_version: 1,
    catalog_id: "snowdon-architectural-precedents-v1",
    project_key: "snowdon-towers-sample",
    evidence: [
      {
        evidence_id: "retained-wall-room405",
        basis: "retained_native_exemplar",
        evidence_reference: "redacted-model-readback:wall-2454523",
        source_document_sha256: REDACTED_MODEL_HASH,
        source_scope_id: "snowdon-l4-room405-retained",
        target_scope_id: "snowdon-l4-room406-target",
        retention_receipt_sha256: RETENTION_HASH,
        native_readback: true,
        source_element_ids: [2454523],
        retained_outside_target: true
      },
      {
        evidence_id: "retained-door-room405",
        basis: "retained_native_exemplar",
        evidence_reference: "redacted-model-readback:door-786324",
        source_document_sha256: REDACTED_MODEL_HASH,
        source_scope_id: "snowdon-l4-room405-retained",
        target_scope_id: "snowdon-l4-room406-target",
        retention_receipt_sha256: RETENTION_HASH,
        native_readback: true,
        source_element_ids: [786324],
        retained_outside_target: true
      },
      {
        evidence_id: "retained-window-room404",
        basis: "retained_native_exemplar",
        evidence_reference: "redacted-model-readback:window-824575",
        source_document_sha256: REDACTED_MODEL_HASH,
        source_scope_id: "snowdon-l4-room404-retained",
        target_scope_id: "snowdon-l4-room406-target",
        retention_receipt_sha256: RETENTION_HASH,
        native_readback: true,
        source_element_ids: [824575],
        retained_outside_target: true
      }
    ],
    entries: [
      {
        mapping_id: "interior-partition-4-7-8-nr",
        approved: true,
        selector: { kind: "wall", measured_thickness_range_ft: [0.38, 0.44] },
        attributes: {
          type: "Interior - 4 7/8\" Partition (NR)",
          thickness: 0.40625,
          height: 8
        },
        evidence_ids: ["retained-wall-room405"]
      },
      {
        mapping_id: "single-flush-36x84-cores",
        approved: true,
        selector: {
          kind: "door",
          classifications: ["single flush"],
          measured_width_range_ft: [2.9, 3.2]
        },
        attributes: {
          family: "Door-Passage-Single-Flush",
          type: "36\" x 84\" (Cores)",
          width: 3,
          height: 7
        },
        evidence_ids: ["retained-door-room405"]
      },
      {
        mapping_id: "sliding-double-50x60",
        approved: true,
        selector: {
          kind: "window",
          classifications: ["sliding double"],
          type_marks: ["59"],
          measured_width_range_ft: [4, 4.5]
        },
        attributes: {
          family: "Window-Sliding-Double",
          type: "50 in x 60 in",
          width: 50 / 12,
          height: 5,
          "sill height": 3
        },
        evidence_ids: ["retained-window-room404"]
      }
    ]
  };
}

function signals(): ArchitecturalPrecedentSignal[] {
  return [
    {
      observation_id: "door-measured-1",
      classification: "single flush",
      classification_evidence_sha256: CLASSIFICATION_HASH
    },
    {
      observation_id: "window-measured-1",
      classification: "sliding double",
      classification_evidence_sha256: CLASSIFICATION_HASH,
      type_mark: "59",
      type_mark_evidence_sha256: CLASSIFICATION_HASH
    }
  ];
}

function truthForInput(input: ArchitecturalPlanGeometryPreviewPackage): ExistingConditionsGroundTruth {
  const preview = compileArchitecturalPlanGeometryPreview(input);
  const truthKey = new Map(preview.preview_elements.map((entry, index) => [entry.plan_key, `truth-${index}`]));
  return {
    schema_version: 1,
    fixture_id: preview.fixture_id,
    scope_id: preview.scope_id,
    discipline: "architectural",
    visible_evidence: [{ role: "source_pdf", sha256: input.source_evidence_sha256 }],
    snapshot: {
      native_readback: true,
      elements: preview.preview_elements.map((entry, index) => ({
        key: `truth-${index}`,
        kind: entry.kind === "wall" ? "linear_element" : "family_instance",
        discipline: "architectural",
        role: entry.kind,
        category: entry.category,
        endpoints: entry.geometry.points
          ? [{ ...entry.geometry.points[0], z: 0 }, { ...entry.geometry.points[1], z: 0 }]
          : null,
        location: entry.geometry.point ? { ...entry.geometry.point, z: 0 } : null
      })),
      connections: [
        ...preview.wall_junctions.map((entry) => ({
          a: truthKey.get(entry.a_wall_observation_id)!,
          b: truthKey.get(entry.b_wall_observation_id)!,
          kind: "wall_junction" as const
        })),
        ...preview.preview_elements.flatMap((entry) => entry.geometry.host_wall_observation_id
          ? [{
            a: truthKey.get(entry.plan_key)!,
            b: truthKey.get(entry.geometry.host_wall_observation_id)!,
            kind: "host" as const
          }]
          : [])
      ],
      open_connector_count: 0
    }
  };
}

function passingGate(input: ArchitecturalPlanGeometryPreviewPackage): ArchitecturalPlanGeometryPromotionGate {
  const preview = compileArchitecturalPlanGeometryPreview(input);
  return {
    plan_geometry_score: scoreArchitecturalPlanGeometryPreview(truthForInput(input), preview)
  };
}

test("retained project precedents resolve measured plan geometry into exact native attributes", () => {
  const input = inputPackage();
  const mapped = resolveArchitecturalPrecedentMappings(input, catalog(), signals());
  assert.equal(mapped.resolutions.length, 3);
  assert.equal(mapped.mapping_receipts.length, 3);
  const door = mapped.resolutions.find((entry) => entry.observation_id === "door-measured-1");
  assert.equal(door?.attributes.find((entry) => entry.attribute === "width")?.value, 3);
  assert.equal(door?.attributes.find((entry) => entry.attribute === "type")?.value, "36\" x 84\" (Cores)");
  assert.match(door?.attributes[0]?.evidence_reference ?? "", /architectural_precedent_catalog/);
  const window = mapped.mapping_receipts.find((entry) => entry.observation_id === "window-measured-1");
  assert.deepEqual(window?.evidence_ids, ["retained-window-room404"]);
});

test("catalog promotion requires the exact passing geometry score and emits an exact dry-run", () => {
  const input = inputPackage();
  const promoted = promoteArchitecturalPlanGeometryWithCatalog(input, catalog(), signals(), passingGate(input));
  assert.equal(promoted.compiled_plan.status, "ready");
  assert.equal(promoted.compiled_plan.action?.dry_run_body.dryRun, true);
  assert.equal(promoted.compiled_plan.action?.apply_body.requireExactWallTypes, true);
  assert.equal(promoted.precedent_mapping_receipts.length, 3);
  const elements = (promoted.compiled_plan.action?.dry_run_body.geometry as { elements: Array<Record<string, unknown>> }).elements;
  const door = elements.find((entry) => entry.id === "door-measured-1");
  assert.equal(door?.width, 3);
  assert.notEqual(door?.width, 3.125);
});

test("catalog rejects target-scope exemplars and missing hash-bound classification evidence", () => {
  const targetLeak = catalog();
  targetLeak.evidence[0]!.source_scope_id = inputPackage().scope_id;
  assert.throws(
    () => resolveArchitecturalPrecedentMappings(inputPackage(), targetLeak, signals()),
    /uses_target_scope_as_precedent/
  );

  const sourceRelabel = catalog();
  sourceRelabel.evidence[0]!.source_document_sha256 = SOURCE_HASH;
  assert.throws(
    () => resolveArchitecturalPrecedentMappings(inputPackage(), sourceRelabel, signals()),
    /source_pdf_cannot_be_native_precedent/
  );

  const unboundSignals = signals();
  delete unboundSignals[0]!.classification_evidence_sha256;
  assert.throws(
    () => resolveArchitecturalPrecedentMappings(inputPackage(), catalog(), unboundSignals),
    /door-measured-1_has_no_matching_approved_precedent/
  );
});

test("measured selectors never fall back to caller-supplied exact native attributes", () => {
  const input = inputPackage();
  const door = input.observations[1];
  if (door?.kind !== "door") throw new Error("precedent_fixture_door_missing");
  delete door.measured_width_ft;
  door.width_ft = 3.125;
  door.supported_attributes.push("width");
  assert.throws(
    () => resolveArchitecturalPrecedentMappings(input, catalog(), signals()),
    /door-measured-1_has_no_matching_approved_precedent/
  );
});

test("catalog fails closed when two approved precedents match the same plan-visible evidence", () => {
  const ambiguous = catalog();
  ambiguous.entries.push({
    ...ambiguous.entries[1]!,
    mapping_id: "single-flush-36x84-alternate"
  });
  assert.throws(
    () => resolveArchitecturalPrecedentMappings(inputPackage(), ambiguous, signals()),
    /architectural_precedent_is_ambiguous/
  );
});
