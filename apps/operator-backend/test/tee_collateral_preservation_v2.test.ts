import test from 'node:test';
import assert from 'node:assert/strict';
import {teeCollateralCoverageV2} from '../src/verification/tee_collateral_preservation_v2.js';
import {teeTakeoffFixture} from './tee_takeoff_readback.fixtures.js';
import {teeTakeoffReadbackMatchesV2} from '../src/verification/tee_takeoff_readback_v2.js';
const physical=()=>({metadata:{elementId:1402993,uniqueId:'remote-1402993',className:'Autodesk.Revit.DB.Mechanical.Duct'},
 geometry:{UniqueId:'remote-1402993',geometryKind:'Line',points:[[0,0,0],[1,0,0]],ports:[{}]},parameters:[],
 connections:[{origin:[0,0,0],basisX:[1,0,0],basisY:[0,1,0],basisZ:[0,0,1],peers:[]}]});
const snapshot=()=>({schema:'operator.tee_collateral.v1',complete:true,scope:'unchanged_connected_system_public_state',
 rows:[{elementId:1402993,uniqueId:'remote-1402993',role:'physical',parentIds:[],state:physical()}]});
test('prospective remote snapshot grants only requested unchanged coverage, not legacy identity inventory',()=>{
 const b=snapshot();assert.deepEqual(teeCollateralCoverageV2(b,b,[1402993],[1,2,3]),[1402993]);
 assert.deepEqual(teeCollateralCoverageV2(b,b,[],[1,2,3]),[]);
 assert.equal(teeCollateralCoverageV2({network:[{elementId:1402993,uniqueId:'remote-1402993'}]},b,[1402993],[1]),null);
});
test('changed remote geometry, references, input, identity, incomplete and unknown scopes refuse',()=>{
 const b=snapshot();
 const mutations:Array<(a:any)=>void>=[a=>a.complete=false,a=>a.rows[0].uniqueId='foreign',a=>a.rows=[],
  a=>a.rows[0].state.geometry.points[1][0]=2,a=>a.rows[0].state.connections[0].peers.push({ownerId:33,connectorId:0}),
  a=>a.rows[0].state.parameters.push({id:7,value:'changed'}),a=>a.rows[0].state.geometry={},
  a=>a.rows[0].role='unknown',a=>a.rows[0].state.metadata.className='Autodesk.Revit.DB.View',a=>a.rows.push(structuredClone(a.rows[0])),a=>a.rows[0].state.geometry.points[0][0]=NaN];
 for(const mutate of mutations){const a=structuredClone(b);mutate(a);assert.equal(teeCollateralCoverageV2(b,a,[1402993],[1]),null);}
 assert.equal(teeCollateralCoverageV2(b,b,[999],[1]),null);assert.equal(teeCollateralCoverageV2(b,b,[1402993],[1402993]),null);
});
test('native tee consumer requires prospective collateral and identical commit/current snapshot',()=>{
 const f:any=teeTakeoffFixture();
 f.apply.transaction.modified_element_ids.push(1402993);f.apply.transaction.affected_element_ids.push(1402993);f.affected.push('element_id:1402993');
 const match=()=>teeTakeoffReadbackMatchesV2(f.input,f.affected,f.apply,f.scan);
 assert.equal(match(),false,'historical footprint without prospective observations still refuses');
 f.apply.preservationBefore.collateral=snapshot();f.scan.teeReplacementState.collateral=snapshot();
 f.apply.preservationAfter=structuredClone(f.scan.teeReplacementState);
 assert.equal(match(),false,'arbitrary foreign owner cannot become a connected-system collateral record');
 for(const s of [f.apply.preservationBefore,f.scan.teeReplacementState])s.system.network.push({elementId:1402993,uniqueId:'remote-1402993'});
 f.apply.preservationAfter=structuredClone(f.scan.teeReplacementState);
 assert.equal(match(),true);
 f.apply.preservationAfter.collateral.rows[0].state.geometry.points[1][0]=2;
 assert.equal(match(),false,'current evidence must agree with committed native observation');
});
test('actual tag geometry and leader/reference state are compared, not just tag identity',()=>{
 const b:any=snapshot();b.rows=[{elementId:1489176,uniqueId:'tag-1489176',role:'tag',parentIds:[1402993],state:{complete:true,
  metadata:{elementId:1489176,uniqueId:'tag-1489176',className:'Autodesk.Revit.DB.IndependentTag'},text:'6 inch',head:[0,1,0],
  references:['host:1402993'],leaders:[{reference:'host:1402993',visible:true,elbow:[1,1,0],end:[1,0,0]}],
  bounds:{min:[0,0,0],max:[1,1,0]}}}];
 assert.deepEqual(teeCollateralCoverageV2(b,b,[1489176],[10]),[1489176]);
 for(const change of [(a:any)=>a.rows[0].state.head[0]=2,(a:any)=>a.rows[0].state.leaders[0].end[1]=2,
  (a:any)=>a.rows[0].state.references=['foreign'],(a:any)=>a.rows[0].state.text='changed',(a:any)=>a.rows[0].state.bounds.max[0]=9]){
  const a=structuredClone(b);change(a);assert.equal(teeCollateralCoverageV2(b,a,[1489176],[10]),null);
 }
});
