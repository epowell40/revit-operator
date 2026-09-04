import assert from "node:assert/strict";
import test from "node:test";
import { registryLookupTransportContractV2 } from "./registryLookupTransport.js";

test("generic dispatcher registry prerequisite uses its own search identity", () => {
  assert.deepEqual(registryLookupTransportContractV2("prerequisite"), {
    channel: "search",
    alias: "revit_tool_registry"
  });
  assert.deepEqual(registryLookupTransportContractV2(undefined), { channel: "search" });
});
