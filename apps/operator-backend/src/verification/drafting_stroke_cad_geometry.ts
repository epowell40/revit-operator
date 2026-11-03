import {canonicalVectorJson,type VectorNativePlan} from '../pdf/drafting_vector_native_plan.js';
import {compileDraftingStrokeCad} from '../pdf/drafting_curve_cad.js';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const id=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
const round=(v:number)=>Number(v.toFixed(9));
const point=(v:unknown):number[]=>{const p=object(v);if(![p.x,p.y,p.z].every(finite))throw Error('Nonfinite/missing complete native coordinate.');return[p.x,p.y,p.z].map(round);};
function key(layer:string,kind:string,points:number[][]){
 const forward=canonicalVectorJson(points),backward=canonicalVectorJson([...points].reverse());
 return canonicalVectorJson({layer,kind,points:forward<backward?forward:backward});
}
function nativeKeys(value:unknown):string[]{
 const n=object(value),g=object(n.geometry),layer=n.layerName;
 if(typeof layer!=='string'||!layer.length)throw Error('Native source layer is missing.');
 if(n.kind==='PolyLine'){
  if(!Array.isArray(n.points)||n.points.length<2||n.points.length>1000)throw Error('Incomplete native polyline.');
  const points=n.points.map(point);
  return points.slice(1).map((p,i)=>key(layer,'line',[points[i],p])); // Exact native vertices only; no faceting or interpolation.
 }
 if(n.kind!=='Curve')throw Error('Unsupported native geometry kind.');
 if(g.kind==='Line')return[key(layer,'line',[point(g.start),point(g.end)])];
 if(g.kind!=='NurbSpline'||g.degree!==3||g.cyclic!==false||typeof g.rational!=='boolean'
  ||!Array.isArray(g.controlPoints)||g.controlPoints.length!==4)throw Error('Complete degree-three native cubic required.');
 const controls=g.controlPoints.map(point),start=point(g.start),end=point(g.end);
 if(canonicalVectorJson(start)!==canonicalVectorJson(controls[0])||canonicalVectorJson(end)!==canonicalVectorJson(controls[3]))throw Error('Native cubic bounded endpoints differ from controls.');
 if(!finite(g.startParameter)||!finite(g.endParameter)||!finite(g.endParameter-g.startParameter)||g.endParameter<=g.startParameter
  ||!Array.isArray(g.knots)||g.knots.length!==8||!g.knots.every(finite)
  ||g.knots.some((k:number,i:number)=>round((k-g.startParameter)/(g.endParameter-g.startParameter))!==(i<4?0:1)))throw Error('Native cubic knots/domain do not preserve the complete source span.');
 if(!Array.isArray(g.weights)||g.weights.length!==4||!g.weights.every((w:unknown)=>finite(w)&&w>0)
  ||g.weights.some((w:number)=>round(w/g.weights[0])!==1)||g.rational===false&&g.weights.some((w:number)=>round(w)!==1))throw Error('Native cubic weights differ or are incomplete.');
 return[key(layer,'cubic_bezier',controls)];
}

/** Pure complete-page comparison, not authority. Canonical assignment/native
 * attestations, original PDF reparse, styles, visuals and save/reopen stay separate. */
export function compareDraftingStrokeCadNativePages(input:{plan:VectorNativePlan;expectedPlanSha256:string;
 viewId:number;viewUniqueId?:string;importElementId:number;importUniqueId:string;nativeReads:unknown[]}){
 const expected=compileDraftingStrokeCad(input.plan,input.expectedPlanSha256),issues:string[]=[];
 if(!id(input.viewId)||!id(input.importElementId)||typeof input.importUniqueId!=='string'||!input.importUniqueId.trim())throw Error('Exact committed native import identity required.');
 if(!Array.isArray(input.nativeReads)||input.nativeReads.length<1||input.nativeReads.length>256)throw Error('One through256 complete native pages required.');
 let snapshot:string|null=null,total:number|null=null,cursor=0,terminal=false,primitiveCount=0;
 let readSchema:string|null=null;
 const observed=new Map<string,number>();
 for(const [index,raw] of input.nativeReads.entries()){
  try{
   if(terminal)throw Error('Extra page after terminal native coverage.');
   const n=object(raw),views=n.views,targetOnly=n.schema==='revit-operator.cad-geometry-target/v1';
   if(readSchema!==null&&readSchema!==n.schema)throw Error('Mixed native read scopes cannot form one complete geometry proof.');
   readSchema=n.schema;
   let item:Record<string,any>,wholeViewCadComplete:unknown;
   if(targetOnly){
    if(n.scope!=='exact_owner_view_cad_target'||n.read_only!==true||n.wholeViewInventoryRead!==false||n.targetReadComplete!==true
     ||n.requestedViewId!==input.viewId||n.requestedCadElementId!==input.importElementId
     ||typeof input.viewUniqueId!=='string'||!input.viewUniqueId.trim()||object(n.view).uniqueId!==input.viewUniqueId
     ||object(n.view).id!==input.viewId||object(n.view).viewType!=='DraftingView'||object(n.view).scale!==expected.viewScale)
     throw Error('Exact native CAD-target scope, owner UniqueId and complete page required.');
    item=object(n.target);
   }else{
    if(n.schema!=='revit-operator.view-owned-detailing/v1'||n.scope!=='exact_owner_view'||n.viewsComplete!==true
    ||!Array.isArray(n.requestedViewIds)||n.requestedViewIds.length!==1||n.requestedViewIds[0]!==input.viewId
    ||!Array.isArray(views)||views.length!==1)throw Error('Exact complete native owner-view inventory required.');
    const v=object(views[0]),items=v.items;
    if(object(v.view).id!==input.viewId||object(v.view).viewType!=='DraftingView'||object(v.view).scale!==expected.viewScale
    ||v.requestedCadElementId!==input.importElementId||v.itemsComplete!==true||v.truncated!==false
    ||v.unreadableCount!==0||!Array.isArray(v.unreadableElementIds)||v.unreadableElementIds.length||v.cadGeometryRequested!==true
    ||v.cadGeometryPageComplete!==true||!Array.isArray(items)||v.returnedCount!==items.length||v.totalOwnedCount!==items.length)
    throw Error('Native page inventory, target or completeness differs.');
    const imports=items.filter(i=>object(i).elementId===input.importElementId);
    if(imports.length!==1)throw Error('Exact native CAD import is missing or duplicated.');
    item=object(imports[0]);wholeViewCadComplete=v.cadGeometryComplete;
   }
   const cad=object(item.cadGeometry),page=object(cad.page);
   if(item.elementId!==input.importElementId||item.className!=='ImportInstance'||item.uniqueId!==input.importUniqueId||item.ownerViewId!==input.viewId
    ||cad.schema!=='revit-operator.cad-geometry/v1'||cad.elementId!==input.importElementId||cad.uniqueId!==input.importUniqueId
    ||cad.ownerViewId!==input.viewId||cad.isLinked!==false||cad.coordinateSpace!=='host_model_feet'||!Array.isArray(cad.issues)||cad.issues.length
    ||page.schema!=='revit-operator.cad-geometry-page/v1'||page.complete!==true||page.offset!==cursor
    ||!Number.isSafeInteger(page.totalPrimitiveCount)||page.totalPrimitiveCount<1||page.totalPrimitiveCount>20000
    ||typeof page.completeGeometrySnapshotSha256!=='string'||!/^[a-f0-9]{64}$/.test(page.completeGeometrySnapshotSha256))
    throw Error('Native page/import identity, snapshot or contiguous offset differs.');
   if(!Array.isArray(cad.items)||cad.items.length<1||cad.items.length>1000||cad.returnedCount!==cad.items.length)throw Error('Native page has incomplete/empty whole records.');
   if(snapshot!==null&&(snapshot!==page.completeGeometrySnapshotSha256||total!==page.totalPrimitiveCount))throw Error('Native geometry changed between pages.');
   snapshot=page.completeGeometrySnapshotSha256;total=page.totalPrimitiveCount;
   const next=cursor+cad.items.length;
   if(next>total!||page.nextOffset!==(next===total?null:next)||cad.complete!==(cursor===0&&next===total)
    ||!targetOnly&&wholeViewCadComplete!==cad.complete)throw Error('Native page coverage/next offset or whole-geometry assertion differs.');
   for(const primitive of cad.items)for(const k of nativeKeys(primitive))observed.set(k,(observed.get(k)??0)+1);
   primitiveCount+=cad.items.length;cursor=next;terminal=next===total;
  }catch(error){issues.push('Page '+index+': '+(error instanceof Error?error.message:String(error)));break;}
 }
 if(!terminal)issues.push('Complete native page coverage was not established.');
 let matched=0;
 for(const source of expected.selection){
  const k=key(source.layer,source.kind,source.points.map(p=>p.map(round))),count=observed.get(k)??0;
  if(count){observed.set(k,count-1);matched++;}
 }
 const unexpected=Array.from(observed.values()).reduce((a,b)=>a+b,0);
 if(matched!==expected.selection.length||unexpected)issues.push('Complete source/native curve multiset differs; missing='+String(expected.selection.length-matched)+', unexpected='+String(unexpected)+'.');
 return {schema:'operator.drafting-stroke-cad-geometry-comparison.v1' as const,geometryMatches:issues.length===0,
  nativePlanSha256:expected.nativePlanSha256,expectedDxfSha256:expected.dxfSha256,completeNativeGeometrySnapshotSha256:snapshot,
  sourceCurveCount:expected.selection.length,matchingSourceCurveCount:matched,nativePrimitiveCount:primitiveCount,
  completePages:terminal&&issues.length===0,remainingEntityCount:expected.remainingEntityIds.length,issues,
  wholeDrawingVerified:false as const,stylesVerified:false as const,nativeEvidenceAuthorityEstablished:false as const};
}
