import fs from "node:fs";
import {isSupportedToolRoute} from "../capabilities/supported_tool_inventory.js";
import path from "node:path";
import {createHash} from "node:crypto";
import {gzipSync} from "node:zlib";
import {readRegisteredAttachmentSource} from "./registered_attachment_source.js";
import {getWorkspaceRoot} from "../workspace.js";
import {readLocalWorkspaceFile} from "./inline_images.js";
import {loadPdfJsForNode,buildPdfJsDocumentOptions} from "../pdf/pdfjs_node.js";
import {inspectDraftingVectorSource,pageDraftingVectorSource,selectDraftingVectorSource,type SourceOmission,type PaperRegion} from "../pdf/drafting_vector_source.js";
import {compileDraftingVectorNativePlan,type VectorNativeLayout} from "../pdf/drafting_vector_native_plan.js";
import {VECTOR_ANNOTATION_PART_SIZE} from "../pdf/drafting_vector_annotations.js";
import {storeVectorStrokeCad} from './vector_stroke_cad_artifacts.js';

type Region={min_u:number;min_v:number;max_u:number;max_v:number};
export const VECTOR_ATTACHMENT_GUIDANCE = " For PDF details/diagrams, mode=vector requires one page and an optional normalized region. It returns a compact source summary and immutable complete artifact. Also inspect mode=detail pixels. Preserve filename/hash/page/sheet and matching native view context. Read whole contour/text/clip records using vector_section, matching expected_plan_sha256, vector_offset/vector_limit and optional vector_filter_region; individual records are never clipped. For dense drawings, contour_index returns compact exact contour IDs, bounds, command counts and pen/fill metadata with the same paging/filter/source hash. Use it with detail pixels to locate every contour of a revision mark, then inspect uncertain contours in full before omission. It does not classify clouds, establish visual review or authorize whole-path or bounding-box deletion; piping may share a paint group or cross the same area. Complete historical mark coverage before preparing CAD/annotations; inspect all marked areas again on the actual resulting view. Explicit vector_omissions identify source record IDs, reason and evidence; normally omit the other project's historical revision marks, without discarding unrelated geometry. Supported reasons are historical_revision, reference_border, reference_identity and outside_requested_detail. native_plan with native_layout:{paperWidthInches,viewScale,partSize?} prepares the full source plan and annotation inputs. Printed width and view scale are separate; scale100 can accommodate fine ink, but never silently change an existing view scale. Actual native tolerance still preflights. stroke_cad with the same layout prepares ALL retained lines/cubics as immutable DXF plus original-PDF descriptor; vector_offset/vector_limit page only its layer styles. No faceting or short-stroke omission. Inspect/create a drafting view at required_view_scale, then use cad_import_inputs plus its viewId through supported /revit/link-cad with the expected source hash. This creates embedded CAD vectors, not individual Revit detail curves. Apply/read back source pens/colors using actual imported category IDs. Check every contiguous cadTargetOnly native page with the same owner/import UniqueIds and complete geometry digest. Separately use native_annotation_inputs with exact viewId/expectedViewUniqueId through supported /revit/import-vector-annotations; it derives every text/fill/dot in ordered40entityparts. Inspect each committed part via /revit/inspect-vector-detail and continue with its fresh manifest/snapshot; native projection and integral original-PDF reparse must pass. The original /revit/import-vector-detail curve route remains withheld. Source preparation is not model authorization or verification. Never duplicate a committed part or retry an uncertain write. Complete content coverage, actual work-area visual review, sheet placement and save/reopen remain separate checks. Unsupported conversion requirements remain explicit.";
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
 if(!["summary","contours","contour_index","text","clips","native_plan","stroke_cad"].includes(String(section)))throw Error("Unknown vector source section.");
 if(!Number.isSafeInteger(offset)||Number(offset)<0||!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>100)throw Error("Vector pages require integer offset>=0 and1through100 whole records.");
 if(a.expected_plan_sha256!==undefined&&(typeof a.expected_plan_sha256!=="string"||!/^[a-f0-9]{64}$/.test(a.expected_plan_sha256)))throw Error("Expected vector plan hash must be SHA256.");
 if((section!=="summary"||a.vector_omissions!==undefined)&&!a.expected_plan_sha256)throw Error("Read the vector summary first; records/omissions require its expected_plan_sha256.");
 if(section==="summary"&&(a.vector_offset!==undefined||a.vector_limit!==undefined||filter))throw Error("Summary does not accept record paging/filter fields.");
 if(section==="native_plan"&&(a.vector_offset!==undefined||a.vector_limit!==undefined||filter)
  ||!["native_plan","stroke_cad"].includes(String(section))&&a.native_layout!==undefined||section==="stroke_cad"&&filter)
  throw Error("native_layout belongs only to native_plan or stroke_cad; native_plan is without record paging/filter fields and stroke_cad permits only layer-style paging.");
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
 const nativePlan=["native_plan","stroke_cad"].includes(String(section))?compileDraftingVectorNativePlan(plan,plan.planSha256,a.native_layout as VectorNativeLayout,(a.vector_omissions??[]) as SourceOmission[]):null;
 const nativeArtifact=nativePlan?storePlan(nativePlan):null;
 const cad=section==='stroke_cad'&&nativePlan&&nativeArtifact?storeVectorStrokeCad({sourcePath:source.relativePath,sourceSha256:source.sha256,
  nativePlanPath:nativeArtifact.relative_path,nativePlanFileSha256:nativeArtifact.sha256,nativePlanSha256:nativePlan.nativePlanSha256},nativePlan):null;
 if(cad&&Number(offset)>cad.cad.layerStyles.length)throw Error('Layer-style cursor exceeds the complete source style inventory.');
 const contours=plan.paths.flatMap(p=>p.contours),commands=contours.flatMap(c=>c.commands);
 const result={mode:"vector",source:plan.sourceLabel,attachment_id:a.attachment_id,source_path:source.relativePath,sha256:source.sha256,page:plan.page,declared_pdf_page_label:declaredLabel,
  native_sheet_identity_established:false,coordinate_space:plan.coordinateSpace,page_width_points:width,page_height_points:height,region:plan.region,normalized_region:region,
  plan_sha256:plan.planSha256,plan_artifact:artifact,counts:{path_groups:plan.paths.length,contours:contours.length,contours_intersecting_region:contours.filter(c=>c.intersectsRegion).length,crossing_contours:contours.filter(c=>c.crossesRegion).length,line_commands:commands.filter(c=>c.kind==="line"||c.kind==="close").length,cubic_commands:commands.filter(c=>c.kind==="cubic_bezier").length,text_records:plan.text.length,clips:plan.clips.length},
  conversion_requirements:selection?.conversionRequirements??plan.conversionRequirements,unsupported_count:plan.unsupported.length,unsupported_selected_count:plan.unsupported.filter(u=>u.intersectsRegion).length,
  ...(!["summary","native_plan","stroke_cad"].includes(String(section))?{record_page:pageDraftingVectorSource(plan,plan.planSha256,section as "contours"|"contour_index"|"text"|"clips",Number(offset),Number(limit),filter?toPaper(filter):undefined)}:{}),
  ...(selection?{selection_sha256:selection.selectionSha256,selection_artifact:storePlan(selection),omissions:selection.omissions}:{}),
  ...(nativePlan&&nativeArtifact?{native_plan_sha256:nativePlan.nativePlanSha256,native_plan_artifact:nativeArtifact,
   native_annotation_inputs:{sourcePath:source.relativePath,expectedSourceSha256:source.sha256,nativePlanPath:nativeArtifact.relative_path,
    expectedNativePlanFileSha256:nativeArtifact.sha256,expectedNativePlanSha256:nativePlan.nativePlanSha256},
   native_annotation_summary:{entities:nativePlan.entities.filter(e=>['text','fill','dot'].includes(e.kind)).length,
    parts:Math.ceil(nativePlan.entities.filter(e=>['text','fill','dot'].includes(e.kind)).length/VECTOR_ANNOTATION_PART_SIZE),part_size:VECTOR_ANNOTATION_PART_SIZE,
    strokes_included:false,requires_exact_existing_view_id_and_unique_id:true},
   native_import_inputs:{sourcePath:source.relativePath,expectedSourceSha256:source.sha256,nativePlanPath:nativeArtifact.relative_path,
    expectedNativePlanFileSha256:nativeArtifact.sha256,expectedNativePlanSha256:nativePlan.nativePlanSha256},
   native_plan_summary:{entities:nativePlan.entities.length,parts:nativePlan.partCount,paper_width_inches:nativePlan.layout.paperWidthInches,paper_height_inches:nativePlan.paperHeightInches,view_scale:nativePlan.layout.viewScale,zero_length_source_commands:nativePlan.zeroLengthSourceCommands,limits:nativePlan.limits}}:{}),
  ...(cad?{stroke_cad_artifact:cad.artifact,stroke_cad_source_descriptor:cad.source,
   stroke_cad_summary:{source_strokes:cad.metadata.sourceStrokeCount,remaining_annotations:cad.metadata.sourceAnnotationCount,view_scale:cad.metadata.viewScale,
    representation:'embedded_CAD_vectors_not_individual_Revit_detail_curves',whole_drawing_verified:false,native_write_allowed:false},
   stroke_cad_style_page:{offset,limit,total:cad.cad.layerStyles.length,items:cad.cad.layerStyles.slice(Number(offset),Number(offset)+Number(limit)),
    nextOffset:Number(offset)+Number(limit)<cad.cad.layerStyles.length?Number(offset)+Number(limit):null},
   cad_style_correction_page:{offset,limit,total:cad.cad.layerStyles.length,
    native_authorization_supplied:false,style_equivalence_established:false,
    items:cad.cad.layerStyles.slice(Number(offset),Number(offset)+Number(limit)).map(style=>({source_layer:style.layer,
     method:'POST',path:'/revit/visibility',requires_unambiguous_native_layer_identity:true,
     body:{action:'set_category_override',lineWeight:style.weight,r:style.color[0],g:style.color[1],b:style.color[2]}})),
    nextOffset:Number(offset)+Number(limit)<cad.cad.layerStyles.length?Number(offset)+Number(limit):null,
    note:'Source-derived values only. Add the freshly identified native view/category target after inspecting current values and normal tool schema/authorization. Never resolve a duplicate layer basename to an arbitrary import. Keep already-correct values; do not reimport settled geometry to correct styling. Verify native overrides and actual drafting/sheet pixels afterward.'},
   cad_import_inputs:{sourcePath:cad.artifact.relative_path,expectedSourceSha256:cad.artifact.sha256,link:false,createDraftingView:false,placeOnSheet:false,
    placement:'origin',importUnit:'Foot',customScale:1,colorMode:'preserve',autoCorrectAlmostVHLines:false},
   cad_import_requires:{exact_existing_drafting_view:true,required_view_scale:cad.metadata.viewScale,current_native_request_schema:true,
    complete_source_native_geometry_comparison:true,source_pen_readback:true,source_annotation_creation_and_verification:true},
   cad_import_route_available:isSupportedToolRoute('POST','/revit/link-cad')}:{}),
  native_import_available:isSupportedToolRoute("POST","/revit/import-vector-detail"),native_import_status:isSupportedToolRoute("POST","/revit/import-vector-detail")?"supported_with_existing_authority":"withheld_pending_live_native_commit_qualification",
  native_curve_import_route:'/revit/import-vector-detail',
  native_curve_gate_scope:'individual_Revit_detail_curves_only_not_all_vector_representations',
  supported_linework_alternative:{vector_section:'stroke_cad',representation:'embedded_CAD_vectors_not_individual_Revit_detail_curves',
   import_route:'/revit/link-cad',route_available:isSupportedToolRoute('POST','/revit/link-cad'),
   requires_separate_native_authorization:true,whole_drawing_verified:false,
   style_source_table:'stroke_cad_style_page.items',
   style_closeout_guidance:'Read vector_section=stroke_cad with the exact source plan/layout to obtain the source style table and target-free cad_style_correction_page; workspace shell/file access is not required. Inspect the exact existing CAD through /revit/view-owned-detailing CAD pages: observed layerName and graphicsStyleId identify its layers. With /revit/native-api-ops, Document.GetElement(observed graphicsStyleId) then GraphicsStyleCategory gives the exact category; read Id, GetLineWeight(Projection), LineColor RGB and current view overrides. Use at most 16 operations per request (one layer can use eight). A parent category is not layer proof; CategoryNameMap.get_Item need not be exposed. Apply only a confirmed discrepancy through a separately authorized native override with an unambiguous target, then read back and visually inspect; source metadata never verifies styling or supplies native write authority.',
   guidance:'Use this supported alternative when the requested detail permits embedded vector linework with separate editable native text. Do not invent an individual-detail-curve requirement or interpret the withheld individual-curve route as blocking the separate CAD route. If the user explicitly requires individual detail curves, report that limitation instead.'},
  native_annotation_available:isSupportedToolRoute("POST","/revit/import-vector-annotations"),
  native_write_allowed:false,source_read_truncated:false,visual_review_established:false,
  note:"Source data only. Inspect mode=detail page/region pixels and retain source/native sheet/view context. Historical clouds/tags need explicit documented contour/text omissions, not whole-group deletion. Paper points are not model coordinates. Native importer must handle listed clipping/fill/font/tolerance requirements, preserve source ownership and read back actual created geometry/text; this source receipt is not model authorization or verification."};
 const json=JSON.stringify(result);if(Buffer.byteLength(json)>47500)throw Error("Whole vector record page exceeds output budget; reduce vector_limit or narrow vector_filter_region. Complete source artifact retained; no record or text was clipped.");
 return{content:[{type:"text",text:json}]};
}
