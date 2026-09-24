import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("existing-tag repair reports the observed native transaction at the handler boundary", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname,
    "../../../revit-bridge-addin/RevitBridge.Logic/Handlers/TagElementsHandler.cs"), "utf8");
  const repair = source.split("private static object HandleExistingTagRepair")[1]
    ?.split("private static ExistingTagSnapshot ReadExistingTagSnapshot")[0];
  assert.ok(repair, "existing-tag repair handler must be present");
  assert.match(repair, /OperatorNativeTransactionReceipt\.FromObservedStatus\(/);
  assert.match(repair, /transaction\.RollBack\(\)/);
  assert.match(repair, /transaction\.Commit\(\)/);
  assert.match(repair, /transaction\s*=\s*transactionReceipt/);
});
