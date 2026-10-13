import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { beginRevitCourierTurnContext, endRevitCourierTurnContext } from '../src/courier/revit_courier_context.js';

test('courier context covers the bounded marked-binder run and closes the exact lease',()=>{
 const previous={root:process.env.OPERATOR_WORKSPACE_ROOT,transport:process.env.OPERATOR_REVIT_TRANSPORT};
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'courier-binder-time-'));
 process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_REVIT_TRANSPORT='courier';
 let lease:ReturnType<typeof beginRevitCourierTurnContext>=null;
 try{
  lease=beginRevitCourierTurnContext({session_id:'owner',message_id:'binder',ttl_ms:121*60_000,
    target_executor_id:'exact-worker',target_document_path:'exact-disposable.rvt'});
  const file=path.join(root,'config','revit-courier-context.json');
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  assert(Date.parse(value.expires_at)-Date.parse(value.created_at)>=121*60_000-100);
  assert.equal(value.target_executor_id,'exact-worker');assert.equal(value.target_document_path,'exact-disposable.rvt');
  assert.throws(()=>beginRevitCourierTurnContext({session_id:'other',message_id:'other',ttl_ms:1000}),/busy/);
  endRevitCourierTurnContext(lease);lease=null;
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).active,false);
 }finally{
  endRevitCourierTurnContext(lease);
  for(const [key,value] of [['OPERATOR_WORKSPACE_ROOT',previous.root],['OPERATOR_REVIT_TRANSPORT',previous.transport]]){
   if(value===undefined)delete process.env[key!];else process.env[key!]=value;
  }
  fs.rmSync(root,{recursive:true,force:true});
 }
});
