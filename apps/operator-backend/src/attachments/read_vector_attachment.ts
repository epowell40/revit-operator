import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {gzipSync} from "node:zlib";
import {readRegisteredAttachmentSource} from "./registered_attachment_source.js";
import {getWorkspaceRoot} from "../workspace.js";
import {readLocalWorkspaceFile} from "./inline_images.js";
import {loadPdfJsForNode,buildPdfJsDocumentOptions} from "../pdf/pdfjs_node.js";
import {inspectDraftingVectorSource,pageDraftingVectorSource,selectDraftingVectorSource,type SourceOmission,type PaperRegion} from "../pdf/drafting_vector_source.js";
import {compileDraftingVectorNativePlan,type VectorNativeLayout} from "../pdf/drafting_vector_native_plan.js";

type Region={min_u:number;min_v:number;max_u:number;max_v:number};
export const VECTOR_ATTACHMENT_GUIDANCE = " For editable PDF details/diagrams, mode=vector with exactly one page and optional normalized source region returns a compact source summary and immutable compressed geometry/text plan, not an image or model verification. Inspect mode=detail pixels too. Follow expected_plan_sha256 for whole contour/text/clip pages using vector_section, vector_offset, vector_limit and optional vector_filter_region. Individual curves/text are never clipped to a response length; reduce page size or use the retained artifact for native import. Retain source filename/page/sheet-location context. Explicit vector_omissions name source contour/text IDs and evidence for historical_revision/reference_border/reference_identity/outside_requested_detail; they do not authorize current-project clouds or model edits. Native conversion requirements still apply.";
const finite=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n);
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function normalized(value:unknown):Region{
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Vector region must contain four normalized page bounds.");
 const r=value as Record<string,unknown>,keys=["min_u","min_v","max_u","max_v"];
 if(Object.keys(r).length!==4||!keys.every(k=>finite(r[k])&&r[k]>=0&&r[k]<=1)||!(Number(r.min_u)<Number(r.max_u))||!(Number(r.min_v)<Number(r.max_v)))throw Error("Vector region must be finite, normalized and nonempty.");
 return r as Region;
}
function storePlan(value:unknown){
 const raw=Buffer.from(JSON.stringify(value));if(raw.length>64*1024*1024)throw Error("Complete source plan exceeds64MiB; no source records were truncated.");
 const packed=gzipSync(raw),rawHash=hash(raw),relative=`artifacts/drafting-vector/source-${rawHash}.json.gz`;
 const root=getWorkspaceRoot(),directory=path.join(root,"artifacts/drafting-vector");fs.mkdirSync(directory,{recursive:true});
 const realRoot=fs.realpathSync(root),realDir=fs.realpathSync(directory),rel=path.relative(realRoot,realDir);
 if(rel.startsWith("..")||path.isAbsolute(rel))throw Error("Vector plan artifact directory escapes workspace.");
 const destination=path.join(directory,path.basename(relative));
 try{fs.writeFileSync(destination,packed,{flag:"wx"});}
 catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;const old=readLocalWorkspaceFile(destination,64*1024*1024);if(!old||hash(old)!==hash(packed))throw Error("Existing immutable vector plan artifact differs; no overwrite.");}
 return{relative_path:relative,sha256:hash(packed),bytes:packed.length,unpacked_sha256:rawHash,unpacked_bytes:raw.length,encoding:"gzip+utf8-json"};
}

/** Shared native-worker/Sidecar attachment path. Derived source artifacts are not model edits. */
export async function readRegisteredVectorAttachment(sessionId:string,value:unknown):Promise<{content:Array<{type:"text";text:string}>}>{
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Vector source read requires registered attachment arguments.");
 const a=value as Record<string,unknown>,allowed=["attachment_id","mode","pages","region","vector_section","vector_offset","vector_limit","vector_filter_region","expected_plan_sha256","vector_omissions","native_layout"];
 if(Object.keys(a).some(k=>!allowed.includes(k))||a.mode!=="vector")throw Error("Only registered vector-source fields accepted; the conversation is host-bound.");
 if(typeof a.attachment_id!=="string")throw Error("Registered attachment ID required, not a source path.");
 if(!Array.isArray(a.pages)||a.pages.length!==1||!Number.isSafeInteger(a.pages[0])||a.pages[0]<1)throw Error("Vector source inspection requires exactly one positive1-based page.");
 const region=a.region===undefined?{min_u:0,min_v:0,max_u:1,max_v:1}:normalized(a.region),filter=a.vector_filter_region===undefined?undefined:normalized(a.vector_filter_region);
 const section=a.vector_section??"summary",offset=a.vector_offset??0,limit=a.vector_limit??20;
 if(!["summary","contours","text","clips","native_plan"].includes(String(section)))throw Error("Unknown vector source section.");
 if(!Number.isSafeInteger(offset)||Number(offset)<0||!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>100)throw Error("Vector pages require integer offset>=0 and1through100 whole records.");
 if(a.expected_plan_sha256!==undefined&&(typeof a.expected_plan_sha256!=="string"||!/^[a-f0-9]{64}$/.test(a.expected_plan_sha256)))throw Error("Expected vector plan hash must be SHA256.");
 if((section!=="summary"||a.vector_omissions!==undefined)&&!a.expected_plan_sha256)throw Error("Read the vector summary first; records/omissions require its expected_plan_sha256.");
 if(section==="summary"&&(a.vector_offset!==undefined||a.vector_limit!==undefined||filter))throw Error("Summary does not accept record paging/filter fields.");
 if(section==="native_plan"&&(a.vector_offset!==undefined||a.vector_limit!==undefined||filter)||section!=="native_plan"&&a.native_layout!==undefined)throw Error("native_layout belongs only to native_plan, without record paging/filter fields.");
 const source=readRegisteredAttachmentSource(sessionId,a.attachment_id);
 if(source.bytes.subarray(0,5).toString("ascii")!=="%PDF-")throw Error("Vector inspection requires a registered PDF attachment.");
 const pdfjs=await loadPdfJsForNode(),doc=await pdfjs.getDocument({...buildPdfJsDocumentOptions(new Uint8Array(source.bytes)),isEvalSupported:false}).promise;
 let width:number,height:number,declaredLabel:string|null=null;
 try{if(a.pages[0]>doc.numPages)throw Error("Vector page exceeds source page count.");const page=await doc.getPage(a.pages[0]),vp=page.getViewport({scale:1});width=vp.width;height=vp.height;declaredLabel=(await doc.getPageLabels())?.[a.pages[0]-1]??null;}finally{await doc.destroy();}
 const toPaper=(r:Region):PaperRegion=>[r.min_u*width,r.min_v*height,r.max_u*width,r.max_v*height];
 const plan=await inspectDraftingVectorSource(new Uint8Array(source.bytes),{expectedSourceSha256:source.sha256,page:a.pages[0],region:toPaper(region),sourceLabel:source.record.filename||path.basename(source.relativePath),...(declaredLabel?{sourceSheet:declaredLabel}:{})});
 if(a.expected_plan_sha256!==undefined&&a.expected_plan_sha256!==plan.planSha256)throw Error("Source page/region/plan changed; inspect its current summary before continuing.");
 const artifact=storePlan(plan);
 const selection=a.vector_omissions===undefined?null:selectDraftingVectorSource(plan,plan.planSha256,a.vector_omissions as SourceOmission[]);
 const nativePlan=section==="native_plan"?compileDraftingVectorNativePlan(plan,plan.planSha256,a.native_layout as VectorNativeLayout,(a.vector_omissions??[]) as SourceOmission[]):null;
 const contours=plan.paths.flatMap(p=>p.contours),commands=contours.flatMap(c=>c.commands);
 const result={mode:"vector",source:plan.sourceLabel,attachment_id:a.attachment_id,source_path:source.relativePath,sha256:source.sha256,page:plan.page,declared_pdf_page_label:declaredLabel,
  native_sheet_identity_established:false,coordinate_space:plan.coordinateSpace,page_width_points:width,page_height_points:height,region:plan.region,normalized_region:region,
  plan_sha256:plan.planSha256,plan_artifact:artifact,counts:{path_groups:plan.paths.length,contours:contours.length,contours_intersecting_region:contours.filter(c=>c.intersectsRegion).length,crossing_contours:contours.filter(c=>c.crossesRegion).length,line_commands:commands.filter(c=>c.kind==="line"||c.kind==="close").length,cubic_commands:commands.filter(c=>c.kind==="cubic_bezier").length,text_records:plan.text.length,clips:plan.clips.length},
  conversion_requirements:selection?.conversionRequirements??plan.conversionRequirements,unsupported_count:plan.unsupported.length,unsupported_selected_count:plan.unsupported.filter(u=>u.intersectsRegion).length,
  ...(!["summary","native_plan"].includes(String(section))?{record_page:pageDraftingVectorSource(plan,plan.planSha256,section as "contours"|"text"|"clips",Number(offset),Number(limit),filter?toPaper(filter):undefined)}:{}),
  ...(selection?{selection_sha256:selection.selectionSha256,selection_artifact:storePlan(selection),omissions:selection.omissions}:{}),
  ...(nativePlan?{native_plan_sha256:nativePlan.nativePlanSha256,native_plan_artifact:storePlan(nativePlan),native_plan_summary:{entities:nativePlan.entities.length,parts:nativePlan.partCount,paper_width_inches:nativePlan.layout.paperWidthInches,paper_height_inches:nativePlan.paperHeightInches,view_scale:nativePlan.layout.viewScale,zero_length_source_commands:nativePlan.zeroLengthSourceCommands,limits:nativePlan.limits}}:{}),
  native_write_allowed:false,source_read_truncated:false,visual_review_established:false,
  note:"Source data only. Inspect mode=detail page/region pixels and retain source/native sheet/view context. Historical clouds/tags need explicit documented contour/text omissions, not whole-group deletion. Paper points are not model coordinates. Native importer must handle listed clipping/fill/font/tolerance requirements, preserve source ownership and read back actual created geometry/text; this source receipt is not model authorization or verification."};
 const json=JSON.stringify(result);if(Buffer.byteLength(json)>47500)throw Error("Whole vector record page exceeds output budget; reduce vector_limit or narrow vector_filter_region. Complete source artifact retained; no record or text was clipped.");
 return{content:[{type:"text",text:json}]};
}
