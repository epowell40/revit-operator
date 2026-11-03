import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {teeTakeoffFixture} from './tee_takeoff_readback.fixtures.js';
import {teeTakeoffReadbackMatchesV2} from '../src/verification/tee_takeoff_readback_v2.js';
import {teeCollateralCoverageV2,teeCollateralScopeV2} from '../src/verification/tee_collateral_preservation_v2.js';
const source=JSON.parse(fs.readFileSync(path.resolve('test/fixtures/flex-centerline203.json'),'utf8'));
function fixture(){const f=teeTakeoffFixture();
 // Only parent identities are adapted to the synthetic transition. The category,
 // proxy parameter shapes and values are retained diagnostic203 observations.
 const c={...structuredClone(source.centers[0]),parentId:30,parentUniqueId:'u30'};
 f.apply.preservationBefore.centerlines.push(structuredClone(c));f.scan.teeReplacementState.centerlines.push(structuredClone(c));
 f.apply.preservationAfter=structuredClone(f.scan.teeReplacementState);f.apply.transaction.modified_element_ids.push(c.elementId);
 f.apply.transaction.affected_element_ids.push(c.elementId);f.affected.push('element_id:'+c.elementId);return f;
}
const match=(f:ReturnType<typeof fixture>)=>teeTakeoffReadbackMatchesV2(f.input,f.affected,f.apply,f.scan);
test('observed flex centerline participates in prospective exact parent-bound native transition and independent readback',()=>assert.equal(match(fixture()),true));
const negatives:Record<string,(c:any)=>void>={wrongParent:c=>c.parentUniqueId='foreign',wrongCategory:c=>c.categoryId=-2008020,wrongClass:c=>c.className='Autodesk.Revit.DB.IndependentTag',schema:c=>c.schemaGuids=['custom'],missingParentParameters:c=>c.parentParameters=[],changedWritable:c=>{const p=c.parameters.find((p:any)=>!p.readOnly&&!c.parentParameters.find((x:any)=>x.id===p.id).readOnly);p.value='changed';},changedReadOnlyShape:c=>c.parameters[0].readOnly=!c.parameters[0].readOnly};
for(const [name,mutate]of Object.entries(negatives))test('flex primary readback refuses '+name,()=>{const f=fixture();mutate(f.scan.teeReplacementState.centerlines.at(-1));assert.equal(match(f),false);});
test('newly observed flex centerline cannot cover unobserved or protected collateral',()=>{const f=fixture();f.apply.transaction.modified_element_ids.push(999);f.apply.transaction.affected_element_ids.push(999);f.affected.push('element_id:999');assert.equal(match(f),false);});
test('collateral flex category, class and parameter observations remain strict',()=>{
 const c=structuredClone(source.centers[0]),b={schema:'operator.tee_collateral.v1',complete:true,scope:'unchanged_connected_system_public_state',rows:[{elementId:c.elementId,uniqueId:c.uniqueId,role:'centerline',parentIds:[c.parentId],state:c}]};
 assert.deepEqual(teeCollateralCoverageV2(b,b,[c.elementId],[]),[c.elementId]);assert.equal(teeCollateralScopeV2(b,[],[]),false,'unobserved parent is not source coverage');
 for(const field of ['categoryId','className','schemaGuids']){const a=structuredClone(b);a.rows[0].state[field]=field==='categoryId'?-2008020:field==='className'?'Autodesk.Revit.DB.IndependentTag':['custom'];assert.equal(teeCollateralCoverageV2(a,a,[c.elementId],[]),null);}
 const a=structuredClone(b);a.rows[0].state.parameters[0].value='changed';assert.equal(teeCollateralCoverageV2(b,a,[c.elementId],[]),null);
});
