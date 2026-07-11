import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AEC_INTENT_EVIDENCE_MAX_STRING_CHARS, AEC_INTENT_EVIDENCE_MAX_URI_CHARS, AEC_INTENT_EVIDENCE_V1_SCHEMA, normalizeAecIntentEvidenceV1, type AecIntentEvidenceV1 } from "../aec_intent_evidence.js";
import type { RedlineAnalyzeResponse } from "./redline_analyzer.js";

export type RedlineAnalyzeEvidenceOptions = { id: string; created_at: string; sha256?: string; host?: AecIntentEvidenceV1["origin"]["host"] };
const MAX_ITEMS_PER_KIND = 256, MAX_EVIDENCE_ITEMS = 768;
type ArtifactRef = { path?: string; uri?: string; omitted?: boolean };
type NormalizedBox = { min_x: number; min_y: number; max_x: number; max_y: number };

function bounded(value: unknown): { text?: string; text_truncated?: boolean } { return typeof value !== "string" ? {} : value.length > AEC_INTENT_EVIDENCE_MAX_STRING_CHARS ? { text: value.slice(0, AEC_INTENT_EVIDENCE_MAX_STRING_CHARS), text_truncated: true } : { text: value }; }
function artifactRef(value: unknown): ArtifactRef {
  const raw = typeof value === "string" ? value.replace(/\\/g, "/").trim() : "";
  const path = raw.startsWith("/") || /^[A-Za-z]:\//.test(raw) ? raw.split("/").at(-1) || "" : raw;
  if (!path || path.length > AEC_INTENT_EVIDENCE_MAX_URI_CHARS) return { omitted: true };
  try { const uri = `artifact://${encodeURIComponent(path)}`; return uri.length <= AEC_INTENT_EVIDENCE_MAX_URI_CHARS ? { path, uri } : { omitted: true }; } catch { return { omitted: true }; }
}
function uri(ref: ArtifactRef, page?: number): string | undefined {
  if (!ref.uri) return undefined;
  const value = `${ref.uri}${page ? `#page=${page}` : ""}`;
  return value.length <= AEC_INTENT_EVIDENCE_MAX_URI_CHARS ? value : undefined;
}
function box(raw: any): NormalizedBox | undefined {
  const min_x = raw?.min_x ?? raw?.minX, min_y = raw?.min_y ?? raw?.minY, max_x = raw?.max_x ?? raw?.maxX, max_y = raw?.max_y ?? raw?.maxY;
  return [min_x, min_y, max_x, max_y].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1) && min_x <= max_x && min_y <= max_y ? { min_x, min_y, max_x, max_y } : undefined;
}
function pageNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined; }
function confidence(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined; }
function safeActions(response: RedlineAnalyzeResponse): AecIntentEvidenceV1["intent"]["proposed_actions"] { return response.suggested_revit_calls.filter((call) => call.method === "POST" && (call.path === "/revit/sheets" || call.path === "/revit/get-titleblock-info")).map((call) => ({ tool: call.path, body: JSON.parse(JSON.stringify(call.body)), requires_apply: false })); }
function evidenceBase(ref: ArtifactRef, sha256: string | undefined, page: number) { return { ...(uri(ref, page) ? { uri: uri(ref, page) } : {}), ...(sha256 ? { sha256 } : {}) }; }

export function adaptRedlineAnalyzeToAecIntentEvidence(response: RedlineAnalyzeResponse, options: RedlineAnalyzeEvidenceOptions): AecIntentEvidenceV1 {
  const ref = artifactRef(response.file_path), evidence: AecIntentEvidenceV1["evidence"] = [], pages = response.pages ?? [], annotationSource = response.pdf_annotations ?? [], candidates = response.route_candidates ?? [], annotations = annotationSource.slice(0, MAX_ITEMS_PER_KIND), annotationPages = new Map<number, Set<number>>(), omitted = new Map<string, number>();
  for (const [category, source] of [["pages", pages], ["annotations", annotationSource], ["route candidates", candidates]] as const) if (source.length > MAX_ITEMS_PER_KIND) omitted.set(category, source.length - MAX_ITEMS_PER_KIND);
  const add = (category: string, item: AecIntentEvidenceV1["evidence"][number]) => { if (evidence.length < MAX_EVIDENCE_ITEMS) evidence.push(item); else omitted.set(category, (omitted.get(category) ?? 0) + 1); };
  for (const annotation of annotations) { const page = pageNumber(annotation.page); if (page) { const set = annotationPages.get(annotation.annotation_index) ?? new Set<number>(); set.add(page); annotationPages.set(annotation.annotation_index, set); } }
  for (const page of pages.slice(0, MAX_ITEMS_PER_KIND)) { const number = pageNumber(page.page); if (number) add("aggregate", { id: `pdf-page-${number}`, kind: "pdf_page", source: { kind: "adapter", field: "pages" }, ...evidenceBase(ref, options.sha256, number), page: { number, label: `page-${number}` }, frame: { id: `pdf-page-${number}-normalized`, coordinate_frame: `pdf-page-${number}-normalized`, units: "normalized" }, ...bounded(page.text_excerpt), confidence: 1 }); }
  for (const annotation of annotations) { const page = pageNumber(annotation.page); if (!page) continue; const normalized = box(annotation.box_norm); add("aggregate", { id: `pdf-annotation-${page}-${annotation.annotation_index}`, kind: "pdf_annotation", source: { kind: "adapter", field: "pdf_annotations" }, ...evidenceBase(ref, options.sha256, page), ...(annotation.contents ? bounded(annotation.contents) : {}), page: { number: page, ...(normalized ? { normalized_box: normalized } : {}) }, frame: { id: `pdf-page-${page}-normalized`, coordinate_frame: `pdf-page-${page}-normalized`, units: "normalized" }, confidence: annotation.is_red_like ? 0.8 : 0.5 }); }
  for (const candidate of candidates.slice(0, MAX_ITEMS_PER_KIND)) {
    const refs = [...new Set([...candidate.target_annotation_indices, ...candidate.label_annotation_indices])], pages = new Set(refs.flatMap((index) => [...(annotationPages.get(index) ?? [])])), page = pages.size === 1 && refs.length ? [...pages][0] : undefined, normalized = box(candidate.box_norm), candidateConfidence = confidence(candidate.confidence);
    if (!page || !normalized || candidateConfidence === undefined) continue;
    add("aggregate", { id: `sheet-region-${candidate.candidate_index}-${page}`, kind: "sheet_region", source: { kind: "adapter", field: "route_candidates" }, ...evidenceBase(ref, options.sha256, page), ...bounded(candidate.label_text), page: { number: page, normalized_box: normalized }, frame: { id: `pdf-page-${page}-normalized`, coordinate_frame: `pdf-page-${page}-normalized`, units: "normalized" }, confidence: candidateConfidence });
  }
  const frames = [...new Set(evidence.map((item) => item.frame?.id).filter((id): id is string => !!id))].map((id) => ({ id, kind: "pdf_page_normalized" as const, units: "normalized" as const }));
  const sheetNumber = response.likely_sheet === true && typeof response.primary_sheet_number === "string" && response.primary_sheet_number.trim() ? response.primary_sheet_number.trim() : undefined;
  const omission = ref.omitted ? ["Artifact path and URI were omitted because their bounded encoded representation exceeds the evidence contract."] : [];
  const truncation = [...omitted].map(([category, count]) => `Redline ${category} omitted ${count} item(s) after deterministic cap.`);
  return normalizeAecIntentEvidenceV1({ schema: AEC_INTENT_EVIDENCE_V1_SCHEMA, id: options.id, revision: 1, created_at: options.created_at, correlation: {}, origin: { host: options.host ?? { kind: "other", name: "revit-operator-backend" }, producer: { kind: "deterministic", name: "redline_analyze" } }, evidence, coordinate_frames: frames, target: { status: sheetNumber ? "ambiguous" : "unresolved", ...(ref.path ? { document: { path: ref.path, ...(options.sha256 ? { fingerprint: options.sha256 } : {}) } } : {}), ...(sheetNumber ? { sheet: { number: sheetNumber } } : {}) }, intent: { domain: "redline", action: "interpret_redline", proposed_actions: safeActions(response) }, constraints: truncation, assumptions: ["PDF-to-Revit transform is not established."], open_questions: [...omission, ...truncation, sheetNumber ? "Confirm the candidate Revit sheet before any model action." : "Resolve the target Revit sheet before any model action."], confidence: { value: sheetNumber ? 0.5 : 0.2, basis: "deterministic", reasons: ["native_redline_analysis"] }, verification: { required: ["dry_run", "apply", "readback", "visual", "revert"], observed: ["dry_run", "apply", "readback", "visual", "revert"].map((gate) => ({ gate, status: "not_run" as const })) } });
}

export async function tryCreateRedlineAnalyzeEvidence(response: RedlineAnalyzeResponse, options: Omit<RedlineAnalyzeEvidenceOptions, "sha256">): Promise<AecIntentEvidenceV1 | undefined> {
  try { return adaptRedlineAnalyzeToAecIntentEvidence(response, { ...options, sha256: createHash("sha256").update(await readFile(response.full_path)).digest("hex") }); } catch { return undefined; }
}
