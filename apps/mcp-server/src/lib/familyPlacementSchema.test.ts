import assert from 'node:assert/strict';
import test from 'node:test';
import {z} from 'zod';
import {familyPlacementToolShape} from './familyPlacementSchema.js';
import fs from 'node:fs';
const schema=z.object(familyPlacementToolShape);

test('C46 exact failure requests survive MCP serialization without dropping recovery constraints',()=>{
 const replay=JSON.parse(fs.readFileSync(new URL('../../src/lib/fixtures/c46-linked-face-placement.json',import.meta.url),'utf8'));
 for(const [name,entry] of Object.entries(replay.cases) as [string,any][]){
  const parsed=schema.parse(entry.request);
  assert.deepEqual(parsed.instances,entry.request.instances,name);
  assert.equal(parsed.levelName,'L4');
  assert.equal(parsed.viewId,1363433);
  assert.equal(parsed.familySymbolId,1380250);
  assert.equal(parsed.dryRun,entry.request.dryRun);
  if(name!=='apply')assert.deepEqual(parsed.idempotency,entry.request.idempotency);
 }
 // The MCP has no native host-class knowledge. It must retain a missing linked
 // selector for authoritative native validation, never infer the whole link's face.
 assert.equal(schema.parse(replay.cases['missing-linked-host'].request).instances[0].linkedHostElementId,undefined);
 assert.equal(schema.parse(replay.cases['wrong-linked-host'].request).instances[0].linkedHostElementId,2095209);
 assert.equal(schema.parse(replay.cases['projected-repeat'].request).instances[0].z,39.6666666667);
 assert.equal(replay.cases.apply.result.transaction,undefined);
});

test('direct room linked ceiling request retains exact native host, type and absolute coordinates',()=>{
 const body={familySymbolId:1380250,levelName:'L4',viewId:1363433,
  instances:[{x:-34.7975,y:-6.688,z:40.1666666667,coordinateMode:'absolute_model',hostElementId:1362429,linkedHostElementId:2095221}]};
 const parsed=schema.parse(body);
 assert.deepEqual(parsed.instances,body.instances);
 assert.equal(parsed.familySymbolId,1380250);
 assert.equal(parsed.viewId,1363433);
 assert.equal(parsed.dryRun,false);
 const missing=structuredClone(body);delete (missing.instances[0] as any).hostElementId;
 assert.equal(schema.safeParse(missing).success,false);
 for(const n of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
  const bad=structuredClone(body);bad.instances[0].linkedHostElementId=n;
  assert.equal(schema.safeParse(bad).success,false);
 }
});

test('legacy placement and view-based stable type requests remain usable without inventing a level',()=>{
 const legacy={levelName:'L4',symbolName:'HRU',instances:[{x:1,y:2,z:8}]};
 assert.deepEqual(schema.parse(legacy).instances,legacy.instances);
 assert.equal(schema.parse({familySymbolId:42,viewId:24,instances:[{x:0,y:0,z:0}]}).viewId,24);
 assert.equal(schema.safeParse({familySymbolId:42,instances:[]}).success,false);
 assert.equal(schema.safeParse({...legacy,instances:[{x:NaN,y:0,z:0}]}).success,false);
});
