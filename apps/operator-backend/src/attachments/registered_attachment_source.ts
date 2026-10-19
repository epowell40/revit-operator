import path from "node:path";
import {createHash} from "node:crypto";
import {findSessionUploadById} from "./upload_index.js";
import {readLocalWorkspaceFile} from "./inline_images.js";
import {getWorkspaceRoot} from "../workspace.js";

/** Current host-owned conversation + immutable upload namespace, never a caller path. */
export function readRegisteredAttachmentSource(sessionId:string,attachmentId:string){
  if(!sessionId.trim()||sessionId.length>300)throw Error("No current conversation is bound to the attachment read.");
  if(!/^[A-Za-z0-9_-]{1,160}$/.test(attachmentId))throw Error("A registered attachment ID is required, not a path.");
  const record=findSessionUploadById(sessionId,attachmentId);
  if(!record)throw Error("This attachment is not registered in the current conversation. Use an ID from its uploaded attachments.");
  const relative=record.relative_path??"";
  if(!/^artifacts\/uploads\/[^/\\]+$/.test(relative)||relative.includes(":"))throw Error("The registered attachment path is invalid.");
  if(!/^[a-f0-9]{64}$/i.test(record.sha256??""))throw Error("The attachment has no immutable upload hash; upload the intended version again.");
  const bytes=readLocalWorkspaceFile(path.resolve(getWorkspaceRoot(),relative),32*1024*1024);
  if(!bytes)throw Error("Cannot safely read this attachment within the 32 MiB limit.");
  const sha256=createHash("sha256").update(bytes).digest("hex");
  if(sha256!==record.sha256!.toLowerCase())throw Error("The attachment changed since upload; upload the intended version again.");
  return{bytes,sha256,record,relativePath:relative};
}
