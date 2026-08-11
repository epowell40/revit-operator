import assert from "node:assert/strict";
import test from "node:test";
import { CertifiedCapabilityProjectionError, projectCertifiedCapabilities } from "./certifiedCapabilityProjection.js";
import {
  assertDiscoveredCapability,
  discoverGeneralAgentCapabilities
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
