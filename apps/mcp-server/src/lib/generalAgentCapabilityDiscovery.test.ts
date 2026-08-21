import assert from "node:assert/strict";
import test from "node:test";
import { CertifiedCapabilityProjectionError, projectCertifiedCapabilities } from "./certifiedCapabilityProjection.js";
import {
  assertDiscoveredCapability,
  discoverGeneralAgentCapabilities,
  discoverHostedGeneralAgentCapabilities
} from "./generalAgentCapabilityDiscovery.js";
import { loadToolExposurePolicy } from "./toolExposurePolicy.js";

const env = { REVIT_OPERATOR_MODE: "local" } as NodeJS.ProcessEnv;

test("general-agent discovery adds exactly one concise non-authorizing dynamic substrate", () => {
  const result = discoverGeneralAgentCapabilities({ need: "complex geometry layout" }, env);
  assert.equal(result.executionSubstrates.length, 1);
  assert.equal(result.executionSubstrates[0]?.id, "dynamic_revit_program");
  assert.match(result.executionSubstrates[0]?.title ?? "", /Generate and preview a bounded task-specific Revit program/);
  assert.equal(result.executionSubstrates[0]?.semantics.previewBeforeCommit, true);
  assert.equal(result.executionSubstrates[0]?.semantics.machineAccess, "restricted");
  assert.equal(result.executionSubstrates[0]?.semantics.externalFileEffects, "explicit_capability_required");
  assert.equal(result.executionSubstrates[0]?.semantics.iterativeObservation, "bounded_needs_facts");
  assert.equal(result.executionSubstrates[0]?.semantics.semanticTrace, "exact_step_node_fact_binding");
  assert.equal(result.executionSubstrates[0]?.semantics.deterministicReplay, true);
  assert.equal(result.executionSubstrates[0]?.admission.state, "not_admitted_by_discovery");
  assert.equal(result.executionSubstrates[0]?.admission.authorizationGranted, false);
  assert.equal(result.executionSubstrates[0]?.execution.tool, "operator_run_dynamic_revit_program");
  assert.equal(result.executionSubstrates[0]?.execution.certifiedProductionExposure, false);
});

test("dynamic affordance never enters certified policy membership or its discovery receipt", () => {
  const loaded = loadToolExposurePolicy(env);
  const projected = projectCertifiedCapabilities(loaded.policy);
  assert.equal(projected.some(capability => capability.id === "dynamic_revit_program"), false);
  assert.equal(projected.some(capability => capability.alias.includes("dynamic")), false);

  const result = discoverGeneralAgentCapabilities({ need: "context" }, env);
  assert.throws(
    () => assertDiscoveredCapability(result.receipt, "dynamic_revit_program", env),
    (error: unknown) => error instanceof CertifiedCapabilityProjectionError
      && error.code === "CAPABILITY_DISCOVERY_CAPABILITY_DENIED"
  );
});

test("hosted General Agent discovery ranks live project query and write registry primitives", async () => {
  const result = await discoverHostedGeneralAgentCapabilities({ need: "count air terminal equipment and change parameters", maxResults: 3 }, async () => ({
    tools: [
      { method: "POST", path: "/revit/query", title: "Query Elements", description: "Find and count elements by category including Air Terminals." },
      { method: "POST", path: "/revit/set-parameter", title: "Set Parameters", description: "Change equipment instance or type parameters." },
      { method: "GET", path: "/revit/context", title: "Context", description: "Current document and view." }
    ]
  }));
  assert.equal(result.exposureMode, "general");
  assert.equal(result.typedCatalogExposure, "full");
  assert.equal(result.status, "available");
  assert.deepEqual(new Set(result.capabilities.map(item => item.path)), new Set(["/revit/query", "/revit/set-parameter"]));
  assert.equal(result.capabilities.every(item => item.authorization === "general_agent_ready"), true);
});
