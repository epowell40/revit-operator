import assert from "node:assert/strict";
import test from "node:test";
import { summarizeExistingConditionsStructuredInterpretationV1, validateExistingConditionsStructuredInterpretationV1 } from "../src/existing_conditions/structured_interpretation_tool.js";

const PDF_HASH = "a".repeat(64);

function response() {
  return {
    schema_version: 1,
    package_id: "floor-4-east",
    coordinate_space: "normalized_uv_top_left",
    view_keys: ["sheet", "detail"],
    source_marks: [{ source_mark_id: "m1", source_view_key: "detail", disposition_status: "candidate", primitive_ids: ["p1"], reason: "" }],
    primitives: [{
      primitive_id: "p1", source_view_key: "detail", source_mark_ids: ["m1"], kind: "route_segment",
      points: [{ u: 0, v: 0.5 }, { u: 1, v: 0.5 }],
      endpoints: [
        { endpoint_key: "start", point: { u: 0, v: 0.5 }, outward_direction_uv: [-1, 0], boundary: "view_boundary", continuation_key: "", continuation_kind: "none" },
        { endpoint_key: "end", point: { u: 1, v: 0.5 }, outward_direction_uv: [1, 0], boundary: "view_boundary", continuation_key: "", continuation_kind: "none" }
      ],
      claims: [], confidence: { geometry: 0.9, classification: 0.8, topology: 0.8, visibility: 0.9 }
    }],
    open_questions: []
  };
}

test("tool binds model interpretation to current-session PDF renders", async () => {
  const renderCalls: unknown[] = [];
  const result = await validateExistingConditionsStructuredInterpretationV1({
    schema_version: 1, session_id: "session-1", package_id: "floor-4-east", objective: "Draft the visible duct network.",
    views: [
      { view_key: "sheet", attachment_id: "pdf-1", page: 4, analysis_role: "sheet_context" },
      { view_key: "detail", attachment_id: "pdf-1", page: 4, analysis_role: "region_detail", region: { min_u: 0.2, min_v: 0.3, max_u: 0.6, max_v: 0.7 }, parent_context_view_key: "sheet" }
    ],
    response: response()
  }, {
    find_upload: (sessionId, attachmentId) => ({ id: attachmentId, session_id: sessionId, filename: "record.pdf", mime: "application/pdf", sha256: PDF_HASH }),
    render_attachment: async (sessionId, args) => {
      renderCalls.push({ sessionId, args });
      return { content: [
        { type: "text", text: JSON.stringify({ attachment_id: args.attachment_id, page: 4, sha256: PDF_HASH, page_geometry: { width_points: 3024.24, height_points: 2160, rotation_degrees: 0 } }) },
        { type: "image", mimeType: "image/png", data: Buffer.from(JSON.stringify(args)).toString("base64") }
      ] };
    }
  });

  assert.equal(renderCalls.length, 2);
  assert.deepEqual((renderCalls[0] as any).args, { attachment_id: "pdf-1", pages: [4] });
  assert.deepEqual((renderCalls[1] as any).args.region, { min_u: 0.2, min_v: 0.3, max_u: 0.6, max_v: 0.7 });
  assert.deepEqual(result.receipt.page_primitives[0]?.points, [{ u: 0.2, v: 0.5 }, { u: 0.6, v: 0.5 }]);
  assert.equal(result.source_views.every(view => view.source_artifact_sha256 === PDF_HASH), true);
  assert.deepEqual(result.receipt.views.map(view => view.page_geometry), [
    { width_points: 3024.24, height_points: 2160, rotation_degrees: 0 },
    { width_points: 3024.24, height_points: 2160, rotation_degrees: 0 }
  ]);
  assert.equal(new Set(result.source_views.map(view => view.image_sha256)).size, 2);
  const summary = summarizeExistingConditionsStructuredInterpretationV1(result, {
    evidence_id: `ev1_${"e".repeat(32)}`, content_hash: `sha256:${"f".repeat(64)}`,
    trust_level: "host_observed", verification_relevance: "supporting"
  });
  assert.equal(summary.primitive_count, 1);
  assert.equal(summary.source_view_count, 2);
  assert.equal("interpretation" in summary, false, "the immediate tool reply must not duplicate retained geometry");
  assert.equal(JSON.stringify(summary).includes("page_primitives"), false);
});

test("tool rejects an attachment outside the current conversation before rendering", async () => {
  let rendered = false;
  await assert.rejects(
    validateExistingConditionsStructuredInterpretationV1({
      schema_version: 1, session_id: "session-1", package_id: "floor-4-east", objective: "Draft the visible duct network.",
      views: [
        { view_key: "sheet", attachment_id: "pdf-1", page: 4, analysis_role: "sheet_context" },
        { view_key: "detail", attachment_id: "pdf-2", page: 4, analysis_role: "region_detail", region: { min_u: 0.2, min_v: 0.3, max_u: 0.6, max_v: 0.7 }, parent_context_view_key: "sheet" }
      ], response: response()
    }, {
      find_upload: (sessionId, attachmentId) => attachmentId === "pdf-1" ? { id: attachmentId, session_id: sessionId, filename: "record.pdf", mime: "application/pdf", sha256: PDF_HASH } : null,
      render_attachment: async () => { rendered = true; return { content: [] }; }
    }),
    /existing_conditions_interpretation_attachment_not_registered:detail/
  );
  assert.equal(rendered, false, "all source bindings must validate before any rendering starts");
});

test("tool rejects a mismatched detail parent before rendering registered PDF bytes", async () => {
  let rendered = false;
  await assert.rejects(
    validateExistingConditionsStructuredInterpretationV1({
      schema_version: 1, session_id: "session-1", package_id: "floor-4-east", objective: "Draft the visible duct network.",
      views: [
        { view_key: "sheet", attachment_id: "pdf-1", page: 4, analysis_role: "sheet_context" },
        { view_key: "detail", attachment_id: "pdf-1", page: 5, analysis_role: "region_detail", region: { min_u: 0.2, min_v: 0.3, max_u: 0.6, max_v: 0.7 }, parent_context_view_key: "sheet" }
      ], response: response()
    }, {
      find_upload: (sessionId, attachmentId) => ({ id: attachmentId, session_id: sessionId, filename: "record.pdf", mime: "application/pdf", sha256: PDF_HASH }),
      render_attachment: async () => { rendered = true; return { content: [] }; }
    }),
    /existing_conditions_interpretation_detail_parent_source_mismatch:detail/
  );
  assert.equal(rendered, false);
});

test("C59 page geometry must come from the exact PDF render metadata", async () => {
  const request = {
    schema_version: 1 as const, session_id: "session-1", package_id: "floor-4-east", objective: "Draft visible ducts.",
    views: [
      { view_key: "sheet", attachment_id: "pdf-1", page: 4, analysis_role: "sheet_context" as const },
      { view_key: "detail", attachment_id: "pdf-1", page: 4, analysis_role: "region_detail" as const,
        region: { min_u: 0.2, min_v: 0.3, max_u: 0.6, max_v: 0.7 }, parent_context_view_key: "sheet" }
    ], response: response()
  };
  const find_upload = (sessionId: string, attachmentId: string) => ({ id: attachmentId, session_id: sessionId, filename: "record.pdf", mime: "application/pdf", sha256: PDF_HASH });
  for (const metadata of [
    { attachment_id: "pdf-1", page: 5, sha256: PDF_HASH, page_geometry: { width_points: 100, height_points: 100, rotation_degrees: 0 } },
    { attachment_id: "pdf-1", page: 4, sha256: "b".repeat(64), page_geometry: { width_points: 100, height_points: 100, rotation_degrees: 0 } },
    { attachment_id: "pdf-1", page: 4, sha256: PDF_HASH, page_geometry: { width_points: 100, height_points: 0, rotation_degrees: 0 } }
  ]) {
    await assert.rejects(validateExistingConditionsStructuredInterpretationV1(request, {
      find_upload,
      render_attachment: async () => ({ content: [
        { type: "text", text: JSON.stringify(metadata) },
        { type: "image", mimeType: "image/png", data: Buffer.from("pixels").toString("base64") }
      ] })
    }), /existing_conditions_interpretation_page_geometry_(missing_or_ambiguous|invalid):sheet/);
  }
});
