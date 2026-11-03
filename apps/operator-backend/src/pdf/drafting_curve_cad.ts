import crypto from "node:crypto";
import { DxfWriter, Units, SplineFlags, point3d, TrueColor } from "@tarikjabiri/dxf";
import { canonicalVectorJson, type VectorNativePlan } from "./drafting_vector_native_plan.js";

const sha = (data:string) => crypto.createHash("sha256").update(data).digest("hex");

/** Bounded experimental curve artifact. This is neither a complete drawing nor model-write authority. */
function requireOriginalPlan(plan:VectorNativePlan, expectedPlanSha256:string) {
  const {nativePlanSha256,...unsigned} = plan;
  if (!/^[a-f0-9]{64}$/.test(expectedPlanSha256) || nativePlanSha256 !== expectedPlanSha256
      || sha(canonicalVectorJson(unsigned)) !== expectedPlanSha256)
    throw Error("Original native plan hash differs; no CAD artifact emitted.");
  if (plan.schema !== "operator.drafting_vector_native_plan.v1" || plan.nativeWriteAllowed !== false
      || plan.coordinateSpace !== "paper inches, right/up, lower-left of selected source region")
    throw Error("Unsupported source plan contract.");
  if (!Number.isFinite(plan.layout.viewScale) || plan.layout.viewScale <= 0
      || plan.entities.length < 1 || plan.entities.length > 100000)
    throw Error("Invalid source scale or inventory.");
  if (new Set(plan.entities.map(e=>e.id)).size !== plan.entities.length) throw Error("Duplicate source identities.");
}
export function compileDraftingCurveCad(plan:VectorNativePlan, expectedPlanSha256:string, selectedIds:string[]) {
  requireOriginalPlan(plan,expectedPlanSha256);
  const {nativePlanSha256}=plan;
  if (selectedIds.length < 1 || selectedIds.length > 64 || new Set(selectedIds).size !== selectedIds.length)
    throw Error("Select 1..64 distinct complete source curves explicitly.");
  const scale = plan.layout.viewScale/12;
  const selection = selectedIds.map((id,index)=> {
    const entity = plan.entities.find(e=>e.id===id);
    if (!entity || !["line","cubic_bezier"].includes(entity.kind))
      throw Error("Selected source entity is absent or is not a supported complete curve: "+id);
    const expected = entity.kind === "line" ? 2 : 4;
    if (!entity.points || entity.points.length !== expected
        || entity.points.some(p=>p.length!==2 || p.some(n=>!Number.isFinite(n))))
      throw Error("Invalid complete source curve coordinates: "+id);
    if (entity.style?.dashInches.length || entity.style?.dashPhaseInches)
      throw Error("Dashed source traversal requires explicit CAD support; no solid substitute emitted: "+id);
    const points=entity.points.map(([x,y])=>[x*scale,y*scale,0]);
    if (points.some(p=>p.some(n=>!Number.isFinite(n)))) throw Error("Host-coordinate overflow: "+id);
    return {entityId:id,sourceId:entity.sourceId,kind:entity.kind,layer:"S"+String(index+1).padStart(4,"0"),
      points,sourceStyle:entity.style};
  });
  // Complete model-space/block/table/owner structure is required by the native
  // importer. This synchronous scope does not interleave mutable writer handles.
  const writer = new DxfWriter();
  writer.setUnits(Units.Feet);
  for (const item of selection) {
    writer.addLayer(item.layer,7,"Continuous");
    const points=item.points.map(([x,y,z])=>point3d(x,y,z));
    const options={layerName:item.layer};
    if (item.kind === "line") {
      writer.addLine(points[0],points[1],options);
    } else {
      writer.addSpline({controlPoints:points,degreeCurve:3,knots:[0,0,0,0,1,1,1,1],flags:SplineFlags.Planar},options);
    }
  }
  const dxf = writer.stringify();
  return {schema:"operator.drafting_curve_cad.v1" as const,sourceSha256:plan.sourceSha256,
    nativePlanSha256,sourceLabel:plan.sourceLabel,sourceSheet:plan.sourceSheet,page:plan.page,region:plan.region,
    coordinateSpace:"host_model_feet" as const,importUnit:"Foot" as const,viewScale:plan.layout.viewScale,
    dxf,dxfSha256:sha(dxf),writer:"@tarikjabiri/dxf",selection,unselectedEntityCount:plan.entities.length-selection.length,
    wholeDrawing:false as const,nativeWriteAllowed:false as const,
    limits:["Explicit source curve selection only; fills, text and other unselected records are not delivered.",
      "Original source styles are retained in the manifest, not yet rendered or visually qualified by this experimental geometry-only CAD artifact.",
      "No model edit or verification is authorized by this artifact; compare fresh complete native geometry and actual source/model visuals."]};
}

/** All retained strokes, grouped only by their complete source pen/color. Fills,
 * dots and editable text remain explicit separate work, never a whole-detail pass. */
export function compileDraftingStrokeCad(plan:VectorNativePlan, expectedPlanSha256:string) {
  requireOriginalPlan(plan,expectedPlanSha256);
  const strokes=plan.entities.filter(e=>e.kind==='line'||e.kind==='cubic_bezier');
  if(!strokes.length||strokes.length>20000)throw Error('Complete source stroke inventory must contain1..20000 curves.');
  const writer=new DxfWriter();writer.setUnits(Units.Feet);
  const layerStyles:Array<{layer:string;color:number[];weight:number;dashInches:number[];dashPhaseInches:number}>=[];
  const layers=new Map<string,string>(),scale=plan.layout.viewScale/12;
  const selection=strokes.map(e=>{
    const style=e.style;
    if(!style||!Array.isArray(style.color)||style.color.length!==3||!style.color.every(c=>Number.isInteger(c)&&c>=0&&c<=255)
      ||!Number.isInteger(style.weight)||style.weight<1||style.weight>16||!Array.isArray(style.dashInches)
      ||style.dashInches.length||style.dashPhaseInches!==0)
      throw Error('Complete source solid pen/color required; unsupported stroke style was not substituted: '+e.id);
    const expected=e.kind==='line'?2:4;
    if(!e.points||e.points.length!==expected||e.points.some(p=>p.length!==2||p.some(n=>!Number.isFinite(n))))
      throw Error('Complete source curve coordinates required: '+e.id);
    const points=e.points.map(([x,y])=>[x*scale,y*scale,0]);
    if(points.some(p=>p.some(n=>!Number.isFinite(n))))throw Error('Host-coordinate overflow: '+e.id);
    const key=canonicalVectorJson({color:style.color,weight:style.weight});let layer=layers.get(key);
    if(!layer){
      layer='P'+String(layers.size+1).padStart(4,'0');layers.set(key,layer);
      const nativeLayer=writer.addLayer(layer,7,'Continuous');nativeLayer.trueColor=TrueColor.fromRGB(style.color[0],style.color[1],style.color[2]);
      layerStyles.push({layer,color:[...style.color],weight:style.weight,dashInches:[],dashPhaseInches:0});
    }
    const xyz=points.map(([x,y,z])=>point3d(x,y,z)),options={layerName:layer};
    if(e.kind==='line')writer.addLine(xyz[0],xyz[1],options);
    else writer.addSpline({controlPoints:xyz,degreeCurve:3,knots:[0,0,0,0,1,1,1,1],flags:SplineFlags.Planar},options);
    return {entityId:e.id,sourceId:e.sourceId,kind:e.kind,layer,points};
  });
  const dxf=writer.stringify();
  return {schema:'operator.drafting_stroke_cad.v1' as const,sourceSha256:plan.sourceSha256,nativePlanSha256:plan.nativePlanSha256,
    sourceLabel:plan.sourceLabel,sourceSheet:plan.sourceSheet,page:plan.page,region:plan.region,coordinateSpace:'host_model_feet' as const,
    importUnit:'Foot' as const,viewScale:plan.layout.viewScale,dxf,dxfSha256:sha(dxf),writer:'@tarikjabiri/dxf',selection,layerStyles,
    remainingEntityIds:plan.entities.filter(e=>e.kind!=='line'&&e.kind!=='cubic_bezier').map(e=>e.id),
    wholeDrawing:false as const,nativeWriteAllowed:false as const,stylesVerified:false as const,
    limits:['All source strokes are retained; text/fills/dots require separate source-bound creation and verification.',
      'Source colors are encoded; apply and freshly inspect the explicit per-layer Revit pen overrides. CAD import alone is not style verification.',
      'Complete native geometry pages must cover the same full native snapshot before source comparison. Visual review and save/reopen are separate.']};
}
