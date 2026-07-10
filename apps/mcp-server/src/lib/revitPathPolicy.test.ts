import test from "node:test";
import assert from "node:assert/strict";
import { assertRevitBridgePath } from "./revitPathPolicy.js";

test("generic Revit bridge policy rejects backend /tools paths", () => {
  assert.doesNotThrow(() => assertRevitBridgePath("/revit/find-elements"));
  assert.throws(() => assertRevitBridgePath("/tools/mep/semantic-route-plan"), /must start with \/revit\//);
  assert.throws(() => assertRevitBridgePath("/tools/arbitrary"), /must start with \/revit\//);
});
