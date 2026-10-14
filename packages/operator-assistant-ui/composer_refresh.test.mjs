import assert from 'node:assert/strict';
import test from 'node:test';
import { saveComposerRefreshTarget, readComposerRefreshTarget, clearComposerRefreshTarget } from './composer_draft.mjs';
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
