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
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:mcp|http|sidecar|revit|work_packets|work_returns|benchmark|evidence_projection)[^"']*["']/i, file);
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

test("OperationV2 identity does not incorporate MCP aliases or route/path strings", () => {
  const source = readFileSync(path.join(process.cwd(), "src/assignments/assignment_kernel_v2_execution.ts"), "utf8");
  const identity = /const operationId = `opv2_\$\{stableHash\(\{([\s\S]*?)\}\)\}`;/.exec(source)?.[1] ?? "";
  assert.ok(identity.includes("assignment_id"));
  assert.ok(identity.includes("controller_request_id"));
  assert.doesNotMatch(identity, /path|route|alias/i);
});
