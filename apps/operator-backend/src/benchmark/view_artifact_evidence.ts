import fs from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { directKernelPublicationsV2 } from "./protocol_v2_kernel.js";
import { assignmentKernelNativeEvidenceProjectionV2 } from "./assignment_kernel_v2_native_evidence.js";
import type { GeneralRevitAttempt, GeneralRevitCapabilityCase } from "./general_revit_capability_acceptance.js";

type Row = Record<string, unknown>;
function row(v: unknown): Row { return v && typeof v === "object" && !Array.isArray(v) ? v as Row : {}; }
const capturePaths = new Set(["/revit/export-view-frame", "/revit/export-visible-elements", "/revit/export-image"]);

// Bounded, non-interlaced 8-bit PNG structure and scanline validation. Other encodings remain unverified.
function validPng(bytes: Buffer, payload: Row): boolean {
  if (bytes.length < 45 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return false;
  let offset=8, width=0, height=0, channels=0, ended=false, dataClosed=false; const parts: Buffer[]=[];
  while (offset+12 <= bytes.length) {
    const length=bytes.readUInt32BE(offset), end=offset+12+length;
    if (end>bytes.length) return false;
    const kind=bytes.toString("ascii",offset+4,offset+8), data=bytes.subarray(offset+8,end-4);
    if (offset===8 && kind!=="IHDR") return false;
    if (!/^[A-Za-z]{4}$/.test(kind) || (/^[A-Z]/.test(kind) && !["IHDR","IDAT","IEND","PLTE"].includes(kind))) return false;
    if (parts.length && kind!=="IDAT") dataClosed=true;
    let crc=0xffffffff;
    for (const value of bytes.subarray(offset+4,end-4)) { crc ^= value; for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
    if (((crc^0xffffffff)>>>0)!==bytes.readUInt32BE(end-4)) return false;
    if (kind==="IHDR") {
      if (offset!==8 || length!==13 || data[8]!==8 || data[10]!==0 || data[11]!==0 || data[12]!==0) return false;
      width=data.readUInt32BE(0); height=data.readUInt32BE(4); channels=({0:1,2:3,4:2,6:4} as Record<number,number>)[data[9]!] || 0;
      if (!width || !height || !channels || height*(width*channels+1)>64*1024*1024) return false;
    } else if (kind==="IDAT") { if(!channels || dataClosed) return false; parts.push(data); }
    else if (kind==="IEND") { if(length || end!==bytes.length) return false; ended=true; break; }
    offset=end;
  }
  if (!ended || !parts.length || !channels) return false;
  const stride=width*channels+1, decoded=inflateSync(Buffer.concat(parts),{maxOutputLength:64*1024*1024});
  if (decoded.length!==height*stride) return false;
  for(let y=0;y<height;y++) if(decoded[y*stride]!>4) return false;
  return (payload.widthPx===undefined || payload.widthPx===width) && (payload.heightPx===undefined || payload.heightPx===height);
}

/** Capture identity is a prerequisite, not an automated judgement of visual legibility. */
export function requestedViewArtifactEvidence(testCase: GeneralRevitCapabilityCase, attempt: GeneralRevitAttempt): boolean | null {
  const target = testCase.fixture_precondition?.active_view;
  if (testCase.expected_effect !== "read" || !target || !testCase.dispatch_any_of.some(p => capturePaths.has(p))) return null;
  const native = assignmentKernelNativeEvidenceProjectionV2(attempt.assignment_kernel_v2);
  if (native.malformed || !native.present) return false;
  let publications: Row[];
  try { publications = directKernelPublicationsV2({ durable_assignment_kernel_v2: attempt.assignment_kernel_v2 }); }
  catch { return false; }
  for (const evidence of native.operations) {
    if (evidence.outcome !== "completed" || evidence.requested_effect !== "read" || !capturePaths.has(evidence.path)) continue;
    const publication = publications.find(p => p.assignment_id === evidence.assignment_id
      && row(row(row(p.snapshot).operations)[evidence.operation_id]).result
      && row(row(row(row(p.snapshot).operations)[evidence.operation_id]).result).result_id === evidence.result_id);
    const snapshot = row(publication?.snapshot);
    const operation = row(row(snapshot.operations)[evidence.operation_id]);
    const result = row(operation.result);
    if (result.authority !== "native-host" || result.persistent_effect !== "none") continue;
    const document = row(snapshot.current_binding).document_fingerprint;
    if (typeof document !== "string" || !document || row(operation.binding).document_fingerprint !== document
      || row(result.binding).document_fingerprint !== document
      || !evidence.observation_ids.some(id => row(row(row(snapshot.observations)[id]).binding).document_fingerprint === document)) continue;
    const payload = row(row(operation.observation_commit).raw_payload);
    if (payloadDigestV2(payload).digest !== result.raw_payload_hash) continue;
    if (!Number.isSafeInteger(payload.viewId) || Number(payload.viewId) <= 0 || payload.viewName !== target.name
      || (target.view_type && payload.viewType !== target.view_type)) continue;
    const filename = typeof payload.path === "string" ? payload.path : "";
    const start = Date.parse(evidence.dispatched_at || ""), end = Date.parse(evidence.completed_at || "");
    if (!path.isAbsolute(filename) || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    // Only a locally retained supported PNG from this operation's interval qualifies; JPEG remains unverified.
    let fd: number | undefined;
    try {
      fd = fs.openSync(filename, "r");
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 12 || stat.size > 64 * 1024 * 1024
        || stat.mtimeMs < start - 2_000 || stat.mtimeMs > end + 2_000) continue;
      const header = Buffer.alloc(12); fs.readSync(fd, header, 0, header.length, 0);
      const png = header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      if (!png) continue;
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length-offset, offset); if (!count) break; offset += count; }
      if (offset !== bytes.length) continue;
      if (validPng(bytes,payload)) return true;
    } catch { /* Missing or inaccessible artifacts remain unverified during replay. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return false;
}
