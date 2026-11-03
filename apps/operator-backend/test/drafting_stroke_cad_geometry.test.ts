import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalVectorJson,type VectorNativePlan} from '../src/pdf/drafting_vector_native_plan.js';
import {compileDraftingStrokeCad as compile} from '../src/pdf/drafting_curve_cad.js';
import {compareDraftingStrokeCadNativePages as compare} from '../src/verification/drafting_stroke_cad_geometry.js';

function plan():VectorNativePlan{
 const p:any={schema:'operator.drafting_vector_native_plan.v1',sourceSha256:'a'.repeat(64),sourcePlanSha256:'b'.repeat(64),selectionSha256:'c'.repeat(64),
  sourceLabel:'diagram.pdf',sourceSheet:'M501',page:1,region:[0,0,100,100],coordinateSpace:'paper inches, right/up, lower-left of selected source region',
  layout:{paperWidthInches:10,viewScale:100,partSize:50},paperHeightInches:10,
  entities:[...Array.from({length:5},(_,i)=>({id:'line-'+i,sourceId:'source-'+i,kind:'line',points:[[i,0],[i+0.5,0.12345678]],
   style:{color:i===4?[255,0,0]:[0,0,0],weight:i%2+1,sourceWidthPoints:0.24,dashInches:[],dashPhaseInches:0}})),
   {id:'cubic',sourceId:'source-cubic',kind:'cubic_bezier',points:[[0,0],[1,2],[2,2],[3,0]],style:{color:[0,0,0],weight:1,sourceWidthPoints:0.24,dashInches:[],dashPhaseInches:0}},
   {id:'text',sourceId:'text',kind:'text',text:'FULL TEXT REQUIRED'},{id:'fill',sourceId:'fill',kind:'fill'},{id:'dot',sourceId:'dot',kind:'dot'}],
  partCount:1,zeroLengthSourceCommands:0,omissions:[],limits:[],nativeWriteAllowed:false};
 p.nativePlanSha256=createHash('sha256').update(canonicalVectorJson(p)).digest('hex');return p;
}
function fixture(pageSize=2){
 const p=plan(),a=compile(p,p.nativePlanSha256),point=([x,y,z]:number[])=>({x,y,z});
 const all:any[]=a.selection.map(s=>({layerName:s.layer,kind:'Curve',geometry:s.kind==='line'
  ?{kind:'Line',start:point(s.points[0]),end:point(s.points[1])}
  :{kind:'NurbSpline',degree:3,cyclic:false,rational:false,start:point(s.points[0]),end:point(s.points[3]),controlPoints:s.points.map(point),
   knots:[0,0,0,0,1,1,1,1],weights:[1,1,1,1],startParameter:0,endParameter:1}}));
 const nativeReads:any[]=Array.from({length:Math.ceil(all.length/pageSize)},(_,i)=>{
  const offset=i*pageSize,items=all.slice(offset,offset+pageSize),next=offset+items.length===all.length?null:offset+items.length,complete=offset===0&&next===null;
  return {schema:'revit-operator.view-owned-detailing/v1',scope:'exact_owner_view',viewsComplete:true,requestedViewIds:[20],views:[{
   view:{id:20,viewType:'DraftingView',scale:100},requestedCadElementId:32,itemsComplete:true,truncated:false,unreadableCount:0,unreadableElementIds:[],
   cadGeometryRequested:true,cadGeometryPageComplete:true,cadGeometryComplete:complete,returnedCount:1,totalOwnedCount:1,
   items:[{elementId:32,uniqueId:'import-32',ownerViewId:20,className:'ImportInstance',cadGeometry:{schema:'revit-operator.cad-geometry/v1',
    elementId:32,uniqueId:'import-32',ownerViewId:20,isLinked:false,coordinateSpace:'host_model_feet',issues:[],returnedCount:items.length,items,complete,
    page:{schema:'revit-operator.cad-geometry-page/v1',offset,totalPrimitiveCount:all.length,nextOffset:next,complete:true,completeGeometrySnapshotSha256:'d'.repeat(64)}}}]}]};
 });
 return {p,a,all,input:{plan:p,expectedPlanSha256:p.nativePlanSha256,viewId:20,importElementId:32,importUniqueId:'import-32',nativeReads},
  cad:(index:number)=>nativeReads[index].views[0].items[0].cadGeometry};
}
test('whole stroke producer retains every stroke, three style layers and all remaining nonstroke IDs',()=>{
 const p=plan(),before=canonicalVectorJson(p),a=compile(p,p.nativePlanSha256);
 assert.equal(a.selection.length,6);assert.equal(a.layerStyles.length,3);assert.deepEqual(a.remainingEntityIds,['text','fill','dot']);
 assert.equal(a.selection[0].layer,a.selection[2].layer);assert.notEqual(a.selection[0].layer,a.selection[1].layer);
 assert(a.dxf.includes('16711680'));assert.equal(a.wholeDrawing,false);assert.equal(a.nativeWriteAllowed,false);assert.equal(a.stylesVerified,false);
 assert.equal(canonicalVectorJson(p),before);assert.equal(compile(p,p.nativePlanSha256).dxfSha256,a.dxfSha256);
});
test('all contiguous native pages match complete source curves but cannot claim styles, authority or remaining text/fills',()=>{
 const f=fixture(),r=compare(f.input);assert.equal(r.geometryMatches,true);assert.equal(r.completePages,true);assert.equal(r.sourceCurveCount,6);
 assert.equal(r.matchingSourceCurveCount,6);assert.equal(r.remainingEntityCount,3);assert.equal(r.wholeDrawingVerified,false);
 assert.equal(r.stylesVerified,false);assert.equal(r.nativeEvidenceAuthorityEstablished,false);assert.equal(compare(fixture(6).input).geometryMatches,true);
});

function scopedFixture(){
 const f=fixture();
 const input={...f.input,viewUniqueId:'view-20',nativeReads:f.input.nativeReads.map((r:any)=>({
  schema:'revit-operator.cad-geometry-target/v1',scope:'exact_owner_view_cad_target',read_only:true,wholeViewInventoryRead:false,
  requestedViewId:20,requestedCadElementId:32,view:{id:20,uniqueId:'view-20',viewType:'DraftingView',scale:100},targetReadComplete:true,
  target:structuredClone(r.views[0].items[0])}))};
 return{...f,input,cad:(i:number)=>input.nativeReads[i].target.cadGeometry};
}
test('explicit complete CAD target pages coexist with unrelated annotation and sketch inventories without asserting their completeness',()=>{
 const f=fixture();
 f.input.nativeReads[0].viewsComplete=false;Object.assign(f.input.nativeReads[0].views[0],{totalOwnedCount:560,returnedCount:500,truncated:true,itemsComplete:false,incompleteSignatureCount:189});
 assert.equal(compare(f.input).geometryMatches,false,'An incomplete whole-view receipt must remain rejected.');
 const scoped=scopedFixture(),result=compare(scoped.input);
 assert.equal(result.geometryMatches,true);assert.equal(result.matchingSourceCurveCount,6);
 assert.equal(result.remainingEntityCount,3);assert.equal(result.wholeDrawingVerified,false);assert.equal(result.nativeEvidenceAuthorityEstablished,false);
});
const targetMutations:Array<[string,(f:ReturnType<typeof scopedFixture>)=>void]>=[
 ['missing page',f=>f.input.nativeReads.pop()],['reordered pages',f=>f.input.nativeReads.reverse()],
 ['changed snapshot',f=>f.cad(1).page.completeGeometrySnapshotSha256='e'.repeat(64)],
 ['skipped offset',f=>f.cad(1).page.offset++],['false next offset',f=>f.cad(0).page.nextOffset++],
 ['incomplete target',f=>f.input.nativeReads[0].targetReadComplete=false],
 ['incomplete page',f=>f.cad(1).page.complete=false],['native issue',f=>f.cad(1).issues=['traversal_limit']],
 ['wrong view UniqueId',f=>f.input.nativeReads[0].view.uniqueId='other-view'],
 ['missing expected view UniqueId',f=>delete (f.input as any).viewUniqueId],
 ['wrong native owner',f=>f.cad(0).ownerViewId=21],['wrong import UniqueId',f=>f.cad(0).uniqueId='other-import'],
 ['wrong requested target',f=>f.input.nativeReads[0].requestedCadElementId=33],
 ['whole-view assertion on target projection',f=>f.input.nativeReads[0].wholeViewInventoryRead=true],
 ['read scope substitution',f=>f.input.nativeReads[0].scope='exact_owner_view'],
 ['changed endpoint',f=>f.cad(0).items[0].geometry.end.y+=2.099605268e-6],
 ['changed cubic control',f=>f.cad(2).items[1].geometry.controlPoints[1].y+=0.001],
 ['changed cubic knots',f=>f.cad(2).items[1].geometry.knots[4]=0.5],
 ['mixed read scopes',f=>{f.input.nativeReads[1]=fixture().input.nativeReads[1] as any;}]
];
for(const [name,mutate]of targetMutations)test('CAD-target source comparison rejects '+name,()=>{const f=scopedFixture();mutate(f);assert.equal(compare(f.input).geometryMatches,false);});
test('native primitive order within a page is irrelevant; complete source multiset and counts remain exact',()=>{
 const f=fixture();f.cad(0).items.reverse();assert.equal(compare(f.input).geometryMatches,true);
});
test('exact native polyline vertices can represent several source lines without facet substitution for cubics',()=>{
 const f=fixture(6),first=f.all[0],second=f.all[1];
 // Construct a valid native polyline for one source line; do not invent source corner vertices.
 f.cad(0).items[0]={kind:'PolyLine',layerName:first.layerName,points:[first.geometry.start,first.geometry.end]};
 assert.equal(compare(f.input).geometryMatches,true);
 const cubic=f.cad(0).items[5];f.cad(0).items[5]={kind:'PolyLine',layerName:cubic.layerName,points:cubic.geometry.controlPoints};
 assert.equal(compare(f.input).geometryMatches,false);assert(second);
});
const mutations:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
 ['missing last page',f=>f.input.nativeReads.pop()],['duplicate page',f=>f.input.nativeReads[1]=structuredClone(f.input.nativeReads[0])],
 ['out of order pages',f=>f.input.nativeReads.reverse()],['extra terminal page',f=>f.input.nativeReads.push(structuredClone(f.input.nativeReads[2]))],
 ['changed snapshot',f=>f.cad(1).page.completeGeometrySnapshotSha256='e'.repeat(64)],
 ['changed total count',f=>f.cad(1).page.totalPrimitiveCount++],['skipped offset',f=>f.cad(1).page.offset++],
 ['false next offset',f=>f.cad(0).page.nextOffset++],['partial page marked whole',f=>f.cad(0).complete=true],
 ['incomplete page',f=>f.cad(1).page.complete=false],['native issue',f=>f.cad(1).issues=['traversal_limit']],
 ['wrong import',f=>f.cad(0).uniqueId='another-import'],['wrong target',f=>f.input.nativeReads[0].views[0].requestedCadElementId=33],
 ['wrong scale',f=>f.input.nativeReads[0].views[0].view.scale=50],['wrong owner view',f=>f.cad(0).ownerViewId=21],
 ['changed endpoint',f=>f.cad(0).items[0].geometry.end.y+=2.099605268e-6],
 ['changed layer',f=>f.cad(0).items[0].layerName='P0999'],
 ['changed cubic control',f=>f.cad(2).items[1].geometry.controlPoints[1].y+=0.001],
 ['trimmed cubic',f=>f.cad(2).items[1].geometry.endParameter=0.5],
 ['weighted cubic',f=>f.cad(2).items[1].geometry.weights=[1,2,1,1]],
 ['unreadable inventory',f=>f.input.nativeReads[0].views[0].unreadableCount=1],
 ['incomplete view inventory',f=>f.input.nativeReads[0].views[0].itemsComplete=false],
 ['empty page',f=>{f.cad(0).items=[];f.cad(0).returnedCount=0;}],
 ['missing whole snapshot',f=>delete f.cad(0).page.completeGeometrySnapshotSha256],
];
for(const [name,mutate] of mutations)test('complete source comparison rejects '+name,()=>{const f=fixture();mutate(f);assert.equal(compare(f.input).geometryMatches,false);});
test('changed source cannot retain its embedded hash',()=>{const p=plan();p.entities[0].points![1][0]++;assert.throws(()=>compile(p,p.nativePlanSha256),/hash differs/);});
test('unsupported dashed stroke cannot be silently rendered solid',()=>{
 const p=plan();p.entities[0].style!.dashInches=[0.1,0.1];const{nativePlanSha256,...unsigned}=p;
 p.nativePlanSha256=createHash('sha256').update(canonicalVectorJson(unsigned)).digest('hex');assert.throws(()=>compile(p,p.nativePlanSha256),/unsupported stroke style/);
});
