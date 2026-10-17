import assert from 'node:assert/strict';import test from 'node:test';
import {desktopHelperCallGrantV1,desktopHelperCallDecisionV1} from '../src/brains/desktop_helper_budget.js';
for(const [remaining,grant]of[[0,0],[1,1],[2,1],[3,1],[16,8],[62,31],[64,32],[512,256]])test(`scoped helper uses only its share of ${remaining} existing calls`,()=>{assert.equal(desktopHelperCallGrantV1(remaining),grant);assert(grant<=remaining);if(remaining>=2)assert(remaining-grant>=grant);});
test('unknown, fractional or malformed remaining allowance cannot create a helper grant',()=>{for(const bad of[-1,.5,NaN,Infinity,null,'64',undefined])assert.throws(()=>desktopHelperCallGrantV1(bad as number),/invalid/);});

test('small funded helpers can perform a useful native call before reporting; larger helpers warn before the share ends',()=>{
 assert.equal(desktopHelperCallDecisionV1(1,1),'continue');assert.equal(desktopHelperCallDecisionV1(1,2),'continue');assert.equal(desktopHelperCallDecisionV1(2,2),'yield');assert.equal(desktopHelperCallDecisionV1(2,3),'continue');assert.equal(desktopHelperCallDecisionV1(3,3),'yield');
 assert.equal(desktopHelperCallDecisionV1(29,32),'continue');assert.equal(desktopHelperCallDecisionV1(30,32),'warn');assert.equal(desktopHelperCallDecisionV1(31,32,true,32),'yield');assert.equal(desktopHelperCallDecisionV1(32,32),'yield');
});
test('only a greater canonical grant can make a warned helper useful again; no grant has no funded work',()=>{assert.equal(desktopHelperCallDecisionV1(31,40,true,32),'continue');assert.equal(desktopHelperCallDecisionV1(31,32,true,32),'yield');assert.equal(desktopHelperCallDecisionV1(0,0),'yield');assert.throws(()=>desktopHelperCallDecisionV1(1.5,4),/invalid/);});
