import type { WorkbenchActionResult } from "../workbench/workbench_runner.js";

export function formatWorkbenchResultsForPrompt(results: WorkbenchActionResult[]): string {
  const lines: string[] = [];
  let i = 0;
  for (const r of results) {
    i++;
    const head = `[B${i}] ${r.ok ? "OK" : "FAIL"} ${r.type}: ${r.summary}`;
    lines.push(head);

    try {
      const details = r.details && typeof r.details === "object" ? r.details : null;
      if (!details) continue;
      const raw = JSON.stringify(compactPdfWorkbenchDetailsForPrompt(r.type, details));
      if (!raw) continue;
      const clipped = raw.length > 3200 ? raw.slice(0, 3200) + "...(truncated)" : raw;
      lines.push(`- details: ${clipped}`);
    } catch {
      // ignore
    }
  }
  return lines.join("\n");
}

function compactPdfWorkbenchDetailsForPrompt(type: WorkbenchActionResult["type"], details: Record<string, unknown>): Record<string, unknown> {
  if (type === "gemini_redline_analyze" && details.package_coverage && typeof details.package_coverage === "object") {
    const regions = Array.isArray(details.regions) ? (details.regions as Array<Record<string, unknown>>) : [];
    const selected = sampleAcross(regions, 36);
    const batches = Array.isArray(details.batch_results) ? (details.batch_results as Array<Record<string, unknown>>) : [];
    return {
      summary: details.summary,
      package_coverage: details.package_coverage,
      deduplication: details.deduplication,
      failed_batches: batches.filter((batch) => batch.ok === false),
      findings: selected,
      findings_omitted_from_prompt: Math.max(0, regions.length - selected.length),
      open_questions: Array.isArray(details.open_questions) ? details.open_questions.slice(0, 20) : [],
      ...(details.warning ? { warning: details.warning } : {})
    };
  }
  if (type !== "analyze_redline" && type !== "redline_orient") return details;
  const analysis = type === "redline_orient" && details.analysis && typeof details.analysis === "object"
    ? (details.analysis as Record<string, unknown>)
    : details;
  if ((analysis.kind ?? "") !== "pdf") return details;

  const annotations = Array.isArray(analysis.pdf_annotations)
    ? (analysis.pdf_annotations as Array<Record<string, unknown>>)
    : [];
  const commentRows = annotations.filter((row) => {
    const contents = typeof row.contents === "string" ? row.contents.trim() : "";
    const related = typeof row.related_text === "string" ? row.related_text.trim() : "";
    return !!contents || !!related;
  });
  const compactComments = commentRows.slice(0, 60).map((row) => ({
    page: row.page,
    annotation_index: row.annotation_index,
    subtype: row.subtype,
    ...(typeof row.contents === "string" && row.contents.trim() ? { contents: row.contents } : {}),
    ...(typeof row.related_text === "string" && row.related_text.trim() ? { related_text: row.related_text } : {}),
    ...(row.box_norm && typeof row.box_norm === "object" ? { box_norm: row.box_norm } : {})
  }));
  const packageBlock = analysis.pdf_package && typeof analysis.pdf_package === "object"
    ? (analysis.pdf_package as Record<string, unknown>)
    : null;
  const batches = packageBlock && Array.isArray(packageBlock.visual_batches)
    ? (packageBlock.visual_batches as Array<Record<string, unknown>>)
    : [];
  const visualBatchSummary = batches.length > 0
    ? {
        count: batches.length,
        batch_size: packageBlock?.visual_batch_size,
        first: batches[0],
        last: batches[batches.length - 1],
        instruction: "Call gemini_redline_analyze once with the full desired page budget; the backend executes and aggregates the bounded batches."
      }
    : null;

  return {
    file_path: analysis.file_path,
    kind: analysis.kind,
    page_count: analysis.page_count,
    page_coverage: analysis.page_coverage,
    primary_sheet_number: analysis.primary_sheet_number,
    sheet_candidates: Array.isArray(analysis.sheet_candidates) ? analysis.sheet_candidates.slice(0, 8) : [],
    native_comment_count: commentRows.length,
    native_comment_pages: packageBlock?.native_comment_pages ?? [],
    native_comments: compactComments,
    comments_omitted_from_prompt: Math.max(0, commentRows.length - compactComments.length),
    ...(visualBatchSummary ? { visual_batch_plan: visualBatchSummary } : {}),
    orientation_hints: Array.isArray(analysis.orientation_hints) ? analysis.orientation_hints.slice(0, 12) : [],
    ...(analysis.warning ? { warning: analysis.warning } : {})
  };
}

function sampleAcross<T>(values: T[], maxItems: number): T[] {
  if (values.length <= maxItems) return values;
  const picked: T[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < maxItems; index += 1) {
    const sourceIndex = Math.round(index * (values.length - 1) / Math.max(1, maxItems - 1));
    if (seen.has(sourceIndex)) continue;
    seen.add(sourceIndex);
    picked.push(values[sourceIndex]!);
  }
  return picked;
}
