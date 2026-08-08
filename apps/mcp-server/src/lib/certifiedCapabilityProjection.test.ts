import assert from "node:assert/strict";
import test from "node:test";
import { assertDiscoveredCapability, CertifiedCapabilityProjectionError, discoverCertifiedCapabilities } from "./certifiedCapabilityProjection.js";

const env = { REVIT_OPERATOR_MODE: "local" } as NodeJS.ProcessEnv;
test("projection is derived solely from exposed trusted policy identities", () => {
  const result = discoverCertifiedCapabilities({ need: "active document context" }, env);
  assert.equal(result.status, "available"); assert.equal(result.capabilities.length, 1);
  assert.equal(result.capabilities[0]?.alias, "revit_get_context"); assert.match(result.capabilities[0]?.id ?? "", /^cap_[0-9a-f]{32}$/);
});
test("unmatched needs and invented ids never expand authority", () => {
  const result = discoverCertifiedCapabilities({ need: "move a fixture east" }, env);
  assert.equal(result.status, "unavailable");
  const context = discoverCertifiedCapabilities({ need: "context" }, env);
  assert.throws(() => assertDiscoveredCapability(context.receipt, "cap_model_created", env), (error: unknown) => error instanceof CertifiedCapabilityProjectionError && error.code === "CAPABILITY_DISCOVERY_CAPABILITY_DENIED");
});
test("request bounds are fail-closed", () => {
  assert.throws(() => discoverCertifiedCapabilities({ need: "", maxResults: 1 }, env), /REQUEST_INVALID/);
  assert.throws(() => discoverCertifiedCapabilities({ need: "context", maxResults: 9 }, env), /REQUEST_INVALID/);
});
