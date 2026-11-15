import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/desktop.ps1");

function attemptClose(processId) {
  return spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-Action", "verified_revit_close", "-ExpectedRevitProcessId", `${processId}`],
  { encoding: "utf8", timeout: 10_000 });
}

test("verified Revit close never sends a key without an exact native process ID", () => {
  const result = attemptClose(0);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /exact native Revit process ID is required/);
});

test("verified Revit close never sends a key to a non-Revit process", () => {
  const result = attemptClose(process.pid);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /expected fixture process is not Revit/);
});
