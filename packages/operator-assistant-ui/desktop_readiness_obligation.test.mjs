import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktopReadinessObligation} from './desktop_readiness_obligation.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-readiness-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return path.join(root,'state','required.json');
}
test('restart retains the obligation independently of conversation state',t=>{
  const file=fixture(t), first=createDesktopReadinessObligation(file);
  assert.equal(first.required(),false);
  first.beforeInput();
  assert.equal(createDesktopReadinessObligation(file).required(),true);
});
test('interrupted or corrupt record cannot erase the requirement',t=>{
  const file=fixture(t);fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,'');
  const store=createDesktopReadinessObligation(file);
  assert.equal(store.required(),true);store.beforeInput();
  assert.equal(fs.readFileSync(file,'utf8'),'');
});
test('repeated input and independent instances preserve the original record',t=>{
  const file=fixture(t),a=createDesktopReadinessObligation(file),b=createDesktopReadinessObligation(file);
  a.beforeInput();const original=fs.readFileSync(file,'utf8');
  b.beforeInput();a.beforeInput();
  assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.equal(a.required(),true);assert.equal(b.required(),true);
});
test('persistence failure rejects input preparation',t=>{
  const file=fixture(t);fs.writeFileSync(path.dirname(file),'not a directory');
  assert.throws(()=>createDesktopReadinessObligation(file).beforeInput());
  assert.throws(()=>createDesktopReadinessObligation(file).required());
});
