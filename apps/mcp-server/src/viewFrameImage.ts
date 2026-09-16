import { readSpatialObservationImage, type SpatialObservationImageReader } from "./spatialObservationV1.js";

const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
type ImageContent = {type:"image";data:string;mimeType:string};
type TextContent = {type:"text";text:string};
type NativeImageRoute = "/revit/export-view-frame" | "/revit/export-visible-elements";

/** Only reviewed image-producing native routes may promote their capture path. */
export function nativeViewImageContent(method: string, path: string, data: unknown,
  readImage: SpatialObservationImageReader = readSpatialObservationImage): {content:Array<TextContent|ImageContent>} | null {
  if (method === "POST" && path === "/revit/mep-route-workflow") return workflowImageContent(data, readImage);
  if (method !== "POST" || (path !== "/revit/export-view-frame" && path !== "/revit/export-visible-elements")) return null;
  return nativeImageContent(data, path, readImage);
}

function workflowImageContent(data:unknown,readImage:SpatialObservationImageReader):{content:Array<TextContent|ImageContent>} {
  const row=(v:unknown):Record<string,any>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,any>:{};
  const root=row(data),apply=row(root.applyResult),visual=row(root.visualVerification),capture=row(visual.capture),visibility=row(capture.elementVisibility);
  const ids=(v:unknown):number[]|null=>Array.isArray(v)&&v.every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(v).size===v.length?v:null;
  const equalIds=(a:unknown,b:number[])=>{const values=ids(a);return values!==null&&values.length===b.length&&values.every(n=>b.includes(n));};
  const segments=ids(apply.createdElementIds),fittings=ids(apply.createdFittingIds),targets=[...(segments??[]),...(fittings??[])];
  const settlement=root.canonical_attempt_settlement;
  const valid=root.status==="AppliedVisualVerificationReady"&&root.workflowMode==="apply"
    &&row(root.transaction).status==="committed"&&row(root.transaction).committed===true
    &&row(apply.transaction).status==="committed"&&row(apply.transaction).committed===true
    &&["CreatedAndConnected","CreatedWithOpenConnectors"].includes(apply.status)
    &&segments!==null&&fittings!==null&&targets.length>0&&new Set(targets).size===targets.length
    &&visual.status==="CaptureReadyForAIReview"&&equalIds(visual.createdElementIds,segments)&&equalIds(visual.createdFittingIds,fittings)
    &&typeof capture.path==="string"&&capture.path.trim().length>0&&visual.capturePath===capture.path
    &&Number.isSafeInteger(capture.widthPx)&&capture.widthPx>0&&Number.isSafeInteger(capture.heightPx)&&capture.heightPx>0
    &&capture.ok!==false&&capture.error==null&&visibility.allRequestedElementsVisible===true
    &&Number.isSafeInteger(visibility.viewId)&&visibility.viewId>0
    &&equalIds(visibility.requestedElementIds,targets)&&equalIds(visibility.visibleElementIds,targets)&&equalIds(visibility.notVisibleElementIds,[])
    &&(!settlement||(settlement.effect_state==="applied"&&settlement.requested_effect==="apply"&&settlement.method==="POST"&&settlement.path==="/revit/mep-route-workflow"));
  const image=valid?readImage(capture.path,IMAGE_LIMIT_BYTES):{ok:false as const,reason:"Committed route capture contract is missing or unsuccessful"};
  const imageDelivery=image.ok?{available:true}:{available:false,reason:image.reason,
    instruction:"The post-change image was not delivered. Obtain a usable view image before claiming visual verification. Do not repeat the committed route to obtain an image."};
  const content:Array<TextContent|ImageContent>=[{type:"text",text:JSON.stringify({...root,image_delivery:imageDelivery},null,2)}];
  if(image.ok)content.push({type:"image",data:image.data,mimeType:image.mimeType});
  return {content};
}

/** Presentation of a native export-view-frame response; never a generic file reader. */
export function viewFrameImageContent(data: unknown, readImage: SpatialObservationImageReader = readSpatialObservationImage): {content:Array<TextContent|ImageContent>} {
  return nativeImageContent(data, "/revit/export-view-frame", readImage);
}

function nativeImageContent(data: unknown, expectedRoute: NativeImageRoute, readImage: SpatialObservationImageReader): {content:Array<TextContent|ImageContent>} {
  const frame = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const settlement = frame?.canonical_attempt_settlement as Record<string, unknown> | undefined;
  const validFrame = frame && typeof frame.frameId === "string" && frame.frameId.trim().length > 0
    && typeof frame.path === "string" && frame.path.trim().length > 0
    && Number.isSafeInteger(frame.viewId) && Number(frame.viewId) > 0
    && Number.isSafeInteger(frame.widthPx) && Number(frame.widthPx) > 0
    && Number.isSafeInteger(frame.heightPx) && Number(frame.heightPx) > 0
    && frame.ok !== false && frame.error == null
    && (frame.status == null || (typeof frame.status === "string" && /^(?:ok|success|succeeded|complete|completed)$/i.test(frame.status)))
    && (!settlement || (settlement.effect_state === "none" && settlement.requested_effect === "read"
      && settlement.method === "POST" && settlement.path === expectedRoute));
  const image = validFrame
    ? readImage(frame.path as string, IMAGE_LIMIT_BYTES)
    : {ok:false as const,reason:"Native view-frame image contract is missing or unsuccessful"};
  const imageDelivery = image.ok ? {available:true} : {available:false,reason:image.reason,
    instruction:"The view image was not delivered. Obtain a usable view image before interpreting its pixels or claiming visual verification."};
  const content:Array<TextContent|ImageContent> = [{type:"text",text:JSON.stringify(frame ? {...frame,image_delivery:imageDelivery} : {native_result:data,image_delivery:imageDelivery},null,2)}];
  if(image.ok) content.push({type:"image",data:image.data,mimeType:image.mimeType});
  return {content};
}
