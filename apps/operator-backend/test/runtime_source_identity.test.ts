import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const packageRoot = ['../packages/operator-runtime-identity', '../../packages/operator-runtime-identity']
  .map(p=>path.resolve(p)).find(p=>fs.existsSync(path.join(p,'runtime_sources.mjs')))!;
const { runtimeSourcesSha256 } = await import(pathToFileURL(path.join(packageRoot,'runtime_sources.mjs')).href);

test('runtime identity changes for helper-only edits, additions and removals while ignoring secrets and live browser assets', t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-runtime-source-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'server.js'),'import "./context_reply.mjs";');
  fs.writeFileSync(path.join(root,'context_reply.mjs'),'export const answer="old";');
  const original=runtimeSourcesSha256(root);
  fs.mkdirSync(path.join(root,'public'));
  fs.writeFileSync(path.join(root,'public','app.js'),'live browser asset');
  fs.writeFileSync(path.join(root,'.env'),'SYNTHETIC_SECRET=never-hash');
  assert.equal(runtimeSourcesSha256(root),original);
  fs.writeFileSync(path.join(root,'context_reply.mjs'),'export const answer="new";');
  const changed=runtimeSourcesSha256(root);
  assert.notEqual(changed,original);
  fs.writeFileSync(path.join(root,'additional.cjs'),'module.exports=1');
  assert.notEqual(runtimeSourcesSha256(root),changed);
  fs.unlinkSync(path.join(root,'additional.cjs'));
  assert.equal(runtimeSourcesSha256(root),changed);
  fs.writeFileSync(path.join(root,'package-lock.json'),'{"lockfileVersion":3}');
  assert.notEqual(runtimeSourcesSha256(root),changed);
});

test('PowerShell and Node attest the same ordinal source bytes and fail on invalid source entries', {skip:process.platform !== 'win32'}, t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-runtime-cross-language-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const [name,text] of [['server.js','entry'],['z.mjs','late'],['A.cjs','early'],['package.json','{}']]) fs.writeFileSync(path.join(root,name!),text!);
  const powershell=path.join(process.env.SystemRoot ?? 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const run=()=>spawnSync(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-Command','$ErrorActionPreference="Stop"; . $env:SOURCE_IDENTITY_SCRIPT; Get-OperatorRuntimeSourcesSha256 $env:SOURCE_IDENTITY_ROOT'],{encoding:'utf8',windowsHide:true,timeout:15_000,env:{...process.env,SOURCE_IDENTITY_SCRIPT:path.join(packageRoot,'runtime_sources.ps1'),SOURCE_IDENTITY_ROOT:root}});
  const valid=run(); assert.equal(valid.status,0,valid.stderr); assert.equal(valid.stdout.trim(),runtimeSourcesSha256(root));
  fs.mkdirSync(path.join(root,'invalid.js'));
  assert.throws(()=>runtimeSourcesSha256(root),/Invalid runtime source file/);
  const invalid=run(); assert.notEqual(invalid.status,0); assert.match(invalid.stderr,/Invalid runtime source file/);
});
