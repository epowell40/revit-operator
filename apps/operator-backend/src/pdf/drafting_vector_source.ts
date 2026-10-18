import crypto from "node:crypto";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "./pdfjs_node.js";

export type PaperPoint = [number, number];
export type PaperRegion = [number, number, number, number];
type Matrix = [number, number, number, number, number, number];
export type VectorBounds = { min: PaperPoint; max: PaperPoint };
export type VectorSegment =
  | { kind: "line" | "close"; start: PaperPoint; end: PaperPoint }
  | { kind: "cubic_bezier"; start: PaperPoint; controlPoints: [PaperPoint, PaperPoint]; end: PaperPoint };
type PathCommand = VectorSegment | { kind: "move"; point: PaperPoint };
type GraphicsState = {
  matrix: Matrix; lineWidth: number; strokeRgb: number[]; fillRgb: number[];
  dash: number[]; dashPhase: number; lineCap: number; lineJoin: number; clipIds: string[];
};
export type DraftingVectorContour = {
  id: string; commands: PathCommand[]; conservativeBounds: VectorBounds;
  intersectsRegion: boolean; crossesRegion: boolean;
};
export type DraftingVectorPath = {
  id: string; operatorIndex: number; contours: DraftingVectorContour[];
  paint: { stroke: boolean; fill: boolean; evenOdd: boolean };
  style: GraphicsState; conservativeBounds: VectorBounds;
};
export type DraftingVectorText = {
  id: string; sequenceIndex: number; text: string; baselineTransform: Matrix;
  paperWidthPoints: number; paperHeightPoints: number; fontName: string | null;
  fontFamily: string | null; ascent: number; descent: number; conservativeBounds: VectorBounds;
  crossesRegion: boolean;
};
export type DraftingVectorSource = {
  schema: "operator.drafting_vector_source.v1";
  sourceSha256: string; page: number; sourceLabel: string; sourceSheet: string | null;
  coordinateSpace: "top-origin rotated PDF paper points";
  pageWidthPoints: number; pageHeightPoints: number; region: PaperRegion;
  operatorCount: number; paths: DraftingVectorPath[]; text: DraftingVectorText[];
  clips: Array<{ id: string; evenOdd: boolean; contours: DraftingVectorContour[] }>;
  unsupported: Array<{ operatorIndex: number; operator: string; bounds: VectorBounds | null; intersectsRegion: boolean }>;
  conversionRequirements: string[]; sourceReadTruncated: false; nativeWriteAllowed: false;
  planSha256: string;
};
export type DraftingVectorSourceInput = {
  expectedSourceSha256: string; page: number; region: PaperRegion;
  sourceLabel: string; sourceSheet?: string;
};

const hash = (value: string | Uint8Array) => crypto.createHash("sha256").update(value).digest("hex");
const digest = (plan: Omit<DraftingVectorSource, "planSha256">) => hash(JSON.stringify(plan));
const finite = (n: number) => typeof n === "number" && Number.isFinite(n);
const multiply = (a: Matrix, b: Matrix): Matrix => [
  a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3],
  a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]
];
const transform = (m: Matrix, x: number, y: number): PaperPoint => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
const bounds = (points: PaperPoint[]): VectorBounds => {
  if(!points.length)throw Error("Cannot bound empty PDF geometry");
  const result:VectorBounds={min:[Infinity,Infinity],max:[-Infinity,-Infinity]};
  for(const p of points){if(!p.every(finite))throw Error("Nonfinite transformed PDF geometry");for(let i=0;i<2;i++){result.min[i]=Math.min(result.min[i],p[i]);result.max[i]=Math.max(result.max[i],p[i]);}}
  return result;
};
const overlaps = (b: VectorBounds, r: PaperRegion) => b.min[0]<=r[2] && b.max[0]>=r[0] && b.min[1]<=r[3] && b.max[1]>=r[1];
const inside = (b: VectorBounds, r: PaperRegion) => b.min[0]>=r[0] && b.max[0]<=r[2] && b.min[1]>=r[1] && b.max[1]<=r[3];
const commandPoints = (c: PathCommand): PaperPoint[] => c.kind === "move" ? [c.point] : [c.start, c.end, ...(c.kind === "cubic_bezier" ? c.controlPoints : [])];
function matrix(values: unknown): Matrix {
  const v = Array.from(values as ArrayLike<number> ?? []);
  const determinant=v[0]*v[3]-v[1]*v[2];
  if (v.length !== 6 || !v.every(finite) || !finite(determinant) || Math.abs(determinant)<1e-15) throw Error("Invalid PDF graphics transform");
  return v as Matrix;
}
function assertInput(bytes: Uint8Array, input: DraftingVectorSourceInput) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length>128*1024*1024) throw Error("PDF source must be 1 through 134217728 bytes");
  if (!/^[a-f0-9]{64}$/.test(input.expectedSourceSha256) || hash(bytes)!==input.expectedSourceSha256) throw Error("PDF source hash mismatch");
  if (!Number.isSafeInteger(input.page) || input.page<1) throw Error("Positive PDF page required");
  const r=input.region;
  if (!Array.isArray(r) || r.length!==4 || !r.every(finite) || r[0]>=r[2] || r[1]>=r[3]) throw Error("Finite nonempty PDF paper region required");
  if (typeof input.sourceLabel!=="string" || !input.sourceLabel.trim() || input.sourceLabel.length>512) throw Error("Source label required");
  if (input.sourceSheet!==undefined && (typeof input.sourceSheet!=="string" || !input.sourceSheet.trim() || input.sourceSheet.length>256)) throw Error("Invalid source sheet label");
}

/** Source inspection only. Paper coordinates are not model geometry or engineering dimensions.
 * Unclipped contours, zero-length source commands, styles and fill grouping remain intact.
 * This deliberately does not use or weaken the Revit-element-marked topology reader.
 */
export async function inspectDraftingVectorSource(bytes: Uint8Array, input: DraftingVectorSourceInput): Promise<DraftingVectorSource> {
  assertInput(bytes,input);
  const pdfjs=await loadPdfJsForNode(), O=pdfjs.OPS;
  const doc=await pdfjs.getDocument(buildPdfJsDocumentOptions(new Uint8Array(bytes))).promise;
  try {
    if(input.page>doc.numPages)throw Error("PDF page exceeds source page count");
    const page=await doc.getPage(input.page), viewport=page.getViewport({scale:1}), ops=await page.getOperatorList();
    const region: PaperRegion=[...input.region];
    if(region[0]<0||region[1]<0||region[2]>viewport.width||region[3]>viewport.height)throw Error("Region exceeds selected rotated PDF page");
    if(ops.fnArray.length>1000000)throw Error("PDF operator budget exceeded; source was not truncated");
    const id=(kind:string,key:string|number)=>kind+"_"+hash(input.expectedSourceSha256+":"+input.page+":"+kind+":"+key).slice(0,24);
    let state:GraphicsState={matrix:matrix(viewport.transform),lineWidth:1,strokeRgb:[0,0,0],fillRgb:[0,0,0],dash:[],dashPhase:0,lineCap:0,lineJoin:0,clipIds:[]};
    const stack:Array<{kind:"save"|"form";state:GraphicsState}>=[];
    let commands:PathCommand[]=[], current:PaperPoint|null=null, start:PaperPoint|null=null, pendingClip:boolean|null=null;
    let segmentCount=0;
    const paths:DraftingVectorPath[]=[], clips:DraftingVectorSource["clips"]=[], unsupported:DraftingVectorSource["unsupported"]=[], requirements=new Set<string>();
    const contours=(cmds:PathCommand[],key:string):DraftingVectorContour[]=>{
      const parts:PathCommand[][]=[];
      for(const c of cmds){if(c.kind==="move")parts.push([]);if(!parts.length)throw Error("PDF path command without contour start");parts.at(-1)!.push(c);}
      return parts.filter(p=>p.some(c=>c.kind!=="move")).map((part,i)=>{
        const box=bounds(part.flatMap(commandPoints));
        return{id:id("contour",key+":"+i),commands:part,conservativeBounds:box,intersectsRegion:overlaps(box,region),crossesRegion:overlaps(box,region)&&!inside(box,region)};
      });
    };
    const add=(command:PathCommand)=>{if(++segmentCount>200000)throw Error("PDF path budget exceeded; source was not truncated");commands.push(command);};
    const colors=(args:any)=>{
      const v=Array.from(args.length===1&&(Array.isArray(args[0])||ArrayBuffer.isView(args[0]))?args[0]:args) as number[];
      if(v.length!==3||!v.every(n=>Number.isInteger(n)&&n>=0&&n<=255))throw Error("Unsupported PDF RGB representation");return v;
    };
    const paintOps=new Map<number,{stroke:boolean;fill:boolean;evenOdd:boolean;close?:boolean}|null>([
      [O.stroke,{stroke:true,fill:false,evenOdd:false}],[O.closeStroke,{stroke:true,fill:false,evenOdd:false,close:true}],
      [O.fill,{stroke:false,fill:true,evenOdd:false}],[O.eoFill,{stroke:false,fill:true,evenOdd:true}],
      [O.fillStroke,{stroke:true,fill:true,evenOdd:false}],[O.eoFillStroke,{stroke:true,fill:true,evenOdd:true}],
      [O.closeFillStroke,{stroke:true,fill:true,evenOdd:false,close:true}],[O.closeEOFillStroke,{stroke:true,fill:true,evenOdd:true,close:true}],[O.endPath,null]
    ]);
    for(let i=0;i<ops.fnArray.length;i++){
      const fn=ops.fnArray[i],a=ops.argsArray[i];
      if(fn===O.save){stack.push({kind:"save",state:structuredClone(state)});continue;}
      if(fn===O.restore){const previous=stack.pop();if(previous?.kind!=="save")throw Error("Unbalanced PDF graphics restore");state=previous.state;continue;}
      if(fn===O.transform){state.matrix=multiply(state.matrix,matrix(a));continue;}
      if(fn===O.paintFormXObjectBegin){
        if(commands.length)throw Error("Form XObject began inside unfinished path");
        stack.push({kind:"form",state:structuredClone(state)});
        if(a[0])state.matrix=multiply(state.matrix,matrix(a[0]));
        if(a[1]){
          const b=Array.from(a[1]) as number[];if(b.length!==4||!b.every(finite)||b[0]>=b[2]||b[1]>=b[3])throw Error("Invalid form bounds");
          const p=[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]].map(v=>transform(state.matrix,v[0],v[1]));
          const cs:PathCommand[]=[{kind:"move",point:p[0]},...p.map((pt,j)=>({kind:"line" as const,start:pt,end:p[(j+1)%4]}))];
          const clipId=id("clip",i);clips.push({id:clipId,evenOdd:false,contours:contours(cs,"form:"+i)});state.clipIds.push(clipId);
        }continue;
      }
      if(fn===O.paintFormXObjectEnd){const previous=stack.pop();if(previous?.kind!=="form"||commands.length)throw Error("Unbalanced PDF form graphics state");state=previous.state;continue;}
      if(fn===O.setLineWidth){if(!finite(a[0])||a[0]<0)throw Error("Invalid PDF line width");state.lineWidth=a[0];continue;}
      if(fn===O.setLineCap){state.lineCap=Number(a[0]);continue;}
      if(fn===O.setLineJoin){state.lineJoin=Number(a[0]);continue;}
      if(fn===O.setStrokeRGBColor){state.strokeRgb=colors(a);continue;}
      if(fn===O.setFillRGBColor){state.fillRgb=colors(a);continue;}
      if(fn===O.setDash){state.dash=Array.from(a[0]);state.dashPhase=a[1];if(!state.dash.every(n=>finite(n)&&n>=0)||!finite(state.dashPhase))throw Error("Invalid PDF dash");continue;}
      if(fn===O.clip||fn===O.eoClip){pendingClip=fn===O.eoClip;continue;}
      if(fn===O.constructPath){
        const kinds=Array.from(a[0]) as number[],data=Array.from(a[1]) as number[];if(!data.every(finite))throw Error("Nonfinite PDF path coordinate");let pos=0;
        const read=():PaperPoint=>{if(pos+1>=data.length)throw Error("Truncated PDF path coordinates");return transform(state.matrix,data[pos++],data[pos++]);};
        for(const kind of kinds){
          if(kind===O.moveTo){current=read();start=current;add({kind:"move",point:current});}
          else if(kind===O.lineTo){if(!current)throw Error("Line before contour start");const end=read();add({kind:"line",start:current,end});current=end;}
          else if(kind===O.curveTo||kind===O.curveTo2||kind===O.curveTo3){
            if(!current)throw Error("Bezier before contour start");let c1:PaperPoint,c2:PaperPoint,end:PaperPoint;
            if(kind===O.curveTo){c1=read();c2=read();end=read();}else if(kind===O.curveTo2){c1=current;c2=read();end=read();}else{c1=read();end=read();c2=end;}
            add({kind:"cubic_bezier",start:current,controlPoints:[c1,c2],end});current=end;
          }else if(kind===O.closePath){if(!current||!start)throw Error("Close before contour start");add({kind:"close",start:current,end:start});current=start;}
          else if(kind===O.rectangle){
            if(pos+3>=data.length)throw Error("Truncated PDF rectangle");const[x,y,w,h]=data.slice(pos,pos+4);pos+=4;
            const p=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(pt=>transform(state.matrix,pt[0],pt[1]));
            add({kind:"move",point:p[0]});for(let j=0;j<4;j++)add({kind:"line",start:p[j],end:p[(j+1)%4]});
            add({kind:"close",start:p[0],end:p[0]});current=start=p[0];
          }else throw Error("Unsupported PDF path command "+kind);
        }if(pos!==data.length)throw Error("Unused PDF path coordinates");continue;
      }
      if(paintOps.has(fn)){
        const paint=paintOps.get(fn);
        if(paint?.close&&current&&start){add({kind:"close",start:current,end:start});current=start;}
        const parts=contours(commands,String(i));
        if(paint&&parts.some(p=>p.intersectsRegion)){
          const {close,...publicPaint}=paint;
          paths.push({id:id("path",i),operatorIndex:i,contours:parts,paint:publicPaint,style:structuredClone(state),conservativeBounds:bounds(commands.flatMap(commandPoints))});
          if(parts.some(p=>p.crossesRegion))requirements.add("clip_crossing_contours_to_selected_region");
          if(state.clipIds.length)requirements.add("apply_source_clipping_before_native_conversion");
          const m=state.matrix,sx=Math.hypot(m[0],m[1]),sy=Math.hypot(m[2],m[3]);
          if(Math.abs(sx-sy)>1e-8||Math.abs(m[0]*m[2]+m[1]*m[3])>1e-8)requirements.add("resolve_nonuniform_stroke_transform");
          if(paint.fill)requirements.add("preserve_grouped_fill_contours_and_winding");
        }
        if(pendingClip!==null&&parts.length){const clipId=id("clip",i);clips.push({id:clipId,evenOdd:pendingClip,contours:parts});state.clipIds.push(clipId);}
        commands=[];current=start=null;pendingClip=null;continue;
      }
      const images=[O.paintImageXObject,O.paintInlineImageXObject,O.paintImageMaskXObject,O.paintSolidColorImageMask];
      if([O.setGState,O.shadingFill,O.beginGroup,O.endGroup,O.setStrokeColorN,O.setFillColorN,
        O.paintImageXObjectRepeat,O.paintImageMaskXObjectRepeat,O.paintImageMaskXObjectGroup,
        O.paintInlineImageXObjectGroup,O.beginAnnotation,O.endAnnotation,...images].includes(fn)){
        const box=images.includes(fn)?bounds([[0,0],[1,0],[1,1],[0,1]].map(p=>transform(state.matrix,p[0],p[1]))):null;
        const intersects=box===null||overlaps(box,region);
        unsupported.push({operatorIndex:i,operator:Object.keys(O).find(k=>O[k]===fn)??String(fn),bounds:box,intersectsRegion:intersects});
        if(intersects)requirements.add("resolve_selected_unsupported_graphics");
      }
    }
    if(commands.length||pendingClip!==null||stack.length)throw Error("Unterminated PDF path or graphics state");
    const content=await page.getTextContent(),text:DraftingVectorText[]=[];
    for(let i=0;i<content.items.length;i++){
      const t=content.items[i];if(typeof t.str!=="string"||!t.str.length)continue;
      const m=multiply(matrix(viewport.transform),matrix(t.transform)),u=Math.hypot(m[0],m[1]),v=Math.hypot(m[2],m[3]);
      if(!u||!v||!finite(t.width)||!finite(t.height))throw Error("Invalid PDF text geometry");
      const style=content.styles[t.fontName];let name:string|null=style?.fontFamily??null;
      try{name=page.commonObjs.get(t.fontName)?.name??name;}catch{}
      const ascent=finite(style?.ascent)?style.ascent:0.8,descent=finite(style?.descent)?style.descent:-0.2;
      const box=bounds([0,t.width].flatMap(x=>[ascent,descent].map(y=>[m[4]+m[0]/u*x+m[2]*y,m[5]+m[1]/u*x+m[3]*y] as PaperPoint)));
      if(overlaps(box,region))text.push({id:id("text",i),sequenceIndex:i,text:t.str,baselineTransform:m,paperWidthPoints:t.width,paperHeightPoints:t.height,fontName:name,fontFamily:style?.fontFamily??null,ascent,descent,conservativeBounds:box,crossesRegion:!inside(box,region)});
      if(text.length>100000)throw Error("PDF text budget exceeded; source was not truncated");
    }
    if(text.length){requirements.add("bind_text_paint_order_and_clipping");requirements.add("qualify_native_font_metrics_and_text_alignment");}
    if(text.some(t=>t.crossesRegion))requirements.add("resolve_text_crossing_selected_region");
    requirements.add("native_tolerance_geometry_style_and_visual_readback_required");
    const plan:Omit<DraftingVectorSource,"planSha256">={schema:"operator.drafting_vector_source.v1",sourceSha256:input.expectedSourceSha256,page:input.page,sourceLabel:input.sourceLabel,sourceSheet:input.sourceSheet??null,coordinateSpace:"top-origin rotated PDF paper points",pageWidthPoints:viewport.width,pageHeightPoints:viewport.height,region,operatorCount:ops.fnArray.length,paths,text,clips,unsupported,conversionRequirements:[...requirements].sort(),sourceReadTruncated:false,nativeWriteAllowed:false};
    return {...plan,planSha256:digest(plan)};
  }finally{await doc.destroy();}
}

function assertPlan(plan:DraftingVectorSource,expected:string){
  const {planSha256,...body}=plan;
  if(plan.schema!=="operator.drafting_vector_source.v1"||plan.nativeWriteAllowed!==false||plan.sourceReadTruncated!==false||planSha256!==expected||digest(body)!==expected)throw Error("Vector source plan hash or boundary mismatch");
}

/** Whole source records are paged; never silently truncate coordinates or text. */
export function pageDraftingVectorSource(plan:DraftingVectorSource,expectedPlanSha256:string,section:"contours"|"text"|"clips",offset:number,limit:number,filterRegion?:PaperRegion){
  assertPlan(plan,expectedPlanSha256);
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error("Whole-record page bounds invalid");
  if(!["contours","text","clips"].includes(section))throw Error("Unknown vector source section");
  if(filterRegion&&(!Array.isArray(filterRegion)||filterRegion.length!==4||!filterRegion.every(finite)||filterRegion[0]>=filterRegion[2]||filterRegion[1]>=filterRegion[3]||filterRegion[0]<plan.region[0]||filterRegion[1]<plan.region[1]||filterRegion[2]>plan.region[2]||filterRegion[3]>plan.region[3]))throw Error("Filter region must be finite, nonempty and within inspected source region");
  const all=section==="text"?plan.text:section==="clips"?plan.clips:plan.paths.flatMap(p=>p.contours.map(c=>({pathId:p.id,operatorIndex:p.operatorIndex,paint:p.paint,style:p.style,...c})));
  const records=all.filter(record=>!filterRegion||("conservativeBounds" in record?overlaps(record.conservativeBounds,filterRegion):record.contours.some(c=>overlaps(c.conservativeBounds,filterRegion))));
  if(offset>records.length)throw Error("Source page offset exceeds record count");
  return {sourceSha256:plan.sourceSha256,planSha256:plan.planSha256,page:plan.page,sourceLabel:plan.sourceLabel,sourceSheet:plan.sourceSheet,region:plan.region,filterRegion:filterRegion??null,section,sourceRecordCount:all.length,total:records.length,offset,records:records.slice(offset,offset+limit),nextOffset:offset+limit<records.length?offset+limit:null,nativeWriteAllowed:false as const};
}

export type SourceOmission={recordId:string;reason:"historical_revision"|"reference_border"|"reference_identity"|"outside_requested_detail";evidence:string};
/** Classification comes from source inspection/user scope, not a cloud-shape heuristic.
 * Omitting a fill contour does not authorize ignoring its compound fill semantics.
 */
export function selectDraftingVectorSource(plan:DraftingVectorSource,expectedPlanSha256:string,omissions:SourceOmission[]){
  assertPlan(plan,expectedPlanSha256);
  if(!Array.isArray(omissions)||omissions.length>10000)throw Error("Invalid source omissions");
  const known=new Set([...plan.paths.flatMap(p=>p.contours.map(c=>c.id)),...plan.text.map(t=>t.id)]),seen=new Set<string>();
  for(const o of omissions){
    if(!known.has(o.recordId)||seen.has(o.recordId)||!["historical_revision","reference_border","reference_identity","outside_requested_detail"].includes(o.reason)||typeof o.evidence!=="string"||!o.evidence.trim()||o.evidence.length>1000)throw Error("Unknown, duplicate or unsupported source omission");
    seen.add(o.recordId);
  }
  const paths=plan.paths.map(p=>({...p,contours:p.contours.filter(c=>!seen.has(c.id))})).filter(p=>p.contours.length);
  const text=plan.text.filter(t=>!seen.has(t.id));
  const body={schema:"operator.drafting_vector_selection.v1",sourceSha256:plan.sourceSha256,sourcePlanSha256:plan.planSha256,page:plan.page,sourceLabel:plan.sourceLabel,sourceSheet:plan.sourceSheet,region:plan.region,paths,text,clips:plan.clips,omissions:structuredClone(omissions),conversionRequirements:[...new Set([...plan.conversionRequirements,...(plan.paths.some(p=>p.paint.fill&&p.contours.some(c=>seen.has(c.id)))?["rebuild_compound_fill_after_explicit_contour_omission"]:[])])].sort(),nativeWriteAllowed:false as const};
  return {...body,selectionSha256:hash(JSON.stringify(body))};
}
