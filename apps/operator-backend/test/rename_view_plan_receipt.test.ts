import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("rename planning emits native not-started evidence without claiming an executed preview", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, import.meta.url.endsWith(".ts")
    ? "../../revit-bridge-addin/RevitBridge/Handlers/CreateViewHandler.cs"
    : "../../../revit-bridge-addin/RevitBridge/Handlers/CreateViewHandler.cs"), "utf8");
  const plan = source.split('if (action == "rename_batch")')[1]?.split("var modified")[0];
  assert.ok(plan);
  assert.match(plan, /ExecuteRenameBatch\(doc, p, dryRun: true\)/);
  assert.match(plan, /transaction = OperatorNativeTransactionReceipt\.NotStarted\(\)/);
  assert.match(plan, /previewExecuted = false/);
  assert.doesNotMatch(plan, /NativeSingleTransaction\.Execute|\.Commit\(|\.RollBack\(/);
});
