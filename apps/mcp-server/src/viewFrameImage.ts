import { readSpatialObservationImage, type SpatialObservationImageReader } from "./spatialObservationV1.js";

const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
type ImageContent = {type:"image";data:string;mimeType:string};
type TextContent = {type:"text";text:string};

/** Presentation of a native export-view-frame response; never a generic file reader. */
export function viewFrameImageContent(data: unknown, readImage: SpatialObservationImageReader = readSpatialObservationImage): {content:Array<TextContent|ImageContent>} {
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
      && settlement.method === "POST" && settlement.path === "/revit/export-view-frame"));
  const image = validFrame
    ? readImage(frame.path as string, IMAGE_LIMIT_BYTES)
    : {ok:false as const,reason:"Native view-frame image contract is missing or unsuccessful"};
  const imageDelivery = image.ok ? {available:true} : {available:false,reason:image.reason,
    instruction:"The view image was not delivered. Obtain a usable view image before interpreting its pixels or claiming visual verification."};
  const content:Array<TextContent|ImageContent> = [{type:"text",text:JSON.stringify(frame ? {...frame,image_delivery:imageDelivery} : {native_result:data,image_delivery:imageDelivery},null,2)}];
  if(image.ok) content.push({type:"image",data:image.data,mimeType:image.mimeType});
  return {content};
}
