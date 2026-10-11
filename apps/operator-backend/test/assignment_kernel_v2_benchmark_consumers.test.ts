import assert from "node:assert/strict";
import test from "node:test";
import { assignmentKernelAcceptanceTruthV2 } from "../src/benchmark/assignment_kernel_v2_acceptance.js";
import { evaluateGeneralRevitCapabilityAttempt, type GeneralRevitCapabilityCase } from "../src/benchmark/general_revit_capability_acceptance.js";
import { loadVerifiedWorkPackets } from "../src/benchmark/work_packet_collection.js";

const binding = {
  assignment_id: "assignment-v2",
  run_id: "run-v2",
  generation: 1,
  session_id: "session-v2",
  principal_id: "principal-v2"
};

function publicationBundle(options: { evidenceClass?: string; outcome?: string; terminal?: boolean } = {}) {
  const operationId = "operation-task";
  const observationId = "observation-task";
  const criterionId = "criterion-task";
  const snapshot = {
    schema: "revit-operator.assignment-snapshot/v2",
    assignment_version: 26,
    current_binding: binding,
    spec: {
      requested_effect: "read",
      criteria: [{ criterion_id: criterionId, required: true }]
    },
    operations: {
      [operationId]: {
        operation_id: operationId,
        binding,
        fulfillment_role: "delegated_task_execution",
        dispatch_state: "dispatched",
        settlement_state: "settled",
        eligible_criterion_ids: [criterionId],
        result: {
          operation_id: operationId,
          binding,
          status: "succeeded",
          dispatch_state: "dispatched",
          result_schema_id: "operator-native/POST:/revit/quantify/v2"
        }
      }
    },
    observations: {
      [observationId]: {
        observation_id: observationId,
        operation_id: operationId,
        binding,
        fulfillment_role: "delegated_task_execution",
        evidence_class: options.evidenceClass ?? "task_result",
        eligible_criterion_ids: [criterionId],
        result_schema_id: "operator-native/POST:/revit/quantify/v2"
      }
    },
    criteria: {
      [criterionId]: {
        status: "pass",
        supporting_operation_ids: [operationId],
        supporting_facts: [{ observation_id: observationId, fact_id: "inventory.complete" }]
      }
    },
    terminal: options.terminal ?? true,
    quiescent: true,
    outcome: options.outcome ?? "complete",
    provider_call_ids: [],
    provider_calls: {},
    in_flight_provider_call_ids: [],
    in_flight_operation_ids: [],
    unresolved_unknown_operation_ids: []
  };
  return {
    schema: "revit-operator.benchmark-assignment-kernel-v2/v1",
    assignment_ids: [binding.assignment_id],
    assignments: [{
      schema: "revit-operator.assignment-kernel-publication/v2",
      assignment_id: binding.assignment_id,
      assignment_version: 26,
      snapshot,
      provider_ledger: {
        schema: "revit-operator.assignment-provider-ledger/v2",
        assignment_id: binding.assignment_id,
        run_id: binding.run_id,
        generation: binding.generation,
        call_ids: [],
        calls: {},
        in_flight_call_ids: []
      }
    }],
    failures: []
  };
}

test("Work Packet collection discovers exact V2 assignments without a legacy projection", async () => {
  const requested: string[] = [];
  const result = await loadVerifiedWorkPackets("http://operator", { assignments: [] }, publicationBundle(),
    async (_baseUrl, pathname) => {
      requested.push(pathname);
      return { packet: { packet_id: "packet-v2", packet_hash: `sha256:${"a".repeat(64)}` } };
    });
  assert.deepEqual(requested, ["/api/assignments/assignment-v2/verified-work-packet"]);
  assert.equal(result.assignment_source, "assignment_kernel_v2");
  assert.equal((result.packets as unknown[]).length, 1);
  assert.deepEqual(result.failures, []);
});

test("V2 Work Packet discovery is authoritative and V1 remains a historical fallback", async () => {
  const v2Paths: string[] = [];
  await loadVerifiedWorkPackets("http://operator", { assignments: [{ id: "legacy-conflict" }] }, publicationBundle(),
    async (_baseUrl, pathname) => {
      v2Paths.push(pathname);
      return { packet: { packet_id: "packet-v2", packet_hash: `sha256:${"b".repeat(64)}` } };
    });
  assert.deepEqual(v2Paths, ["/api/assignments/assignment-v2/verified-work-packet"]);

  const v1Paths: string[] = [];
  const v1 = await loadVerifiedWorkPackets("http://operator", { assignments: [{ source_record_id: "goal:legacy-only" }] }, {},
    async (_baseUrl, pathname) => {
      v1Paths.push(pathname);
      return { packet: { packet_id: "packet-v1", packet_hash: `sha256:${"c".repeat(64)}` } };
    });
  assert.deepEqual(v1Paths, ["/api/assignments/legacy-only/verified-work-packet"]);
  assert.equal(v1.assignment_source, "legacy_v1_projection");
});

test("Candidate 6 V2 causal chain yields the actual native task path and terminal acceptance truth", () => {
  const truth = assignmentKernelAcceptanceTruthV2(publicationBundle());
  assert.equal(truth.malformed, false);
  assert.equal(truth.completed, true);
  assert.equal(truth.verified, true);
  assert.equal(truth.dispatched, true);
  assert.deepEqual(truth.successful_task_paths, ["/revit/quantify"]);
});

test("control evidence cannot become benchmark task completion through a terminal flag", () => {
  const truth = assignmentKernelAcceptanceTruthV2(publicationBundle({ evidenceClass: "control" }));
  assert.equal(truth.completed, false);
  assert.equal(truth.verified, false);
});

function advisoryCommittedBundle(): any {
  const bundle: any = publicationBundle({ terminal: false, outcome: "awaiting_user_review" });
  const snapshot = bundle.assignments[0].snapshot;
  snapshot.spec.requested_effect = "apply";
  snapshot.criteria = {};
  const operation = snapshot.operations["operation-task"];
  operation.requested_effect = "apply";
  operation.persistent_effect = "applied";
  operation.request_identity = { method: "POST", path: "/revit/set-parameter" };
  Object.assign(operation.result, { persistent_effect: "applied", native_transaction_state: "committed",
    authority: "native-host", request_identity: operation.request_identity,
    result_schema_id: "operator-native/POST:/revit/set-parameter/v2" });
  snapshot.observations["observation-task"].result_schema_id = operation.result.result_schema_id;
  return bundle;
}

test("native commit diagnostics do not promote advisory execution to task acceptance", () => {
  const bundle = advisoryCommittedBundle();
  const truth = assignmentKernelAcceptanceTruthV2(bundle);
  assert.deepEqual(truth.native_committed_task_paths, ["/revit/set-parameter"]);
  assert.equal(truth.apply_dispatched, false);
  assert.equal(truth.completed, false);
  assert.equal(truth.verified, false);
  const testCase: GeneralRevitCapabilityCase = { case_id: "parameter-change", source: "user_basic",
    operation_family: "parameter_edit", prompt: "Set Mark and verify.", probe_prompt: "Set Mark and verify.",
    capability_paths: ["/revit/set-parameter"], dispatch_any_of: ["/revit/set-parameter"],
    expected_effect: "apply", epic0441_task_refs: [] };
  const result = evaluateGeneralRevitCapabilityAttempt(testCase, { ok: true, assignment_kernel_v2: bundle,
    actions: [{ path: "/chat", request_effect: "read", request_dispatched: true, status: "success" }] });
  assert.equal(result.tier, "failed");
  assert.equal(result.verified, false);
  assert.equal(result.summary, "A native apply committed on an expected route, but independent whole-task verification is missing.");
});

test("commit diagnostics reject rollback, wrong document, stale generation and control evidence", () => {
  const mutations = [
    (s: any) => { s.operations["operation-task"].result.native_transaction_state = "rolled_back"; },
    (s: any) => { s.operations["operation-task"].result.binding = { ...binding, document_fingerprint: "other" }; },
    (s: any) => { s.operations["operation-task"].binding = { ...binding, generation: 2 }; },
    (s: any) => { s.observations["observation-task"].evidence_class = "control"; },
    (s: any) => { s.operations["operation-task"].result.request_identity = { path: "/revit/other" }; }
  ];
  for (const mutate of mutations) {
    const bundle = advisoryCommittedBundle(); mutate(bundle.assignments[0].snapshot);
    assert.deepEqual(assignmentKernelAcceptanceTruthV2(bundle).native_committed_task_paths, []);
  }
});

test("general evaluator consumes exact V2 terminal truth instead of the empty legacy projection", () => {
  const testCase: GeneralRevitCapabilityCase = {
    case_id: "generic_inventory",
    source: "user_basic",
    operation_family: "project_query",
    prompt: "Inventory the model.",
    probe_prompt: "Inventory the model.",
    capability_paths: ["/revit/find-elements"],
    dispatch_any_of: ["/revit/find-elements"],
    expected_effect: "read",
    epic0441_task_refs: [],
    answer_assertions: { must_match: ["509"] }
  };
  const result = evaluateGeneralRevitCapabilityAttempt(testCase, {
    ok: true,
    assistant_message: "The inventory contains 509 elements.",
    assignment_projection: { assignments: [] },
    assignment_kernel_v2: publicationBundle(),
    durable_tool_evidence: { successful_paths: [] },
    actions: [{ path: "/chat", request_effect: "read", request_dispatched: true, status: "success" }]
  });
  assert.equal(result.tier, "verified");
  assert.equal(result.completed, true);
  assert.equal(result.verified, true);
  assert.equal(result.expected_path_observed, true);
  assert.ok(result.observed_paths.includes("/revit/quantify"));
  assert.equal(result.verification_basis, "fixture_semantic_oracle");
});

test("malformed V2 publication fails explicitly instead of falling back to legacy success", () => {
  const testCase: GeneralRevitCapabilityCase = {
    case_id: "generic_inventory",
    source: "user_basic",
    operation_family: "project_query",
    prompt: "Inventory the model.",
    probe_prompt: "Inventory the model.",
    capability_paths: ["/revit/find-elements"],
    dispatch_any_of: ["/revit/find-elements"],
    expected_effect: "read",
    epic0441_task_refs: []
  };
  const result = evaluateGeneralRevitCapabilityAttempt(testCase, {
    ok: true,
    assignment_kernel_v2: { ...publicationBundle(), schema: "wrong-schema" },
    actions: [{ path: "/revit/find-elements", request_effect: "read", request_dispatched: true, status: "success" }]
  });
  assert.equal(result.tier, "failed");
  assert.equal(result.outcome_unknown, true);
});
