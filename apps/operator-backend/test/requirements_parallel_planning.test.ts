import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { beginRequirementsPlanningLease, createRequirement, endRequirementsPlanningLease, resolveRequirements } from "../src/memory/requirements_store.js";

test("a second process can plan concurrently and still fences writes after the first reader leaves", { timeout: 15000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "requirements-readers-"));
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const scope = { kind: "engineer" as const, id: "local" };
  const receipt = resolveRequirements({ scope_refs: [scope] });
  const first = beginRequirementsPlanningLease(receipt.receipt_sha256);
  const moduleUrl = pathToFileURL(path.resolve("dist/src/memory/requirements_store.js")).href;
  const script = `
    const { beginRequirementsPlanningLease, endRequirementsPlanningLease, resolveRequirements } = await import(${JSON.stringify(moduleUrl)});
    const receipt = resolveRequirements({ scope_refs: [{ kind: "engineer", id: "local" }] });
    const lease = beginRequirementsPlanningLease(receipt.receipt_sha256);
    process.send({ ready: true, hash: receipt.receipt_sha256, lease: lease.lease_path });
    process.once("message", () => { endRequirementsPlanningLease(lease); process.send({ released: true }); process.disconnect(); });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { cwd: process.cwd(),
    env: { ...process.env, OPERATOR_WORKSPACE_ROOT: root }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  const finished = once(child, "exit");
  try {
    const [ready] = await Promise.race([once(child, "message"), finished.then(() => { throw new Error(`Planning child exited: ${stderr}`); })]);
    assert.equal(ready.ready, true); assert.equal(ready.hash, receipt.receipt_sha256);
    assert.equal(fs.existsSync(ready.lease), true);
    endRequirementsPlanningLease(first);
    assert.throws(() => createRequirement({ scope, key: "audit.rule", text: "Wait for every active plan." }), /active planning lease/);
    const released = once(child, "message");
    child.send("release");
    assert.equal((await released)[0].released, true);
    assert.equal((await finished)[0], 0, stderr);
    assert.equal(fs.existsSync(ready.lease), false);
    assert.equal(createRequirement({ scope, key: "audit.rule", text: "Every reader has left." }).requirement.revision, 1);
  } finally {
    endRequirementsPlanningLease(first);
    if (child.exitCode === null) { child.kill(); await finished; }
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
