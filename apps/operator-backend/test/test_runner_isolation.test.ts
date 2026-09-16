import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("complete and selected backend test runs isolate workstation provider settings while permitting fixture overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-runner-isolation-"));
  const directory = path.join(root, "dist", "test");
  fs.mkdirSync(directory, { recursive: true });
  const probe = `const assert=require('node:assert/strict'); const {spawnSync}=require('node:child_process');
    assert.equal(process.env.OPERATOR_BRAIN,'rule'); assert.equal(process.env.OPERATOR_ASSIGNMENT_KERNEL_V2,'0');
    const explicit=spawnSync(process.execPath,['-e',"require('node:assert/strict').equal(process.env.OPERATOR_BRAIN,'fixture-provider');require('node:assert/strict').equal(process.env.OPERATOR_ASSIGNMENT_KERNEL_V2,'1')"],
      {env:{...process.env,OPERATOR_BRAIN:'fixture-provider',OPERATOR_ASSIGNMENT_KERNEL_V2:'1'}});
    assert.equal(explicit.status,0,explicit.stderr.toString());`;
  fs.writeFileSync(path.join(directory, "probe.test.js"), probe);
  const runner = path.resolve("scripts/run-tests.mjs");
  try {
    for (const selected of [[], ["dist/test/probe.test.js"]]) {
      const result = spawnSync(process.execPath, [runner, ...selected], { cwd: root, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, OPERATOR_BRAIN: "codex", OPERATOR_ASSIGNMENT_KERNEL_V2: "1" } });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    }
    const outside = spawnSync(process.execPath, [runner, "../unrelated.test.js"], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.notEqual(outside.status, 0);
    assert.match(outside.stderr, /Expected a compiled test beneath/);
  } finally {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
