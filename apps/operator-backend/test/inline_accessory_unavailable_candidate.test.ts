import assert from 'node:assert/strict';
import test from 'node:test';
import {inlineBookkeepingFixture} from './inline_accessory_bookkeeping.fixtures.js';
import {inlineAccessoryReadbackMatchesV2} from '../src/verification/inline_accessory_readback_v2.js';
const matches=(f:any)=>inlineAccessoryReadbackMatchesV2(f.input,f.affected,f.apply,f.scan);
function fixture(){const f=inlineBookkeepingFixture();for(const s of [f.apply.preservationBefore.bookkeeping,f.scan.inlineAccessoryState.bookkeeping]){const u=structuredClone(s.internals[0]);u.elementId=999;u.uniqueId='unavailable-999';delete u.dependentIds;u.dependencyObservation={status:'unavailable',reason:'dependency_limit_exceeded',limit:64,observedAtLeast:65};s.unavailableInternals=[u];}return f;}
test('unmodified unavailable candidate is explicit and adds no effect authority',()=>assert.equal(matches(fixture()),true));
for(const kind of ['modified','deleted','added'])test('unavailable owner '+kind+' is never covered',()=>{const f=fixture();f.apply.transaction[kind+'_element_ids'].push(999);f.apply.transaction.affected_element_ids.push(999);f.affected.push('element_id:999');assert.equal(matches(f),false);});
const negatives:Record<string,(a:any)=>void>={removed:a=>a.unavailableInternals=[],identity:a=>a.unavailableInternals[0].uniqueId='replacement',duplicate:a=>a.unavailableInternals[0].elementId=90,physical:a=>a.unavailableInternals[0].elementId=10,profile:a=>a.unavailableInternals[0].hasBounds=true,reason:a=>a.unavailableInternals[0].dependencyObservation.reason='read_error',bound:a=>a.unavailableInternals[0].dependencyObservation.limit=128,falseCoverage:a=>a.unavailableInternals[0].dependentIds=[999],nullRows:a=>a.unavailableInternals=null};
for(const [name,mutate]of Object.entries(negatives))test('unavailable metadata refuses '+name,()=>{const f=fixture();mutate(f.scan.inlineAccessoryState.bookkeeping);assert.equal(matches(f),false);});
