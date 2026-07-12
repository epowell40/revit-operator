import assert from "node:assert/strict";
import test from "node:test";
import { AEC_SEMANTIC_TASK_V1_SCHEMA, isAecSemanticTaskV1, normalizeAecSemanticTaskV1, type AecSemanticTaskV1 } from "../src/aec_semantic_task.js";

function exactAhuTask(): AecSemanticTaskV1 {
  return {
    schema: AEC_SEMANTIC_TASK_V1_SCHEMA,
    operation: "locate",
    subject: {
      kind: "exact_identifier",
      semantic_class: "mechanical_equipment",
      terms: ["air handling unit"],
      categories: ["OST_MechanicalEquipment"],
      family_name: null,
      type_name: null,
      system_name: null,
      identifiers: [{ parameter: "Mark", value: "AHU-1", match: "case_insensitive_exact" }]
    },
    scope: {
      kind: "active_context",
      document: null,
      levels: [],
      rooms: [],
      spaces: [],
      areas: [],
      views: [],
      sheets: [],
      systems: [],
      element_ids: [],
      region: null
    },
    reference: { strategy: "none", source_description: null, source_room: null },
    mutation: { kind: "none", requested: false },
    outputs: ["summary", "element_ids", "parameters", "spatial_context", "best_view"],
    execution: { max_results: 10, max_primary_actions: 2, allow_document_fallback: false, requires_visual_verification: false },
    confidence: { value: 0.98, ambiguity: "none", reasons: ["exact equipment mark"] },
    evidence: { user_text: "Where is AHU-1?" }
  };
}

test("AecSemanticTaskV1 normalizes exact identity and preserves authoritative request evidence", () => {
  const source = exactAhuTask();
  const normalized = normalizeAecSemanticTaskV1(source, "  where can I find AHU-1?  ");
  assert.equal(normalized.evidence.user_text, "where can I find AHU-1?");
  assert.equal(normalized.subject.identifiers[0].value, "AHU-1");
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), normalized);
  assert.ok(isAecSemanticTaskV1(normalized));
  source.subject.identifiers[0].value = "MUTATED";
  source.scope.levels.push("MUTATED");
  assert.equal(normalized.subject.identifiers[0].value, "AHU-1");
  assert.deepEqual(normalized.scope.levels, []);
});

test("AecSemanticTaskV1 represents room, level, view, sheet, selection, region, and mixed scope without silent widening", () => {
  const cases: AecSemanticTaskV1[] = [
    { ...exactAhuTask(), scope: { ...exactAhuTask().scope, kind: "room", rooms: ["403"] } },
    { ...exactAhuTask(), scope: { ...exactAhuTask().scope, kind: "level", levels: ["LEVEL 4"] } },
    { ...exactAhuTask(), scope: { ...exactAhuTask().scope, kind: "view", views: [{ id: 123, name: "L4 - POWER" }] } },
    { ...exactAhuTask(), scope: { ...exactAhuTask().scope, kind: "sheet", sheets: ["E401"] } },
    { ...exactAhuTask(), scope: { ...exactAhuTask().scope, kind: "selection", element_ids: [1, 2] } },
    { ...exactAhuTask(), scope: { ...exactAhuTask().scope, kind: "region", region: { frame_id: "frame-1", min_u: 0, min_v: 0, max_u: 1, max_v: 1 } } },
    { ...exactAhuTask(), scope: { ...exactAhuTask().scope, kind: "mixed", levels: ["LEVEL 4"], rooms: ["403"] } }
  ];
  for (const value of cases) assert.ok(isAecSemanticTaskV1(value), value.scope.kind);

  const unsupported = structuredClone(exactAhuTask()) as any;
  unsupported.scope.phase = "NEW CONSTRUCTION";
  assert.throws(() => normalizeAecSemanticTaskV1(unsupported), /scope\.phase/);
  const mismatched = structuredClone(exactAhuTask());
  mismatched.scope.kind = "room";
  assert.throws(() => normalizeAecSemanticTaskV1(mismatched), /scope\.kind/);
  const accidentalDocument = structuredClone(exactAhuTask());
  accidentalDocument.scope.kind = "document";
  assert.throws(() => normalizeAecSemanticTaskV1(accidentalDocument), /allow_document_fallback/);
});

test("AecSemanticTaskV1 rejects malformed, ambiguous, non-plain, unbounded, and internally inconsistent values", () => {
  const invalid: unknown[] = [];
  const push = (mutate: (value: any) => void) => { const value: any = structuredClone(exactAhuTask()); mutate(value); invalid.push(value); };
  push(value => { value.extra = true; });
  push(value => { value.confidence.value = Number.NaN; });
  push(value => { value.execution.max_results = 501; });
  push(value => { value.scope.element_ids = [1, 1]; value.scope.kind = "selection"; });
  push(value => { value.scope.region = { frame_id: "f", min_u: 2, min_v: 0, max_u: 1, max_v: 1 }; value.scope.kind = "region"; });
  push(value => { value.subject.identifiers = []; });
  push(value => { value.mutation = { kind: "create", requested: true }; });
  push(value => { value.reference = { strategy: "explicit", source_description: null }; });
  push(value => { value.outputs = ["summary", "summary"]; });
  push(value => { value.evidence.user_text = "x".repeat(4001); });
  invalid.push(new Date(), new Map(), { ...exactAhuTask(), subject: new (class Subject {})() });
  for (const value of invalid) assert.throws(() => normalizeAecSemanticTaskV1(value));
});

test("document scope is an explicit opt-in rather than a fallback side effect", () => {
  const value = exactAhuTask();
  value.scope.kind = "document";
  value.execution.allow_document_fallback = true;
  assert.equal(normalizeAecSemanticTaskV1(value).scope.kind, "document");
  value.scope.rooms = ["403"];
  assert.throws(() => normalizeAecSemanticTaskV1(value), /scope\.kind/);
});
