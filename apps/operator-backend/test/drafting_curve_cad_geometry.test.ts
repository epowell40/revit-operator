import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalVectorJson,type VectorNativePlan} from '../src/pdf/drafting_vector_native_plan.js';
import {compileDraftingCurveCad} from '../src/pdf/drafting_curve_cad.js';
import {compareDraftingCurveCadNativeGeometry as compare} from '../src/verification/drafting_curve_cad_geometry.js';

function fixture(){
 const plan:any={schema:'operator.drafting_vector_native_plan.v1',sourceSha256:'a'.repeat(64),sourcePlanSha256:'b'.repeat(64),selectionSha256:'c'.repeat(64),
  sourceLabel:'source.pdf',sourceSheet:'M501',page:1,region:[0,0,144,144],layout:{paperWidthInches:2,viewScale:100,partSize:50},paperHeightInches:2,
  coordinateSpace:'paper inches, right/up, lower-left of selected source region',entities:[
   {id:'line',sourceId:'source-line',kind:'line',points:[[2.944822205845301,3.8095235827664424],[2.944822205845301,3.857898488284203]]},
   {id:'cubic',sourceId:'source-cubic',kind:'cubic_bezier',points:[[0,0],[1,2],[2,2],[3,0]]},
   {id:'text',sourceId:'source-text',kind:'text',text:'REQUIRED TEXT'}],partCount:1,zeroLengthSourceCommands:0,omissions:[],limits:[],nativeWriteAllowed:false};
 plan.nativePlanSha256=createHash('sha256').update(canonicalVectorJson(plan)).digest('hex');
 const typed=plan as VectorNativePlan,artifact=compileDraftingCurveCad(typed,plan.nativePlanSha256,['line','cubic']);
 const point=([x,y,z]:number[])=>({x,y,z});
 const primitives=artifact.selection.map(s=>({kind:'Curve',layerName:s.layer,geometry:s.kind==='line'
  ?{kind:'Line',start:point(s.points[0]),end:point(s.points[1])}
  :{kind:'NurbSpline',degree:3,cyclic:false,rational:false,controlPoints:s.points.map(point),start:point(s.points[0]),end:point(s.points[3]),
    knots:[0,0,0,0,1,1,1,1],weights:[1,1,1,1],startParameter:0,endParameter:1}}));
 const cad:any={schema:'revit-operator.cad-geometry/v1',elementId:32,uniqueId:'native-import-32',ownerViewId:20,isLinked:false,
  coordinateSpace:'host_model_feet',complete:true,issues:[],returnedCount:2,items:primitives};
 const view:any={view:{id:20},itemsComplete:true,truncated:false,unreadableCount:0,unreadableElementIds:[],cadGeometryRequested:true,
  cadGeometryComplete:true,returnedCount:1,totalOwnedCount:1,items:[{elementId:32,uniqueId:cad.uniqueId,ownerViewId:20,className:'ImportInstance',cadGeometry:cad}]};
 const nativeRead:any={schema:'revit-operator.view-owned-detailing/v1',scope:'exact_owner_view',viewsComplete:true,requestedViewIds:[20],views:[view]};
 const input={plan:typed,expectedPlanSha256:plan.nativePlanSha256,selectedIds:['line','cubic'],viewId:20,importElementId:32,importUniqueId:cad.uniqueId,nativeRead};
 return {input,view,cad,line:primitives[0] as any,cubic:primitives[1] as any};
}

test('complete source curves match but never imply full drawing, styles or native evidence authority',()=>{
 const {input}=fixture(),before=JSON.stringify(input),r=compare(input);
 assert.equal(r.geometryMatches,true);assert.equal(r.matchingSourceCount,2);assert.equal(r.unselectedSourceCount,1);
 assert.equal(r.wholeDrawingVerified,false);assert.equal(r.stylesVerified,false);assert.equal(r.nativeEvidenceAuthorityEstablished,false);
 assert.equal(r.scope,'selected_complete_source_curves_only');assert.equal(JSON.stringify(input),before);
});
test('retained native join-sized endpoint drift fails even when primitive counts and source IDs match',()=>{
 const f=fixture();f.line.geometry.end.y+=2.099605268e-6;
 const r=compare(f.input);assert.equal(r.geometryMatches,false);assert.match(r.issues.join(' '),/line coordinates differ/);
});
test('same cubic endpoints with changed inner controls fail',()=>{
 const f=fixture();f.cubic.geometry.controlPoints[1].y+=0.001;assert.equal(compare(f.input).geometryMatches,false);
});
test('geometrically equivalent reversed controls and affine knot domain remain supported',()=>{
 const f=fixture(),g=f.cubic.geometry;g.controlPoints.reverse();[g.start,g.end]=[g.end,g.start];
 g.knots=[10,10,10,10,14,14,14,14];g.startParameter=10;g.endParameter=14;g.rational=true;g.weights=[2,2,2,2];
 [f.line.geometry.start,f.line.geometry.end]=[f.line.geometry.end,f.line.geometry.start];
 assert.equal(compare(f.input).geometryMatches,true);
});
test('two-point native polyline can preserve a line; faceted cubic cannot pass',()=>{
 const f=fixture();f.cad.items[0]={kind:'PolyLine',layerName:'S0001',points:[f.line.geometry.start,f.line.geometry.end]};
 assert.equal(compare(f.input).geometryMatches,true);
 f.cad.items[1]={kind:'PolyLine',layerName:'S0002',points:f.cubic.geometry.controlPoints};assert.equal(compare(f.input).geometryMatches,false);
});

const malformed:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
 ['wrong owner view',f=>f.input.nativeRead.views[0].view.id=21],
 ['another requested view',f=>f.input.nativeRead.requestedViewIds=[21]],
 ['extra view',f=>f.input.nativeRead.views.push(structuredClone(f.view))],
 ['incomplete views',f=>f.input.nativeRead.viewsComplete=false],
 ['truncated inventory',f=>f.view.truncated=true],
 ['incomplete inventory',f=>f.view.itemsComplete=false],
 ['unreadable element',f=>{f.view.unreadableCount=1;f.view.unreadableElementIds=[31];}],
 ['missing CAD request',f=>f.view.cadGeometryRequested=false],
 ['incomplete CAD aggregate',f=>f.view.cadGeometryComplete=false],
 ['wrong total inventory',f=>f.view.totalOwnedCount=2],
 ['duplicate import identity',f=>{f.view.items.push(structuredClone(f.view.items[0]));f.view.totalOwnedCount=f.view.returnedCount=2;}],
 ['another import unique identity',f=>f.view.items[0].uniqueId='replacement-import'],
 ['another CAD owner',f=>f.cad.ownerViewId=21],
 ['another CAD identity',f=>f.cad.elementId=33],
 ['linked mutable file',f=>f.cad.isLinked=true],
 ['wrong coordinate space',f=>f.cad.coordinateSpace='symbol_coordinates'],
 ['incomplete geometry',f=>f.cad.complete=false],
 ['native issue',f=>f.cad.issues=['response_geometry_limit']],
 ['missing primitive',f=>{f.cad.items.pop();f.cad.returnedCount=1;}],
 ['extra primitive',f=>{f.cad.items.push(structuredClone(f.line));f.cad.returnedCount=3;}],
 ['false returned count',f=>f.cad.returnedCount=99],
 ['missing source layer',f=>delete f.line.layerName],
 ['duplicate source layer',f=>f.cubic.layerName='S0001'],
 ['nonfinite coordinate',f=>f.line.geometry.start.x=NaN],
 ['wrong degree',f=>f.cubic.geometry.degree=2],
 ['cyclic curve',f=>f.cubic.geometry.cyclic=true],
 ['missing controls',f=>f.cubic.geometry.controlPoints.pop()],
 ['nonconstant weights',f=>f.cubic.geometry.weights=[1,2,1,1]],
 ['missing weights',f=>delete f.cubic.geometry.weights],
 ['nonfinite weights',f=>f.cubic.geometry.weights=[Infinity,Infinity,Infinity,Infinity]],
 ['negative weights',f=>f.cubic.geometry.weights=[-1,-1,-1,-1]],
 ['nonunit nonrational weights',f=>f.cubic.geometry.weights=[2,2,2,2]],
 ['missing rational flag',f=>delete f.cubic.geometry.rational],
 ['trimmed native domain',f=>f.cubic.geometry.startParameter=0.25],
 ['unclamped knots',f=>f.cubic.geometry.knots[3]=0.1],
 ['missing knots',f=>delete f.cubic.geometry.knots],
 ['nonfinite knots',f=>f.cubic.geometry.knots[0]=NaN],
 ['false endpoint metadata',f=>f.cubic.geometry.end.x+=0.1],
 ['missing bounded endpoint',f=>delete f.cubic.geometry.start],
];
for(const [name,mutate] of malformed)test('rejects '+name,()=>{const f=fixture();mutate(f);assert.equal(compare(f.input).geometryMatches,false);});

test('source tampering cannot reuse an unchanged embedded plan hash',()=>{
 const f=fixture();f.input.plan.entities[0].points![0][0]+=0.01;assert.throws(()=>compare(f.input),/hash differs/);
});
test('invalid caller target identity never becomes a successful comparison',()=>{
 const f=fixture();for(const value of [0,-1,NaN])assert.throws(()=>compare({...f.input,importElementId:value}),/identity required/);
});
