import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { registeredStageDuctRouteInputV2, registeredStageDuctRouteReadbackMatchesV2 }
  from '../src/verification/registered_stage_route_readback_v2.js';

const fixture = () => JSON.parse(fs.readFileSync('test/fixtures/c107-registered-stage-route-verification.json', 'utf8'));
const check = (f: any) => registeredStageDuctRouteReadbackMatchesV2(f.input,
  f.apply.createdElementIds.map((id: number) => `element_id:${id}`), f.apply,
  f.connectors.verificationParameters, f.connectors);

test('C107 registered stage proves its exact native two-duct elbow and old-duct connection', () => {
  const f = fixture();
  assert.equal(registeredStageDuctRouteInputV2(f.input), true);
  assert.equal(check(f), true);
  for (const [name, mutate] of [
    ['preview', (x: any) => { x.input.body.dryRun = true; }],
    ['other stage', (x: any) => { x.apply.stageKey = 'operation:other'; }],
    ['other source', (x: any) => { x.apply.inputFingerprintSha256 = '0'.repeat(64); }],
    ['unbounded stage', (x: any) => { x.input.body.maximumCreatedElements = 1000; }],
    ['second action', (x: any) => { x.input.body.operations.push(structuredClone(x.input.body.operations[0])); }],
    ['missing fitting identity', (x: any) => { x.apply.createdElementIds.pop(); }],
    ['wrong existing owner', (x: any) => { x.input.body.operations[0].apply_body.expectedExistingStartOwnerId = 1542972; }],
    ['wrong route system', (x: any) => { x.input.body.operations[0].apply_body.systemType = 'ExhaustAir'; }],
    ['disconnected elbow', (x: any) => {
      const elbow = x.connectors.results.find((r: any) => r.id === 1543145);
      elbow.connectors[0].physicalConnectedTo = [];
    }],
    ['unverified parameter', (x: any) => {
      x.connectors.verificationParameters.items[0].parameters.Diameter = '0.5';
    }]
  ] as Array<[string, (f: any) => void]>) {
    const changed = fixture(); mutate(changed);
    assert.equal(check(changed), false, name);
  }
});

test('C117 registered stage accepts Revit display-name spelling for the same physically verified duct system', () => {
  const f = fixture();
  f.input.body.operations[0].apply_body.systemType = 'Supply Air';
  assert.equal(check(f), true);
  f.input.body.operations[0].apply_body.systemType = 'Return Air';
  assert.equal(check(f), false, 'a different system must not inherit the supply-air proof');
});

test('C117 exact live Return Air section verifies four ducts, three fittings and the HRU connection', () => {
  const f = JSON.parse(fs.readFileSync('test/fixtures/c117-return-air-verification.json', 'utf8'));
  assert.equal(registeredStageDuctRouteInputV2(f.input), true);
  assert.equal(registeredStageDuctRouteReadbackMatchesV2(f.input, f.affected_target_identities,
    f.apply, f.connectors.verificationParameters, f.connectors), true);
  for (const [name, mutate] of [
    ['wrong system', (x: any) => { x.input.body.operations[0].apply_body.systemType = 'Supply Air'; }],
    ['missing fitting', (x: any) => { x.connectors.results.pop(); }],
    ['disconnected fitting', (x: any) => { x.connectors.results.find((r: any) => r.id === 1543292).connectors[0].physicalConnectedTo = []; }],
    ['wrong size', (x: any) => { x.connectors.verificationParameters.items[0].parameters.Diameter = '0.5'; }]
  ] as Array<[string, (f: any) => void]>) {
    const changed = structuredClone(f); mutate(changed);
    assert.equal(registeredStageDuctRouteReadbackMatchesV2(changed.input, changed.affected_target_identities,
      changed.apply, changed.connectors.verificationParameters, changed.connectors), false, name);
  }
});
