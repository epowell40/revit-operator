import {states,browserFixture,equipmentGraph,pipeCenterFixture} from './native_pipe_placement_coverage.fixtures.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {example} from './native_accessory_preservation.fixtures.js';
import {readNativePlacementGraphV2} from '../src/verification/native_placement_graph_v2.js';
import {nativeAccessoryPreservationV2} from '../src/verification/native_accessory_preservation_v2.js';
const run=(f:any)=>nativeAccessoryPreservationV2(f.input,f.affected,f.apply,f.after);
test('pipe insertion covers an exactly observed unchanged System Browser at all three stages',()=>assert.ok(run(browserFixture())));
for(const mode of ['baseline-missing','immediate-missing','independent-missing','incomplete','wrong-type','wrong-class','changed-parameter','immediate-change','changed-dependency','foreign-uid','added-view','duplicate','extra-field','bad-parameter','nonfinite','schema','affected-content','owner-alias','self-dependency-missing','metadata-extra'])test('System Browser rejects '+mode,()=>{
 const f=browserFixture(),ss=states(f),s=ss[2],b=s.systemBrowserViews,r=b.items[0];
 if(mode.endsWith('-missing'))delete ss[mode==='baseline-missing'?0:mode==='immediate-missing'?1:2].systemBrowserViews;
 else if(mode==='incomplete')b.complete=false;
 else if(mode==='changed-parameter')r.metadata.parameters[0].value='changed';
 else if(mode==='immediate-change')ss[1].systemBrowserViews.items[0].name='changed';
 else if(mode==='changed-dependency')r.metadata.dependentIds.push(902);
 else if(mode==='foreign-uid')r.uniqueId='foreign';
 else if(mode==='added-view')b.items=[];
 else if(mode==='affected-content')s.affected.at(-1).parameters=[];
 else for(const state of ss){const x=state.systemBrowserViews.items[0];
  if(mode==='wrong-type')x.viewType='FloorPlan';
  if(mode==='wrong-class')x.metadata.className='Autodesk.Revit.DB.ViewPlan';
  if(mode==='duplicate')state.systemBrowserViews.items.push(structuredClone(x));
  if(mode==='extra-field')x.exempt=true;
  if(mode==='bad-parameter')x.metadata.parameters[0].storage='Unknown';
  if(mode==='nonfinite'){x.metadata.parameters[0].storage='Double';x.metadata.parameters[0].value='NaN';}
  if(mode==='self-dependency-missing')x.metadata.dependentIds=[];
  if(mode==='metadata-extra')x.metadata.exempt=true;
  if(mode==='schema')x.metadata.schemaGuids=['foreign-schema'];
  if(mode==='owner-alias'){x.elementId=40;x.metadata.elementId=40;}
 }
 assert.equal(run(f),null);
});
function newPipeCenter(){const f=pipeCenterFixture();
 for(const s of states(f).slice(1)){const parent=s.owners.find((o:any)=>o.elementId===100)!;parent.parameters=structuredClone(s.owners.find((o:any)=>o.elementId===10)!.parameters);parent.dependentIds=[801];
  const d={...structuredClone(s.dependents[0]),elementId:801,uniqueId:'new-pipe-center',dependentIds:[801]};s.dependents.push(d);
  if(!s.requestedChangedIds.includes(801))s.requestedChangedIds.push(801);s.affected.push(structuredClone(d));}
 for(const xs of [f.apply.transaction.added_element_ids,f.apply.changeTracking.observedAddedIds,f.apply.transaction.affected_element_ids])if(!xs.includes(801))xs.push(801);
 f.affected.push('element_id:801');return f;
}
test('new split-pipe centerline uses the original host template and actual new parent',()=>assert.ok(run(newPipeCenter())));
test('new split-pipe centerline cannot acquire an unobserved input',()=>{const f=newPipeCenter();f.after.nativePlacementState.dependents.at(-1)!.parameters[0].value='333';assert.equal(run(f),null);});
test('legacy observations without System Browser do not gain modified-view coverage',()=>{const f=browserFixture();for(const s of states(f))delete s.systemBrowserViews;assert.equal(run(f),null);});
test('known PlumbingEquipment retains complete strict native graph observation',()=>assert.ok(readNativePlacementGraphV2(equipmentGraph())));
for(const mode of ['unknown-category','truncated','unknown-port','missing-peer','count'])test('equipment graph rejects '+mode,()=>{
 const g=equipmentGraph();if(mode==='unknown-category')g.results[0].category='OST_Unknown';
 if(mode==='truncated')g.results[0].connectorScanTruncated=true;
 if(mode==='unknown-port')g.unknownPhysicalConnectorCount=1;
 if(mode==='missing-peer')g.results[0].connectors[1].physicalConnectedTo=[];
 if(mode==='count')g.requestedCount++;assert.equal(readNativePlacementGraphV2(g),null);
});
test('pipe centerline derives only parent-bound readonly area and length',()=>assert.ok(run(pipeCenterFixture())));
for(const mode of ['wrong-parent','wrong-category','wrong-value','writable','unknown-derived','immediate-change'])test('pipe centerline rejects '+mode,()=>{
 const f=pipeCenterFixture(),ss=states(f),s=ss[2];
 if(mode==='wrong-parent')for(const scan of [f.apply.preservationBefore,f.apply.preservationAfter,f.after])scan.results.find((r:any)=>r.id===10)!.category='OST_DuctCurves';
 if(mode==='wrong-category')for(const x of ss)x.dependents[0].categoryId=-1234;
 if(mode==='wrong-value')s.dependents[0].parameters[0].value='123';
 if(mode==='writable')for(const x of ss)x.dependents[0].parameters[0].readOnly=false;
 if(mode==='unknown-derived')for(const x of ss){x.dependents[0].parameters[0].id=-9999999;x.owners.find((o:any)=>o.elementId===10)!.parameters[0].id=-9999999;}
 if(mode==='immediate-change')ss[1].dependents[0].parameters[0].value='123';
 assert.equal(run(f),null);
});
