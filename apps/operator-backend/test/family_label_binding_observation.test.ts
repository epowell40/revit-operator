import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "../src/tools/audit_tool_registry.js";
import { projectToolDocumentation } from "../src/evidence/tool_documentation_projection.js";
import type { EvidenceRefV1 } from "../src/evidence/evidence_ref.js";
import { nativeInspectionTargetIdsV2 } from "../src/assignments/native_inspection_coverage.js";
import { familyInspectionFixture } from "./fixtures/native_inspection_coverage_fixture.js";

test("actual native label-binding guidance survives the existing model-visible documentation projection", () => {
  const root = findRepoRoot(process.cwd());
  const apps = existsSync(path.join(root, "apps", "revit-bridge-addin")) ? path.join(root, "apps") : root;
  const source = readFileSync(path.join(apps, "revit-bridge-addin", "RevitBridge", "Operator", "OperatorToolManifest.cs"), "utf8");
  const line = source.split(/\r?\n/).find(line => line.includes('"/revit/inspect-family-content"'))!;
  const literals = [...line.matchAll(/"(?:\\.|[^"\\])*"/g)].map(match => JSON.parse(match[0]));
  const description = literals[4];
  const ref = { source: "assignment_kernel_v2:revit_tool_doc", trust_level: "host_observed" } as EvidenceRefV1;
  const raw = { version: "operator.tool_doc.v1", method: "POST", path: "/revit/inspect-family-content", description };
  const projection = projectToolDocumentation(ref, raw, 8192)!;
  assert.equal(projection.tools[0]!.description, description);
  assert.match(String(projection.tools[0]!.description), /Empty driverParameters does not prove an unbound label/);
  assert.match(String(projection.tools[0]!.description), /unboundLabelCount is null/);
  assert.equal(projection.completion_eligible, false);
  const bounded = projectToolDocumentation(ref, raw, 1536)!;
  assert.equal(bounded.tools[0]!.description, undefined, "An over-budget description is omitted atomically");
  assert.ok(bounded.omitted_paths.includes("payload.description"));
});

test("undetermined label bindings do not expand native inspection identity, source or completeness authority", () => {
  const f: any = familyInspectionFixture();
  Object.assign(f.payload.labels[0], { driverParameters: [], driverParameterObservation: {
    state: "binding_undetermined", requested: true, parameterReadSucceeded: true,
    bindingDetermined: false, coverageComplete: false, error: null
  } });
  f.payload.classification = { parameterDrivenLabelCount: 0, observedDriverReferenceLabelCount: 0,
    unboundLabelCount: null, bindingUndeterminedLabelCount: 1, bindingInspectionComplete: false, scope: "returned_label_rows_only" };
  assert.deepEqual(nativeInspectionTargetIdsV2(f.input, f.payload), [42], "Requested family content was observed; binding was not certified");
  for (const change of [
    (x: any) => x.payload.source.scope = "external_file",
    (x: any) => x.input.body.filePath = "source.rfa",
    (x: any) => x.payload.inventory.truncated = true,
    (x: any) => x.input.body.contains = "Mark",
    (x: any) => x.payload.closedWithoutSaving = false,
    (x: any) => x.payload.mutated = true,
    (x: any) => x.payload.source.elementId = 43
  ]) {
    const x = structuredClone(f); change(x);
    assert.equal(nativeInspectionTargetIdsV2(x.input, x.payload), null);
  }
});
