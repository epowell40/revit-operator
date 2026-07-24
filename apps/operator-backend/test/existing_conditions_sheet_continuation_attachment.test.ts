import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSheetContinuationAttachmentsV1,
  type SheetContinuationAttachmentInputV1
} from "../src/existing_conditions/sheet_continuation_attachment.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function input(): SheetContinuationAttachmentInputV1 {
  return {
    schema_version: 1,
    package_id: "fixture-cross-level",
    interpretation: {
      schema_version: 1,
      package_id: "fixture-cross-level",
      coordinate_space: "normalized_uv_top_left",
      view_keys: ["lower", "upper"],
      source_marks: [
        { source_mark_id: "lower-mark", source_view_key: "lower", disposition: { status: "candidate", primitive_ids: ["lower-route", "lower-marker"] } },
        { source_mark_id: "upper-mark", source_view_key: "upper", disposition: { status: "candidate", primitive_ids: ["upper-route", "upper-marker", "upper-leader"] } }
      ],
      primitives: [
        {
          primitive_id: "lower-route",
          source_view_key: "lower",
          source_mark_ids: ["lower-mark"],
          kind: "route_segment",
          points: [{ u: 0.2, v: 0.5 }, { u: 0.24, v: 0.46 }],
          endpoints: [
            { endpoint_key: "lower:start", point: { u: 0.2, v: 0.5 }, outward_direction_uv: [0, -1], boundary: "sheet_continuation", continuation_key: "RISER-1", continuation_kind: "vertical_riser" },
            { endpoint_key: "lower:end", point: { u: 0.24, v: 0.46 }, outward_direction_uv: [1, 0], boundary: "internal" }
          ],
          confidence: { geometry: 0.9, classification: 0.9, topology: 0.9, visibility: 0.9 }
        },
        {
          primitive_id: "lower-marker",
          source_view_key: "lower",
          source_mark_ids: ["lower-mark"],
          kind: "point_symbol",
          points: [{ u: 0.2, v: 0.5 }],
          confidence: { geometry: 0.9, classification: 0.5, topology: 0.9, visibility: 0.9 }
        },
        {
          primitive_id: "upper-route",
          source_view_key: "upper",
          source_mark_ids: ["upper-mark"],
          kind: "route_segment",
          points: [{ u: 0.2, v: 0.5 }, { u: 0.23, v: 0.44 }],
          endpoints: [
            { endpoint_key: "upper:start", point: { u: 0.2, v: 0.5 }, outward_direction_uv: [0, 1], boundary: "sheet_continuation", continuation_key: "RISER-1", continuation_kind: "vertical_riser" },
            { endpoint_key: "upper:end", point: { u: 0.23, v: 0.44 }, outward_direction_uv: [1, 0], boundary: "internal" }
          ],
          confidence: { geometry: 0.9, classification: 0.9, topology: 0.9, visibility: 0.9 }
        },
        {
          primitive_id: "upper-marker",
          source_view_key: "upper",
          source_mark_ids: ["upper-mark"],
          kind: "point_symbol",
          points: [{ u: 0.2, v: 0.5 }],
          confidence: { geometry: 0.9, classification: 0.5, topology: 0.9, visibility: 0.9 }
        },
        {
          primitive_id: "upper-leader",
          source_view_key: "upper",
          source_mark_ids: ["upper-mark"],
          kind: "annotation",
          points: [{ u: 0.28, v: 0.55 }, { u: 0.22, v: 0.5 }],
          claims: { type: { value: "leader", confidence: 0.95, basis: "legible_source_evidence" } },
          confidence: { geometry: 0.9, classification: 0.9, topology: 0.9, visibility: 0.9 }
        }
      ]
    },
    source_views: [
      { view_key: "lower", source_image_sha256: HASH_A, source_image_width_px: 1000, source_image_height_px: 1000 },
      { view_key: "upper", source_image_sha256: HASH_B, source_image_width_px: 1000, source_image_height_px: 1000 }
    ],
    trusted_continuations: [{
      continuation_key: "RISER-1",
      continuation_kind: "vertical_riser",
      endpoint_keys: ["lower:start", "upper:start"],
      evidence_basis: "legible_source_evidence",
      evidence_sha256: HASH_B
    }]
  };
}

test("trusted continuation symbols resolve to adjacent source route vertices without granting writes", () => {
  const receipt = resolveSheetContinuationAttachmentsV1(input());

  assert.equal(receipt.status, "resolved_for_native_frontier_search");
  assert.equal(receipt.native_write_allowed, false);
  assert.deepEqual(receipt.bindings.map(value => value.route_attachment_point_uv), [
    { u: 0.24, v: 0.46 },
    { u: 0.23, v: 0.44 }
  ]);
  assert.deepEqual(receipt.bindings[1]?.supporting_leader_primitive_ids, ["upper-leader"]);
  assert.ok(receipt.bindings.every(value => value.shared_marker_primitive_id));
});

test("a continuation without one exact shared-source point marker remains deferred", () => {
  const value = input();
  value.interpretation.primitives = value.interpretation.primitives.filter(primitive => primitive.primitive_id !== "lower-marker");

  const receipt = resolveSheetContinuationAttachmentsV1(value);

  assert.equal(receipt.status, "clarification_required");
  assert.equal(receipt.bindings[0]?.route_attachment_point_uv, null);
  assert.deepEqual(receipt.bindings[0]?.blockers, ["shared_source_continuation_marker_not_found"]);
});

test("a host-trusted exact marker may bind a separately accounted coincident source mark", () => {
  const value = input();
  const marker = value.interpretation.primitives.find(primitive => primitive.primitive_id === "lower-marker")!;
  marker.source_mark_ids = ["lower-anchor-mark"];
  const routeMark = value.interpretation.source_marks.find(mark => mark.source_mark_id === "lower-mark")!;
  if (routeMark.disposition.status === "candidate") routeMark.disposition.primitive_ids = ["lower-route"];
  value.interpretation.source_marks.push({
    source_mark_id: "lower-anchor-mark",
    source_view_key: "lower",
    disposition: { status: "candidate", primitive_ids: ["lower-marker"] }
  });
  value.trusted_marker_primitive_id_by_endpoint_key = { "lower:start": "lower-marker" };

  const receipt = resolveSheetContinuationAttachmentsV1(value);

  assert.equal(receipt.status, "resolved_for_native_frontier_search");
  assert.equal(receipt.bindings[0]?.marker_binding_basis, "host_trusted_exact_marker");
});

test("a long path cannot silently move the native-search anchor", () => {
  const value = input();
  const route = value.interpretation.primitives.find(primitive => primitive.primitive_id === "lower-route")!;
  route.points[1] = { u: 0.8, v: 0.5 };
  route.endpoints![1]!.point = { u: 0.8, v: 0.5 };

  const receipt = resolveSheetContinuationAttachmentsV1(value);

  assert.equal(receipt.status, "clarification_required");
  assert.ok(receipt.bindings[0]?.blockers.includes("attachment_path_too_long"));
  assert.equal(receipt.bindings[0]?.route_attachment_point_uv, null);
});

test("trusted evidence must name the exact provider endpoint", () => {
  const value = input();
  value.trusted_continuations[0]!.endpoint_keys[0] = "missing:endpoint";

  const receipt = resolveSheetContinuationAttachmentsV1(value);

  assert.equal(receipt.status, "clarification_required");
  assert.equal(receipt.bindings[0]?.endpoint_key, "missing:endpoint");
  assert.deepEqual(receipt.bindings[0]?.blockers, ["trusted_endpoint_not_found"]);
});
