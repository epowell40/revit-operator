import assert from 'node:assert/strict';
import test from 'node:test';
import {operationTargetSelectorV2} from '../src/verification/verification_capability_admission_v2.js';
import {segmented} from './native_segmented_preservation_v2.test.js';
const select=(body:unknown)=>operationTargetSelectorV2({operation:{capability_id:'revit_call_tool',method:'POST',path:'/revit/get-connectors'},value:body});
const body=()=>({elementIds:Array.from({length:3077},(_,i)=>10000+i),includeNativePlacementState:true,placementChangedIds:[12000,14000,15000]});
const observation=()=>({nativePlacementState:{schema:'operator.native_accessory_placement_state.v1',complete:true,requestedElementIds:body().elementIds,requestedChangedIds:body().placementChangedIds},padding:'x'.repeat(2_000_001)});
test('actual segmented native placement read exposes its observed target scope rather than opaque codec fields',()=>{
 const value=segmented(observation());assert.deepEqual(select(value).principal_target_tokens,['id:12000','id:14000','id:15000']);
});
for(const mode of ['incomplete','foreign-schema','empty','duplicate','nonfinite','extra-codec','digest','too-many'] as const)test('observed placement scope rejects '+mode,()=>{
 const p=observation();
 if(mode==='incomplete')p.nativePlacementState.complete=false;
 if(mode==='foreign-schema')p.nativePlacementState.schema='foreign';
 if(mode==='empty')p.nativePlacementState.requestedChangedIds=[];
 if(mode==='duplicate')p.nativePlacementState.requestedChangedIds=[12000,12000];
 if(mode==='nonfinite')p.nativePlacementState.requestedChangedIds=[NaN];
 if(mode==='too-many')p.nativePlacementState.requestedChangedIds=Array.from({length:1025},(_,i)=>i+1);
 const value:any=segmented(p);if(mode==='extra-codec')value.verified=true;if(mode==='digest')value.sha256='0'.repeat(64);
 assert.deepEqual(select(value).principal_target_tokens,[]);
});
test('system-wide placement read binds every changed owner beyond generic token cap, including non-connector collateral',()=>{
 const result=select(body());assert.deepEqual(result.principal_target_tokens,['id:12000','id:14000','id:15000']);
 assert.equal(result.source,'reviewed_capability_contract');
 assert.deepEqual(select({...body(),elementIds:[...body().elementIds].reverse()}).principal_target_tokens,result.principal_target_tokens);
});
for(const [name,patch] of Object.entries({missing:{placementChangedIds:undefined},empty:{placementChangedIds:[]},duplicate:{placementChangedIds:[12000,12000]},null:{placementChangedIds:null},strings:{placementChangedIds:['12000']},nonfinite:{placementChangedIds:[Infinity]},negative:{placementChangedIds:[-1]},tooMany:{placementChangedIds:Array.from({length:1025},(_,i)=>i+1)},missingCohort:{elementIds:undefined},emptyCohort:{elementIds:[]},duplicateCohort:{elementIds:[1,1]},tooManyCohort:{elementIds:Array.from({length:5001},(_,i)=>i+1)}}))
 test('placement selector fails closed on '+name,()=>assert.deepEqual(select({...body(),...patch}).principal_target_tokens,[]));
test('placement selector accepts exact existing contract bounds without increasing generic selector capacity',()=>{
 assert.equal(select({elementIds:Array.from({length:5000},(_,i)=>i+1),placementChangedIds:Array.from({length:1024},(_,i)=>i+1),includeNativePlacementState:true}).principal_target_tokens.length,1024);
 const legacy=select({elementIds:body().elementIds});assert.equal(legacy.principal_target_tokens.length,128);
 assert.deepEqual(select({...body(),includeNativePlacementState:false}).principal_target_tokens,legacy.principal_target_tokens);
 assert.deepEqual(select({...body(),includeNativePlacementState:'true'}).principal_target_tokens,legacy.principal_target_tokens);
});
