import {compileDraftingCurveCad} from '../pdf/drafting_curve_cad.js';
import type {VectorNativePlan} from '../pdf/drafting_vector_native_plan.js';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const id=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
const xyz=(v:unknown):number[]|null=>{const p=object(v);return [p.x,p.y,p.z].every(finite)?[p.x,p.y,p.z]:null;};
const rounded=(v:number)=>Number(v.toFixed(9));
const samePoint=(a:number[]|null,b:number[]|null)=>!!a&&!!b&&a.length===3&&b.length===3&&a.every((v,i)=>rounded(v)===rounded(b[i]));
const samePoints=(a:Array<number[]|null>,b:number[][])=>a.length===b.length&&a.every((p,i)=>samePoint(p,b[i]));
const sameLocus=(a:Array<number[]|null>,b:number[][])=>samePoints(a,b)||samePoints(a,[...b].reverse());

/** Geometry comparison only. The assignment verifier must separately establish fresh
 * native evidence, committed scope, source custody and visual/style proof. Raw caller
 * JSON or this return value is never an authority/attestation or whole-drawing pass. */
export function compareDraftingCurveCadNativeGeometry(input:{
 plan:VectorNativePlan;expectedPlanSha256:string;selectedIds:string[];
 viewId:number;importElementId:number;importUniqueId:string;nativeRead:unknown;
}) {
 const expected=compileDraftingCurveCad(input.plan,input.expectedPlanSha256,input.selectedIds);
 const issues:string[]=[],reports:Array<{entityId:string;layer:string;matches:boolean;issues:string[]}>=[];
 const n=object(input.nativeRead),views=n.views;
 if(!id(input.viewId)||!id(input.importElementId)||typeof input.importUniqueId!=='string'||!input.importUniqueId.trim())
  throw Error('Exact native owner view and committed CAD identity required.');
 if(n.schema!=='revit-operator.view-owned-detailing/v1'||n.scope!=='exact_owner_view'||n.viewsComplete!==true
  ||!Array.isArray(n.requestedViewIds)||n.requestedViewIds.length!==1||n.requestedViewIds[0]!==input.viewId
  ||!Array.isArray(views)||views.length!==1||object(object(views[0]).view).id!==input.viewId)
  issues.push('Exact complete requested owner-view inventory is required.');
 const view=object(Array.isArray(views)&&views.length===1?views[0]:null),items=view.items;
 if(view.itemsComplete!==true||view.truncated!==false||view.unreadableCount!==0
  ||!Array.isArray(view.unreadableElementIds)||view.unreadableElementIds.length!==0
  ||view.cadGeometryRequested!==true||view.cadGeometryComplete!==true||!Array.isArray(items)
  ||view.returnedCount!==items?.length||view.totalOwnedCount!==items?.length)
  issues.push('Owner-view read is incomplete, unreadable or did not request complete CAD geometry.');
 const matches=Array.isArray(items)?items.filter(i=>object(i).elementId===input.importElementId):[];
 const item=object(matches.length===1?matches[0]:null),cad=object(item.cadGeometry);
 if(matches.length!==1||item.className!=='ImportInstance'||item.uniqueId!==input.importUniqueId||item.ownerViewId!==input.viewId
  ||cad.schema!=='revit-operator.cad-geometry/v1'||cad.elementId!==input.importElementId||cad.uniqueId!==input.importUniqueId
  ||cad.ownerViewId!==input.viewId||cad.coordinateSpace!=='host_model_feet'||cad.isLinked!==false)
  issues.push('CAD geometry does not belong to the exact committed import in the requested view.');
 const primitives=Array.isArray(cad.items)?cad.items:[];
 if(cad.complete!==true||!Array.isArray(cad.issues)||cad.issues.length||cad.returnedCount!==primitives.length)
  issues.push('Native CAD geometry is incomplete or has unresolved read issues.');
 if(primitives.length!==expected.selection.length)issues.push('Complete native/source primitive counts differ.');
 for(const source of expected.selection){
  const candidates=primitives.filter(p=>object(p).layerName===source.layer),reasons:string[]=[];
  if(candidates.length!==1)reasons.push('Expected exactly one primitive on the source layer.');
  else{
   const native=object(candidates[0]),g=object(native.geometry);
   if(source.kind==='line'){
    const points=native.kind==='Curve'&&g.kind==='Line'?[xyz(g.start),xyz(g.end)]
     :native.kind==='PolyLine'&&Array.isArray(native.points)&&native.points.length===2?native.points.map(xyz):[];
    if(!sameLocus(points,source.points))reasons.push('Complete line coordinates differ at nine decimals or representation is unsupported.');
   }else{
    const controls=Array.isArray(g.controlPoints)?g.controlPoints.map(xyz):[],knots=g.knots,weights=g.weights;
    if(native.kind!=='Curve'||g.kind!=='NurbSpline'||g.degree!==3||g.cyclic!==false||controls.length!==4
     ||!sameLocus(controls,source.points))reasons.push('Complete degree-three cubic controls differ at nine decimals; faceting is not source fidelity.');
    if(!samePoint(xyz(g.start),controls[0])||!samePoint(xyz(g.end),controls[3]))reasons.push('Native bounded endpoints do not match the complete cubic controls.');
    const start=g.startParameter,end=g.endParameter;
    if(!finite(start)||!finite(end)||!finite(end-start)||end<=start||!Array.isArray(knots)||knots.length!==8
     ||!knots.every(finite)||knots.some((k:number,i:number)=>((k-start)/(end-start)).toFixed(9)!==(i<4?0:1).toFixed(9)))
     reasons.push('Complete clamped cubic knots/domain differ.');
    if(typeof g.rational!=='boolean'||!Array.isArray(weights)||weights.length!==4||!weights.every((w:unknown)=>finite(w)&&w>0)
     ||weights.some((w:number)=>(w/weights[0]).toFixed(9)!=='1.000000000')
     ||g.rational===false&&weights.some((w:number)=>w.toFixed(9)!=='1.000000000'))
     reasons.push('Missing or nonconstant cubic weights change or fail to establish the source geometry.');
   }
  }
  reports.push({entityId:source.entityId,layer:source.layer,matches:reasons.length===0,issues:reasons});
  issues.push(...reasons.map(reason=>source.entityId+': '+reason));
 }
 return {schema:'operator.drafting-curve-cad-geometry-comparison.v1' as const,geometryMatches:issues.length===0,
  nativePlanSha256:expected.nativePlanSha256,expectedDxfSha256:expected.dxfSha256,
  viewId:input.viewId,importElementId:input.importElementId,importUniqueId:input.importUniqueId,
  selectedSourceCount:expected.selection.length,unselectedSourceCount:expected.unselectedEntityCount,
  nativePrimitiveCount:primitives.length,matchingSourceCount:reports.filter(r=>r.matches).length,reports,issues,
  scope:'selected_complete_source_curves_only' as const,wholeDrawingVerified:false as const,stylesVerified:false as const,
  nativeEvidenceAuthorityEstablished:false as const};
}
