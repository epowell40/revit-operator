import assert from 'node:assert/strict';
import test from 'node:test';
import {z} from 'zod';
import {familyPlacementToolShape} from './familyPlacementSchema.js';
const schema=z.object(familyPlacementToolShape);

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
