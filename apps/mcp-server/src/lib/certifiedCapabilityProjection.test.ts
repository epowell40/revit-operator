import assert from "node:assert/strict";
import test from "node:test";
import { assertDiscoveredCapability, CertifiedCapabilityProjectionError, discoverCertifiedCapabilities, projectCertifiedCapabilities } from "./certifiedCapabilityProjection.js";
import type { ToolExposurePolicy } from "./toolExposurePolicy.js";

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
test("preview and apply policy records project one request-family capability", () => {
  const family = { schema: "revit-operator.certified-request-family.v1" as const, id: "move-family", validator_hash: `sha256:${"a".repeat(64)}` };
  const channel = { exposed: true, required_level: "L4", reason_codes: ["CERTIFIED"] };
  const record = (suffix: string) => ({
    method: "POST", path: "/revit/move-elements", request_hash: `sha256:${suffix.repeat(64)}`,
    effect_hash: `sha256:${suffix.repeat(64)}`, evidence_record_hash: `sha256:${suffix.repeat(64)}`,
    request_family: family, highest_cumulative_level: "L4", observed_levels: ["L0", "L1", "L2", "L3", "L4"],
    visibility: "candidate" as const, typed_mcp_aliases: ["revit_move_one_certified"],
    channels: { search: channel, generic_call: channel, typed_mcp: channel, deterministic_workflow: channel },
    policy_record_hash: `sha256:${suffix.repeat(64)}`
  });
  const policy = { schema: "revit-operator.tool-exposure-policy.v1", hash_algorithm: "sha256", evidence_schema: "revit-operator.tool-certification-evidence.v1", evidence_source_hash: `sha256:${"c".repeat(64)}`, records: [record("1"), record("2")], policy_hash: `sha256:${"d".repeat(64)}` } as ToolExposurePolicy;
  const capabilities = projectCertifiedCapabilities(policy);
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0]?.alias, "revit_move_one_certified");
  assert.deepEqual(capabilities[0]?.effectHashes, [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`]);
  assert.equal(capabilities[0]?.requestFamily?.id, family.id);
});
