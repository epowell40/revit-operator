import { createHash } from "node:crypto";
import path from "node:path";
import { findSessionUploadById } from "../attachments/upload_index.js";
import { readLocalWorkspaceFile } from "../attachments/inline_images.js";
import { buildPdfJsDocumentOptions, loadPdfJsForNode } from "../pdf/pdfjs_node.js";
import { getWorkspaceRoot } from "../workspace.js";
import { localExecutorCapability } from "./local_advisory_policy.js";
import type { PdfWorkAllowanceV1 } from "../domain/assignment-kernel/execution_policy.js";
export type { PdfWorkAllowanceV1 } from "../domain/assignment-kernel/execution_policy.js";

/** Count source workload, never agent claims or completion. Call only before
 * creation, after exact semantic intake and authenticated upload registration. */
export async function preparePdfWorkAllowance(input: Record<string, unknown>): Promise<PdfWorkAllowanceV1 | undefined> {
  const budget=input.work_budget as Record<string, unknown> | undefined;
  if (process.env.OPERATOR_LOCAL_PDF_WORK_ALLOWANCE !== "marked_pdf_sheets_v1" || !localExecutorCapability()
    || input.start_assignment_run !== true || budget?.requested_effect !== "apply") return undefined;
  const ids=budget.attachment_ids;
  if (!Array.isArray(ids) || !ids.length) return undefined;
  if (ids.length>8 || ids.some(id=>typeof id!=="string" || !/^[A-Za-z0-9_-]{1,160}$/.test(id))) throw Error("pdf_work_allowance_attachment_ids_invalid");
  const sources: PdfWorkAllowanceV1["sources"]=[], hashes=new Set<string>();
  for (const id of new Set(ids as string[])) {
    const record=findSessionUploadById(String(input.session_id??""),id);
    if (!record) throw Error("pdf_work_allowance_attachment_not_registered");
    if (record.mime!=="application/pdf" && !/\.pdf$/i.test(record.filename??"")) continue;
    if (!/^artifacts\/uploads\/[^/\\]+$/.test(record.relative_path??"")) throw Error("pdf_work_allowance_path_invalid");
    const bytes=readLocalWorkspaceFile(path.resolve(getWorkspaceRoot(),record.relative_path!),32*1024*1024);
    if (!bytes || createHash("sha256").update(bytes).digest("hex")!==record.sha256) throw Error("pdf_work_allowance_source_changed");
    if (hashes.has(record.sha256!)) continue;
    hashes.add(record.sha256!);
    sources.push(await inspectPdfWorkAllowance(bytes));
  }
  const units=sources.reduce((sum,source)=>sum+source.sheets.reduce((n,sheet)=>n+sheet.units,0),0);
  if (!units) return undefined; // Flattened marks need visual scope; do not claim a zero-work document.
  if (units>24) throw Error("pdf_work_allowance_requires_bounded_batch_max_24_units");
  return {mode:"marked_pdf_sheets_v1",units,sources};
}

export async function inspectPdfWorkAllowance(bytes: Buffer): Promise<PdfWorkAllowanceV1["sources"][number]> {
  const pdfjs=await loadPdfJsForNode();
  const document=await pdfjs.getDocument({...buildPdfJsDocumentOptions(new Uint8Array(bytes)),isEvalSupported:false}).promise;
  try {
    if (document.numPages>100) throw Error("pdf_work_allowance_requires_bounded_document_max_100_pages");
    const sheets: PdfWorkAllowanceV1["sources"][number]["sheets"]=[];
    for(let page=1;page<=document.numPages;page++){
      const sheet=await document.getPage(page);
      try {
        const marks=(await sheet.getAnnotations({intent:"display"})).filter((a:any)=>
          !["Link","Widget","Popup"].includes(a.subtype) && !(Number(a.annotationFlags??0)&(1|2|32)) && !a.inReplyTo);
        if (!marks.length) continue;
        const comments=marks.filter((a:any)=>typeof a.contentsObj?.str==="string" && a.contentsObj.str.trim()).length;
        sheets.push({page,comments,units:Math.max(1,Math.ceil(comments/5))});
      } finally {sheet.cleanup();}
    }
    return {sha256:createHash("sha256").update(bytes).digest("hex"),page_count:document.numPages,sheets};
  } finally {await document.destroy();}
}
