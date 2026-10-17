import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {jobLockOpenWaitKind}from '../src/revit_batch/job_lock_open_error.js';
test('bounded wait classifies only existing lock and Windows EPERM, never other permission/I/O errors',()=>{
 assert.equal(jobLockOpenWaitKind({code:'EEXIST'},'linux'),'existing');assert.equal(jobLockOpenWaitKind({code:'EPERM'},'win32'),'windows_denial');
 for(const code of ['EACCES','EIO','ENOENT','ENOSPC'])assert.equal(jobLockOpenWaitKind({code},'win32'),null);
 assert.equal(jobLockOpenWaitKind({code:'EPERM'},'linux'),null);assert.equal(jobLockOpenWaitKind(null,'win32'),null);
});
test('a held real exclusive file is waitable, never ownership; release permits a fresh exclusive open',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-exclusive-lock-')),file=path.join(root,'.job.lock');let owner:number|undefined;
 try{owner=fs.openSync(file,'wx');fs.writeFileSync(owner,'original-owner');let denial:unknown;
  try{const other=fs.openSync(file,'wx');fs.closeSync(other);assert.fail('second exclusive open acquired held file');}catch(error){denial=error;}
  assert(jobLockOpenWaitKind(denial,process.platform));assert.equal(fs.readFileSync(file,'utf8'),'original-owner');
  fs.closeSync(owner);owner=undefined;fs.unlinkSync(file);owner=fs.openSync(file,'wx');fs.writeFileSync(owner,'new-owner');assert.equal(fs.readFileSync(file,'utf8'),'new-owner');
 }finally{if(owner!==undefined)fs.closeSync(owner);assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});}
});
