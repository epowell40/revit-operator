import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmNativeViewActivation} from './native_view_activation.mjs';
const context=()=>({process_id:123,document:{sessionId:'doc',projectIdentity:{fingerprint:'project'},activeView:{id:41,name:'Sheet'}}});
const receipt=()=>({ok:true,activationPending:false,focusPending:false,requestedViewId:41,activeViewId:41,activeViewName:'Sheet',
 shownElementIds:[102],notShownElementIds:[],scheduleFocusAssociations:[{scheduleId:101,scheduleUniqueId:'schedule',instanceId:102,instanceUniqueId:'placement',sheetId:41,sheetUniqueId:'sheet'}]});
const run=(alter=()=>{},ids=[101])=>confirmNativeViewActivation({view_id:41,show_element_ids:ids},{readContext:async()=>context(),assertCurrent:async()=>{},activate:async()=>{const r=receipt();alter(r);return r;}});
test('native schedule definition focus confirms its actual single sheet placement without aliasing verification targets',async()=>{
 for(const ids of [[101],[101,102]]){const r=await run(()=>{},ids);assert.equal(r.ok,true);assert.equal(r.focus.native_navigation_only,true);assert.equal(r.native_postcondition_verified,undefined);}
});
for(const [name,mutate]of Object.entries({foreignSheet:r=>r.scheduleFocusAssociations[0].sheetId=42,missingUID:r=>delete r.scheduleFocusAssociations[0].scheduleUniqueId,
 duplicate:r=>r.scheduleFocusAssociations.push({...r.scheduleFocusAssociations[0]}),wrongDefinition:r=>r.scheduleFocusAssociations[0].scheduleId=999,
 unshown:r=>r.shownElementIds=[],unexpected:r=>r.shownElementIds.push(999),hidden:r=>r.notShownElementIds=[101],pending:r=>r.focusPending=true,
 missingAssociation:r=>delete r.scheduleFocusAssociations}))test('schedule navigation refuses '+name,async()=>assert.equal((await run(mutate)).ok,false));
