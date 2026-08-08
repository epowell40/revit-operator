import assert from "node:assert/strict";
import test from "node:test";
import { loadToolExposurePolicy } from "./toolExposurePolicy.js";
import { projectCertifiedCapabilities } from "./certifiedCapabilityProjection.js";

test("policy exposure drift cannot be masked by a discovery metadata catalog", () => {
  const loaded = loadToolExposurePolicy({ REVIT_OPERATOR_MODE: "local" } as NodeJS.ProcessEnv);
  const policy = structuredClone(loaded.policy);
  const context = policy.records.find(record => record.path === "/revit/context");
  assert.ok(context);
  context.channels.typed_mcp.exposed = false;
  assert.deepEqual(projectCertifiedCapabilities(policy), []);
});
