import assert from "node:assert/strict";
import test from "node:test";
import { assertDiscoveredCapability, CapabilityDiscoveryError, discoverCertifiedCapabilities } from "./progressiveCapabilityDiscoveryV1.js";

const env = { REVIT_OPERATOR_MODE: "local" } as NodeJS.ProcessEnv;
test("returns a bounded policy-certified description rather than a raw inventory", () => {
  const result = discoverCertifiedCapabilities({ need: "need active document and view context", maxResults: 8 }, env);
  assert.equal(result.status, "available"); assert.equal(result.capabilities.length, 1); assert.equal(result.capabilities[0]?.alias, "revit_get_context");
});
test("does not treat unmet semantic need as an authorization claim", () => {
  const result = discoverCertifiedCapabilities({ need: "mutate arbitrary family instances" }, env);
  assert.equal(result.status, "unavailable"); assert.deepEqual(result.capabilities, []);
});
test("receipt rejects model-created ids and rechecks final policy", () => {
  const result = discoverCertifiedCapabilities({ need: "live Revit context" }, env);
  assert.throws(() => assertDiscoveredCapability(result.receipt, "invented.capability", env), (error: unknown) => error instanceof CapabilityDiscoveryError && error.code === "CAPABILITY_DISCOVERY_CAPABILITY_DENIED");
  assert.equal(assertDiscoveredCapability(result.receipt, "revit.context.v1", env).path, "/revit/context");
  assert.throws(() => assertDiscoveredCapability("model-created-receipt", "revit.context.v1", env), /RECEIPT_INVALID/);
});
