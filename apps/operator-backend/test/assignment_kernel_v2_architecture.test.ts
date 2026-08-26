import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  }
});
