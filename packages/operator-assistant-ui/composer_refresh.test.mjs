import assert from 'node:assert/strict';
import test from 'node:test';
import { createComposerDraftStore, saveComposerRefreshTarget, readComposerRefreshTarget, clearComposerRefreshTarget } from './composer_draft.mjs';
function storage() { const values=new Map(); return { values, setItem:(k,v)=>values.set(k,v),getItem:k=>values.get(k),removeItem:k=>values.delete(k) }; }
test('intentional tab-local refresh records only conversation navigation and expires',()=>{
  const s=storage();saveComposerRefreshTarget(s,'tab','saved-conversation',1000);
  assert.equal(readComposerRefreshTarget(s,'tab',2000).sessionId,'saved-conversation');
  assert.equal(readComposerRefreshTarget(s,'other',2000),null);
  assert.equal(readComposerRefreshTarget(s,'tab',1000+24*60*60*1000+1),null);
  assert.equal(readComposerRefreshTarget(s,'tab',-61000),null);
  const value=readComposerRefreshTarget(s,'tab',2000);assert.equal(value.resume,undefined);assert.equal(value.attachments,undefined);
  clearComposerRefreshTarget(s);assert.equal(readComposerRefreshTarget(s,'tab',2000),null);
});
test('malformed or unavailable storage cannot cause conversation restoration',()=>{
  const s=storage();for(const v of ['{','null',JSON.stringify({schema:'other',tabId:'tab',sessionId:'old',at:1000})]){
    s.setItem('operator-desktop.composer-refresh-target',v);assert.equal(readComposerRefreshTarget(s,'tab',1000),null);
  }
  assert.equal(readComposerRefreshTarget({getItem(){throw Error('unavailable');}},'tab'),null);
  assert.throws(()=>saveComposerRefreshTarget(s,'','saved'));
});

function storedDrafts(){
 const records=new Map();
 return {records,storage:{get:async k=>records.get(k),put:async(k,v)=>records.set(k,structuredClone(v)),delete:async k=>records.delete(k)}};
}

test('default composer byte limits also fit local draft recovery without storing base64 strings',async()=>{
 const {records,storage}=storedDrafts();
 const drafts=createComposerDraftStore({storage});
 const attachments=[104857600,13082608].map((sizeBytes,index)=>({id:`attachment-${index}`,name:`reference-${index}.txt`,
  mimeType:'text/plain',sizeBytes,dataBase64:'ICAg'.repeat(Math.trunc(sizeBytes/3))+['','IA==','ICA='][sizeBytes%3]}));
 await drafts.save('tab-test-default',{text:'Retain the refs',attachments,sessionId:''});
 const stored=records.get('tab-test-default');
 assert.equal(stored.version,2);
 assert.equal(stored.attachments.reduce((sum,item)=>sum+item.payload.size,0),117940208);
 assert.ok(stored.attachments.every(item=>item.payload instanceof Blob&&item.dataBase64===undefined));
});

test('local recovery restores exact binary bytes and reads existing version-one drafts',async()=>{
 const {records,storage}=storedDrafts();
 const drafts=createComposerDraftStore({storage,now:()=>1000});
 const draft={text:'Retain the refs',attachments:[{id:'example',name:'capture.png',mimeType:'image/png',sizeBytes:5,dataBase64:'AP8AAQo='}],sessionId:'session'};
 await drafts.save('tab-test-v2',draft);
 assert.deepEqual(await drafts.load('tab-test-v2'),draft);
 records.set('tab-test-v1',{version:1,savedAt:1000,...draft});
 assert.deepEqual(await drafts.load('tab-test-v1'),draft);
 await assert.rejects(drafts.save('tab-test-v2',{...draft,attachments:[{...draft.attachments[0],sizeBytes:4}]}),/bytes do not match/);
 assert.deepEqual(await drafts.load('tab-test-v2'),draft);
 const invalid=structuredClone(records.get('tab-test-v2'));
 invalid.attachments[0].sizeBytes=2;
 records.set('tab-test-invalid',invalid);
 assert.equal(await drafts.load('tab-test-invalid'),null);
 assert.equal(records.has('tab-test-invalid'),false);
 await drafts.clear('tab-test-v2');
 assert.equal(await drafts.load('tab-test-v2'),null);
});
