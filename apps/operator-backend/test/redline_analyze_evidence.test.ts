import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adaptRedlineAnalyzeToAecIntentEvidence, tryCreateRedlineAnalyzeEvidence } from "../src/redline/redline_analyze_evidence.js";
import { analyzeRedlineFile } from "../src/redline/redline_analyzer.js";
import { buildCommentedPdf } from "./fixtures/commented_pdf.js";

const options = { id: "evidence-id", created_at: "2026-07-11T00:00:00.000Z", sha256: "a".repeat(64) };
const base: any = { ok: true, file_path: "artifacts/uploads/marked.pdf", full_path: "C:\\secret\\marked.pdf", kind: "pdf", bytes: 1, page_count: 125, primary_sheet_number: "M-101", likely_sheet: true, sheet_candidates: [], pages: [{ page: 1, text_excerpt: "one", text_chars: 3, sheet_candidates: [] }, { page: 63, text_excerpt: "middle", text_chars: 6, sheet_candidates: [] }, { page: 125, text_excerpt: "late", text_chars: 4, sheet_candidates: [] }], pdf_annotations: [{ page: 63, annotation_index: 2, subtype: "FreeText", is_red_like: true, contents: "12x10 SA duct 450 CFM", box_norm: { minX: .1, minY: .2, maxX: .4, maxY: .5 } }, { page: 125, annotation_index: 3, subtype: "PolyLine", is_red_like: true, box_norm: { minX: .5, minY: .6, maxX: .8, maxY: .9 } }], mark_regions: [{ index: 99, x: 12, y: 10, w: 9, h: 4, area: 36 }], route_candidates: [{ candidate_index: 7, label_text: "12x10 SA duct 450 CFM", target_annotation_indices: [2], label_annotation_indices: [], box_norm: { minX: .1, minY: .2, maxX: .4, maxY: .5 }, confidence: .77 }, { candidate_index: 8, label_text: "cross-page", target_annotation_indices: [2, 3], label_annotation_indices: [], box_norm: { minX: .1, minY: .2, maxX: .4, maxY: .5 }, confidence: .9 }], suggested_revit_calls: [{ method: "POST", path: "/revit/sheets", body: { includeViewportGeometry: true } }, { method: "POST", path: "/revit/get-titleblock-info", body: { sheetNumber: "M-101" } }, { method: "POST", path: "/revit/create-sheet", body: {} }] };

test("redline evidence preserves real camel-case annotation geometry, grounded route region, URI/hash, and page isolation", () => {
  const evidence = adaptRedlineAnalyzeToAecIntentEvidence(base, options);
  assert.deepEqual(evidence.evidence.filter((item) => item.kind === "pdf_page").map((item) => item.page?.number), [1, 63, 125]);
  const annotation = evidence.evidence.find((item) => item.kind === "pdf_annotation" && item.page?.number === 63)!;
  const region = evidence.evidence.find((item) => item.kind === "sheet_region")!;
  assert.deepEqual(annotation.page?.normalized_box, { min_x: .1, min_y: .2, max_x: .4, max_y: .5 });
  assert.deepEqual(region.page?.normalized_box, { min_x: .1, min_y: .2, max_x: .4, max_y: .5 });
  assert.equal(region.text, "12x10 SA duct 450 CFM"); assert.equal(region.confidence, .77); assert.equal(region.page?.number, 63);
  assert.equal(evidence.evidence.filter((item) => item.kind === "sheet_region").length, 1);
  assert.ok([annotation, region].every((item) => item.uri?.includes("marked.pdf") && item.sha256 === options.sha256));
  assert.equal(evidence.target.status, "ambiguous"); assert.equal(evidence.target.document?.path, "artifacts/uploads/marked.pdf"); assert.equal(evidence.target.document?.fingerprint, options.sha256);
  assert.equal(JSON.stringify(evidence).includes("C:\\secret"), false);
  assert.deepEqual(evidence.intent.proposed_actions.map((action) => action.tool), ["/revit/sheets", "/revit/get-titleblock-info"]); assert.ok(evidence.intent.proposed_actions.every((action) => action.requires_apply === false)); assert.ok(evidence.verification.observed.every((gate) => gate.status === "not_run"));
});

test("redline evidence reports exact isolated per-kind omissions and preserves the 768 aggregate cap", () => {
  const pages = (count: number): any => ({ ...structuredClone(base), pages: Array.from({ length: count }, (_, i) => ({ page: i + 1, text_excerpt: "x", text_chars: 1, sheet_candidates: [] })), pdf_annotations: [], route_candidates: [] });
  const annotations = (count: number): any => ({ ...structuredClone(base), pages: [], pdf_annotations: Array.from({ length: count }, (_, i) => ({ page: 1, annotation_index: i, subtype: "FreeText", is_red_like: true, box_norm: { minX: .1, minY: .1, maxX: .2, maxY: .2 } })), route_candidates: [] });
  const candidates = (count: number): any => ({ ...structuredClone(base), pages: [], pdf_annotations: [{ page: 1, annotation_index: 1, subtype: "FreeText", is_red_like: true, box_norm: { minX: .1, minY: .1, maxX: .2, maxY: .2 } }], route_candidates: Array.from({ length: count }, (_, i) => ({ candidate_index: i, label_text: "route", target_annotation_indices: [1], label_annotation_indices: [], box_norm: { minX: .1, minY: .1, maxX: .2, maxY: .2 }, confidence: .5 })) });
  for (const [category, kind, source] of [["pages", "pdf_page", pages], ["annotations", "pdf_annotation", annotations], ["route candidates", "sheet_region", candidates]] as const) for (const count of [257, 768, 1000, 1001]) { const evidence = adaptRedlineAnalyzeToAecIntentEvidence(source(count), options), report = `Redline ${category} omitted ${count - 256} item(s) after deterministic cap.`; assert.equal(evidence.evidence.filter((item) => item.kind === kind).length, 256); assert.deepEqual(evidence.constraints, [report]); assert.ok(evidence.open_questions.includes(report)); }
  const aggregate = adaptRedlineAnalyzeToAecIntentEvidence({ ...pages(256), pdf_annotations: annotations(256).pdf_annotations, route_candidates: candidates(256).route_candidates }, options); assert.equal(aggregate.evidence.length, 768); assert.deepEqual(aggregate.constraints, []);
  const long = adaptRedlineAnalyzeToAecIntentEvidence({ ...base, file_path: "a".repeat(2101) }, options);
  assert.equal(long.target.document, undefined); assert.ok(long.evidence.every((item) => item.uri === undefined)); assert.ok(long.open_questions.some((item) => item.includes("Artifact path and URI were omitted")));
});

test("redline evidence remains provider-neutral, excludes malformed and ungrounded geometry, and has no mutable aliases", async () => {
  const input = structuredClone(base); input.likely_sheet = false; input.pdf_annotations[0].box_norm = { minX: 2, minY: 0, maxX: 3, maxY: 1 }; input.route_candidates[0].box_norm = { minX: .5, minY: .5, maxX: .4, maxY: .6 };
  const evidence = adaptRedlineAnalyzeToAecIntentEvidence(input, { ...options, provider: { name: "spoof" } } as any);
  assert.equal(evidence.origin.provider, undefined); assert.equal(evidence.target.status, "unresolved"); assert.equal(evidence.evidence.find((item) => item.kind === "pdf_annotation" && item.page?.number === 63)?.page?.normalized_box, undefined); assert.equal(evidence.evidence.some((item) => item.kind === "sheet_region"), false);
  input.suggested_revit_calls[0].body.changed = true; assert.equal((evidence.intent.proposed_actions[0]?.body as any).changed, undefined);
  assert.equal(await tryCreateRedlineAnalyzeEvidence({ ...base, full_path: "C:\\missing\\race.pdf" }, { id: options.id, created_at: options.created_at }), undefined);
});

test("redline evidence integrates actual 125-page annotations with page isolation and grounded route confidence", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redline-evidence-125-")), relative = "artifacts/uploads/package.pdf", file = path.join(root, "artifacts", "uploads", "package.pdf"), previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buildCommentedPdf(125, new Map([[1, "page one"], [63, "12x10 SA duct 450 CFM"], [125, "page last"]]))); process.env.OPERATOR_WORKSPACE_ROOT = root;
  t.after(() => { if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot; fs.rmSync(root, { recursive: true, force: true }); });
  const analyzed: any = await analyzeRedlineFile({ file_path: relative }), annotations = analyzed.pdf_annotations.map((item: any, index: number) => ({ ...item, annotation_index: item.page * 1000 + index })); assert.equal(analyzed.ok, true); const annotation = annotations.find((item: any) => item.page === 63 && item.box_norm); assert.ok(annotation);
  const evidence = adaptRedlineAnalyzeToAecIntentEvidence({ ...analyzed, pdf_annotations: annotations, route_candidates: [{ candidate_index: 63, label_text: "12x10 SA duct 450 CFM", target_annotation_indices: [annotation.annotation_index], label_annotation_indices: [], box_norm: annotation.box_norm, confidence: .66 }] }, options);
  assert.ok([1, 63, 125].every((page) => evidence.evidence.some((item) => item.kind === "pdf_page" && item.page?.number === page)));
  const region = evidence.evidence.find((item) => item.kind === "sheet_region")!; assert.equal(region.page?.number, 63); assert.deepEqual(region.page?.normalized_box, { min_x: annotation.box_norm.minX, min_y: annotation.box_norm.minY, max_x: annotation.box_norm.maxX, max_y: annotation.box_norm.maxY }); assert.equal(region.confidence, .66);
});
