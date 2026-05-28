import type { ChatRequest, ChatResponse } from "../contracts.js";

export function detectUnverifiedTitleblockEdit(req: ChatRequest): boolean {
  const trs: any[] = Array.isArray(req.tool_results) ? (req.tool_results as any) : [];
  if (trs.length === 0) return false;

  const hasTitleblockApply = trs.some(tr => {
    if (!tr || typeof tr !== "object") return false;
    if (String(tr.path ?? "") !== "/revit/set-parameter") return false;
    if (String(tr.status ?? "") !== "done") return false;
    const r: any = tr.result_json;
    if (!r || typeof r !== "object") return false;
    if (r.dryRun === true) return false;
    const impacts = Array.isArray((r as any).titleblockImpacts) ? (r as any).titleblockImpacts : [];
    return impacts.length > 0;
  });

  if (!hasTitleblockApply) return false;

  // Consider it verified if we have any image evidence capture tool result after the apply in this turn.
  const hasEvidence = trs.some(tr => {
    if (!tr || typeof tr !== "object") return false;
    const path = String(tr.path ?? "");
    if (path !== "/revit/capture-sheet-region" && path !== "/revit/verify-parameter-on-sheet") return false;
    if (String(tr.status ?? "") !== "done") return false;
    const atts = Array.isArray((tr as any).attachments) ? (tr as any).attachments : [];
    return atts.some((a: any) => a && String(a.kind ?? "").toLowerCase() === "image");
  });

  return !hasEvidence;
}

export function enforceVerificationDisclaimer(req: ChatRequest, decision: ChatResponse): ChatResponse {
  if (!detectUnverifiedTitleblockEdit(req)) return decision;

  const msg = (decision.assistant_message ?? "").toString();
  if (/not verified/i.test(msg)) return decision;

  const extra =
    "\n\nNot verified: A titleblock parameter was edited but I do not have a post-change sheet/titleblock capture to confirm the displayed value. " +
    "Please run a sheet titleblock capture (or ask me to) so I can verify.";

  return { ...decision, assistant_message: (msg ? msg + extra : extra.trim()) };
}

