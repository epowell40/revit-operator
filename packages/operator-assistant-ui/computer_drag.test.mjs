import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComputerDrag, computerDragArguments, summarizeComputerDrag } from './computer_drag.mjs';

const paths = [
  [{x:872,y:766},{x:883,y:748},{x:901,y:718},{x:917,y:692}],
  [{x:872,y:766},{x:872,y:760},{x:878,y:749},{x:890,y:729},{x:903,y:709},{x:917,y:692}],
  [{x:839,y:782},{x:840,y:780},{x:845,y:770},{x:860,y:750},{x:880,y:710},{x:907,y:671}]
];
export function decodedPath(args) {
  return JSON.parse(Buffer.from(args[args.indexOf('-DragPathJsonBase64') + 1], 'base64').toString('utf8'));
}
for (const [i,path] of paths.entries()) test(`retained355 drag ${i+1} preserves every vertex at script boundary`, () => {
  const args = computerDragArguments({type:'drag',path}, (x,y)=>({x:x-1920,y:y+40}));
  assert.deepEqual(decodedPath(args), path.map(p=>({x:p.x-1920,y:p.y+40})));
  assert.match(summarizeComputerDrag({path}), new RegExp(`via ${path.length} points`));
});
test('legacy scalar aliases retain explicit zero and negative desktop coordinates', () => {
  for (const action of [
    {x:0,y:0,endX:-20,endY:80},
    {start_x:0,start_y:0,end_x:-20,end_y:80},
    {startX:0,startY:0,toX:-20,toY:80},
    {x:0,y:0,to_x:-20,to_y:80}
  ]) assert.deepEqual(normalizeComputerDrag(action).path, [{x:0,y:0},{x:-20,y:80}]);
});
test('path wins over conflicting legacy endpoints without dropping intermediate points', () => {
  assert.deepEqual(normalizeComputerDrag({path:paths[0],x:0,y:0,endX:0,endY:0}).path,paths[0]);
});
test('bounded geometry rejects missing, coercible, malformed and nonfinite data', () => {
  for (const action of [
    {},{x:1,y:2},{path:null,x:1,y:2,endX:3,endY:4},{path:[]},{path:[{x:1,y:2}]},
    {path:[{x:1,y:2},null]}, {path:[{x:1,y:2},{x:Infinity,y:2}]},
    {path:[{x:1,y:2},{x:NaN,y:2}]}, {path:[{x:1,y:2},{x:'3',y:2}]},
    {path:[{x:1,y:2},{x:null,y:2}]}, {path:[{x:1,y:2},[3,4]]},
    {path:Array(257).fill({x:1,y:2})}, {path:new Array(2)}, {x:0,y:0,endX:2**31,endY:4},
    {path:paths[0],button:'bogus'}
  ]) {
    assert.throws(()=>computerDragArguments(action), /drag/i);
    assert.equal(summarizeComputerDrag(action),'invalid drag geometry');
  }
});
test('rounding is consistent and mapped coordinate overflow is rejected', () => {
  assert.deepEqual(normalizeComputerDrag({x:0.2,y:0.7,endX:4.7,endY:8.1}).path,[{x:0,y:1},{x:5,y:8}]);
  assert.throws(()=>computerDragArguments({path:paths[0]},()=>({x:Infinity,y:0})), /drag/i);
});
