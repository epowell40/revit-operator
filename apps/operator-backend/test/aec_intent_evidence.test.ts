import test from "node:test";
import assert from "node:assert/strict";
import { AEC_INTENT_EVIDENCE_MAX_STRING_CHARS, AEC_INTENT_EVIDENCE_V1_SCHEMA, toSerializableAecIntentEvidenceV1, validateAecIntentEvidenceV1 } from "../src/aec_intent_evidence.js";
import { adaptMepSemanticRoutePlanToAecIntentEvidence } from "../src/deterministic/mep_semantic_route_evidence.js";
import { resolveMepSemanticRoutePlan } from "../src/deterministic/mep_semantic_route.js";

const adapterOptions = { id: "evidence-test-id", created_at: "2026-07-10T00:00:00.000Z" };
const row1936Request = "Assess, PLAN-ONLY, a potential extension of piping from the main to the sink in room 405. Do not modify the Revit model. Do not execute, dry-run, apply, or write any next_actions. Produce a discovery-first assessment identifying exactly what information, elements, and conditions must be discovered before a feasible routing plan can be made, including: room 405 identity, level and boundaries; sink fixture identity, location, connector count/type/domain/system/direction/size/elevation and connection status; candidate piping mains and branch connection points; domestic cold water, hot water, sanitary, vent, or other applicable systems; pipe types, sizes, materials and elevations; ceiling/plenum and vertical routing constraints; slopes, clearances, penetrations, clashes, accessibility and code/design constraints; and connector/system compatibility and connection feasibility. Return planner findings, blockers, required discoveries, and proposed next_actions strictly as unexecuted recommendations.";

test("AecIntentEvidenceV1 normalizes to a serializable, valid round-trip record", () => {
  const response = resolveMepSemanticRoutePlan({ user_text: "Extend piping from the main to the sink in room 405.", room_number: "405" });
  const evidence = adaptMepSemanticRoutePlanToAecIntentEvidence(
    { user_text: "Extend piping from the main to the sink in room 405.", room_number: "405" },
    response,
    adapterOptions
  );
  const roundTrip = JSON.parse(JSON.stringify(toSerializableAecIntentEvidenceV1(evidence)));
  const validated = validateAecIntentEvidenceV1(roundTrip);
  assert.equal(validated.ok, true);
  assert.equal(roundTrip.schema, AEC_INTENT_EVIDENCE_V1_SCHEMA);
  assert.equal(roundTrip.origin.producer.name, "mep_semantic_route");
  assert.equal(roundTrip.evidence[0].kind, "user_text");
  assert.equal(roundTrip.evidence[0].text, "Extend piping from the main to the sink in room 405.");
  assert.deepEqual(roundTrip.evidence[0].source, { kind: "request", field: "user_text" });
  assert.notEqual(roundTrip, evidence);
  assert.equal(validateAecIntentEvidenceV1({ ...roundTrip, schema: "wrong" }).ok, false);
  assert.equal(validateAecIntentEvidenceV1({
    ...roundTrip,
    intent: { ...roundTrip.intent, proposed_actions: [{ ...roundTrip.intent.proposed_actions[0], body: { nonSerializable: () => undefined } }] }
  }).ok, false);
  assert.equal(validateAecIntentEvidenceV1({
    ...roundTrip,
    verification: { ...roundTrip.verification, observed: [{ gate: "not_a_gate", status: "not_run" }] }
  }).ok, false);
  assert.equal(validateAecIntentEvidenceV1({
    ...roundTrip,
    intent: { ...roundTrip.intent, proposed_actions: [{ tool: "/revit/find-elements", body: {}, requires_apply: "false" }] }
  }).ok, false);
});

test("AecIntentEvidenceV1 preserves every approved nested provider, evidence, frame, target, and verification field", () => {
  const base = adaptMepSemanticRoutePlanToAecIntentEvidence({ user_text: "x" }, resolveMepSemanticRoutePlan({ user_text: "x" }), adapterOptions) as any;
  const full = { ...base, origin: { ...base.origin, provider: { name: "gemini", model: "vision", request_id: "r1" } }, evidence: [{ id: "pdf", kind: "pdf_annotation", source: { kind: "provider", field: "annotation" }, text: "callout", text_truncated: false, uri: "artifact://a", sha256: "abc", captured_at: "2026-07-10T00:00:00Z", page: { number: 1, label: "A101", normalized_box: { min_x: 0.1, min_y: 0.2, max_x: 0.9, max_y: 0.8 } }, frame: { id: "f1", view_id: 101, coordinate_frame: "pdf_page_normalized", units: "normalized" }, confidence: 0.8 }], coordinate_frames: [{ id: "f1", kind: "pdf_page_normalized", units: "normalized", transform_evidence_ids: ["pdf"] }, { id: "f2", kind: "image_pixel", units: "px" }, { id: "f3", kind: "sheet_uv", units: "normalized" }], target: { ...base.target, document: { id: "d", path: "p", fingerprint: "fp" }, sheet: { number: "M1", id: 2 }, view: { id: 101, name: "V", frame_id: "f1" }, location: { level: "L1", room_or_space: "405", element_ids: [2, "3"] } }, verification: { ...base.verification, observed: [{ gate: "dry_run", status: "not_run", reason: "not executed", evidence_ids: ["pdf"] }] } };
  const result = validateAecIntentEvidenceV1(full);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(JSON.parse(JSON.stringify(toSerializableAecIntentEvidenceV1(result.value))), full);
});

test("AecIntentEvidenceV1 rejects malformed nested approved fields and undefined JSON values", () => {
  const base = adaptMepSemanticRoutePlanToAecIntentEvidence({ user_text: "x" }, resolveMepSemanticRoutePlan({ user_text: "x" }), adapterOptions) as any;
  const invalid = (patch: Record<string, unknown>) => assert.equal(validateAecIntentEvidenceV1({ ...base, ...patch }).ok, false);
  invalid({ origin: { ...base.origin, provider: { name: 123 } } });
  invalid({ evidence: [{ ...base.evidence[0], page: { number: "1" } }] });
  invalid({ coordinate_frames: [{ id: "f1", kind: "pdf_page_normalized", units: "normalized", transform_evidence_ids: [123] }] });
  invalid({ verification: { ...base.verification, observed: [{ gate: "dry_run", status: "not_run", evidence_ids: [123] }] } });
  invalid({ created_at: "2026-02-30T00:00:00Z" });
  invalid({ intent: { ...base.intent, proposed_actions: [{ ...base.intent.proposed_actions[0], body: { nested: undefined } }] } });
  invalid({ origin: { ...base.origin, host: { ...base.origin.host, name: "x".repeat(AEC_INTENT_EVIDENCE_MAX_STRING_CHARS + 1) } } });
  invalid({ evidence: [{ ...base.evidence[0], page: { number: 1, normalized_box: { min_x: 0.8, min_y: -0.1, max_x: 0.2, max_y: 1.1 } } }] });
});

test("semantic MEP evidence preserves vague discovery actions and an unresolved target", () => {
  const request = { user_text: "Extend piping from the main to the sink in room 405.", room_number: "405" };
  const response = resolveMepSemanticRoutePlan(request);
  const evidence = adaptMepSemanticRoutePlanToAecIntentEvidence(request, response, adapterOptions);

  assert.equal(response.status, "needs_discovery");
  assert.equal(evidence.target.status, "unresolved");
  assert.equal(evidence.confidence.value, 0.5);
  assert.deepEqual(evidence.intent.proposed_actions.map((action) => action.tool), ["/revit/find-elements", "/revit/find-elements"]);
  assert.deepEqual(evidence.intent.proposed_actions.map((action) => action.body), JSON.parse(JSON.stringify(response.next_actions.map((action) => action.body))));
  assert.ok(evidence.intent.proposed_actions.every((action) => action.requires_apply === false));
  assert.deepEqual(evidence.verification.observed.map((gate) => gate.status), ["not_run", "not_run", "not_run", "not_run", "not_run"]);
});

test("semantic MEP evidence records the exact live room phrase without changing unresolved discovery actions", () => {
  const request = { user_text: "Plan only—do not modify the model. Use only the semantic MEP planner to assess extending piping from the main to the sink in room 405. Identify what must be discovered first. Do not execute returned next_actions, do not dry-run, apply, or write any changes." };
  const response = resolveMepSemanticRoutePlan(request);
  const evidence = adaptMepSemanticRoutePlanToAecIntentEvidence(request, response, adapterOptions);

  assert.equal(evidence.target.status, "unresolved");
  assert.equal(evidence.target.location?.room_or_space, "405");
  assert.deepEqual(evidence.intent.proposed_actions.map((action) => action.tool), ["/revit/find-elements", "/revit/find-elements"]);
  assert.ok(evidence.intent.proposed_actions.every((action) => action.requires_apply === false));
  assert.deepEqual(evidence.intent.proposed_actions.map((action) => action.body), JSON.parse(JSON.stringify(response.next_actions.map((action) => action.body))));
});

test("semantic MEP evidence accepts repeated identical Room 405 grounding from row 1936", () => {
  const request = { user_text: row1936Request };
  const response = resolveMepSemanticRoutePlan(request);
  const evidence = adaptMepSemanticRoutePlanToAecIntentEvidence(request, response, adapterOptions);
  assert.equal(response.status, "needs_discovery");
  assert.equal(evidence.target.status, "unresolved");
  assert.equal(evidence.target.location?.room_or_space, "405");
  assert.deepEqual(evidence.intent.proposed_actions.map((action) => action.tool), ["/revit/find-elements", "/revit/find-elements"]);
  assert.ok(evidence.intent.proposed_actions.every((action) => action.requires_apply === false));
  assert.deepEqual(evidence.verification.observed.map((gate) => gate.status), ["not_run", "not_run", "not_run", "not_run", "not_run"]);
});

test("semantic MEP evidence accepts separated identical rooms and rejects lexical or direct-list variants", () => {
  for (const user_text of ["Room 405 is in scope. Inspect room 405 before routing.", "ROOM 405 is in scope. After discovery, Room 405 remains in scope. Confirm room 405 boundaries."]) {
    const evidence = adaptMepSemanticRoutePlanToAecIntentEvidence({ user_text }, resolveMepSemanticRoutePlan({ user_text }), adapterOptions);
    assert.equal(evidence.target.location?.room_or_space, "405", user_text);
  }
  for (const user_text of ["Extend piping in room 405/406.", "Extend piping in room 405/0405.", "Extend piping in room 405 and room #405.", "Extend piping in room 405 / room 405.", "Extend piping in room 405 + room405.", "Extend piping in room 405 to room 405.", "Extend piping in room 405, room 405."]) {
    const evidence = adaptMepSemanticRoutePlanToAecIntentEvidence({ user_text }, resolveMepSemanticRoutePlan({ user_text }), adapterOptions);
    assert.equal(evidence.target.location?.room_or_space, undefined, user_text);
  }
});

test("semantic MEP evidence gives structured room scope precedence over user text", () => {
  const request = { user_text: "Extend piping in room 405.", room_number: " 402 " };
  const evidence = adaptMepSemanticRoutePlanToAecIntentEvidence(request, resolveMepSemanticRoutePlan(request), adapterOptions);
  assert.equal(evidence.target.location?.room_or_space, "402");
});

test("semantic MEP evidence omits room scope when user text has no explicit room phrase", () => {
  const request = { user_text: "Extend piping from the main to the sink nearby." };
  const evidence = adaptMepSemanticRoutePlanToAecIntentEvidence(request, resolveMepSemanticRoutePlan(request), adapterOptions);
  assert.equal(evidence.target.location?.room_or_space, undefined);
});

test("semantic MEP evidence rejects numeric continuations, ranges, and list separators", () => {
  for (const user_text of ["Extend piping in room 405 to 406.", "Extend piping in room 405 through 406.", "Extend piping in room 405 thru 406.", "Extend piping in room 405 & 406.", "Extend piping in room 405 + 406.", "Extend piping in room 405 406.", "Extend piping in room 405.5.", "Extend piping in room 405A.", "Extend piping in room 405a.", "Extend piping in room 405th.", "Extend piping in room 405_1.", "Extend piping in room 405Z.", "Extend piping in room 405-406.", "Extend piping in room 405–406.", "Extend piping in room 405—406.", "Extend piping in room 405 and 406.", "Extend piping in room 405 or 406.", "Extend piping in room 405, 406.", "Extend piping in room 405/406.", "Extend piping in room 405;406.", "Extend piping in room 405:406.", "Extend piping in room 405\\406."]) {
    const request = { user_text };
    const evidence = adaptMepSemanticRoutePlanToAecIntentEvidence(request, resolveMepSemanticRoutePlan(request), adapterOptions);
    assert.equal(evidence.target.location?.room_or_space, undefined, user_text);
  }
});

test("semantic MEP evidence rejects multiple, malformed, oversized, and truncated-source room text", () => {
  for (const user_text of ["Extend piping in room 405 and room 406.", "Extend piping in room #405.", `Extend piping in room ${"9".repeat(513)}.`, `${"x".repeat(4_000)} room 405`]) {
    const request = { user_text };
    const evidence = adaptMepSemanticRoutePlanToAecIntentEvidence(request, resolveMepSemanticRoutePlan(request), adapterOptions);
    assert.equal(evidence.target.location?.room_or_space, undefined, user_text.slice(-32));
  }
});

test("semantic MEP evidence accepts only explicit trusted host context and deduplicates blocked constraints", () => {
  const response = resolveMepSemanticRoutePlan({ user_text: "Connect piping to that sink.", tool_results: [{ action_id: "x", method: "POST", path: "/revit/find-elements", status: "done", result_json: { elements: [{ id: 1, category: "OST_PlumbingFixtures", name: "Sink" }, { id: 2, category: "OST_PlumbingFixtures", name: "Sink" }] } }] });
  const codex = adaptMepSemanticRoutePlanToAecIntentEvidence({ user_text: "Connect piping to that sink." }, response, { ...adapterOptions, host: { kind: "codex", name: "trusted-codex" } });
  const unknown = adaptMepSemanticRoutePlanToAecIntentEvidence({ user_text: "Connect piping to that sink." }, response, adapterOptions);
  assert.equal(codex.origin.host.kind, "codex");
  assert.equal(unknown.origin.host.kind, "other");
  assert.equal(new Set(codex.constraints).size, codex.constraints.length);
});

test("semantic MEP evidence keeps the guarded dry-run action declarative and does not invoke tools or upgrade state", () => {
  const request = {
    user_text: "Extend piping from the main to the sink.",
    tool_results: [
      { action_id: "targets", method: "POST" as const, path: "/revit/find-elements", status: "done" as const, result_json: { elements: [{ id: 2001, category: "OST_PlumbingFixtures", name: "Sink", point: { x: 14, y: 20, z: 0 } }] } },
      { action_id: "mains", method: "POST" as const, path: "/revit/find-elements", status: "done" as const, result_json: { elements: [{ id: 3001, category: "OST_PipeCurves", name: "Pipe Main", projectedPoint: { x: 10, y: 20, z: 0 } }] } }
    ]
  };
  const response = resolveMepSemanticRoutePlan(request);
  let invoked = 0;
  (response.next_actions[0] as any).invoke = () => { invoked += 1; };
  const evidence = adaptMepSemanticRoutePlanToAecIntentEvidence(request, response, adapterOptions);

  assert.equal(response.status, "dry_run_ready");
  assert.equal(evidence.target.status, "resolved");
  assert.equal(evidence.confidence.value, 0.8);
  assert.equal(evidence.intent.proposed_actions.length, 1);
  assert.equal(evidence.intent.proposed_actions[0]?.tool, "/revit/connect-mep-branch");
  assert.equal(evidence.intent.proposed_actions[0]?.requires_apply, false);
  assert.equal(invoked, 0);
  assert.equal("invoke" in (evidence.intent.proposed_actions[0]?.body ?? {}), false);
});
