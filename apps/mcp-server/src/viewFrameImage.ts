import { readSpatialObservationImage, type SpatialObservationImageReader } from "./spatialObservationV1.js";
import { createHash } from "node:crypto";

const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
const VISIBLE_INVENTORY_PRESENTATION_LIMIT_BYTES = 512 * 1024;
const VISIBLE_INVENTORY_ITEM_BUDGET_BYTES = 384 * 1024;
const VISIBLE_INVENTORY_ITEM_LIMIT = 128;
const REGISTRATION_AND_MEP_CATEGORIES = new Set([
  "OST_Grids", "OST_MechanicalEquipment", "OST_DuctCurves", "OST_DuctFitting",
  "OST_DuctTerminal", "OST_DuctAccessory", "OST_FlexDuctCurves", "OST_PipeCurves",
  "OST_PipeFitting", "OST_PlumbingFixtures", "OST_ElectricalEquipment", "OST_ElectricalFixtures"
]);
type ImageContent = {type:"image";data:string;mimeType:string};
type TextContent = {type:"text";text:string};
type NativeImageRoute = "/revit/export-view-frame" | "/revit/export-visible-elements";

/** Only reviewed image-producing native routes may promote their capture path. */
export function nativeViewImageContent(method: string, path: string, data: unknown,
  readImage: SpatialObservationImageReader = readSpatialObservationImage): {content:Array<TextContent|ImageContent>} | null {
  if (method === "POST" && path === "/revit/mep-route-workflow") return workflowImageContent(data, readImage);
  if (method === "POST" && (path === "/revit/export-image" || path === "/revit/capture-screenshare")) return captureImageContent(data, path, readImage);
  if (method !== "POST" || (path !== "/revit/export-view-frame" && path !== "/revit/export-visible-elements")) return null;
  return nativeImageContent(data, path, readImage);
}

/** A one-shot window capture or native view export already contains the needed
 * pixels. Deliver them in this result rather than making the agent find a file
 * reader or capture the same scene again. Neither image has pixel/model mapping. */
export function captureImageContent(data: unknown, route: "/revit/export-image" | "/revit/capture-screenshare",
  readImage: SpatialObservationImageReader = readSpatialObservationImage): {content:Array<TextContent|ImageContent>} {
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, any> : {};
  const settlement = root.canonical_attempt_settlement;
  const successful = root.ok !== false && root.error == null
    && (root.status == null || /^(?:ok|success|succeeded|complete|completed|captured)$/i.test(String(root.status)));
  const identity = route === "/revit/export-image"
    ? Number.isSafeInteger(root.viewId) && root.viewId > 0 && typeof root.timestamp === "string" && Number.isFinite(Date.parse(root.timestamp))
    : root.ok === true && root.kind === "screenshare" && typeof root.captured_at === "string" && Number.isFinite(Date.parse(root.captured_at))
      && typeof root.sha256 === "string" && /^[a-f0-9]{64}$/i.test(root.sha256) && Number.isSafeInteger(root.bytes) && root.bytes > 0;
  const valid = successful && identity && typeof root.path === "string" && root.path.trim().length > 0
    && settlement?.effect_state === "none" && settlement.requested_effect === "read"
    && settlement.method === "POST" && settlement.path === route;
  let pixels = valid ? readImage(root.path, IMAGE_LIMIT_BYTES) : {ok:false as const,reason:"Native capture contract or read settlement is missing or unsuccessful"};
  if (pixels.ok && route === "/revit/capture-screenshare") {
    const bytes=Buffer.from(pixels.data,"base64");
    if (bytes.length !== root.bytes || createHash("sha256").update(bytes).digest("hex") !== root.sha256.toLowerCase())
      pixels={ok:false,reason:"Capture pixels no longer match the native screenshot receipt"};
  }
  const imageDelivery = pixels.ok ? {available:true} : {available:false,reason:pixels.reason,
    instruction:"The capture pixels were not delivered. Do not claim to have viewed this image. Use a supported capture or attachment reader."};
  return {content:[{type:"text",text:JSON.stringify({...root,image_delivery:imageDelivery},null,2)},
    ...(pixels.ok ? [{type:"image" as const,data:pixels.data,mimeType:pixels.mimeType}] : [])]};
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
  const presented = frame && expectedRoute === "/revit/export-visible-elements"
    ? projectLargeVisibleInventoryForAgent(frame)
    : frame;
  const content:Array<TextContent|ImageContent> = [{type:"text",text:JSON.stringify(presented ? {...presented,image_delivery:imageDelivery} : {native_result:data,image_delivery:imageDelivery},null,2)}];
  if(image.ok) content.push({type:"image",data:image.data,mimeType:image.mimeType});
  return {content};
}

/** Keep the authoritative native payload in the evidence ledger. A floor-wide
 * inventory can be megabytes of linked walls and doors; the model receives the
 * same image, frame mapping, grid/MEP anchors, and an explicit partial-inventory
 * notice so it can request a bounded modelBounds/category read when needed. */
function projectLargeVisibleInventoryForAgent(frame: Record<string, unknown>): Record<string, unknown> {
  const items = Array.isArray(frame.items) ? frame.items : null;
  if (!items || JSON.stringify(frame).length <= VISIBLE_INVENTORY_PRESENTATION_LIMIT_BYTES) return frame;
  const retained: unknown[] = [];
  let retainedBytes = 0;
  const omittedByCategory: Record<string, number> = {};
  for (const item of items) {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const category = String(row.categoryToken ?? row.builtInCategory ?? row.category ?? "unknown");
    const bytes = JSON.stringify(item).length;
    if (REGISTRATION_AND_MEP_CATEGORIES.has(category)
      && retained.length < VISIBLE_INVENTORY_ITEM_LIMIT
      && retainedBytes + bytes <= VISIBLE_INVENTORY_ITEM_BUDGET_BYTES) {
      retained.push(item);
      retainedBytes += bytes;
    } else {
      omittedByCategory[category] = (omittedByCategory[category] ?? 0) + 1;
    }
  }
  return {
    ...frame,
    items: retained,
    agent_projection: {
      schema: "revit-operator.visible-inventory-agent-projection.v1",
      items_complete: false,
      native_item_count: items.length,
      included_item_count: retained.length,
      omitted_item_count: items.length - retained.length,
      omitted_by_category: omittedByCategory,
      instruction: "The image and frame mapping are complete, but this text omits inventory rows. Query a smaller modelBounds or category with /revit/export-visible-elements or /revit/find-elements before asserting absence, counting, or selecting an omitted element."
    }
  };
}
