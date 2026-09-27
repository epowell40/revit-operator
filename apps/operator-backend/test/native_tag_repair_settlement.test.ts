import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("existing-tag repair reports the observed native transaction at the handler boundary", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, import.meta.url.endsWith(".ts")
    ? "../../revit-bridge-addin/RevitBridge.Logic/Handlers/TagElementsHandler.cs"
    : "../../../revit-bridge-addin/RevitBridge.Logic/Handlers/TagElementsHandler.cs"), "utf8");
  const repair = source.split("private static object HandleExistingTagRepair")[1]
    ?.split("private static ExistingTagSnapshot ReadExistingTagSnapshot")[0];
  assert.ok(repair, "existing-tag repair handler must be present");
  assert.match(source, /NativeSingleTransaction\.Execute\(/);
  assert.match(repair, /runNative\(/);
  assert.match(repair, /dryRun\s*\?\s*NativeTransactionDisposition\.Rollback\s*:\s*NativeTransactionDisposition\.Commit/);
  assert.match(repair, /OperatorNativeTransactionExecution\.ReadCommitted\(/);
  assert.match(repair, /ReadExistingTagSnapshot\(committedTag, view\)/);
});
