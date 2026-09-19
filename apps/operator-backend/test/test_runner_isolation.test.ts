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
  const childEnv={...process.env}; delete childEnv.NODE_TEST_CONTEXT;
  try {
    for (const selected of [[], ["dist/test/probe.test.js"]]) {
      const result = spawnSync(process.execPath, [runner, ...selected], { cwd: root, encoding: "utf8", timeout: 10_000,
        env: { ...childEnv, OPERATOR_BRAIN: "codex", OPERATOR_ASSIGNMENT_KERNEL_V2: "1" } });
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

test('runner isolates the default workspace from inherited live history, including fixture restoration and failing runs', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-runner-workspace-'));
  const live=path.join(root,'live'); const directory=path.join(root,'dist','test');
  fs.mkdirSync(live); fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(live,'history'),'user history');
  const receipt=path.join(root,'batch-path.txt');
  const childEnv={...process.env}; delete childEnv.NODE_TEST_CONTEXT;
  const probe=`const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    const batch=process.env.OPERATOR_WORKSPACE_ROOT;
    assert.notEqual(batch,process.env.PROBE_LIVE); assert.ok(path.basename(batch).startsWith('operator-test-batch-'));
    fs.writeFileSync(process.env.PROBE_RECEIPT,batch);
    const fixture=path.join(batch,'fixture'); fs.mkdirSync(fixture);
    process.env.OPERATOR_WORKSPACE_ROOT=fixture;
    try { fs.writeFileSync(path.join(process.env.OPERATOR_WORKSPACE_ROOT,'fixture-data'),'test'); }
    finally { process.env.OPERATOR_WORKSPACE_ROOT=batch; }
    fs.writeFileSync(path.join(process.env.OPERATOR_WORKSPACE_ROOT,'restored-default'),'test');
    if(process.env.PROBE_FAIL==='1') process.exitCode=7;`;
  fs.writeFileSync(path.join(directory,'probe.test.js'),probe);
  try {
    for(const fail of [false,true]){
      const result=spawnSync(process.execPath,[path.resolve('scripts/run-tests.mjs'),'dist/test/probe.test.js'],{
        cwd:root,encoding:'utf8',timeout:15000,env:{...childEnv,OPERATOR_WORKSPACE_ROOT:live,
          PROBE_LIVE:live,PROBE_RECEIPT:receipt,PROBE_FAIL:fail?'1':'0'}});
      assert.ok(fs.existsSync(receipt),result.stdout+result.stderr);
      const batch=fs.readFileSync(receipt,'utf8');
      assert.equal(result.status===0,!fail,result.stdout+result.stderr);
      assert.deepEqual(fs.readdirSync(live),['history']);
      assert.equal(fs.readFileSync(path.join(live,'history'),'utf8'),'user history');
      assert.equal(fs.existsSync(batch),fail);
      if(fail){
        assert.match(result.stderr,/Failed test workspace retained:/);
        assert.equal(fs.readFileSync(path.join(batch,'restored-default'),'utf8'),'test');
        assert.equal(path.dirname(path.resolve(batch)),path.resolve(os.tmpdir()));
        assert.ok(path.basename(batch).startsWith('operator-test-batch-'));
        fs.rmSync(batch,{recursive:true,force:true});
      }
    }
  }finally{
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
