import type http from "node:http";
import { readJson, writeJson } from "../http.js";
import { getEvidenceContextBudget } from "./model_context_budget.js";
import { readEvidenceTelemetrySummary, retrieveEvidence, storeEvidence } from "./evidence_store.js";

export async function handleEvidenceHttpRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<boolean> {
  if (req.method === "POST" && url.pathname === "/evidence/store") {
    try {
      const body = await readJson(req, 32_000_000) as any;
      const raw = typeof body?.raw_base64 === "string"
        ? Buffer.from(body.raw_base64, "base64")
        : Object.prototype.hasOwnProperty.call(body ?? {}, "raw_json")
          ? body.raw_json
          : typeof body?.raw_text === "string"
            ? body.raw_text
            : undefined;
      if (raw === undefined) {
        writeJson(res, 400, { error: "raw_json, raw_text, or raw_base64 is required." });
        return true;
      }
      if (body.trust_level != null && body.trust_level !== "untrusted_caller") {
        writeJson(res, 400, { error: "Caller-submitted evidence is always untrusted until independently verified." });
        return true;
      }
      const stored = storeEvidence({
        scope: body.scope,
        source: body.source,
        media_type: body.media_type,
        trust_level: "untrusted_caller",
        target_scope: body.target_scope,
        bounded_summary: body.bounded_summary,
        verification_relevance: body.verification_relevance,
        relationships: body.relationships,
        raw
      }, getEvidenceContextBudget().item_bytes);
      writeJson(res, 201, { ok: true, ...stored });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/evidence/retrieve") {
    try {
      const body = await readJson(req, 100_000);
      writeJson(res, 200, { ok: true, result: retrieveEvidence(body as any) });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/evidence/telemetry") {
    writeJson(res, 200, {
      ok: true,
      summary: readEvidenceTelemetrySummary({
        ...(url.searchParams.get("session_id") ? { session_id: url.searchParams.get("session_id")! } : {}),
        ...(url.searchParams.has("assignment_id") ? { assignment_id: url.searchParams.get("assignment_id") } : {})
      })
    });
    return true;
  }

  return false;
}
