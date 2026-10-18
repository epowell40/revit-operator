import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshAssignmentDisplayContext as refresh} from './assignment_display_context.mjs';

test('cold display identity can observe worker preflight without a native read during execution',async()=>{
  const state={assignmentRevitContext:null,streaming:true},routes=[];
  let health={ok:false,context:null};
  const fetch=async route=>{routes.push(route);return health;},project=h=>h.ok?h.context:null;
  await refresh(state,fetch,project,{cachedOnly:true});assert.equal(state.assignmentRevitContext,null);
  health={ok:true,authority:'display_only',context:{document_fingerprint:'model',document_title:'Disposable',executor_id:'executor'}};
  await refresh(state,fetch,project,{cachedOnly:true});assert.deepEqual(state.assignmentRevitContext,health.context);
  assert.deepEqual(routes,['/api/revit/health?prefer_cached=1','/api/revit/health?prefer_cached=1']);
});
test('late cached identity cannot replace a fresh explicit observation used by controls',async()=>{
  const state={},calls=[];let release;
  const fetch=route=>{calls.push(route);return route.includes('prefer_cached')?new Promise(resolve=>{release=resolve;}):Promise.resolve({context:{document_title:'New'}});};
  const old=refresh(state,fetch,h=>h.context,{cachedOnly:true});
  assert.equal((await refresh(state,fetch,h=>h.context)).document_title,'New');
  release({context:{document_title:'Old'}});await old;
  assert.equal(state.assignmentRevitContext.document_title,'New');assert.equal(calls.length,2);
});
test('background callers coalesce and wait for an explicit read already in flight',async()=>{
  const state={},calls=[];let release;
  const fetch=route=>{calls.push(route);return new Promise(resolve=>{release=resolve;});};
  const live=refresh(state,fetch,h=>h.context),poll=refresh(state,fetch,h=>h.context,{cachedOnly:true});
  release({context:{document_title:'Live'}});assert.deepEqual(await poll,await live);assert.deepEqual(calls,['/api/revit/health']);
});
test('genuine missing health clears display identity and does not change grants or task state',async()=>{
  const state={assignmentRevitContext:{document_title:'Old'},writeGrant:'off',outcome:'blocked'};
  await refresh(state,async()=>{throw Error('Offline');},h=>h.context,{cachedOnly:true});
  assert.equal(state.assignmentRevitContext,null);assert.equal(state.writeGrant,'off');assert.equal(state.outcome,'blocked');
});
