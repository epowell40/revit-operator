import fs from 'node:fs';import {gunzipSync} from 'node:zlib';import {createHash} from 'node:crypto';import {test} from 'node:test';import assert from 'node:assert/strict';
import {expandNativeAccessoryPreservationV2} from '../src/verification/native_preservation_snapshot_v2.js';
import {nativeAccessoryPreservationV2} from '../src/verification/native_accessory_preservation_v2.js';
import {assignedConnectorInputsPreservedV2} from '../src/verification/native_accessory_flow_v2.js';
import {preservedInternalCandidatesV2,preservedNativePlacementInternalsV2} from '../src/verification/inline_accessory_bookkeeping_v2.js';
const urls=[new URL('./fixtures/native-placement-consequences154.json',import.meta.url),new URL('../../test/fixtures/native-placement-consequences154.json',import.meta.url)];
const raw=JSON.parse(fs.readFileSync(urls.find(p=>fs.existsSync(p))!,'utf8'));
function fixture(){const [apply,read]=raw.records.map((r:any)=>{const b=gunzipSync(Buffer.from(r.gzipBase64,'base64'));assert.equal(b.length,r.bytes);assert.equal(createHash('sha256').update(b).digest('hex'),r.sha256);return JSON.parse(b.toString('utf8'));});return {input:structuredClone(raw.input),affected:[...raw.affected],apply:expandNativeAccessoryPreservationV2(apply),read};}
const state=(f:any,phase:string)=>phase==='before'?f.apply.preservationBefore.nativePlacementState:phase==='immediate'?f.apply.preservationAfter.nativePlacementState:f.read.nativePlacementState;
const owner=(f:any,phase:string)=>state(f,phase).owners.find((o:any)=>o.elementId===1484034);
const run=(f:any)=>nativeAccessoryPreservationV2(f.input,f.affected,f.apply,f.read);
test('exact154 calculated connector fields match native calculated counterparts in all three observations',()=>{const f=fixture();assert(assignedConnectorInputsPreservedV2(owner(f,'before'),owner(f,'after'),owner(f,'immediate')));});
test('exact154 native placement semantic comparison covers only proven insertion consequences',()=>{const f=fixture(),original=JSON.stringify(f);assert(run(f));assert.equal(JSON.stringify(f),original);});
for(const [name,mutate]of Object.entries({
 'preset input change':(f:any)=>{for(const p of ['before','immediate','after'])owner(f,p).assignedConnectorFlows[1].observation.configuration='Preset';},
 'system configuration':(f:any)=>{for(const p of ['before','immediate','after'])owner(f,p).assignedConnectorFlows[1].observation.configuration='System';},
 'missing calculated proof':(f:any)=>{delete owner(f,'after').calculatedConnectorFlows;},
 'wrong calculated value':(f:any)=>{owner(f,'after').calculatedConnectorFlows[1].observation.value=9;},
 'stale immediate':(f:any)=>{owner(f,'immediate').assignedConnectorFlows[1].observation.flow=9;},
 'changed direction':(f:any)=>{owner(f,'after').assignedConnectorFlows[1].observation.direction='In';},
 'unknown calculated':(f:any)=>{owner(f,'after').calculatedConnectorFlows[1].observation.status='unavailable';},
 'wrong units':(f:any)=>{owner(f,'after').calculatedConnectorFlows[1].observation.units='cfm';},
 'missing source symbol edge':(f:any)=>{state(f,'before').internalBookkeeping.unavailableInternals.find((r:any)=>r.elementId===1544967).dependencyObservation.observedDependentIds= [1544967];},
 'unrelated dependency added':(f:any)=>{state(f,'after').internalBookkeeping.unavailableInternals.find((r:any)=>r.elementId===1544967).dependencyObservation.observedDependentIds.push(987654);},
 'dependency removed':(f:any)=>{state(f,'after').internalBookkeeping.unavailableInternals.find((r:any)=>r.elementId===1544967).dependencyObservation.observedDependentIds.shift();},
 'changed internal parameter':(f:any)=>{state(f,'after').internalBookkeeping.unavailableInternals.find((r:any)=>r.elementId===1544967).parameters[0].value='2';},
 'unknown internal reason':(f:any)=>{state(f,'after').internalBookkeeping.unavailableInternals.find((r:any)=>r.elementId===1544967).dependencyObservation.reason='unavailable';},
 'interim dependency mismatch':(f:any)=>{state(f,'immediate').internalBookkeeping.unavailableInternals.find((r:any)=>r.elementId===1544967).dependencyObservation.observedDependentIds.pop();},
 'uncovered modified owner':(f:any)=>{f.apply.transaction.modified_element_ids.push(1544967);f.apply.transaction.affected_element_ids.push(1544967);f.apply.changeTracking.observedModifiedIds.push(1544967);f.affected.push('element_id:1544967');},
 'foreign type request':(f:any)=>{f.input.body.accessoryTypeId=42;},
 'lost terminal prescribed flow':(f:any)=>{state(f,'after').owners.find((r:any)=>r.elementId===1484667).assignedConnectorFlows[0].observation.flow=0;},
 'remote physical movement':(f:any)=>{state(f,'after').owners.find((r:any)=>r.elementId===1484667).state.points[0][0]+=1;},
}))test('native insertion consequences reject '+name,()=>{const f=fixture();mutate(f);assert.equal(run(f),null);});

test('unavailable dependency edges never cover a modified owner or relax the generic comparator',()=>{
 const f=fixture(),b=state(f,'before').internalBookkeeping,a=state(f,'after').internalBookkeeping,i=state(f,'immediate').internalBookkeeping;
 assert.equal(preservedInternalCandidatesV2(b,a,i),null);
 assert(preservedNativePlacementInternalsV2(b,a,i,[],1545043,[1546009]));
 for(const id of [1544967,1545044])assert.equal(preservedNativePlacementInternalsV2(b,a,i,[id],1545043,[1546009]),null);
 assert.equal(preservedNativePlacementInternalsV2(b,a,i,[],1545043,[1546012]),null);
 assert.equal(preservedNativePlacementInternalsV2(b,a,i,[],1546009,[1546009]),null);
});
for(const [name,mutate]of Object.entries({
 NaN:(o:any):void=>{o.assignedConnectorFlows[1].observation.flow=NaN;},
 Infinity:(o:any):void=>{o.assignedConnectorFlows[1].observation.flow=Infinity;},
 negative:(o:any):void=>{o.assignedConnectorFlows[1].observation.flow=-1;},
 duplicate:(o:any):void=>{o.calculatedConnectorFlows[2].connectorId=2;},
 foreign:(o:any):void=>{o.assignedConnectorFlows[1].connectorId=99;},
 missing:(o:any):void=>{delete o.assignedConnectorFlows;},
 extraMeaning:(o:any):void=>{o.assignedConnectorFlows[1].observation.meaning='prescribed';},
 config:(o:any):void=>{o.assignedConnectorFlows[1].observation.configuration='Preset';},
}))test('calculated connector comparison fails closed for '+name,()=>{
 const f=fixture();mutate(owner(f,'after'));assert.equal(assignedConnectorInputsPreservedV2(owner(f,'before'),owner(f,'after'),owner(f,'immediate')),false);
});
