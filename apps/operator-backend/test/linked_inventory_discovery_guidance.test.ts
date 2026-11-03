import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "../src/tools/audit_tool_registry.js";
import { projectToolDocumentation } from "../src/evidence/tool_documentation_projection.js";
import type { EvidenceRefV1 } from "../src/evidence/evidence_ref.js";

function nativeDescription(route: string): string {
  const root = findRepoRoot(process.cwd());
  const apps = existsSync(path.join(root, "apps", "revit-bridge-addin")) ? path.join(root, "apps") : root;
  const source = readFileSync(path.join(apps, "revit-bridge-addin", "RevitBridge", "Operator", "OperatorToolManifest.cs"), "utf8");
  const line = source.split(/\r?\n/).find(value => value.includes(`"${route}"`));
  assert.ok(line, `Native route is registered: ${route}`);
  return [...line.matchAll(/"(?:\\.|[^"\\])*"/g)].map(match => JSON.parse(match[0]))[4];
}

const ref = { source: "assignment_kernel_v2:revit_tool_doc", trust_level: "host_observed" } as EvidenceRefV1;
for (const route of ["/revit/find-elements", "/revit/export-visible-elements"]) {
  test(`${route}: model-visible discovery provides the existing linked-source route with its limits`, () => {
    const description = nativeDescription(route);
    const raw = { version: "operator.tool_doc.v1", method: "POST", path: route, description };
    const projected = projectToolDocumentation(ref, raw, 8192)!;
    assert.equal(projected.tools[0]!.description, description);
    assert.match(description, /POST \/revit\/quantify/);
    assert.match(description, /scope=links or both/);
    assert.match(description, /sourceCoverage/);
    assert.match(description, /direct source-document instances/);
    assert.match(description, /not room membership or hidden\/nested completeness/);
    assert.equal(projected.completion_eligible, false, "Documentation is discovery, never native census or absence proof");
    const bounded = projectToolDocumentation(ref, raw, 1024)!;
    assert.equal(bounded.tools[0]!.description, undefined, "Over-budget guidance must not be partially delivered without its limitations");
    assert.ok(bounded.omitted_paths.includes("payload.description"));
    assert.equal(bounded.completion_eligible, false);
  });
}

test("source inventory retains explicit coverage and room-membership limitations", () => {
  const description = nativeDescription("/revit/quantify");
  assert.match(description, /incomplete coverage cannot prove absence/);
  assert.match(description, /not unshared family-definition contents or room membership/);
  const projected = projectToolDocumentation(ref, { version: "operator.tool_doc.v1", method: "POST", path: "/revit/quantify", description }, 8192)!;
  assert.equal(projected.completion_eligible, false);
});
