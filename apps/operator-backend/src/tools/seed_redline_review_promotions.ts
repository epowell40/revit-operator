import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, readJsonFile, repoRoot, writeTextFile } from "../benchmark/files.js";
import { classifyRedlineCorpusText } from "../redline/corpus_classifier.js";

type CsvRow = Record<string, string>;

type PriorityQueue = {
  items?: Array<{
    rank?: number;
    operation?: string;
    target?: string;
    examples?: Array<{
      id?: string;
      confidence?: number;
      needs_human_review?: boolean;
      evidence?: string;
    }>;
  }>;
};

export type SeedReviewedPromotionsOptions = {
  priorityQueuePath: string;
  reviewQueuePath: string;
  outputPath: string;
  belowConfidenceAuditPath?: string;
  belowConfidenceReviewPath?: string;
  skippedReviewPath?: string;
  linkedPhaseReviewPath?: string;
  groupReviewPath?: string;
  operations?: string[];
  targets?: string[];
  pairs?: string[];
  status?: string;
  maxPairs?: number;
  maxPerPair?: number;
  minConfidence?: number;
  includeNeedsHumanReview?: boolean;
};

type PairSelectionSummary = {
  pair: string;
  selected_count: number;
};

type MissingPairSummary = PairSelectionSummary & {
  reason: string;
  candidate_count?: number;
  eligible_count?: number;
  review_match_count?: number;
  best_confidence?: number;
};

type SkippedSeedSummary = {
  pair: string;
  reason: string;
  skipped_count: number;
};

type PairDiagnostic = {
  candidate_count: number;
  eligible_count: number;
  review_match_count: number;
  best_confidence: number;
};

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === "\"" && next === "\"") {
        cell += "\"";
        i++;
      } else if (ch === "\"") {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === "\"") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const [headers = [], ...dataRows] = rows;
  return dataRows
    .filter((entries) => entries.some((entry) => entry.trim()))
    .map((entries) => {
      const out: CsvRow = {};
      headers.forEach((header, index) => {
        out[header.trim()] = entries[index]?.trim() ?? "";
      });
      return out;
    });
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function writeCsv(filePath: string, rows: CsvRow[]): void {
  const headers = Array.from(rows.reduce((set, row) => {
    for (const key of Object.keys(row)) set.add(key);
    return set;
  }, new Set<string>()));
  writeCsvWithHeaders(filePath, headers, rows);
}

function writeCsvWithHeaders(filePath: string, headers: string[], rows: CsvRow[]): void {
  writeTextFile(filePath, [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header] ?? "")).join(","))
  ].join("\n") + "\n");
}

function idKey(id: string): string | null {
  const match = /^mark:(.+):p(\d+):a(\d+)$/i.exec(id.trim());
  if (!match) return null;
  return `${match[1]}|${Number(match[2])}|${Number(match[3])}`;
}

function rowExactMarkKey(row: CsvRow): string | null {
  if (!String(row.index ?? "").trim()) return null;
  return `${path.basename(row.file || row.file_path || "")}|${Number(row.page)}|${Number(row.index)}`;
}

function rowHasReviewLabel(row: CsvRow): boolean {
  return Boolean((row.review_status || row.review_operation || row.review_target || row.review_notes || "").trim());
}

function reviewRowIndex(rows: CsvRow[]): Map<string, CsvRow> {
  const out = new Map<string, CsvRow>();
  for (const row of rows) {
    const exactMarkKey = rowExactMarkKey(row);
    if (exactMarkKey) out.set(exactMarkKey, row);
    const annotationIndices = String(row.annotation_indices ?? "").trim();
    if (!annotationIndices || !rowHasReviewLabel(row)) continue;
    const base = `${path.basename(row.file || row.file_path || "")}|${Number(row.page)}`;
    for (const rawIndex of annotationIndices.split(/[|;\s,]+/)) {
      const index = Number(rawIndex);
      if (Number.isFinite(index) && index > 0) out.set(`${base}|${index}`, row);
    }
  }
  return out;
}

function splitFilter(values?: string[]): Set<string> | null {
  const normalized = values?.map((value) => value.trim()).filter(Boolean) ?? [];
  return normalized.length ? new Set(normalized) : null;
}

function canonicalOperation(value: string): string {
  const normalized = value.trim();
  if (normalized === "reroute") return "reroute_offset";
  return normalized;
}

function canonicalPair(value: string): string {
  const normalized = value.trim().replace(/:/g, "/");
  const [operation, target] = normalized.split("/");
  if (!operation || !target) return normalized;
  return `${canonicalOperation(operation)}/${target.trim()}`;
}

function locallyConfirmedConfidence(args: {
  reviewRow?: CsvRow;
  evidence?: string;
  operation: string;
  target: string;
  minConfidence: number;
}): number | undefined {
  const local = locallyConfirmedClassification(args);
  if (!local) return undefined;
  if (canonicalOperation(local.operation_class) !== canonicalOperation(args.operation)) return undefined;
  if (local.target_class !== args.target) return undefined;
  return local.confidence;
}

function locallyConfirmedClassification(args: {
  reviewRow?: CsvRow;
  evidence?: string;
  minConfidence: number;
}): ReturnType<typeof classifyRedlineCorpusText> | undefined {
  if (!args.reviewRow) return undefined;
  const reviewText = [args.reviewRow.text_excerpt ?? "", args.evidence ?? ""].filter(Boolean).join(" ");
  if (!reviewText.trim()) return undefined;
  const local = classifyRedlineCorpusText({
    file_path: args.reviewRow.file ?? args.reviewRow.file_path ?? "",
    text: reviewText
  });
  if (local.manual_review_reason && !/reload-capable CAD link workflow/i.test(local.manual_review_reason)) return undefined;
  return local.confidence >= args.minConfidence ? local : undefined;
}

function effectiveExampleConfidence(args: {
  confidence: number;
  reviewRow?: CsvRow;
  evidence?: string;
  operation: string;
  target: string;
  minConfidence: number;
}): number {
  const local = locallyConfirmedConfidence(args);
  return local === undefined ? args.confidence : Math.max(args.confidence, local);
}

function splitPairFilter(values?: string[]): Set<string> | null {
  const normalized = values
    ?.map((value) => value.trim())
    .filter(Boolean)
    .map(canonicalPair)
    .filter((value) => /^[^/]+\/[^/]+$/.test(value)) ?? [];
  return normalized.length ? new Set(normalized) : null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function requestedPairDiagnostics(
  queue: PriorityQueue,
  reviewByKey: Map<string, CsvRow>,
  requestedPairs: string[],
  minConfidence: number,
  includeNeedsHumanReview: boolean | undefined
): Map<string, PairDiagnostic> {
  const requested = new Set(requestedPairs);
  const diagnostics = new Map<string, PairDiagnostic>();
  for (const item of queue.items ?? []) {
    const pair = `${canonicalOperation(String(item.operation ?? ""))}/${String(item.target ?? "").trim()}`;
    if (!requested.has(pair)) continue;
    const current = diagnostics.get(pair) ?? { candidate_count: 0, eligible_count: 0, review_match_count: 0, best_confidence: 0 };
    for (const example of item.examples ?? []) {
      current.candidate_count++;
      const confidence = Number(example.confidence ?? 0);
      const key = idKey(String(example.id ?? ""));
      const reviewRow = key ? reviewByKey.get(key) : undefined;
      const effectiveConfidence = Number.isFinite(confidence)
        ? effectiveExampleConfidence({
          confidence,
          reviewRow,
          evidence: String(example.evidence ?? ""),
          operation: String(item.operation ?? ""),
          target: String(item.target ?? "").trim(),
          minConfidence
        })
        : confidence;
      if (Number.isFinite(effectiveConfidence)) current.best_confidence = Math.max(current.best_confidence, effectiveConfidence);
      if (effectiveConfidence < minConfidence) continue;
      if (example.needs_human_review && !includeNeedsHumanReview) continue;
      current.eligible_count++;
      if (reviewRow) current.review_match_count++;
    }
    diagnostics.set(pair, current);
  }
  return diagnostics;
}

function missingPairReason(diagnostic: PairDiagnostic | undefined, skippedCount: number, minConfidence: number): string {
  if (!diagnostic || !diagnostic.candidate_count) return "no priority queue candidates for requested pair";
  if (!diagnostic.eligible_count) return `no candidates meet minConfidence ${minConfidence}`;
  if (!diagnostic.review_match_count) return "eligible candidates do not match review queue rows";
  if (skippedCount > 0) return "eligible candidates were skipped before live seeding";
  return "eligible candidates produced no selected rows";
}

function cleanRequestedDocumentationText(value: string): string {
  return value
    .replace(/[.;,:)\]]+\s*$/g, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanGraphicsStyleIntent(value: string): string {
  return cleanRequestedDocumentationText(value)
    .replace(/\s+lineweight$/i, "")
    .trim();
}

function extractedReviewFacts(text: string, target: string): { requestedSize?: string; existingSize?: string; requestedSizeCandidates?: string; requestedSizeBasis?: string; requestedAirflow?: string; elevationHint?: string; requestedBranchCount?: string; requestedConnectionKind?: string; tapPlacementHint?: string; clearanceHint?: string; requestedText?: string; existingText?: string; requestedLineWeight?: string; graphicsStyleIntent?: string; graphicsTargetHint?: string; visibilityIntent?: string; requestedAccessoryKind?: string; requestedAccessorySize?: string; requestedTagKind?: string; requestedTagValue?: string; requestedTagNoteNumber?: string; tagTargetScope?: string; existingType?: string; requestedType?: string; linkedModelCategory?: string; linkedVisibilityIntent?: string; phaseName?: string; phaseFilter?: string; phaseMappingIntent?: string } {
  const sizes: string[] = [];
  let existingSize: string | undefined;
  let requestedSizeBasis: string | undefined;
  if (target === "duct") {
    const ductTransition = /\bfrom\s+(\d{1,3}\s*(?:x|×)\s*\d{1,3})\s+to\s+(\d{1,3}\s*(?:x|×)\s*\d{1,3})\b/i.exec(text);
    if (ductTransition?.[1]) existingSize = cleanRequestedDocumentationText(ductTransition[1].replace(/×/g, "x"));
    if (ductTransition?.[2]) {
      sizes.push(ductTransition[2].replace(/×/g, "x"));
      requestedSizeBasis = "explicit_from_to";
    }
    if (!requestedSizeBasis) {
      const changeTo = /\b(?:change|resize|revise|update|set|make)\b.{0,80}?\b(?:to|as)\s+(\d{1,3}\s*(?:x|×)\s*\d{1,3})\b/i.exec(text);
      if (changeTo?.[1]) {
        sizes.push(changeTo[1].replace(/×/g, "x"));
        requestedSizeBasis = "explicit_to";
      }
    }
    for (const match of text.matchAll(/\b\d{1,3}\s*(?:x|×)\s*\d{1,3}\b/gi)) sizes.push(match[0].replace(/×/g, "x"));
  }
  if (target === "pipe") {
    const pipeSizePattern = String.raw`(?:\d+\s*[- ]\s*)?\d+\s*\/\s*\d+\s*(?:"|in\b|inch(?:es)?\b)?|\d+(?:\.\d+)?\s*(?:"|in\b|inch(?:es)?\b|dia\b|ø)`;
    const pipeTransition = new RegExp(String.raw`\bfrom\s+(${pipeSizePattern})\s+to\s+(${pipeSizePattern})`, "i").exec(text);
    if (pipeTransition?.[1]) existingSize = cleanRequestedDocumentationText(pipeTransition[1]);
    if (pipeTransition?.[2]) {
      sizes.push(pipeTransition[2]);
      requestedSizeBasis = "explicit_from_to";
    }
    for (const match of text.matchAll(/\b(?:\d+\s*[- ]\s*)?\d+\s*\/\s*\d+\s*(?:"|in\b|inch(?:es)?\b)?|\b\d+(?:\.\d+)?\s*(?:"|in\b|inch(?:es)?\b|dia\b|ø)\b/gi)) sizes.push(match[0]);
  }
  const sizeCandidates = unique(sizes.map((value) => value.replace(/\s+/g, " ")));
  const requestedSize = sizeCandidates[0];
  if (!requestedSizeBasis && requestedSize) requestedSizeBasis = sizeCandidates.length > 1 ? "ambiguous_size_candidates" : "single_size_mention";
  const requestedAirflow = target === "duct" ? unique(Array.from(text.matchAll(/\b\d{2,6}\s*cfm\b/gi)).map((match) => match[0].toUpperCase().replace(/\s+/g, " ")))[0] : undefined;
  const elevationHint = unique(Array.from(text.matchAll(/\b(?:bottom\s+of\s+duct\s+at\s+)?\d+(?:\.\d+)?\s*(?:"|in\b|inch(?:es)?\b|ft\b|feet\b)\s+(?:above|below)\s+(?:floor|ceiling|slab)\b/gi)).map((match) => match[0].replace(/\s+/g, " ")))[0];
  let requestedBranchCount: string | undefined;
  let requestedConnectionKind: string | undefined;
  let tapPlacementHint: string | undefined;
  let clearanceHint: string | undefined;
  if (target === "duct" || target === "pipe") {
    requestedBranchCount =
      /\b(\d{1,2})\s+branches?\s+(?:off|from)\s+(?:the\s+)?main\b/i.exec(text)?.[1]
      ?? /\bbranches?\s+(?:off|from)\s+(?:the\s+)?main\b.{0,40}?\b(\d{1,2})\b/i.exec(text)?.[1];
    if (/\bbullhead\s+tee\b/i.test(text)) {
      requestedConnectionKind = "bullhead tee";
    } else if (/\bcenter\s+takeoffs?\b/i.test(text)) {
      requestedConnectionKind = "takeoff";
      tapPlacementHint = "center takeoff";
    } else if (/\btap\s+off\b|\btaps?\s+(?:off|from)\b/i.test(text)) {
      requestedConnectionKind = "tap";
    } else if (/\btake\s*offs?\b|\btakeoffs?\b/i.test(text)) {
      requestedConnectionKind = "takeoff";
    } else if (/\btee\b/i.test(text)) {
      requestedConnectionKind = "tee";
    } else if (/\bbranches?\s+(?:off|from)\s+(?:the\s+)?main\b/i.test(text)) {
      requestedConnectionKind = "branch";
    }
    const placementMatch =
      /\bside\s+of\s+(?:the\s+)?main\b/i.exec(text)?.[0]
      ?? /\bbottom\s+tapping\b/i.exec(text)?.[0]
      ?? /\bbottom\s+tap(?:ping)?\b/i.exec(text)?.[0]
      ?? /\bcenter\s+takeoffs?\b/i.exec(text)?.[0];
    if (placementMatch) tapPlacementHint = cleanRequestedDocumentationText(placementMatch.toLowerCase());
    const clearanceMatch = /\b\d+(?:\.\d+)?\s*(?:"|in\b|inch(?:es)?\b|ft\b|feet\b)\s+clear\s+(?:for|at|around)\s+(?:takeoffs?|taps?|branches?)\b/i.exec(text)?.[0];
    if (clearanceMatch) clearanceHint = cleanRequestedDocumentationText(clearanceMatch);
  }
  let requestedText: string | undefined;
  let existingText: string | undefined;
  if (target === "schedule" || target === "text" || target === "tag") {
    const quotedDirective = /\b(?:read|shown)\b.*?:\s+"([^"]+)"/i.exec(text);
    if (quotedDirective?.[1]) requestedText = cleanRequestedDocumentationText(quotedDirective[1]);
    if (!requestedText) {
      const correction = /\bcorrection\s+["'`]([^"'`]+)["'`]/i.exec(text);
      if (correction?.[1]) requestedText = cleanRequestedDocumentationText(correction[1]);
    }
    if (!requestedText) {
      const writtenWord = /\bword\s+["'`]([^"'`]+)["'`]\s+is\s+written\b/i.exec(text);
      if (writtenWord?.[1]) requestedText = cleanRequestedDocumentationText(writtenWord[1]);
    }
    if (!requestedText) {
      const quotedChange = /\b(?:text\s+)?change\s+to\s+["'`]([^"'`]+)["'`]/i.exec(text);
      if (quotedChange?.[1]) requestedText = cleanRequestedDocumentationText(quotedChange[1]);
    }
    const replacement = /\b(?:from|replace)\s+["'`]?([^"'`.,;:]+?)["'`]?\s+(?:to|with)\s+["'`]?([^"'`.,;:]+)["'`]?/i.exec(text);
    if (replacement?.[1] && replacement[2]) {
      existingText = cleanRequestedDocumentationText(replacement[1]);
      if (!requestedText) requestedText = cleanRequestedDocumentationText(replacement[2]);
    }
    if (!requestedText) {
      const directive = /\b(?:change|revise|update|edit|correct|set)\b.*?\b(?:to|as|say|says|read|reads)\s+["'`]?([^"'`.,;:]+)["'`]?/i.exec(text);
      requestedText = cleanRequestedDocumentationText(directive?.[1] ?? "");
    }
    if (!requestedText) {
      const notUsed = /\bnot\s+used\b/i.exec(text)?.[0];
      if (notUsed) requestedText = notUsed.toUpperCase();
    }
    if (!requestedText && target === "schedule" && /\bvalue\s+update\s+in\s+schedule\b/i.test(text)) {
      requestedText = /\b\d+(?:\.\d+)?\/\d+(?:\.\d+)?\b/.exec(text)?.[0];
    }
  }
  let requestedLineWeight: string | undefined;
  let graphicsStyleIntent: string | undefined;
  let graphicsTargetHint: string | undefined;
  let visibilityIntent: string | undefined;
  if (["category_graphics", "view_filter", "view_template", "cad_link", "schedule", "sheet", "unknown"].includes(target)) {
    requestedLineWeight = /\b(?:line\s*weight|lineweight|lw)\s*(?:to|=|:)?\s*(\d{1,2})\b/i.exec(text)?.[1];
    const styleMatches = [
      /\b(light\s+hidden(?:\s+line(?:weight)?)?)\b/i,
      /\b(hidden\s+line(?:weight)?)\b/i,
      /\bhalftone\b/i,
      /\bmonochrome\b/i,
      /\bdashed(?:\s+lines?)?\b/i,
      /\bhide\b|\bhidden\b/i,
      /\bfuture(?:\s+new\s+work|\s+work)?\b/i
    ];
    for (const pattern of styleMatches) {
      const match = pattern.exec(text);
      if (match?.[0]) {
        graphicsStyleIntent = cleanGraphicsStyleIntent(match[0].toLowerCase());
        break;
      }
    }
    const targetPatterns = [
      /\ball\s+mechanical\s+equipment\b/i,
      /\bmechanical\s+equipment\b/i,
      /\bentire\s+FFU\b/i,
      /\bFFU'?s\b/i,
      /\bducts?\s+that\s+pass\s+underneath\s+one\s+another\b/i,
      /\bducts?\s+go\s+over\s+or\s+under\s+one\s+another\b/i,
      /\bducts?\b/i,
      /\bfuture(?:\s+new\s+work|\s+work)?\b/i,
      /\bnew\s+work\b/i,
      /\bcontours?\b/i,
      /\bcad\s+link\s+markers?\/points?\b/i,
      /\bcad\s+(?:markers?|points?)\b/i,
      /\blink\s+markers?\b/i,
      /\blayers?\b/i
    ];
    for (const pattern of targetPatterns) {
      const match = pattern.exec(text);
      if (match?.[0]) {
        graphicsTargetHint = cleanRequestedDocumentationText(match[0].toLowerCase());
        break;
      }
    }
    visibilityIntent = cleanRequestedDocumentationText(
      requestedLineWeight ? `lineweight ${requestedLineWeight}` : (graphicsStyleIntent ?? "")
    ) || undefined;
  }
  let linkedModelCategory: string | undefined;
  let linkedVisibilityIntent: string | undefined;
  if (/\b(?:linked\s+model|revit\s+link|architectural\s+link|linked\s+arch)\b/i.test(text)) {
    const categoryPatterns = [
      /\b(plumbing\s+fixtures?)\b/i,
      /\b(furniture)\b/i,
      /\b(mechanical\s+equipment)\b/i,
      /\b(ducts?|ductwork)\b/i,
      /\b(pipes?|piping)\b/i,
      /\b(receptacles?|electrical\s+fixtures?)\b/i,
      /\b(walls?|doors?|windows?|ceilings?|floors?)\b/i
    ];
    for (const pattern of categoryPatterns) {
      const match = pattern.exec(text);
      if (match?.[1]) {
        linkedModelCategory = cleanRequestedDocumentationText(match[1].toLowerCase());
        break;
      }
    }
    const visibilityMatch =
      /\b(show|hide|halftone|override|lineweight\s*\d{1,2}|line\s*weight\s*\d{1,2})\b/i.exec(text)?.[0]
      ?? graphicsStyleIntent
      ?? (requestedLineWeight ? `lineweight ${requestedLineWeight}` : undefined);
    linkedVisibilityIntent = visibilityMatch ? cleanRequestedDocumentationText(visibilityMatch.toLowerCase()) : undefined;
  }
  let phaseName: string | undefined;
  let phaseFilter: string | undefined;
  let phaseMappingIntent: string | undefined;
  if (/\bphase(?:\s+filter|\s+mapping)?|demo(?:lition)?\s+work|removal\s+view|existing\s+phase|new\s+construction|new\s+work\b/i.test(text)) {
    phaseName = cleanRequestedDocumentationText(
      /\b(existing|new\s+construction|new\s+work|demolition\s+work|demo\s+work|demo(?:lition)?)\b/i.exec(text)?.[1] ?? ""
    );
    phaseFilter = cleanRequestedDocumentationText(
      /\bphase\s+filter\s+(?:to|as|=|:)?\s*["'`]?([^"'`.;,:]+)["'`]?/i.exec(text)?.[1] ?? ""
    );
    const mapping = /\bphase\s+mapping\b/i.exec(text)?.[0] ?? /\bmatch\b.{0,80}\b(?:linked\s+model|architectural\s+linked\s+model)\b.{0,80}\bphase/i.exec(text)?.[0];
    phaseMappingIntent = mapping ? cleanRequestedDocumentationText(mapping.toLowerCase()) : undefined;
  }
  let requestedAccessoryKind: string | undefined;
  let requestedAccessorySize: string | undefined;
  if (target === "mep_accessory") {
    requestedAccessorySize = unique(Array.from(text.matchAll(/\b\d{1,3}\s*(?:x|×)\s*\d{1,3}\b/gi)).map((match) => match[0].replace(/×/g, "x").replace(/\s+/g, "")))[0];
    if (/\b(?:remove|delete|take\s+out)\s+(?:this\s+|the\s+)?access\s+doors?\b/i.test(text)) {
      requestedAccessoryKind = "access door";
    } else if (/\b(?:move|shift|relocate)\b.{0,80}\bdampers?\b/i.test(text)) {
      requestedAccessoryKind = "damper";
    }
    const accessoryPatterns = [
      /\bfire\s+smoke\s+dampers?\b/i,
      /\bfire\s+dampers?\b/i,
      /\bsmoke\s+dampers?\b/i,
      /\bbubble[-\s]*tight\s+isolation\s+dampers?\b/i,
      /\bmanual\s+balancing\s+dampers?\b/i,
      /\bbalancing\s+dampers?\b/i,
      /\bdampers?\b/i,
      /\bFSD\b/i,
      /\bbutterfly\s+valves?\b/i,
      /\bball\s+valves?\b/i,
      /\baccess\s+doors?\b/i,
      /\btransfer\s+grilles?\b/i,
      /\bface\s+grilles?\b/i,
      /\bdiffusers?\b/i,
      /\bair\s+devices?\b/i,
      /\bVAV(?:\s+boxes?)?\b/i,
      /\broom\s+pressure\s+monitors?\b/i
    ];
    if (!requestedAccessoryKind) {
      for (const pattern of accessoryPatterns) {
        const match = pattern.exec(text);
        if (match?.[0]) {
          requestedAccessoryKind = cleanRequestedDocumentationText(match[0].toLowerCase());
          break;
        }
      }
    }
  }
  let requestedTagKind: string | undefined;
  let requestedTagValue: string | undefined;
  let requestedTagNoteNumber: string | undefined;
  let tagTargetScope: string | undefined;
  if (target === "tag" || /\b(tag|keynote|diamond\s+note)\b/i.test(text)) {
    requestedTagNoteNumber =
      /\b(?:diamond\s+note|keynote)\s*(?:number|#|no\.?)?\s*(\d{1,3})\b/i.exec(text)?.[1]
      ?? /\b(?:note|tag)\s*(?:number|#)\s*(\d{1,3})\b/i.exec(text)?.[1];
    const tagValuePatterns = [
      /\b(?:tag|prefix|label)\s+(?:to|as)\s+([A-Z]{1,4}\d?(?:-[A-Z0-9]+)*(?:,\d{2})*)\b/i,
      /\b(?:change|update|revise)\b.{0,80}\b(?:tag|prefix|label)\b.{0,40}\bto\s+([A-Z]{1,4}\d?(?:-[A-Z0-9]+)*(?:,\d{2})*)\b/i,
      /\b([A-Z]{1,4}\d?-\d-[A-Z]{1,4}-\d{2}(?:,\d{2})*)\b/i,
      /\b(?:tag|label|designate)\b.{0,30}\bas\s+([A-Z]{2,8})\b/i
    ];
    for (const pattern of tagValuePatterns) {
      const match = pattern.exec(text);
      if (match?.[1]) {
        requestedTagValue = cleanRequestedDocumentationText(match[1].toUpperCase());
        break;
      }
    }
    const kindPatterns = [
      /\bfire\s+smoke\s+dampers?\b/i,
      /\bfire\s+dampers?\b/i,
      /\bsmoke\s+dampers?\b/i,
      /\bhard[-\s]*duct\s+low\s+pressure\s+ducts?\b/i,
      /\bexisting\s+piping\b/i,
      /\bsection\s+(?:view\s+)?callouts?\b/i,
      /\bduplicate\s+tags?\b/i,
      /\bkeynotes?\b/i,
      /\bdiamond\s+notes?\b/i,
      /\bduct\s+tags?\b/i,
      /\bpipe\s+tags?\b/i,
      /\bequipment\s+tags?\b/i
    ];
    for (const pattern of kindPatterns) {
      const match = pattern.exec(text);
      if (match?.[0]) {
        requestedTagKind = cleanRequestedDocumentationText(match[0].toLowerCase());
        break;
      }
    }
    tagTargetScope =
      /\ball\s+hard[-\s]*duct\s+low\s+pressure\s+ducts?\b/i.exec(text)?.[0]
      ?? /\ball\s+existing\s+piping\b/i.exec(text)?.[0]
      ?? /\ball\s+tags?\s+from\s+[^.;]+/i.exec(text)?.[0]
      ?? /\b(?:off|from)\s+the\s+duct\b/i.exec(text)?.[0];
    tagTargetScope = tagTargetScope ? cleanRequestedDocumentationText(tagTargetScope.toLowerCase()) : undefined;
  }
  let existingType: string | undefined;
  let requestedType: string | undefined;
  if (/\b(?:type|family|designation|rectangular|round|diffuser|grille|register|air\s*device|fire\s+smoke\s+damper|FSD)\b/i.test(text)) {
    const typeReplacement =
      /\b(?:from|replace)\s+["'`]?([^"'`.,;:]+?)["'`]?\s+(?:to|with)\s+["'`]?([^"'`.,;:]+?)["'`]?(?:\b|[.;,:])/i.exec(text)
      ?? /\b(?:change|swap|convert|revise|update|switch|make)\b.{0,80}\b(?:type|family|designation|diffuser|grille|register|air\s*device)\b.{0,40}\b(?:to|with|as)\s+["'`]?([^"'`.,;:]+?)["'`]?(?:\b|[.;,:])/i.exec(text);
    if (typeReplacement?.[2]) {
      existingType = cleanRequestedDocumentationText(typeReplacement[1] ?? "");
      requestedType = cleanRequestedDocumentationText(typeReplacement[2]);
    } else if (typeReplacement?.[1]) {
      requestedType = cleanRequestedDocumentationText(typeReplacement[1]);
    }
    if (!existingType && !requestedType && /\brectangular\s+to\s+round\b/i.test(text)) {
      existingType = "rectangular";
      requestedType = "round";
    }
    if (!requestedType || /^(?:a|fire|change|switch|make)$/i.test(requestedType)) {
      const directRequestedType =
        /\bchange\s+designation\s+to\s+(fire\s+smoke\s+damper|FSD)\b/i.exec(text)?.[1]
        ?? /\bswitch\s+to\s+(?:a\s+)?(\d{1,3}\s*(?:x|×)\s*\d{1,3}\s+air\s+device|air\s+device)\b/i.exec(text)?.[1]
        ?? /\bmake\s+(?:this|these)?\s*(?:a\s+)?((?:\d{1,3}\s*(?:x|×)\s*\d{1,3}\s+)?rectangular(?:\s+\d{1,3}\s*(?:x|×)\s*\d{1,3})?(?:\s+ducts?)?)\b/i.exec(text)?.[1]
        ?? /\bmake\s+these\s+(\d{1,3}\s*"?\s+wide\s+rectangular\s+ducts?)\b/i.exec(text)?.[1]
        ?? /\bextend\s+(hard\s+round\s+duct)\b/i.exec(text)?.[1];
      requestedType = cleanRequestedDocumentationText(directRequestedType ?? "").replace(/×/g, "x");
    }
    if (/^\d{1,3}$/.test(requestedType)) {
      const rectangularSize =
        /\brectangular\s+(\d{1,3})\s*"?\s*(?:x|×)\s*(\d{1,3})\s*"?/i.exec(text)
        ?? /\brectangular\s+duct\s*(\d{1,3})\s*"?\s*(?:x|×)\s*(\d{1,3})\s*"?/i.exec(text);
      if (rectangularSize?.[2]) requestedType = `rectangular ${rectangularSize[1]}x${rectangularSize[2]}`;
    }
    const airDeviceSwap = /\b([A-Z]\d+)\b.{0,80}\b(?:to|with|as)\s+\b([A-Z]\d+)\b/i.exec(text);
    if (airDeviceSwap?.[2] && /\b(diffuser|grille|register|air\s*device|cfm)\b/i.test(text)) {
      existingType = existingType ?? airDeviceSwap[1];
      requestedType = requestedType ?? airDeviceSwap[2];
    }
  }
  return {
    requestedSize,
    existingSize,
    requestedSizeCandidates: sizeCandidates.length > 1 ? sizeCandidates.join("|") : undefined,
    requestedSizeBasis,
    requestedAirflow,
    elevationHint,
    requestedBranchCount,
    requestedConnectionKind,
    tapPlacementHint,
    clearanceHint,
    requestedText,
    existingText,
    requestedLineWeight,
    graphicsStyleIntent,
    graphicsTargetHint,
    visibilityIntent,
    requestedAccessoryKind,
    requestedAccessorySize,
    requestedTagKind,
    requestedTagValue,
    requestedTagNoteNumber,
    tagTargetScope,
    existingType,
    requestedType,
    linkedModelCategory,
    linkedVisibilityIntent,
    phaseName: phaseName || undefined,
    phaseFilter: phaseFilter || undefined,
    phaseMappingIntent
  };
}

function liveSeedSkipReason(operation: string, target: string, facts: ReturnType<typeof extractedReviewFacts>, text = ""): string | undefined {
  if (operation !== "graphics_override") return undefined;
  if (target === "category_graphics" && /^layers?$/i.test(facts.graphicsTargetHint ?? "")) {
    return "graphics override candidate targets generic layers and needs CAD layer/link review before category graphics seeding";
  }
  if (["category_graphics", "view_filter", "view_template"].includes(target) && facts.linkedModelCategory) {
    return "linked-model graphics candidate needs linked model instance/category readback and revert proof before live seeding";
  }
  if (["category_graphics", "view_filter", "view_template"].includes(target) && (facts.phaseName || facts.phaseFilter || facts.phaseMappingIntent)) {
    return "phase graphics candidate needs phase/filter readback, original value readback, and revert proof before live seeding";
  }
  if (!["category_graphics", "view_filter", "view_template"].includes(target)) return undefined;
  if (facts.graphicsTargetHint || facts.linkedModelCategory || facts.phaseName || facts.phaseFilter || facts.phaseMappingIntent) return undefined;
  return "graphics override candidate lacks a category/filter/template/link/phase target hint";
}

function belowConfidenceSafetyBlockReason(operation: string, target: string, text = ""): string | undefined {
  if (canonicalOperation(operation) !== "tap_branch" || !["duct", "pipe"].includes(target)) return undefined;
  if (/\bfuture\s+towers?\b/i.test(text)) {
    return "MEP tap/branch candidate references future work and lacks verified host/main element, branch path, target system, and connector readback before live seeding";
  }
  if (/\btap\s+elevations?\b|\badjust\b.{0,40}\belevations?\b/i.test(text)) {
    return "MEP tap/branch elevation candidate lacks exact tap ids, elevation delta, host/main element, and connector readback before live seeding";
  }
  if (/\bcenter\s+take\s*offs?\b|\bcenter\s+takeoffs?\b/i.test(text)) {
    return "MEP tap/branch takeoff-layout candidate lacks host/main element, branch path, conflict resolution, and connector readback before live seeding";
  }
  if (/\b(?:tap|take\s*off|takeoff|branch)\b/i.test(text)) {
    return "MEP tap/branch candidate lacks verified host/main element, projected tap point, branch path, fitting/connection mode, and connector readback before live seeding";
  }
  return undefined;
}

function skippedSeedEvidenceNotes(skipReason: string, facts: ReturnType<typeof extractedReviewFacts>): string[] {
  if (/reload-capable CAD link workflow/i.test(skipReason)) {
    return [
      "missing_live_evidence=cad_reload_endpoint_or_workflow",
      "required_revit_proof=existing CAD import/link id plus source path readback before reload",
      "required_revit_proof=post-reload source timestamp/status readback and sheet/view capture"
    ];
  }
  if (/lacks a category\/filter\/template\/link\/phase target hint/i.test(skipReason)) {
    return [
      "missing_live_evidence=graphics_target",
      facts.requestedLineWeight ? `known_requested_lineweight=${facts.requestedLineWeight}` : "",
      "required_revit_proof=category/filter/template/link/phase target identified from mark context or live view readback",
      "required_revit_proof=graphics readback, focused capture, and cleanup/revert plan before promotion"
    ];
  }
  if (/generic layers/i.test(skipReason)) {
    return [
      "missing_live_evidence=cad_layer_or_revit_category_disambiguation",
      "required_revit_proof=CAD import/link id and layer/subcategory readback if this is a CAD-layer request",
      "required_revit_proof=Revit category/filter/template target readback if this is not CAD"
    ];
  }
  if (/linked-model graphics/i.test(skipReason)) {
    return [
      "missing_live_evidence=linked_model_instance_or_type_id",
      "missing_live_evidence=linked_model_category_graphics_readback",
      "missing_live_evidence=focused_capture_target",
      "missing_live_evidence=cleanup_revert_proof",
      facts.linkedModelCategory ? `known_linked_model_category_hint=${facts.linkedModelCategory}` : "",
      "required_revit_proof=linked model instance/type plus category target readback before write",
      "required_revit_proof=post-change linked model graphics readback, focused capture, and clear/revert readback"
    ];
  }
  if (/phase graphics/i.test(skipReason)) {
    return [
      "missing_live_evidence=phase_name_or_filter",
      "missing_live_evidence=original_phase_filter_readback",
      facts.phaseMappingIntent ? "missing_live_evidence=linked_phase_mapping_readback" : "",
      "missing_live_evidence=focused_capture_target",
      "missing_live_evidence=cleanup_revert_proof",
      facts.phaseName ? `known_phase_hint=${facts.phaseName}` : "",
      facts.phaseFilter ? `known_phase_filter_hint=${facts.phaseFilter}` : "",
      "required_revit_proof=target view phase/filter and original values read back before write",
      "required_revit_proof=post-change phase/filter readback, focused capture, and clear/revert readback"
    ];
  }
  return [];
}

function belowConfidenceBlockEvidenceNotes(blockReason: string | undefined): string[] {
  if (!blockReason) return [];
  if (/tap\/branch elevation/i.test(blockReason)) {
    return [
      "missing_live_evidence=tap_element_ids",
      "missing_live_evidence=elevation_delta_or_target_elevation",
      "missing_live_evidence=host_main_element",
      "missing_live_evidence=connector_readback"
    ];
  }
  if (/takeoff-layout/i.test(blockReason)) {
    return [
      "missing_live_evidence=host_main_element",
      "missing_live_evidence=branch_path_points",
      "missing_live_evidence=conflict_resolution_context",
      "missing_live_evidence=connector_readback"
    ];
  }
  if (/future work/i.test(blockReason)) {
    return [
      "missing_live_evidence=approved_current_scope",
      "missing_live_evidence=host_main_element",
      "missing_live_evidence=branch_path_points",
      "missing_live_evidence=target_system",
      "missing_live_evidence=connector_readback"
    ];
  }
  if (/MEP tap\/branch/i.test(blockReason)) {
    return [
      "missing_live_evidence=host_main_element",
      "missing_live_evidence=projected_tap_point",
      "missing_live_evidence=branch_path_points",
      "missing_live_evidence=fitting_or_connection_mode",
      "missing_live_evidence=connector_readback"
    ];
  }
  return [];
}

function graphicsReviewEvidenceNotes(facts: ReturnType<typeof extractedReviewFacts>): string[] {
  const notes: string[] = [];
  if (facts.linkedModelCategory) {
    notes.push(
      "missing_live_evidence=linked_model_instance_or_type_id",
      "missing_live_evidence=linked_model_category_graphics_readback",
      "missing_live_evidence=focused_capture_target",
      "missing_live_evidence=cleanup_revert_proof"
    );
  }
  if (facts.phaseName || facts.phaseFilter || facts.phaseMappingIntent) {
    notes.push(
      "missing_live_evidence=phase_name_or_filter",
      "missing_live_evidence=original_phase_filter_readback",
      facts.phaseMappingIntent ? "missing_live_evidence=linked_phase_mapping_readback" : "",
      "missing_live_evidence=focused_capture_target",
      "missing_live_evidence=cleanup_revert_proof"
    );
  }
  return notes;
}

function modeledMepReviewEvidenceNotes(operation: string, target: string): string[] {
  if (!["duct", "pipe"].includes(target)) return [];
  const notes = [
    "missing_live_evidence=target_view_or_sheet_id",
    "missing_live_evidence=focused_capture_target",
    "missing_live_evidence=cleanup_verification"
  ];
  if (operation === "route") {
    notes.push(
      "missing_live_evidence=projected_route_points",
      "missing_live_evidence=system_type",
      "missing_live_evidence=level_or_route_plane",
      "missing_live_evidence=connector_readback"
    );
  } else if (operation === "reroute_offset") {
    notes.push(
      "missing_live_evidence=host_route_element_id",
      "missing_live_evidence=projected_split_points",
      "missing_live_evidence=offset_vector_or_replacement_route",
      "missing_live_evidence=connector_readback"
    );
  } else if (operation === "tap_branch") {
    notes.push(
      "missing_live_evidence=host_main_element",
      "missing_live_evidence=projected_tap_point",
      "missing_live_evidence=branch_path_points",
      "missing_live_evidence=fitting_or_connection_mode",
      "missing_live_evidence=connector_readback"
    );
  } else if (operation === "size_transition") {
    notes.push(
      "missing_live_evidence=host_route_element_id",
      "missing_live_evidence=upstream_size_readback",
      "missing_live_evidence=downstream_size",
      "missing_live_evidence=projected_transition_point_or_chainage",
      "missing_live_evidence=fitting_readback",
      "missing_live_evidence=connector_readback"
    );
  }
  return notes;
}

function mepSizingReviewEvidenceNotes(operation: string, target: string, facts: ReturnType<typeof extractedReviewFacts>, text = ""): string[] {
  if (operation !== "size_transition" || !["duct", "pipe"].includes(target)) return [];
  const cfmDrivenSizing = Boolean(facts.requestedAirflow) || /\b(?:size|resize|calculate|revise|update|provide|set)\b.{0,80}\b\d{2,6}\s*cfm\b|\b\d{2,6}\s*cfm\b.{0,80}\b(?:ductwork|ducts?|supply|return|exhaust|airflow)\b/i.test(text);
  const scopedSizing = /\b(?:all|these|this|the)\s+(?:ductwork|ducts?|piping|pipes?)\b|\b(?:ductwork|ducts?|piping|pipes?)\s+(?:need|needs|shall|should)\s+to\s+be\s+(?:sized|resized)\b|\b(?:each|per)\s+(?:segment|branch|run)\b/i.test(text);
  const notes = [
    facts.existingSize ? `known_existing_size=${facts.existingSize}` : "",
    facts.requestedSize ? `known_requested_size=${facts.requestedSize}` : "",
    facts.requestedSizeCandidates ? `known_requested_size_candidates=${facts.requestedSizeCandidates}` : "",
    facts.requestedSizeBasis ? `known_requested_size_basis=${facts.requestedSizeBasis}` : "",
    facts.requestedAirflow ? `known_requested_airflow=${facts.requestedAirflow}` : ""
  ];
  if (cfmDrivenSizing) {
    notes.push(
      "missing_live_evidence=engineering_sizing_basis",
      "required_revit_proof=airflow basis and selected size must be justified by schedule/calculation or reviewer-supplied sizing basis"
    );
  }
  if (scopedSizing || facts.requestedSizeCandidates) {
    notes.push(
      "missing_live_evidence=per_segment_size_readback",
      "required_revit_proof=each affected duct/pipe segment must have before/after size readback"
    );
  }
  return notes.filter(Boolean);
}

function mepTopologyReviewEvidenceNotes(operation: string, target: string, facts: ReturnType<typeof extractedReviewFacts>): string[] {
  if (operation !== "tap_branch" || !["duct", "pipe"].includes(target)) return [];
  return [
    facts.requestedBranchCount ? `known_branch_count=${facts.requestedBranchCount}` : "",
    facts.requestedConnectionKind ? `known_connection_kind=${facts.requestedConnectionKind}` : "",
    facts.tapPlacementHint ? `known_tap_placement=${facts.tapPlacementHint}` : "",
    facts.clearanceHint ? `known_clearance=${facts.clearanceHint}` : ""
  ].filter(Boolean);
}

function documentationGraphicsReviewEvidenceNotes(operation: string, target: string, facts: ReturnType<typeof extractedReviewFacts>): string[] {
  if (operation !== "graphics_override") return [];
  const notes = [
    "missing_live_evidence=target_view_or_sheet_id",
    "missing_live_evidence=graphics_readback",
    "missing_live_evidence=focused_capture_target",
    "missing_live_evidence=cleanup_revert_proof"
  ];
  if (target === "category_graphics") {
    notes.push("missing_live_evidence=category_name_or_id");
    if (!facts.graphicsTargetHint && !facts.linkedModelCategory && !facts.phaseName && !facts.phaseFilter && !facts.phaseMappingIntent) {
      notes.push("missing_live_evidence=graphics_target");
    }
  } else if (target === "view_filter") {
    notes.push("missing_live_evidence=filter_name_or_id");
    notes.push("missing_live_evidence=filter_override_revert_readback");
  } else if (target === "view_template") {
    notes.push("missing_live_evidence=view_template_name_or_id");
    notes.push("missing_live_evidence=view_template_override_readback");
  } else if (target === "cad_link") {
    notes.push("missing_live_evidence=cad_import_or_link_id");
    notes.push("missing_live_evidence=cad_layer_or_subcategory_readback");
  }
  return [
    ...notes,
    ...graphicsReviewEvidenceNotes(facts)
  ];
}

const belowConfidenceAuditHeaders = [
  "pair",
  "priority_rank",
  "example_id",
  "confidence",
  "min_confidence",
  "needs_human_review",
  "review_match",
  "file",
  "page",
  "index",
  "text_excerpt",
  "evidence",
  "review_requested_size",
  "review_existing_size",
  "review_requested_size_candidates",
  "review_requested_size_basis",
  "review_requested_airflow",
  "review_elevation_hint",
  "review_requested_branch_count",
  "review_requested_connection_kind",
  "review_tap_placement_hint",
  "review_clearance_hint",
  "review_requested_text",
  "review_existing_text",
  "review_requested_lineweight",
  "review_graphics_style_intent",
  "review_graphics_target_hint",
  "review_visibility_intent",
  "review_linked_model_category",
  "review_linked_visibility_intent",
  "review_phase_name",
  "review_phase_filter",
  "review_phase_mapping_intent",
  "review_requested_accessory_kind",
  "review_requested_accessory_size",
  "review_requested_tag_kind",
  "review_requested_tag_value",
  "review_requested_tag_note_number",
  "review_tag_target_scope",
  "review_existing_type",
  "review_requested_type"
];

const belowConfidenceReviewHeaders = [
  "file",
  "page",
  "index",
  "text_excerpt",
  "review_status",
  "review_operation",
  "review_target",
  "review_requested_size",
  "review_existing_size",
  "review_requested_size_candidates",
  "review_requested_size_basis",
  "review_requested_airflow",
  "review_elevation_hint",
  "review_requested_branch_count",
  "review_requested_connection_kind",
  "review_tap_placement_hint",
  "review_clearance_hint",
  "review_requested_text",
  "review_existing_text",
  "review_requested_lineweight",
  "review_graphics_style_intent",
  "review_graphics_target_hint",
  "review_visibility_intent",
  "review_linked_model_category",
  "review_linked_visibility_intent",
  "review_phase_name",
  "review_phase_filter",
  "review_phase_mapping_intent",
  "review_requested_accessory_kind",
  "review_requested_accessory_size",
  "review_requested_tag_kind",
  "review_requested_tag_value",
  "review_requested_tag_note_number",
  "review_tag_target_scope",
  "review_existing_type",
  "review_requested_type",
  "review_skip_reason",
  "review_notes"
];

const groupReviewHeaders = [
  "source_kind",
  "file",
  "page",
  "group_index",
  "parent_group_index",
  "annotation_indices",
  "parent_annotation_indices",
  "index",
  "review_split_child_index",
  "text_excerpt",
  "review_status",
  "review_operation",
  "review_target",
  "review_group_actionability",
  "review_split_hint",
  "review_primary_annotation_indices",
  "review_non_actionable_reason",
  "review_requested_size",
  "review_existing_size",
  "review_requested_size_candidates",
  "review_requested_size_basis",
  "review_requested_airflow",
  "review_elevation_hint",
  "review_requested_branch_count",
  "review_requested_connection_kind",
  "review_tap_placement_hint",
  "review_clearance_hint",
  "review_requested_text",
  "review_existing_text",
  "review_requested_lineweight",
  "review_graphics_style_intent",
  "review_graphics_target_hint",
  "review_visibility_intent",
  "review_linked_model_category",
  "review_linked_visibility_intent",
  "review_phase_name",
  "review_phase_filter",
  "review_phase_mapping_intent",
  "review_requested_accessory_kind",
  "review_requested_accessory_size",
  "review_requested_tag_kind",
  "review_requested_tag_value",
  "review_requested_tag_note_number",
  "review_tag_target_scope",
  "review_existing_type",
  "review_requested_type",
  "review_skip_reason",
  "review_notes"
];

function reviewedCandidateRow(options: {
  reviewRow: CsvRow;
  operation: string;
  target: string;
  facts: ReturnType<typeof extractedReviewFacts>;
  reviewStatus: string;
  notes: string[];
  skipReason?: string;
}): CsvRow {
  return {
    ...(options.reviewRow.source_kind ? { source_kind: options.reviewRow.source_kind } : {}),
    file: options.reviewRow.file ?? options.reviewRow.file_path ?? "",
    page: options.reviewRow.page ?? "",
    ...(options.reviewRow.group_index ? { group_index: options.reviewRow.group_index } : {}),
    ...(options.reviewRow.parent_group_index ? { parent_group_index: options.reviewRow.parent_group_index } : {}),
    ...(options.reviewRow.annotation_indices ? { annotation_indices: options.reviewRow.annotation_indices } : {}),
    ...(options.reviewRow.parent_annotation_indices ? { parent_annotation_indices: options.reviewRow.parent_annotation_indices } : {}),
    index: options.reviewRow.index ?? options.reviewRow.group_index ?? "",
    ...(options.reviewRow.review_split_child_index ? { review_split_child_index: options.reviewRow.review_split_child_index } : {}),
    text_excerpt: options.reviewRow.text_excerpt ?? "",
    review_status: options.reviewStatus,
    review_operation: options.operation,
    review_target: options.target,
    ...(options.facts.requestedSize ? { review_requested_size: options.facts.requestedSize } : {}),
    ...(options.facts.existingSize ? { review_existing_size: options.facts.existingSize } : {}),
    ...(options.facts.requestedSizeCandidates ? { review_requested_size_candidates: options.facts.requestedSizeCandidates } : {}),
    ...(options.facts.requestedSizeBasis ? { review_requested_size_basis: options.facts.requestedSizeBasis } : {}),
    ...(options.facts.requestedAirflow ? { review_requested_airflow: options.facts.requestedAirflow } : {}),
    ...(options.facts.elevationHint ? { review_elevation_hint: options.facts.elevationHint } : {}),
    ...(options.facts.requestedBranchCount ? { review_requested_branch_count: options.facts.requestedBranchCount } : {}),
    ...(options.facts.requestedConnectionKind ? { review_requested_connection_kind: options.facts.requestedConnectionKind } : {}),
    ...(options.facts.tapPlacementHint ? { review_tap_placement_hint: options.facts.tapPlacementHint } : {}),
    ...(options.facts.clearanceHint ? { review_clearance_hint: options.facts.clearanceHint } : {}),
    ...(options.facts.requestedText ? { review_requested_text: options.facts.requestedText } : {}),
    ...(options.facts.existingText ? { review_existing_text: options.facts.existingText } : {}),
    ...(options.facts.requestedLineWeight ? { review_requested_lineweight: options.facts.requestedLineWeight } : {}),
    ...(options.facts.graphicsStyleIntent ? { review_graphics_style_intent: options.facts.graphicsStyleIntent } : {}),
    ...(options.facts.graphicsTargetHint ? { review_graphics_target_hint: options.facts.graphicsTargetHint } : {}),
    ...(options.facts.visibilityIntent ? { review_visibility_intent: options.facts.visibilityIntent } : {}),
    ...(options.facts.linkedModelCategory ? { review_linked_model_category: options.facts.linkedModelCategory } : {}),
    ...(options.facts.linkedVisibilityIntent ? { review_linked_visibility_intent: options.facts.linkedVisibilityIntent } : {}),
    ...(options.facts.phaseName ? { review_phase_name: options.facts.phaseName } : {}),
    ...(options.facts.phaseFilter ? { review_phase_filter: options.facts.phaseFilter } : {}),
    ...(options.facts.phaseMappingIntent ? { review_phase_mapping_intent: options.facts.phaseMappingIntent } : {}),
    ...(options.facts.requestedAccessoryKind ? { review_requested_accessory_kind: options.facts.requestedAccessoryKind } : {}),
    ...(options.facts.requestedAccessorySize ? { review_requested_accessory_size: options.facts.requestedAccessorySize } : {}),
    ...(options.facts.requestedTagKind ? { review_requested_tag_kind: options.facts.requestedTagKind } : {}),
    ...(options.facts.requestedTagValue ? { review_requested_tag_value: options.facts.requestedTagValue } : {}),
    ...(options.facts.requestedTagNoteNumber ? { review_requested_tag_note_number: options.facts.requestedTagNoteNumber } : {}),
    ...(options.facts.tagTargetScope ? { review_tag_target_scope: options.facts.tagTargetScope } : {}),
    ...(options.facts.existingType ? { review_existing_type: options.facts.existingType } : {}),
    ...(options.facts.requestedType ? { review_requested_type: options.facts.requestedType } : {}),
    ...(options.skipReason ? { review_skip_reason: options.skipReason } : {}),
    review_notes: options.notes.filter(Boolean).join("; ")
  };
}

function buildBelowConfidenceAuditRows(
  queue: PriorityQueue,
  reviewByKey: Map<string, CsvRow>,
  options: {
    operationFilter: Set<string> | null;
    targetFilter: Set<string> | null;
    pairFilter: Set<string> | null;
    minConfidence: number;
  }
): CsvRow[] {
  const rows: CsvRow[] = [];
  for (const item of queue.items ?? []) {
    const operation = canonicalOperation(String(item.operation ?? "").trim());
    const target = String(item.target ?? "").trim();
    const pair = `${operation}/${target}`;
    if (options.pairFilter) {
      if (!options.pairFilter.has(pair)) continue;
    } else {
      if (options.operationFilter && !options.operationFilter.has(operation)) continue;
      if (options.targetFilter && !options.targetFilter.has(target)) continue;
    }
    for (const example of item.examples ?? []) {
      const confidence = Number(example.confidence ?? 0);
      const key = idKey(String(example.id ?? ""));
      const reviewRow = key ? reviewByKey.get(key) : undefined;
      const effectiveConfidence = Number.isFinite(confidence)
        ? effectiveExampleConfidence({
          confidence,
          reviewRow,
          evidence: String(example.evidence ?? ""),
          operation,
          target,
          minConfidence: options.minConfidence
        })
        : confidence;
      if (!Number.isFinite(effectiveConfidence) || effectiveConfidence >= options.minConfidence) continue;
      const facts = extractedReviewFacts(`${reviewRow?.text_excerpt ?? ""} ${example.evidence ?? ""}`, target);
      rows.push({
        pair,
        priority_rank: String(item.rank ?? ""),
        example_id: String(example.id ?? ""),
        confidence: String(confidence),
        min_confidence: String(options.minConfidence),
        needs_human_review: example.needs_human_review ? "true" : "false",
        review_match: reviewRow ? "true" : "false",
        file: reviewRow?.file ?? reviewRow?.file_path ?? "",
        page: reviewRow?.page ?? "",
        index: reviewRow?.index ?? reviewRow?.group_index ?? "",
        text_excerpt: reviewRow?.text_excerpt ?? "",
        evidence: String(example.evidence ?? ""),
        ...(facts.requestedSize ? { review_requested_size: facts.requestedSize } : {}),
        ...(facts.existingSize ? { review_existing_size: facts.existingSize } : {}),
        ...(facts.requestedSizeCandidates ? { review_requested_size_candidates: facts.requestedSizeCandidates } : {}),
        ...(facts.requestedSizeBasis ? { review_requested_size_basis: facts.requestedSizeBasis } : {}),
        ...(facts.requestedAirflow ? { review_requested_airflow: facts.requestedAirflow } : {}),
        ...(facts.elevationHint ? { review_elevation_hint: facts.elevationHint } : {}),
        ...(facts.requestedBranchCount ? { review_requested_branch_count: facts.requestedBranchCount } : {}),
        ...(facts.requestedConnectionKind ? { review_requested_connection_kind: facts.requestedConnectionKind } : {}),
        ...(facts.tapPlacementHint ? { review_tap_placement_hint: facts.tapPlacementHint } : {}),
        ...(facts.clearanceHint ? { review_clearance_hint: facts.clearanceHint } : {}),
        ...(facts.requestedText ? { review_requested_text: facts.requestedText } : {}),
        ...(facts.existingText ? { review_existing_text: facts.existingText } : {}),
        ...(facts.requestedLineWeight ? { review_requested_lineweight: facts.requestedLineWeight } : {}),
        ...(facts.graphicsStyleIntent ? { review_graphics_style_intent: facts.graphicsStyleIntent } : {}),
        ...(facts.graphicsTargetHint ? { review_graphics_target_hint: facts.graphicsTargetHint } : {}),
        ...(facts.visibilityIntent ? { review_visibility_intent: facts.visibilityIntent } : {}),
        ...(facts.linkedModelCategory ? { review_linked_model_category: facts.linkedModelCategory } : {}),
        ...(facts.linkedVisibilityIntent ? { review_linked_visibility_intent: facts.linkedVisibilityIntent } : {}),
        ...(facts.phaseName ? { review_phase_name: facts.phaseName } : {}),
        ...(facts.phaseFilter ? { review_phase_filter: facts.phaseFilter } : {}),
        ...(facts.phaseMappingIntent ? { review_phase_mapping_intent: facts.phaseMappingIntent } : {}),
        ...(facts.requestedAccessoryKind ? { review_requested_accessory_kind: facts.requestedAccessoryKind } : {}),
        ...(facts.requestedAccessorySize ? { review_requested_accessory_size: facts.requestedAccessorySize } : {}),
        ...(facts.requestedTagKind ? { review_requested_tag_kind: facts.requestedTagKind } : {}),
        ...(facts.requestedTagValue ? { review_requested_tag_value: facts.requestedTagValue } : {}),
        ...(facts.requestedTagNoteNumber ? { review_requested_tag_note_number: facts.requestedTagNoteNumber } : {}),
        ...(facts.tagTargetScope ? { review_tag_target_scope: facts.tagTargetScope } : {}),
        ...(facts.existingType ? { review_existing_type: facts.existingType } : {}),
        ...(facts.requestedType ? { review_requested_type: facts.requestedType } : {})
      });
    }
  }
  return rows;
}

function buildBelowConfidenceReviewRows(
  queue: PriorityQueue,
  reviewByKey: Map<string, CsvRow>,
  options: {
    operationFilter: Set<string> | null;
    targetFilter: Set<string> | null;
    pairFilter: Set<string> | null;
    minConfidence: number;
  }
): CsvRow[] {
  const rows: CsvRow[] = [];
  const seen = new Set<string>();
  for (const item of queue.items ?? []) {
    const operation = canonicalOperation(String(item.operation ?? "").trim());
    const target = String(item.target ?? "").trim();
    const pair = `${operation}/${target}`;
    if (options.pairFilter) {
      if (!options.pairFilter.has(pair)) continue;
    } else {
      if (options.operationFilter && !options.operationFilter.has(operation)) continue;
      if (options.targetFilter && !options.targetFilter.has(target)) continue;
    }
    for (const example of item.examples ?? []) {
      const confidence = Number(example.confidence ?? 0);
      const key = idKey(String(example.id ?? ""));
      if (!key || seen.has(key)) continue;
      const reviewRow = reviewByKey.get(key);
      if (!reviewRow) continue;
      const effectiveConfidence = Number.isFinite(confidence)
        ? effectiveExampleConfidence({
          confidence,
          reviewRow,
          evidence: String(example.evidence ?? ""),
          operation,
          target,
          minConfidence: options.minConfidence
        })
        : confidence;
      if (!Number.isFinite(effectiveConfidence) || effectiveConfidence >= options.minConfidence) continue;
      seen.add(key);
      const reviewAndEvidenceText = `${reviewRow.text_excerpt ?? ""} ${example.evidence ?? ""}`;
      const facts = extractedReviewFacts(reviewAndEvidenceText, target);
      const safetyBlockReason = belowConfidenceSafetyBlockReason(operation, target, reviewAndEvidenceText);
      rows.push(reviewedCandidateRow({
        reviewRow,
        operation,
        target,
        facts,
        reviewStatus: "needs_review",
        skipReason: safetyBlockReason,
        notes: [
          "below_confidence_review_candidate",
          safetyBlockReason ? "blocked_before_live_seed" : "",
          ...belowConfidenceBlockEvidenceNotes(safetyBlockReason),
          ...graphicsReviewEvidenceNotes(facts),
          `seeded_from_priority_rank=${item.rank ?? ""}`,
          `confidence=${confidence}`,
          `min_confidence=${options.minConfidence}`,
          facts.requestedSize ? `requested_size=${facts.requestedSize}` : "",
          facts.requestedAirflow ? `requested_airflow=${facts.requestedAirflow}` : "",
          ...mepSizingReviewEvidenceNotes(operation, target, facts, reviewAndEvidenceText),
          ...mepTopologyReviewEvidenceNotes(operation, target, facts),
          facts.graphicsTargetHint ? `graphics_target_hint=${facts.graphicsTargetHint}` : "",
          facts.linkedModelCategory ? `linked_model_category=${facts.linkedModelCategory}` : "",
          facts.phaseName ? `phase_name=${facts.phaseName}` : "",
          facts.phaseFilter ? `phase_filter=${facts.phaseFilter}` : "",
          String(example.evidence ?? "").slice(0, 240)
        ]
      }));
    }
  }
  return rows;
}

function reviewRowKey(row: CsvRow): string {
  return [
    row.file ?? row.file_path ?? "",
    row.page ?? "",
    row.index ?? row.group_index ?? "",
    row.text_excerpt ?? ""
  ].join("\n");
}

function groupAnnotationIndices(row: CsvRow): string[] {
  return String(row.annotation_indices ?? "")
    .split(/[|;\s]+/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

function groupActionabilityHints(row: CsvRow, operation: string, target: string): {
  actionability: string;
  splitHint: string;
  primaryAnnotationIndices: string;
  nonActionableReason: string;
  notes: string[];
} {
  const text = String(row.text_excerpt ?? "");
  const lower = text.toLowerCase();
  const annotationIndices = groupAnnotationIndices(row);
  const markCount = Number(row.mark_count || annotationIndices.length || 0);
  const textMarkCount = Number(row.text_mark_count || 0);
  const geometryOnlyCount = Number(row.geometry_only_count || 0);
  const sourceOperation = canonicalOperation(String(row.operation_class ?? ""));
  const sourceTarget = String(row.target_class ?? "");
  const bucket = String(row.bucket ?? "");
  const notes: string[] = [];

  const nonActionableReason = /\b(?:general\s+note\s+only|for\s+reference|reference\s+only|no\s+(?:new\s+)?work(?:\s+shown|\s+requirements?)?|no\s+change|existing\s+to\s+remain|revision\s+cloud\s+only|cloud\s+only|status\s+note)\b/i.test(text)
    ? "source text reads as note/status/reference rather than Revit change"
    : "";
  if (nonActionableReason) {
    return {
      actionability: "likely_non_actionable",
      splitHint: "do_not_promote_without_human_relabel",
      primaryAnnotationIndices: annotationIndices.join("|"),
      nonActionableReason,
      notes: [
        "group_actionability=likely_non_actionable",
        `non_actionable_reason=${nonActionableReason}`
      ]
    };
  }

  if (markCount >= 8 || annotationIndices.length >= 8) {
    notes.push("group_split_risk=large_composite_group");
    notes.push(`group_member_count=${markCount || annotationIndices.length}`);
  }
  if (geometryOnlyCount > textMarkCount && annotationIndices.length > 3) {
    notes.push("group_split_risk=geometry_heavy_group");
  }
  const coordinatedTapRequest = operation === "tap_branch" && /\btap\b/i.test(lower) && /\bconnect\b/i.test(lower);
  if (!coordinatedTapRequest && /\b(?:and|also|plus|then)\b/i.test(lower) && /\b(?:add|remove|delete|move|reroute|route|tap|connect|change|resize|hide|show)\b/i.test(lower)) {
    notes.push("group_split_risk=multiple_action_words");
  }
  if (/\b(?:as\s+shown|blue\s+line|red\s+line|clouded|highlighted|circled)\b/i.test(lower)) {
    notes.push("group_split_risk=visual_reference_requires_region_review");
  }
  if (sourceOperation && sourceOperation !== "unknown" && sourceOperation !== operation) {
    notes.push(`group_split_risk=source_operation_mismatch:${sourceOperation}`);
  }
  if (sourceTarget && sourceTarget !== "unknown" && sourceTarget !== target) {
    notes.push(`group_split_risk=source_target_mismatch:${sourceTarget}`);
  }
  if (bucket === "unknown_geometry_candidate") {
    notes.push("group_split_risk=unknown_geometry_bucket");
  }

  const splitRisk = notes.length > 0;
  return {
    actionability: splitRisk ? "split_review_required" : "likely_single_action",
    splitHint: splitRisk
      ? "review_annotation_indices_and_split_or_relabel_before_promotion"
      : "confirm_all_annotation_indices_are_one_request_before_promotion",
    primaryAnnotationIndices: splitRisk && annotationIndices.length > 12 ? "" : annotationIndices.join("|"),
    nonActionableReason: "",
    notes: [
      `group_actionability=${splitRisk ? "split_review_required" : "likely_single_action"}`,
      splitRisk ? "required_human_step=split_or_confirm_group_scope" : "required_human_step=confirm_single_action_group",
      ...notes
    ]
  };
}

function splitReviewClauses(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const raw = normalized
    .split(/\s*(?:[.;]|\bthen\b|\balso\b|\bplus\b|\band\b)\s*/i)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 8);
  const clauses = raw.length > 1 ? raw : [normalized];
  return Array.from(new Set(clauses))
    .filter((entry) => /\b(add|remove|delete|move|reroute|route|tap|connect|change|resize|hide|show|offset|drop|raise|transition|replace)\b/i.test(entry));
}

function rowMatchesGroupReviewFilters(
  operation: string,
  target: string,
  options: {
    operationFilter: Set<string> | null;
    targetFilter: Set<string> | null;
    pairFilter: Set<string> | null;
  }
): boolean {
  const pair = `${operation}/${target}`;
  if (options.pairFilter) return options.pairFilter.has(pair);
  if (options.operationFilter && !options.operationFilter.has(operation)) return false;
  if (options.targetFilter && !options.targetFilter.has(target)) return false;
  return true;
}

function buildSplitReviewChildRows(
  reviewRow: CsvRow,
  parentOperation: string,
  parentTarget: string,
  options: {
    operationFilter: Set<string> | null;
    targetFilter: Set<string> | null;
    pairFilter: Set<string> | null;
  }
): CsvRow[] {
  const text = String(reviewRow.text_excerpt ?? "");
  const clauses = splitReviewClauses(text);
  const rows: CsvRow[] = [];
  const parentGroupIndex = String(reviewRow.group_index ?? "");
  const parentAnnotationIndices = groupAnnotationIndices(reviewRow).join("|");
  clauses.forEach((clause, index) => {
    const local = classifyRedlineCorpusText({
      file_path: reviewRow.file ?? reviewRow.file_path ?? "",
      text: clause
    });
    if (local.manual_review_reason) return;
    const operation = canonicalOperation(local.operation_class || parentOperation);
    const target = local.target_class || parentTarget;
    if (!rowMatchesGroupReviewFilters(operation, target, options)) return;
    const childReviewRow: CsvRow = {
      ...reviewRow,
      source_kind: "split_review_child",
      parent_group_index: parentGroupIndex,
      parent_annotation_indices: parentAnnotationIndices,
      group_index: parentGroupIndex ? `${parentGroupIndex}.${index + 1}` : "",
      annotation_indices: "",
      index: parentGroupIndex ? `${parentGroupIndex}.${index + 1}` : String(index + 1),
      review_split_child_index: String(index + 1),
      text_excerpt: clause
    };
    const facts = extractedReviewFacts(clause, target);
    rows.push({
      ...reviewedCandidateRow({
        reviewRow: childReviewRow,
        operation,
        target,
        facts,
        reviewStatus: "needs_review",
        skipReason: "split-review child candidate requires human confirmation before live promotion",
        notes: [
          "split_review_child_candidate",
          `parent_group_index=${parentGroupIndex}`,
          parentAnnotationIndices ? `parent_annotation_indices=${parentAnnotationIndices}` : "",
          `child_clause_index=${index + 1}`,
          `locally_classified_confidence=${local.confidence}`,
          `parent_operation=${parentOperation}`,
          `parent_target=${parentTarget}`,
          facts.requestedSize ? `requested_size=${facts.requestedSize}` : "",
          facts.requestedAirflow ? `requested_airflow=${facts.requestedAirflow}` : "",
          ...modeledMepReviewEvidenceNotes(operation, target),
          ...mepSizingReviewEvidenceNotes(operation, target, facts, clause),
          ...mepTopologyReviewEvidenceNotes(operation, target, facts),
          ...documentationGraphicsReviewEvidenceNotes(operation, target, facts),
          "required_human_step=confirm_child_is_one_action_before_promotion",
          "required_revit_proof=live model ids, projection/readback, focused capture, visual gate, and cleanup before run"
        ]
      }),
      review_group_actionability: "split_review_child",
      review_split_hint: "review_child_clause_and_relabel_likely_single_action_before_promotion",
      review_primary_annotation_indices: "",
      parent_group_index: parentGroupIndex,
      parent_annotation_indices: parentAnnotationIndices,
      review_split_child_index: String(index + 1)
    });
  });
  return rows;
}

function isGraphicsReviewCandidate(row: CsvRow, facts: ReturnType<typeof extractedReviewFacts>): boolean {
  if (!(facts.linkedModelCategory || facts.phaseName || facts.phaseFilter || facts.phaseMappingIntent)) return false;
  const operation = canonicalOperation(String(row.review_operation || row.operation_class || ""));
  const target = String(row.review_target || row.target_class || "");
  const text = String(row.text_excerpt ?? "");
  if (operation === "graphics_override") return true;
  if (["category_graphics", "view_filter", "view_template", "view", "sheet"].includes(target)) return true;
  return /\b(?:line\s*weight|lineweight|halftone|visibility|graphics|show|hide|dashed|new\s+work|demo\s+work)\b/i.test(text);
}

function linkedPhaseReviewTarget(row: CsvRow, facts: ReturnType<typeof extractedReviewFacts>): string {
  const existing = String(row.review_target || row.target_class || "").trim();
  if (["category_graphics", "view_filter", "view_template"].includes(existing)) return existing;
  if (facts.linkedModelCategory) return "category_graphics";
  return "view_filter";
}

function buildLinkedPhaseGraphicsReviewRows(reviewRows: CsvRow[]): CsvRow[] {
  const rows: CsvRow[] = [];
  const seen = new Set<string>();
  for (const reviewRow of reviewRows) {
    if (rowHasReviewLabel(reviewRow)) continue;
    const text = String(reviewRow.text_excerpt ?? "");
    const facts = extractedReviewFacts(text, String(reviewRow.review_target || reviewRow.target_class || ""));
    if (!isGraphicsReviewCandidate(reviewRow, facts)) continue;
    const key = reviewRowKey(reviewRow);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(reviewedCandidateRow({
      reviewRow,
      operation: "graphics_override",
      target: linkedPhaseReviewTarget(reviewRow, facts),
      facts,
      reviewStatus: "needs_review",
      skipReason: facts.linkedModelCategory
        ? "linked-model/phase graphics audit candidate requires linked/phase readback and revert evidence before live promotion"
        : "phase graphics audit candidate requires phase/filter readback and revert evidence before live promotion",
      notes: [
        "linked_phase_review_candidate",
        facts.linkedModelCategory ? `linked_model_category=${facts.linkedModelCategory}` : "",
        facts.linkedVisibilityIntent ? `linked_visibility_intent=${facts.linkedVisibilityIntent}` : "",
        facts.phaseName ? `phase_name=${facts.phaseName}` : "",
        facts.phaseFilter ? `phase_filter=${facts.phaseFilter}` : "",
        facts.phaseMappingIntent ? `phase_mapping_intent=${facts.phaseMappingIntent}` : "",
        ...graphicsReviewEvidenceNotes(facts),
        "required_revit_proof=exact view/sheet and target linked model/category or phase/filter readback before any write",
        "required_revit_proof=focused capture plus cleanup/revert readback before completion"
      ]
    }));
  }
  return rows;
}

function buildGroupReviewRows(
  reviewRows: CsvRow[],
  options: {
    operationFilter: Set<string> | null;
    targetFilter: Set<string> | null;
    pairFilter: Set<string> | null;
  }
): CsvRow[] {
  const rows: CsvRow[] = [];
  const seen = new Set<string>();
  for (const reviewRow of reviewRows) {
    if (!String(reviewRow.group_index ?? "").trim() && !String(reviewRow.annotation_indices ?? "").trim()) continue;
    if (rowHasReviewLabel(reviewRow)) continue;
    const text = String(reviewRow.text_excerpt ?? "");
    if (!text.trim()) continue;
    const local = classifyRedlineCorpusText({
      file_path: reviewRow.file ?? reviewRow.file_path ?? "",
      text
    });
    if (local.manual_review_reason) continue;
    const operation = canonicalOperation(local.operation_class);
    const target = local.target_class;
    const pair = `${operation}/${target}`;
    if (options.pairFilter) {
      if (!options.pairFilter.has(pair)) continue;
    } else {
      if (options.operationFilter && !options.operationFilter.has(operation)) continue;
      if (options.targetFilter && !options.targetFilter.has(target)) continue;
    }
    const key = reviewRowKey(reviewRow);
    if (seen.has(key)) continue;
    seen.add(key);
    const facts = extractedReviewFacts(text, target);
    const groupHints = groupActionabilityHints(reviewRow, operation, target);
    const row = reviewedCandidateRow({
      reviewRow,
      operation,
      target,
      facts,
      reviewStatus: "needs_review",
      skipReason: "composite group candidate requires human grouping review and verified Revit context before live promotion",
      notes: [
        "composite_group_review_candidate",
        `locally_classified_confidence=${local.confidence}`,
        `source_operation=${reviewRow.operation_class ?? ""}`,
        `source_target=${reviewRow.target_class ?? ""}`,
        facts.requestedSize ? `requested_size=${facts.requestedSize}` : "",
        facts.requestedAirflow ? `requested_airflow=${facts.requestedAirflow}` : "",
        facts.elevationHint ? `elevation_hint=${facts.elevationHint}` : "",
        ...modeledMepReviewEvidenceNotes(operation, target),
        ...mepSizingReviewEvidenceNotes(operation, target, facts, text),
        ...mepTopologyReviewEvidenceNotes(operation, target, facts),
        ...documentationGraphicsReviewEvidenceNotes(operation, target, facts),
        ...groupHints.notes,
        "required_revit_proof=human confirms grouped marks are one actionable request before approval",
        "required_revit_proof=live model ids, projection/readback, focused capture, visual gate, and cleanup before run"
      ]
    });
    rows.push({
      ...row,
      review_group_actionability: groupHints.actionability,
      review_split_hint: groupHints.splitHint,
      review_primary_annotation_indices: groupHints.primaryAnnotationIndices,
      ...(groupHints.nonActionableReason ? { review_non_actionable_reason: groupHints.nonActionableReason } : {})
    });
    if (groupHints.actionability === "split_review_required") {
      rows.push(...buildSplitReviewChildRows(reviewRow, operation, target, options));
    }
  }
  return rows;
}

export function seedReviewedRedlinePromotions(options: SeedReviewedPromotionsOptions) {
  const priorityQueuePath = path.resolve(options.priorityQueuePath);
  const reviewQueuePath = path.resolve(options.reviewQueuePath);
  const outputPath = path.resolve(options.outputPath);
  const queue = readJsonFile<PriorityQueue>(priorityQueuePath);
  const reviewRows = parseCsv(fs.readFileSync(reviewQueuePath, "utf8"));
  const reviewByKey = reviewRowIndex(reviewRows);
  const operationFilter = splitFilter(options.operations);
  const targetFilter = splitFilter(options.targets);
  const pairFilter = splitPairFilter(options.pairs);
  const maxPairs = Number.isFinite(options.maxPairs) && options.maxPairs && options.maxPairs > 0 ? options.maxPairs : 20;
  const maxPerPair = Number.isFinite(options.maxPerPair) && options.maxPerPair && options.maxPerPair > 0 ? options.maxPerPair : 3;
  const minConfidence = Number.isFinite(options.minConfidence) ? Number(options.minConfidence) : 0.9;
  const status = options.status?.trim() || "promote";
  const outputRows: CsvRow[] = [];
  const seen = new Set<string>();
  const requestedPairs = pairFilter ? Array.from(pairFilter) : [];
  const missingDiagnostics = requestedPairDiagnostics(queue, reviewByKey, requestedPairs, minConfidence, options.includeNeedsHumanReview);
  const belowConfidenceAuditRows = options.belowConfidenceAuditPath ? buildBelowConfidenceAuditRows(queue, reviewByKey, {
    operationFilter,
    targetFilter,
    pairFilter,
    minConfidence
  }) : [];
  const belowConfidenceReviewRows = options.belowConfidenceReviewPath ? buildBelowConfidenceReviewRows(queue, reviewByKey, {
    operationFilter,
    targetFilter,
    pairFilter,
    minConfidence
  }) : [];
  const linkedPhaseReviewRows = options.linkedPhaseReviewPath ? buildLinkedPhaseGraphicsReviewRows(reviewRows) : [];
  const groupReviewRows = options.groupReviewPath ? buildGroupReviewRows(reviewRows, {
    operationFilter,
    targetFilter,
    pairFilter
  }) : [];
  const skippedReviewRows: CsvRow[] = [];
  const skippedReviewKeys = new Set<string>();
  const selectedPairCounts = new Map<string, number>();
  const skippedSeedCounts = new Map<string, SkippedSeedSummary>();
  let matchedPairCount = 0;

  for (const item of queue.items ?? []) {
    const operation = String(item.operation ?? "").trim();
    const target = String(item.target ?? "").trim();
    const itemPairKey = `${operation}/${target}`;
    const canRetargetCategoryGraphicsToCadLink =
      operation === "graphics_override" &&
      target === "category_graphics" &&
      pairFilter?.has("graphics_override/cad_link");
    if (pairFilter) {
      if (!pairFilter.has(itemPairKey) && !canRetargetCategoryGraphicsToCadLink) continue;
    } else {
      if (operationFilter && !operationFilter.has(operation)) continue;
      if (targetFilter && !targetFilter.has(target)) continue;
    }
    if (matchedPairCount >= maxPairs) break;
    matchedPairCount++;
    let emittedForPair = 0;
    for (const example of item.examples ?? []) {
      if (emittedForPair >= maxPerPair) break;
      const id = String(example.id ?? "");
      const key = idKey(id);
      if (!key || seen.has(key)) continue;
      const confidence = Number(example.confidence ?? 0);
      const reviewRow = reviewByKey.get(key);
      if (!reviewRow) continue;
      const localClassification = locallyConfirmedClassification({
        reviewRow,
        evidence: String(example.evidence ?? ""),
        minConfidence
      });
      let outputOperation = operation;
      let outputTarget = target;
      let retargetedByLocalClassification = false;
      if (
        operation === "graphics_override" &&
        target === "category_graphics" &&
        (!pairFilter || pairFilter.has("graphics_override/cad_link")) &&
        canonicalOperation(localClassification?.operation_class ?? "") === "graphics_override" &&
        localClassification?.target_class === "cad_link"
      ) {
        outputTarget = "cad_link";
        retargetedByLocalClassification = true;
      }
      const pairKey = `${outputOperation}/${outputTarget}`;
      if (pairFilter && !pairFilter.has(pairKey)) continue;
      const effectiveConfidence = effectiveExampleConfidence({
        confidence,
        reviewRow,
        evidence: String(example.evidence ?? ""),
        operation: outputOperation,
        target: outputTarget,
        minConfidence
      });
      if (effectiveConfidence < minConfidence) continue;
      if (example.needs_human_review && !options.includeNeedsHumanReview) continue;
      const reviewAndEvidenceText = `${reviewRow.text_excerpt ?? ""} ${example.evidence ?? ""}`;
      const facts = extractedReviewFacts(reviewAndEvidenceText, outputTarget);
      const skipReason = liveSeedSkipReason(outputOperation, outputTarget, facts, reviewAndEvidenceText);
      if (skipReason) {
        const skipKey = `${pairKey}\n${skipReason}`;
        const current = skippedSeedCounts.get(skipKey);
        skippedSeedCounts.set(skipKey, {
          pair: pairKey,
          reason: skipReason,
          skipped_count: (current?.skipped_count ?? 0) + 1
        });
        if (options.skippedReviewPath && !skippedReviewKeys.has(`${key}\n${pairKey}`)) {
          skippedReviewKeys.add(`${key}\n${pairKey}`);
          skippedReviewRows.push(reviewedCandidateRow({
            reviewRow,
            operation: outputOperation,
            target: outputTarget,
            facts,
            reviewStatus: "needs_review",
            skipReason,
            notes: [
              "skipped_live_seed_candidate",
              `skip_reason=${skipReason}`,
              `seeded_from_priority_rank=${item.rank ?? ""}`,
              `confidence=${confidence}`,
              effectiveConfidence !== confidence ? `locally_confirmed_confidence=${effectiveConfidence}` : "",
              retargetedByLocalClassification ? `retargeted_from=${operation}/${target}` : "",
              facts.requestedLineWeight ? `requested_lineweight=${facts.requestedLineWeight}` : "",
              ...mepTopologyReviewEvidenceNotes(outputOperation, outputTarget, facts),
              facts.graphicsTargetHint ? `graphics_target_hint=${facts.graphicsTargetHint}` : "",
              facts.visibilityIntent ? `visibility_intent=${facts.visibilityIntent}` : "",
              facts.linkedModelCategory ? `linked_model_category=${facts.linkedModelCategory}` : "",
              facts.linkedVisibilityIntent ? `linked_visibility_intent=${facts.linkedVisibilityIntent}` : "",
              facts.phaseName ? `phase_name=${facts.phaseName}` : "",
              facts.phaseFilter ? `phase_filter=${facts.phaseFilter}` : "",
              facts.phaseMappingIntent ? `phase_mapping_intent=${facts.phaseMappingIntent}` : "",
              ...skippedSeedEvidenceNotes(skipReason, facts),
              String(example.evidence ?? "").slice(0, 240)
            ]
          }));
        }
        continue;
      }
      seen.add(key);
      emittedForPair++;
      selectedPairCounts.set(pairKey, (selectedPairCounts.get(pairKey) ?? 0) + 1);
      outputRows.push({
        ...reviewRow,
        review_status: status,
        review_operation: outputOperation,
        review_target: outputTarget,
        ...(facts.requestedSize ? { review_requested_size: facts.requestedSize } : {}),
        ...(facts.existingSize ? { review_existing_size: facts.existingSize } : {}),
        ...(facts.requestedSizeCandidates ? { review_requested_size_candidates: facts.requestedSizeCandidates } : {}),
        ...(facts.requestedSizeBasis ? { review_requested_size_basis: facts.requestedSizeBasis } : {}),
        ...(facts.requestedAirflow ? { review_requested_airflow: facts.requestedAirflow } : {}),
        ...(facts.elevationHint ? { review_elevation_hint: facts.elevationHint } : {}),
        ...(facts.requestedBranchCount ? { review_requested_branch_count: facts.requestedBranchCount } : {}),
        ...(facts.requestedConnectionKind ? { review_requested_connection_kind: facts.requestedConnectionKind } : {}),
        ...(facts.tapPlacementHint ? { review_tap_placement_hint: facts.tapPlacementHint } : {}),
        ...(facts.clearanceHint ? { review_clearance_hint: facts.clearanceHint } : {}),
        ...(facts.requestedText ? { review_requested_text: facts.requestedText } : {}),
        ...(facts.existingText ? { review_existing_text: facts.existingText } : {}),
        ...(facts.requestedLineWeight ? { review_requested_lineweight: facts.requestedLineWeight } : {}),
        ...(facts.graphicsStyleIntent ? { review_graphics_style_intent: facts.graphicsStyleIntent } : {}),
        ...(facts.graphicsTargetHint ? { review_graphics_target_hint: facts.graphicsTargetHint } : {}),
        ...(facts.visibilityIntent ? { review_visibility_intent: facts.visibilityIntent } : {}),
        ...(facts.requestedAccessoryKind ? { review_requested_accessory_kind: facts.requestedAccessoryKind } : {}),
        ...(facts.requestedAccessorySize ? { review_requested_accessory_size: facts.requestedAccessorySize } : {}),
        ...(facts.requestedTagKind ? { review_requested_tag_kind: facts.requestedTagKind } : {}),
        ...(facts.requestedTagValue ? { review_requested_tag_value: facts.requestedTagValue } : {}),
        ...(facts.requestedTagNoteNumber ? { review_requested_tag_note_number: facts.requestedTagNoteNumber } : {}),
        ...(facts.tagTargetScope ? { review_tag_target_scope: facts.tagTargetScope } : {}),
        ...(facts.existingType ? { review_existing_type: facts.existingType } : {}),
        ...(facts.requestedType ? { review_requested_type: facts.requestedType } : {}),
        ...(facts.linkedModelCategory ? { review_linked_model_category: facts.linkedModelCategory } : {}),
        ...(facts.linkedVisibilityIntent ? { review_linked_visibility_intent: facts.linkedVisibilityIntent } : {}),
        ...(facts.phaseName ? { review_phase_name: facts.phaseName } : {}),
        ...(facts.phaseFilter ? { review_phase_filter: facts.phaseFilter } : {}),
        ...(facts.phaseMappingIntent ? { review_phase_mapping_intent: facts.phaseMappingIntent } : {}),
        review_notes: [
          `seeded_from_priority_rank=${item.rank ?? ""}`,
          `confidence=${confidence}`,
          effectiveConfidence !== confidence ? `locally_confirmed_confidence=${effectiveConfidence}` : "",
          retargetedByLocalClassification ? `retargeted_from=${operation}/${target}` : "",
          facts.existingSize ? `existing_size=${facts.existingSize}` : "",
          facts.requestedSize ? `requested_size=${facts.requestedSize}` : "",
          facts.requestedSizeBasis ? `requested_size_basis=${facts.requestedSizeBasis}` : "",
          facts.requestedAirflow ? `requested_airflow=${facts.requestedAirflow}` : "",
          ...mepSizingReviewEvidenceNotes(outputOperation, outputTarget, facts, reviewAndEvidenceText),
          ...mepTopologyReviewEvidenceNotes(outputOperation, outputTarget, facts),
          facts.elevationHint ? `elevation_hint=${facts.elevationHint}` : "",
          facts.existingText ? `existing_text=${facts.existingText}` : "",
          facts.requestedText ? `requested_text=${facts.requestedText}` : "",
          facts.requestedLineWeight ? `requested_lineweight=${facts.requestedLineWeight}` : "",
          facts.graphicsStyleIntent ? `graphics_style_intent=${facts.graphicsStyleIntent}` : "",
          facts.graphicsTargetHint ? `graphics_target_hint=${facts.graphicsTargetHint}` : "",
          facts.visibilityIntent ? `visibility_intent=${facts.visibilityIntent}` : "",
          facts.requestedAccessoryKind ? `requested_accessory_kind=${facts.requestedAccessoryKind}` : "",
          facts.requestedAccessorySize ? `requested_accessory_size=${facts.requestedAccessorySize}` : "",
          facts.requestedTagKind ? `requested_tag_kind=${facts.requestedTagKind}` : "",
          facts.requestedTagValue ? `requested_tag_value=${facts.requestedTagValue}` : "",
          facts.requestedTagNoteNumber ? `requested_tag_note_number=${facts.requestedTagNoteNumber}` : "",
          facts.tagTargetScope ? `tag_target_scope=${facts.tagTargetScope}` : "",
          facts.existingType ? `existing_type=${facts.existingType}` : "",
          facts.requestedType ? `requested_type=${facts.requestedType}` : "",
          facts.linkedModelCategory ? `linked_model_category=${facts.linkedModelCategory}` : "",
          facts.linkedVisibilityIntent ? `linked_visibility_intent=${facts.linkedVisibilityIntent}` : "",
          facts.phaseName ? `phase_name=${facts.phaseName}` : "",
          facts.phaseFilter ? `phase_filter=${facts.phaseFilter}` : "",
          facts.phaseMappingIntent ? `phase_mapping_intent=${facts.phaseMappingIntent}` : "",
          String(example.evidence ?? "").slice(0, 240)
        ].filter(Boolean).join("; ")
      });
    }
  }

  ensureDir(path.dirname(outputPath));
  writeCsv(outputPath, outputRows);
  if (options.belowConfidenceAuditPath) {
    const auditPath = path.resolve(options.belowConfidenceAuditPath);
    ensureDir(path.dirname(auditPath));
    writeCsvWithHeaders(auditPath, belowConfidenceAuditHeaders, belowConfidenceAuditRows);
  }
  if (options.belowConfidenceReviewPath) {
    const reviewPath = path.resolve(options.belowConfidenceReviewPath);
    ensureDir(path.dirname(reviewPath));
    writeCsvWithHeaders(reviewPath, belowConfidenceReviewHeaders, belowConfidenceReviewRows);
  }
  if (options.skippedReviewPath) {
    const reviewPath = path.resolve(options.skippedReviewPath);
    ensureDir(path.dirname(reviewPath));
    writeCsvWithHeaders(reviewPath, belowConfidenceReviewHeaders, skippedReviewRows);
  }
  if (options.linkedPhaseReviewPath) {
    const reviewPath = path.resolve(options.linkedPhaseReviewPath);
    ensureDir(path.dirname(reviewPath));
    writeCsvWithHeaders(reviewPath, belowConfidenceReviewHeaders, linkedPhaseReviewRows);
  }
  if (options.groupReviewPath) {
    const reviewPath = path.resolve(options.groupReviewPath);
    ensureDir(path.dirname(reviewPath));
    writeCsvWithHeaders(reviewPath, groupReviewHeaders, groupReviewRows);
  }
  const selectedPairs: PairSelectionSummary[] = Array.from(selectedPairCounts.entries())
    .map(([pair, selected_count]) => ({ pair, selected_count }));
  const missingRequestedPairs = requestedPairs
    .filter((pair) => !selectedPairCounts.has(pair))
    .map((pair) => {
      const diagnostic = missingDiagnostics.get(pair);
      const skippedCount = Array.from(skippedSeedCounts.values())
        .filter((entry) => entry.pair === pair)
        .reduce((sum, entry) => sum + entry.skipped_count, 0);
      return {
        pair,
        selected_count: 0,
        reason: missingPairReason(diagnostic, skippedCount, minConfidence),
        ...(diagnostic?.candidate_count ? { candidate_count: diagnostic.candidate_count } : {}),
        ...(diagnostic?.eligible_count ? { eligible_count: diagnostic.eligible_count } : {}),
        ...(diagnostic?.review_match_count ? { review_match_count: diagnostic.review_match_count } : {}),
        ...(diagnostic?.best_confidence ? { best_confidence: diagnostic.best_confidence } : {})
      };
    });
  return {
    ok: true,
    priority_queue: priorityQueuePath,
    review_queue: reviewQueuePath,
    output: outputPath,
    ...(options.belowConfidenceAuditPath ? {
      below_confidence_audit_output: path.resolve(options.belowConfidenceAuditPath),
      below_confidence_audit_count: belowConfidenceAuditRows.length
    } : {}),
    ...(options.belowConfidenceReviewPath ? {
      below_confidence_review_output: path.resolve(options.belowConfidenceReviewPath),
      below_confidence_review_count: belowConfidenceReviewRows.length
    } : {}),
    ...(options.skippedReviewPath ? {
      skipped_review_output: path.resolve(options.skippedReviewPath),
      skipped_review_count: skippedReviewRows.length
    } : {}),
    ...(options.linkedPhaseReviewPath ? {
      linked_phase_review_output: path.resolve(options.linkedPhaseReviewPath),
      linked_phase_review_count: linkedPhaseReviewRows.length
    } : {}),
    ...(options.groupReviewPath ? {
      group_review_output: path.resolve(options.groupReviewPath),
      group_review_count: groupReviewRows.length
    } : {}),
    seeded_count: outputRows.length,
    matched_pair_count: matchedPairCount,
    selected_pairs: selectedPairs,
    missing_requested_pairs: missingRequestedPairs,
    skipped_seed_candidates: Array.from(skippedSeedCounts.values())
  };
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function splitFlag(args: string[], name: string): string[] | undefined {
  return flagValue(args, name)?.split(",").map((entry) => entry.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const priorityQueuePath = flagValue(process.argv, "--priority-queue") ?? path.join(repoRoot(), "local-work", "redline-corpus", "capability-summary", "gemini-unresolved-visual-context", "redline_capability_priority_queue.json");
  const reviewQueuePath = flagValue(process.argv, "--review-queue") ?? path.join(repoRoot(), "local-work", "redline-corpus", "inventory", "2026-07-03-desktop-pdfs", "redline_corpus_mark_review_queue.csv");
  const outputPath = flagValue(process.argv, "--output");
  if (!outputPath) {
    console.error("Usage: npm run redline:seed-reviewed-promotions -- --output <seed-review-rows.csv> [--below-confidence-audit-output <audit.csv>] [--below-confidence-review-output <needs-review.csv>] [--skipped-review-output <skipped-needs-review.csv>] [--linked-phase-review-output <linked-phase-needs-review.csv>] [--group-review-output <group-needs-review.csv>] [--pairs route/duct,size_transition/pipe] [--operations route,size_transition] [--targets duct,pipe] [--max-pairs 20] [--max-per-pair 3] [--min-confidence 0.9]");
    process.exit(2);
  }
  const result = seedReviewedRedlinePromotions({
    priorityQueuePath,
    reviewQueuePath,
    outputPath,
    belowConfidenceAuditPath: flagValue(process.argv, "--below-confidence-audit-output"),
    belowConfidenceReviewPath: flagValue(process.argv, "--below-confidence-review-output"),
    skippedReviewPath: flagValue(process.argv, "--skipped-review-output"),
    linkedPhaseReviewPath: flagValue(process.argv, "--linked-phase-review-output"),
    groupReviewPath: flagValue(process.argv, "--group-review-output"),
    operations: splitFlag(process.argv, "--operations"),
    targets: splitFlag(process.argv, "--targets"),
    pairs: splitFlag(process.argv, "--pairs"),
    status: flagValue(process.argv, "--status"),
    maxPairs: flagValue(process.argv, "--max-pairs") ? Number(flagValue(process.argv, "--max-pairs")) : undefined,
    maxPerPair: flagValue(process.argv, "--max-per-pair") ? Number(flagValue(process.argv, "--max-per-pair")) : undefined,
    minConfidence: flagValue(process.argv, "--min-confidence") ? Number(flagValue(process.argv, "--min-confidence")) : undefined,
    includeNeedsHumanReview: process.argv.includes("--include-needs-human-review")
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
