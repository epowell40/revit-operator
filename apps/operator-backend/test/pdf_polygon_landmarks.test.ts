import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {extractCircularLabelCandidates as extract} from '../src/attachments/pdf_source_landmarks.js';
const replay=JSON.parse(fs.readFileSync(new URL('../../test/fixtures/c46-tessellated-grid-replay.json',import.meta.url),'utf8'));
const copy=()=>structuredClone(replay.input);
test('actual Revit polygon grid yields the exact recorded source candidate',()=>{

 assert.deepEqual(extract(copy()).items,[replay.expected]);
});
test('nonuniform scale, shear, missing closure, incomplete arc, nonfinite point and budget excess abstain',()=>{
 for(const mutate of [
  (f:any)=>f.operatorList.argsArray[0]=[2,0,0,1,0,0],
  (f:any)=>f.operatorList.argsArray[0]=[1,0,.3,1,0,0],
  (f:any)=>{f.operatorList.argsArray[1][0].pop();f.operatorList.argsArray[1][1].splice(-2)},
  (f:any)=>f.operatorList.argsArray[1][1][0]=NaN,
  (f:any)=>f.operatorList.argsArray[1][0]=Array(259).fill(f.OPS.lineTo),
  (f:any)=>{const a=f.operatorList.argsArray[1][1];[a[2],a[8]]=[a[8],a[2]];[a[3],a[9]]=[a[9],a[3]];}
 ]){const f=copy();mutate(f);assert.equal(extract(f).items.length,0);}
});
test('annotations and ambiguous labels cannot produce an accepted grid correspondence',()=>{
 const f=copy();f.operatorList.fnArray.unshift(f.OPS.beginAnnotation);f.operatorList.argsArray.unshift([]);f.operatorList.fnArray.push(f.OPS.endAnnotation);f.operatorList.argsArray.push([]);
 assert.equal(extract(f).items.length,0);
 const g=copy();g.textContent.items.push({...g.textContent.items[0],str:'X'});assert.equal(extract(g).items.length,0);
});
test('page rotation transforms the same source circle and text consistently',()=>{
 const f=copy(),old=f.viewport;
 f.viewport={width:old.height,height:old.width,transform:[old.transform[1],old.transform[0],old.transform[3],old.transform[2],old.transform[5],old.transform[4]]};
 const found=extract(f);assert.equal(found.items.length,1);
 assert.ok(Math.abs(found.items[0].center.u-replay.expected.center.v)<1e-10);
 assert.ok(Math.abs(found.items[0].center.v-replay.expected.center.u)<1e-10);
});
