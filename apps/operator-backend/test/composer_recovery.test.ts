import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const root = ['../packages/operator-assistant-ui','../../packages/operator-assistant-ui'].map(p=>path.resolve(p))
  .find(p=>fs.existsSync(path.join(p,'composer_draft.mjs')))!;
const { createComposerDraftStore, staleComposerNotice } = await import(pathToFileURL(path.join(root,'composer_draft.mjs')).href);
const { cachedRevitHealthForDisplay } = await import(pathToFileURL(path.join(root,'revit_health_display.mjs')).href);
const attachment = {id:'pdf-1',name:'drawing.pdf',mimeType:'application/pdf',sizeBytes:3,dataBase64:'YWJj'};
function memory() {
  const entries = new Map();
  return { entries, async get(key: string) { return entries.get(key); }, async put(key: string,value: unknown) { entries.set(key,structuredClone(value)); }, async delete(key: string) { entries.delete(key); } };
}
test('a new page restores the exact unsent text and attachment bytes without retaining authority fields',async()=>{
  const storage=memory();
  await createComposerDraftStore({storage}).save('tab-123456',{text:'Review this PDF',attachments:[{...attachment,write_grant:'forged'}],sessionId:'existing-chat',assignment_id:'forged'});
  const draft=await createComposerDraftStore({storage}).load('tab-123456');
  assert.deepEqual(draft,{text:'Review this PDF',attachments:[attachment],sessionId:'existing-chat'});
  assert.equal(await createComposerDraftStore({storage}).load('different-tab'),null);
});
test('clearing a sent draft waits behind a slow save and cannot resurrect it',async()=>{
  const storage=memory(); let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const put=storage.put.bind(storage); storage.put=async(k,v)=>{await blocked;await put(k,v);};
  const store=createComposerDraftStore({storage});
  const save=store.save('tab-123456',{text:'Unsent',attachments:[]});
  const clear=store.clear('tab-123456'); release(); await Promise.all([save,clear]);
  assert.equal(await store.load('tab-123456'),null);
});
test('expired, corrupt and oversize drafts cannot become recovered input; storage failure is explicit',async()=>{
  const storage=memory(); const store=createComposerDraftStore({storage,now:()=>100_000_000});
  storage.entries.set('tab-123456',{version:1,savedAt:0,text:'Expired',attachments:[]});
  assert.equal(await store.load('tab-123456'),null);
  storage.entries.set('tab-123456',{version:1,savedAt:100_000_000,text:'Bad',attachments:[{...attachment,dataBase64:42}]});
  assert.equal(await store.load('tab-123456'),null);
  await assert.rejects(store.save('tab-123456',{text:'x'.repeat(100_001),attachments:[]}));
  const unavailable=createComposerDraftStore({storage:{...storage,put:async()=>{throw new Error('Quota exceeded');}}});
  await assert.rejects(unavailable.save('tab-123456',{text:'Keep me',attachments:[]}),/Quota/);
  assert.match(staleComposerNotice(false),/Copy your unsent text.*recovery is unavailable/);
  assert.doesNotMatch(staleComposerNotice(false),/are saved/);
});
test('cached health is explicitly display-only, including an empty cache',()=>{
  const cold=cachedRevitHealthForDisplay(null);
  assert.equal(cold.ok,false); assert.equal(cold.context,null); assert.equal(cold.authority,'display_only');
  const source=Object.freeze({ok:true,context:{document:{title:'Last observed model'}},checked_at:'old'});
  const cached=cachedRevitHealthForDisplay(source);
  assert.equal(cached.checked_at,'old'); assert.equal(cached.cached,true); assert.equal(cached.authority,'display_only');
  assert.equal((source as any).cached,undefined);
});
