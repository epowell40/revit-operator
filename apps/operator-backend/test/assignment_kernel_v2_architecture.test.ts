import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ASSIGNMENT_EVENT_V2_SCHEMA,
  ASSIGNMENT_KERNEL_V2_FEATURE_FLAG,
  ASSIGNMENT_SNAPSHOT_V2_SCHEMA,
  ASSIGNMENT_SPEC_V2_SCHEMA,
  OBSERVATION_V2_SCHEMA,
  OPERATION_RESULT_V2_SCHEMA,
  OPERATION_V2_SCHEMA,
  assignmentKernelV2Enabled,
  sameAssignmentBindingV2,
  type AssignmentBindingV2
} from "../src/domain/assignment-kernel/index.js";

interface ReplayScenario {
  id: string;
  shape: string;
  invariant: string;
  expected_domain_result: string;
  regression?: { path: string; test: string };
  private_regression_id?: string;
}

interface ReplayCorpus {
  schema: string;
  scenarios: ReplayScenario[];
}

function loadCorpus(): ReplayCorpus {
  const file = path.join(process.cwd(), "test", "fixtures", "assignment-kernel-v2", "epic0455_failure_shapes.json");
  return JSON.parse(readFileSync(file, "utf8")) as ReplayCorpus;
}

test("Assignment Kernel V2 schemas are versioned independently of transports", () => {
  assert.equal(ASSIGNMENT_SPEC_V2_SCHEMA, "revit-operator.assignment-spec/v2");
  assert.equal(ASSIGNMENT_EVENT_V2_SCHEMA, "revit-operator.assignment-event/v2");
  assert.equal(ASSIGNMENT_SNAPSHOT_V2_SCHEMA, "revit-operator.assignment-snapshot/v2");
  assert.equal(OPERATION_V2_SCHEMA, "revit-operator.operation/v2");
  assert.equal(OPERATION_RESULT_V2_SCHEMA, "revit-operator.operation-result/v2");
  assert.equal(OBSERVATION_V2_SCHEMA, "revit-operator.observation/v2");
});

test("Assignment Kernel V2 is default off and only explicit values enable it", () => {
  assert.equal(assignmentKernelV2Enabled({}), false);
  assert.equal(assignmentKernelV2Enabled({ [ASSIGNMENT_KERNEL_V2_FEATURE_FLAG]: "0" }), false);
  assert.equal(assignmentKernelV2Enabled({ [ASSIGNMENT_KERNEL_V2_FEATURE_FLAG]: "yes" }), false);
  assert.equal(assignmentKernelV2Enabled({ [ASSIGNMENT_KERNEL_V2_FEATURE_FLAG]: "1" }), true);
  assert.equal(assignmentKernelV2Enabled({ [ASSIGNMENT_KERNEL_V2_FEATURE_FLAG]: "TRUE" }), true);
});

test("Assignment binding equality includes every trusted lifecycle dimension", () => {
  const binding: AssignmentBindingV2 = {
    assignment_id: "assignment-a",
    run_id: "run-a",
    generation: 2,
    session_id: "session-a",
    principal_id: "principal-a",
    document_fingerprint: "document-a"
  };
  assert.equal(sameAssignmentBindingV2(binding, { ...binding }), true);
  for (const changed of [
    { ...binding, assignment_id: "assignment-b" },
    { ...binding, run_id: "run-b" },
    { ...binding, generation: 3 },
    { ...binding, session_id: "session-b" },
    { ...binding, principal_id: "principal-b" },
    { ...binding, document_fingerprint: "document-b" }
  ]) {
    assert.equal(sameAssignmentBindingV2(binding, changed), false);
  }
});

test("historical replay corpus covers every EPIC-0455 candidate and required failure family", () => {
  const corpus = loadCorpus();
  assert.equal(corpus.schema, "revit-operator.assignment-kernel-historical-replay/v1");
  assert.equal(corpus.scenarios.length, 19);
  const ids = new Set(corpus.scenarios.map((scenario) => scenario.id));
  assert.equal(ids.size, corpus.scenarios.length);
  for (let candidate = 1; candidate <= 16; candidate += 1) {
    assert.ok(corpus.scenarios.some((scenario) => scenario.id.startsWith(`candidate-${String(candidate).padStart(2, "0")}-`)));
  }
  for (const scenario of corpus.scenarios) {
    assert.ok(scenario.shape.length > 4);
    assert.ok(scenario.invariant.length > 4);
    assert.ok(scenario.expected_domain_result.length > 4);
    if (scenario.regression) {
      const regressionPath = path.resolve(process.cwd(), scenario.regression.path);
      assert.equal(existsSync(regressionPath), true, `${scenario.id}: missing executable regression ${scenario.regression.path}`);
      const source = readFileSync(regressionPath, "utf8");
      assert.ok(source.includes(`test("${scenario.regression.test}"`), `${scenario.id}: missing executable test '${scenario.regression.test}'`);
    } else {
      assert.match(scenario.private_regression_id ?? "", /^sidecar-/, `${scenario.id}: every historical shape must bind an executable public or private regression`);
    }
  }
});

test("EPIC-0456 progression replay names every frozen liveness failure family", () => {
  const file = path.join(process.cwd(), "test", "fixtures", "assignment-kernel-v2", "epic0456_liveness_shapes.json");
  const corpus = JSON.parse(readFileSync(file, "utf8")) as {
    schema: string;
    source_summary: Record<string, number | boolean>;
    scenarios: Array<{ id: string; invariant: string; implementation_phase: number }>;
  };
  assert.equal(corpus.schema, "revit-operator.assignment-progression-historical-replay/v1");
  assert.deepEqual(corpus.source_summary, {
    provider_calls: 51,
    operations: 45,
    observations: 29,
    criterion_evaluations: 0,
    terminal: false,
    quiescent: true
  });
  assert.equal(corpus.scenarios.length, 15);
  assert.equal(new Set(corpus.scenarios.map((scenario) => scenario.id)).size, corpus.scenarios.length);
  for (const scenario of corpus.scenarios) {
    assert.ok(scenario.id.length > 4);
    assert.ok(scenario.invariant.length > 8);
    assert.ok([1, 2, 3].includes(scenario.implementation_phase));
  }
});

test("EPIC-0457 Candidate 1 replay assigns every authoritative request one immutable operation owner", () => {
  const file = path.join(process.cwd(), "test", "fixtures", "assignment-kernel-v2", "epic0457_candidate1_operation_ownership.json");
  const corpus = JSON.parse(readFileSync(file, "utf8")) as {
    schema: string;
    source_summary: { provider_calls: number; parent_route: string; hidden_prerequisite_route: string };
    operation_tree: {
      parent: { operation_id: string; settlement_rule: string };
      children: Array<{ operation_id: string; role: string; settlement_rule: string }>;
    };
    invariants: string[];
  };
  assert.equal(corpus.schema, "revit-operator.assignment-operation-ownership-replay/v1");
  assert.equal(corpus.source_summary.provider_calls, 51);
  assert.equal(corpus.source_summary.parent_route, "POST /revit/quantify");
  assert.equal(corpus.source_summary.hidden_prerequisite_route, "GET /revit/tool-registry");
  const operationIds = [corpus.operation_tree.parent.operation_id, ...corpus.operation_tree.children.map(child => child.operation_id)];
  assert.equal(new Set(operationIds).size, operationIds.length);
  assert.ok(corpus.operation_tree.children.some(child => child.role === "prerequisite"));
  assert.ok(corpus.operation_tree.children.every(child => child.settlement_rule.includes(child.operation_id)));
  assert.match(corpus.operation_tree.parent.settlement_rule, /exact_operation_id/);
  assert.ok(corpus.invariants.includes("child_result_never_settles_parent"));
  assert.ok(corpus.invariants.includes("v2_publication_uses_snapshot_and_provider_ledger_without_v1_projection"));
});

test("canonical progression decision and epoch contracts have one domain owner", () => {
  const root = path.join(process.cwd(), "src");
  const declarations = sourceFiles(root).filter((file) => /export type ProgressDecisionV2|export interface ProgressEpochV2/.test(readFileSync(file, "utf8")));
  assert.deepEqual(declarations.map((file) => path.relative(process.cwd(), file).replaceAll("\\", "/")), [
    "src/domain/assignment-kernel/progress/contracts.ts"
  ]);
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(absolute) : entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

test("the transport-independent domain imports no edge, route, evidence-projection, packet, or benchmark types", () => {
  const root = path.join(process.cwd(), "src", "domain", "assignment-kernel");
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, "utf8");
    if (source.includes("@revitoperator/payload-digest-v2")) {
      assert.ok(["canonical.ts", "payload_provenance.ts"].includes(path.basename(file)), file);
    }
    const withoutSharedPayloadContract = source.replaceAll("@revitoperator/payload-digest-v2", "assignment-kernel-payload-contract");
    assert.doesNotMatch(withoutSharedPayloadContract, /from\s+["'][^"']*(?:mcp|http|sidecar|revit|work_packets|work_returns|benchmark|evidence_projection)[^"']*["']/i, file);
    assert.doesNotMatch(source, /(?:route|path)_string/i, file);
  }
});

test("the machine-readable adapter registry is bounded to the four admitted edge/projection classes", () => {
  const registryPath = path.join(process.cwd(), "architecture", "assignment-kernel-v2-adapters.v1.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { schema: string; allowed_adapters: Array<{ id: string; class: string; paths: string[] }> };
  assert.equal(registry.schema, "revit-operator.assignment-kernel-adapter-registry/v1");
  assert.deepEqual(new Set(registry.allowed_adapters.map(item => item.class)), new Set([
    "external_input", "native_result", "legacy_read_projection", "presentation"
  ]));
  for (const adapter of registry.allowed_adapters) {
    assert.ok(adapter.id.length > 4);
    assert.ok(adapter.paths.length > 0);
    for (const relative of adapter.paths) assert.equal(existsSync(path.resolve(process.cwd(), relative)), true, `${adapter.id}: ${relative}`);
  }
});

test("V2 projections cannot write journal events and V2 completion has no specialized assertion DSL", () => {
  for (const relative of [
    "src/assignments/projection.ts",
    "src/work_packets/assignment_kernel_v2_generator.ts",
    "src/work_returns/assignment_kernel_v2_generator.ts",
    "src/benchmark/canonical_assignment_truth.ts",
    "src/benchmark/protocol_v2_runner.ts"
  ]) {
    const source = readFileSync(path.join(process.cwd(), relative), "utf8");
    assert.doesNotMatch(source, /append(?:Current)?AssignmentKernelEventV2|mutateGoalRecord/, relative);
  }
  const lifecycle = readFileSync(path.join(process.cwd(), "src/assignments/assignment_kernel_v2_lifecycle.ts"), "utf8");
  assert.doesNotMatch(lifecycle, /read_completion|noop_completion|assertion.*path|json.*selector/i);
  const evaluator = readFileSync(path.join(process.cwd(), "src/domain/assignment-kernel/criterion_evaluator.ts"), "utf8");
  assert.doesNotMatch(evaluator, /EvidenceProjection|evidence_projection|payload\.items|content\[0\]/);
});

test("V2 terminal commit has one owner and provider turns reconcile before releasing its barrier", () => {
  const sourceRoot = path.join(process.cwd(), "src");
  const terminalWriters = sourceFiles(sourceRoot).filter((file) =>
    /body:\s*\{\s*event_type:\s*"assignment_terminal"/.test(readFileSync(file, "utf8")));
  assert.deepEqual(terminalWriters.map((file) => path.relative(process.cwd(), file).replaceAll("\\", "/")), [
    "src/assignments/assignment_kernel_v2_lifecycle.ts"
  ]);

  const lifecycle = readFileSync(path.join(sourceRoot, "assignments", "assignment_kernel_v2_lifecycle.ts"), "utf8");
  assert.match(lifecycle, /assignmentKernelTerminalSettlementDeferredV2/);
  const brain = readFileSync(path.join(sourceRoot, "brains", "codex_brain.ts"), "utf8");
  const barrierAdmissionAt = brain.indexOf("assignmentTerminalBarrier = beginAssignmentKernelTerminalBarrierV2");
  const notificationBindAt = brain.indexOf("bindTurnNotificationSource(activeClient);", barrierAdmissionAt);
  const providerStartAt = brain.indexOf("return await activeClient.startTurn({", barrierAdmissionAt);
  assert.ok(barrierAdmissionAt >= 0 && notificationBindAt > barrierAdmissionAt && providerStartAt > notificationBindAt,
    "terminality must be barred and provider notifications captured before provider execution starts");
  const reconcileAt = brain.indexOf("providerReceiptRecorder.reconcile(modelTelemetry.receipts)");
  const normalReleaseAt = brain.indexOf("await releaseStartedProviderTurn(false)", reconcileAt);
  assert.ok(reconcileAt >= 0 && normalReleaseAt > reconcileAt,
    "completed provider receipts must reconcile before the immutable terminal barrier is released");
  const setupBindAt = brain.indexOf("bindBackendAuthLeaseTurn(backendAuthLease, turnId)", providerStartAt);
  const abnormalReleaseAt = brain.indexOf("await releaseStartedProviderTurn(true)", setupBindAt);
  assert.ok(setupBindAt > providerStartAt && abnormalReleaseAt > setupBindAt,
    "every failure after provider start must interrupt and release the exact started turn");
  assert.match(brain, /const releaseStartedProviderTurn = async[\s\S]*interruptTurn[\s\S]*endAssignmentKernelTerminalBarrierV2[\s\S]*endAssignmentKernelV2Lease/,
    "started-turn cleanup must own interruption, terminal barrier release, and lease release as one idempotent path");
});

test("settled task evidence cannot be overtaken by another root operation", () => {
  const sourceRoot = path.join(process.cwd(), "src");
  const dynamicHandler = readFileSync(path.join(sourceRoot, "brains", "codex_dynamic_tool_handler.ts"), "utf8");
  const checkpointStart = dynamicHandler.indexOf("function checkpointAssignmentKernelProgressV2");
  const checkpointEnd = dynamicHandler.indexOf("export async function handleCodexDynamicToolCall", checkpointStart);
  const checkpoint = dynamicHandler.slice(checkpointStart, checkpointEnd);
  assert.ok(checkpointStart >= 0 && checkpointEnd > checkpointStart);
  assert.match(checkpoint, /recordAssignmentProgressEpochV2[\s\S]*advanceAssignmentKernelProgressV2/);
  assert.doesNotMatch(checkpoint, /providerReceiptRetained|if\s*\([^)]*provider[^)]*receipt[^)]*\)\s*return/i,
    "criterion progression must not wait for provider telemetry; the terminal barrier owns receipt ordering");

  const execution = readFileSync(path.join(sourceRoot, "assignments", "assignment_kernel_v2_execution.ts"), "utf8");
  assert.match(execution, /criteriaPendingEvaluationV2\(snapshot\)[\s\S]*assignment_kernel_v2_criterion_evaluation_pending/);
  const reducer = readFileSync(path.join(sourceRoot, "domain", "assignment-kernel", "reducer.ts"), "utf8");
  assert.match(reducer, /role !== "root" \|\| Object\.keys\(criteriaPendingEvaluationV2\(snapshot\)\)\.length === 0/,
    "the canonical reducer, not only one adapter, must enforce evaluate-before-act");
});

test("apply progress exposes one typed verification gap per unverified persistent effect", () => {
  const sourceRoot = path.join(process.cwd(), "src", "domain", "assignment-kernel");
  const controller = readFileSync(path.join(sourceRoot, "progress", "controller.ts"), "utf8");
  assert.match(controller, /kind:\s*"verification_required"/);
  assert.match(controller, /required_fact_ids:\s*\["verification\.postcondition_satisfied"\]/);
  const outcome = readFileSync(path.join(sourceRoot, "outcome.ts"), "utf8");
  assert.match(outcome, /appliedOperations\.every\(\(operation\) => appliedOperationHasVerifiedPostconditionV2/,
    "every applied operation must retain its own verified postcondition before completion");
  assert.doesNotMatch(outcome, /appliedOperations\.some\(/);
});

test("OperationV2 identity does not incorporate MCP aliases or route/path strings", () => {
  const source = readFileSync(path.join(process.cwd(), "src/assignments/assignment_kernel_v2_execution.ts"), "utf8");
  const identity = /const operationId = `opv2_\$\{stableHash\(\{([\s\S]*?)\}\)\}`;/.exec(source)?.[1] ?? "";
  assert.ok(identity.includes("assignment_id"));
  assert.ok(identity.includes("controller_request_id"));
  assert.doesNotMatch(identity, /path|route|alias/i);
});

test("V2 publication and benchmark truth consume the canonical snapshot and provider ledger directly", () => {
  const publication = readFileSync(path.join(process.cwd(), "src/assignments/assignment_kernel_v2_publication.ts"), "utf8");
  assert.match(publication, /AssignmentSnapshotV2/);
  assert.match(publication, /provider_ledger/);
  const publicationImports = [...publication.matchAll(/from\s+["'][^"']+["']/g)].map(match => match[0]).join("\n");
  assert.doesNotMatch(publicationImports, /GoalRecord|AssignmentProjection|durable_assignment_projection|chat_response/i);
  assert.doesNotMatch(publication, /listGoals|related_session_id|assignment_kernel_v2\?/,
    "V2 session discovery must use the V2-native index, not legacy Goal arrays or lifecycle fields.");

  const protocol = readFileSync(path.join(process.cwd(), "src/benchmark/protocol_v2_kernel.ts"), "utf8");
  assert.match(protocol, /durable_assignment_kernel_v2/);
  assert.match(protocol, /Historical V1 report compatibility only/);
  assert.match(protocol, /expectedDirect\.length > 0 \? direct/);
});
