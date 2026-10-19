import crypto from "node:crypto";
import polygonClipping,{type MultiPolygon} from "polygon-clipping";
import {selectDraftingVectorSource,type DraftingVectorSource,type PaperPoint,type SourceOmission,type VectorSegment} from "./drafting_vector_source.js";

type Segment=VectorSegment;
type Polygon=PaperPoint[];
export type VectorNativeLayout={paperWidthInches:number;viewScale:number;partSize?:number;fontMap?:Record<string,string>;lineWeightMap?:Record<string,number>};
export type NativeVectorStyle={color:number[];weight:number;sourceWidthPoints:number;dashInches:number[];dashPhaseInches:number};
export type NativeVectorEntity={id:string;sourceId:string;kind:"line"|"cubic_bezier"|"fill"|"text";points?:PaperPoint[];loops?:Segment[][];style?:NativeVectorStyle;fillColor?:number[];
 text?:string;anchor?:PaperPoint;rotation?:number;font?:string;emPoints?:number;bold?:boolean;italic?:boolean;widthScale?:number;expectedWidthInches?:number};
export type VectorNativePlan={schema:"operator.drafting_vector_native_plan.v1";sourceSha256:string;sourcePlanSha256:string;selectionSha256:string;sourceLabel:string;sourceSheet:string|null;page:number;region:number[];
 layout:Required<Pick<VectorNativeLayout,"paperWidthInches"|"viewScale"|"partSize">>&Pick<VectorNativeLayout,"fontMap"|"lineWeightMap">;paperHeightInches:number;coordinateSpace:"paper inches, right/up, lower-left of selected source region";
 entities:NativeVectorEntity[];partCount:number;zeroLengthSourceCommands:number;omissions:SourceOmission[];limits:string[];nativeWriteAllowed:false;nativePlanSha256:string};
const epsilon=1e-9;
export function canonicalVectorJson(value:unknown):string{
 if(Array.isArray(value))return"["+value.map(v=>canonicalVectorJson(v)).join(",")+"]";
 if(value&&typeof value==="object")return"{"+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+":"+canonicalVectorJson(v)).join(",")+"}";
 const result=JSON.stringify(value);if(result===undefined)throw Error("Incomplete vector JSON value.");return result;
}
const hash=(v:unknown)=>crypto.createHash("sha256").update(canonicalVectorJson(v)).digest("hex");
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
const cross=(a:PaperPoint,b:PaperPoint,c:PaperPoint)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const same=(a:PaperPoint,b:PaperPoint)=>Math.hypot(a[0]-b[0],a[1]-b[1])<epsilon;
const area=(p:Polygon)=>p.reduce((n,a,i)=>{const b=p[(i+1)%p.length];return n+a[0]*b[1]-b[0]*a[1];},0)/2;
function convex(p:Polygon){
 if(p.length<3||Math.abs(area(p))<epsilon)return false;const sign=Math.sign(area(p));
 return p.every((a,i)=>sign*cross(a,p[(i+1)%p.length],p[(i+2)%p.length])>=-epsilon);
}
function inside(p:PaperPoint,clip:Polygon){
 let result=false;
 for(let i=0,j=clip.length-1;i<clip.length;j=i++){
  const a=clip[j],b=clip[i];
  if(Math.abs(cross(a,b,p))<=epsilon&&p[0]>=Math.min(a[0],b[0])-epsilon&&p[0]<=Math.max(a[0],b[0])+epsilon&&p[1]>=Math.min(a[1],b[1])-epsilon&&p[1]<=Math.max(a[1],b[1])+epsilon)return true;
  if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])result=!result;
 }return result;
}
function simple(p:Polygon){
 if(p.length<3||p.length>2048||p.some(pt=>pt.length!==2||!pt.every(finite))||Math.abs(area(p))<epsilon)return false;
 for(let i=0;i<p.length;i++)for(let j=i+1;j<p.length;j++){
  if(j===i+1||i===0&&j===p.length-1)continue;
  const a=p[i],b=p[(i+1)%p.length],c=p[j],d=p[(j+1)%p.length];
  if(cross(a,b,c)*cross(a,b,d)<-epsilon&&cross(c,d,a)*cross(c,d,b)<-epsilon)return false;
  const on=(a:PaperPoint,b:PaperPoint,c:PaperPoint)=>Math.abs(cross(a,b,c))<epsilon&&c[0]>=Math.min(a[0],b[0])-epsilon&&c[0]<=Math.max(a[0],b[0])+epsilon&&c[1]>=Math.min(a[1],b[1])-epsilon&&c[1]<=Math.max(a[1],b[1])+epsilon;
  if(on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b))return false;
 }return true;
}
function lerp(a:PaperPoint,b:PaperPoint,t:number):PaperPoint{return[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];}
function split(p:PaperPoint[],t:number):[PaperPoint[],PaperPoint[]]{const a=lerp(p[0],p[1],t),b=lerp(p[1],p[2],t),c=lerp(p[2],p[3],t),d=lerp(a,b,t),e=lerp(b,c,t),f=lerp(d,e,t);return[[p[0],a,d,f],[f,e,c,p[3]]];}
function span(p:PaperPoint[],a:number,b:number){const left=b===1?p:split(p,b)[0];return a===0?left:split(left,a/b)[1];}
function evalCubic(p:PaperPoint[],t:number){return split(p,t)[0][3];}

// All roots on [0,1], including tangencies, using derivative monotonic intervals.
// Splits retain cubic controls; this is not tessellation or raster tracing.
function roots(v:number[]){
 const[a,b,c,d]=[-v[0]+3*v[1]-3*v[2]+v[3],3*v[0]-6*v[1]+3*v[2],-3*v[0]+3*v[1],v[0]];
 const f=(t:number)=>((a*t+b)*t+c)*t+d,tolerance=Math.max(1,...v.map(Math.abs))*1e-12;
 const critical:number[]=[];
 if(Math.abs(a)<1e-14){if(Math.abs(b)>1e-14)critical.push(-c/(2*b));}
 else{const disc=4*b*b-12*a*c;if(disc>=0){critical.push((-2*b-Math.sqrt(disc))/(6*a),(-2*b+Math.sqrt(disc))/(6*a));}}
 const nodes=[0,...critical.filter(t=>t>0&&t<1),1].sort((x,y)=>x-y),result=nodes.filter(t=>Math.abs(f(t))<=tolerance);
 for(let i=1;i<nodes.length;i++){
  let lo=nodes[i-1],hi=nodes[i],fl=f(lo),fh=f(hi);if(fl*fh>=0)continue;
  for(let n=0;n<64;n++){const mid=(lo+hi)/2,fm=f(mid);if(fl*fm<=0){hi=mid;fh=fm;}else{lo=mid;fl=fm;}}
  result.push((lo+hi)/2);
 }return result;
}
export function clipDraftingSegment(segment:Segment,clip:Polygon):Segment[]{
 if(!simple(clip))throw Error("Source clipping requires a bounded simple polygon; unsupported masks were not ignored.");
 const points=segment.kind==="cubic_bezier"?[segment.start,...segment.controlPoints,segment.end]:[segment.start,segment.end];
 if(convex(clip)&&points.every(p=>inside(p,clip)))return[segment];
 const all=[0,1];for(let i=0;i<clip.length;i++){
  const v=points.map(p=>cross(clip[i],clip[(i+1)%clip.length],p));
  if(segment.kind==="cubic_bezier")all.push(...roots(v));
  else if(Math.abs(v[1]-v[0])>1e-15){const t=v[0]/(v[0]-v[1]);if(t>0&&t<1)all.push(t);}
 }
 const nodes=all.sort((a,b)=>a-b).filter((v,i,a)=>i===0||v-a[i-1]>1e-10),intervals:Array<[number,number]>=[];
 for(let i=1;i<nodes.length;i++){
  const a=nodes[i-1],b=nodes[i],mid=segment.kind==="cubic_bezier"?evalCubic(points,(a+b)/2):lerp(segment.start,segment.end,(a+b)/2);
  if(b-a<1e-12||!inside(mid,clip))continue;
  if(intervals.length&&Math.abs(intervals.at(-1)![1]-a)<1e-10)intervals.at(-1)![1]=b;else intervals.push([a,b]);
 }return intervals.map(([a,b]):Segment=>{
  if(segment.kind!=="cubic_bezier")return{kind:"line",start:lerp(segment.start,segment.end,a),end:lerp(segment.start,segment.end,b)};
  const p=span(points,a,b);return{kind:"cubic_bezier",start:p[0],controlPoints:[p[1],p[2]],end:p[3]};
 });
}
function polygon(segments:Segment[]):Polygon{
 if(segments.some(s=>s.kind==="cubic_bezier"))throw Error("Curved source clip mask requires explicit support; no mask was approximated.");
 const points=segments.map(s=>s.start).filter((p,i,a)=>i===0||!same(p,a[i-1]));
 if(points.length>1&&same(points[0],points.at(-1)!))points.pop();
 if(points.length<3||!segments.every((s,i)=>same(s.end,segments[(i+1)%segments.length].start)))throw Error("Source clip/fill contour must be closed.");
 return points;
}
const segmentPoints=(s:Segment)=>s.kind==="cubic_bezier"?[s.start,...s.controlPoints,s.end]:[s.start,s.end];
const lineLoop=(p:Polygon):Segment[]=>p.map((point,i)=>({kind:"line",start:point,end:p[(i+1)%p.length]}));

/** Deterministic source conversion, not model authorization. Native creation must independently
 * enforce model/view identity, real short-curve tolerance, settlement and fresh native reads. */
export function compileDraftingVectorNativePlan(source:DraftingVectorSource,expectedPlanSha256:string,options:VectorNativeLayout,omissions:SourceOmission[]=[]):VectorNativePlan{
 const selected=selectDraftingVectorSource(source,expectedPlanSha256,omissions);
 if(!options||typeof options!=="object"||Array.isArray(options)||Object.keys(options).some(k=>!["paperWidthInches","viewScale","partSize","fontMap","lineWeightMap"].includes(k)))throw Error("Only explicit native layout fields are accepted.");
 if(!finite(options.paperWidthInches)||options.paperWidthInches<1||options.paperWidthInches>120||!Number.isInteger(options.viewScale)||options.viewScale<1||options.viewScale>1000)throw Error("Finite1through120inch target width and integer1through1000 drafting viewScale required.");
 const partSize=options.partSize??750;if(!Number.isSafeInteger(partSize)||partSize<50||partSize>1000)throw Error("Native import partSize must be50through1000 entities.");
 for(const value of [options.fontMap,options.lineWeightMap])if(value!==undefined&&(!value||typeof value!=="object"||Array.isArray(value)))throw Error("Explicit font and pen mappings must be objects.");
 for(const [name,font]of Object.entries(options.fontMap??{}))if(!name.trim()||name.length>256||typeof font!=="string"||!font.trim()||font.length>128)throw Error("Invalid explicit source/native font mapping.");
 for(const [name,weight]of Object.entries(options.lineWeightMap??{}))if(!name.trim()||!finite(Number(name))||Number(name)<0||!Number.isInteger(weight)||weight<1||weight>16)throw Error("Invalid explicit source width/native pen mapping.");
 if(source.unsupported.some(u=>u.intersectsRegion))throw Error("Selected PDF has unsupported graphics; no partial native plan was prepared.");
 const r=source.region,scale=options.paperWidthInches/(r[2]-r[0]),paperScale=scale*72;
 const point=(p:PaperPoint):PaperPoint=>[(p[0]-r[0])*scale,(r[3]-p[1])*scale];
 const mappedSegment=(s:Segment):Segment=>s.kind==="cubic_bezier"?{...s,start:point(s.start),end:point(s.end),controlPoints:[point(s.controlPoints[0]),point(s.controlPoints[1])]}:{...s,start:point(s.start),end:point(s.end)};
 const regionClip:Polygon=[[r[0],r[1]],[r[2],r[1]],[r[2],r[3]],[r[0],r[3]]],clipById=new Map(source.clips.map(c=>[c.id,c]));
 const entities:NativeVectorEntity[]=[];let zero=0;
 for(const path of selected.paths){
  const m=path.style.matrix,sx=Math.hypot(m[0],m[1]),sy=Math.hypot(m[2],m[3]);
  if(Math.abs(sx-sy)>1e-8||Math.abs(m[0]*m[2]+m[1]*m[3])>1e-8)throw Error("Nonuniform stroke transform needs explicit native outline conversion.");
  if(path.style.dashPhase!==0)throw Error("Nonzero source dash phase needs explicit path splitting; it was not discarded.");
  const width=path.style.lineWidth*sx,weight=options.lineWeightMap?.[String(width)]??Math.max(1,Math.min(16,Math.round(width*paperScale/.24)));
  const style:NativeVectorStyle={color:path.style.strokeRgb,weight,sourceWidthPoints:width,dashInches:path.style.dash.map(d=>d*sx*scale),dashPhaseInches:0};
  const masks=[regionClip,...path.style.clipIds.map(id=>{
   const c=clipById.get(id);if(!c||c.contours.length!==1)throw Error("Compound or missing PDF clip requires explicit conversion.");
   const poly=polygon(c.contours[0].commands.filter(c=>c.kind!=="move") as Segment[]);if(!simple(poly))throw Error("Complex source clip requires explicit conversion.");return poly;
  })];
  if(path.paint.fill&&!path.paint.evenOdd&&path.contours.length>1)throw Error("Compound nonzero-winding fills require explicit boolean conversion.");
  if(path.paint.fill){
   const loops:Segment[][]=[],linear:Polygon[]=[];let curved=false;
   for(const contour of path.contours){
    let segments=contour.commands.filter(c=>c.kind!=="move") as Segment[];
    segments=segments.filter(s=>{if(s.kind!=="cubic_bezier"&&same(s.start,s.end)){zero++;return false;}return true;});
    if(!segments.length)continue;
    if(segments.some(s=>s.kind==="cubic_bezier")){
     if(masks.some(mask=>!convex(mask)||!segments.every(s=>segmentPoints(s).every(p=>inside(p,mask)))))throw Error("A clipped curved fill needs explicit boolean conversion; no source fill was approximated.");
     curved=true;loops.push(segments.map(mappedSegment));continue;
    }
    linear.push(polygon(segments));
   }
   if(curved&&(linear.length||loops.length>1))throw Error("Compound curved fills need explicit boolean conversion.");
   if(curved)entities.push({id:path.id+":fill:0",sourceId:path.id,kind:"fill",loops,fillColor:path.style.fillRgb});
   else if(linear.length){
    let geometry:MultiPolygon=path.paint.evenOdd?polygonClipping.xor([linear[0]],...linear.slice(1).map(p=>[p])):[[linear[0]]];
    for(const mask of masks)geometry=polygonClipping.intersection(geometry,[mask]);
    for(const [index,poly]of geometry.entries()){
     const nativeLoops=poly.map(ring=>ring.filter((p,i,a)=>i!==a.length-1||!same(p,a[0]))).filter(vertices=>vertices.length>=3).map(vertices=>lineLoop(vertices).map(mappedSegment));
     if(nativeLoops.length)entities.push({id:path.id+":fill:"+index,sourceId:path.id,kind:"fill",loops:nativeLoops,fillColor:path.style.fillRgb});
    }
   }
  }
  if(path.paint.stroke){
   for(const contour of path.contours)for(const [index,segment]of contour.commands.entries()){
    if(segment.kind==="move")continue;
    if(segment.kind!=="cubic_bezier"&&same(segment.start,segment.end)){zero++;continue;}
    let parts:Segment[]=[segment];for(const mask of masks)parts=parts.flatMap(s=>clipDraftingSegment(s,mask));
    for(const [part,s]of parts.entries())entities.push({id:contour.id+":"+index+":"+part,sourceId:contour.id,kind:s.kind==="cubic_bezier"?"cubic_bezier":"line",points:segmentPoints(s).map(point),style});
   }
  }
 }
 for(const t of selected.text){
  if(!t.text.trim())continue;
  if(t.text.length>1000000)throw Error("Native text item exceeds complete-item budget; no text truncated.");
  if(t.crossesRegion)throw Error("Selected text crosses the source region; enlarge or explicitly exclude that complete record.");
  const m=t.baselineTransform,u=Math.hypot(m[0],m[1]),v=Math.hypot(m[2],m[3]);if(Math.abs(m[0]*m[2]+m[1]*m[3])>1e-7*u*v)throw Error("Sheared PDF text requires native outline conversion.");
  const sourceFont=(t.fontName??t.fontFamily??"").replace(/^[A-Z]{6}\+/,"");
  const aliases:Record<string,string>={ArialMT:"Arial","Arial-BoldMT":"Arial","Arial-ItalicMT":"Arial","Arial-BoldItalicMT":"Arial",Helvetica:"Arial",TimesNewRomanPSMT:"Times New Roman"};
  const font=options.fontMap?.[t.fontName??""]??options.fontMap?.[sourceFont]??aliases[sourceFont]??sourceFont;
  if(!font)throw Error("Source font is unresolved; supply an explicit installed font mapping.");
  entities.push({id:t.id,sourceId:t.id,kind:"text",text:t.text,anchor:point([m[4]+m[2]*t.ascent,m[5]+m[3]*t.ascent]),rotation:Math.atan2(-m[1],m[0]),font,emPoints:v*paperScale,bold:/bold/i.test(sourceFont),italic:/italic|oblique/i.test(sourceFont),widthScale:u/v,expectedWidthInches:t.paperWidthPoints*scale});
 }
 if(!entities.length||entities.length>100000)throw Error("Native plan must contain1through100000 complete entities; no partial plan was emitted.");
 if(new Set(entities.map(e=>e.id)).size!==entities.length)throw Error("Duplicate source entity identities.");
 const plan:Omit<VectorNativePlan,"nativePlanSha256">={schema:"operator.drafting_vector_native_plan.v1",sourceSha256:source.sourceSha256,sourcePlanSha256:source.planSha256,selectionSha256:selected.selectionSha256,sourceLabel:source.sourceLabel,sourceSheet:source.sourceSheet,page:source.page,region:source.region,layout:{...options,partSize},paperHeightInches:(r[3]-r[1])*scale,coordinateSpace:"paper inches, right/up, lower-left of selected source region",entities,partCount:Math.ceil(entities.length/partSize),zeroLengthSourceCommands:zero,omissions:selected.omissions,
 limits:["Source plan does not authorize model changes or certify native/visual results.","Text paint order, source text clipping/color/decorations, native text anchor/font metrics, line caps/joins and native pen physical widths require actual visual comparison; native text defaults to black.","Native pen indices preserve relative source widths by a declared default .24point base unless explicitly mapped; native project pen thickness is not assumed.","Path stroke/fill colors, editable text/curves/fills and explicit source omissions are retained. Schematics are not physical engineering scale.","Import each owned part once, inspect fresh source/native geometry/text and then review/iterate actual work-area and sheet visuals."] ,nativeWriteAllowed:false};
 return{...plan,nativePlanSha256:hash(plan)};
}
