import path from "node:path";

export type RedlineSheetCandidate = {
  sheet_number: string;
  score: number;
  source: "text" | "filename";
  page?: number;
  hit_count: number;
  evidence?: string;
};

const SHEET_HINT_WORDS = /(?:sheet|sht|drawing|dwg|drg|detail|plan|elevation|section)/i;
const PREFERRED_DISC_PREFIXES = new Set(["A", "M", "E", "P", "S", "C", "I", "FP", "G"]);
const NON_SHEET_PREFIXES = new Set(["ROOM", "RM", "LEVEL"]);

function truncate(value: string, maxChars: number): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…(truncated)`;
}

export function normalizeSheetNumber(raw: string): string {
  const text = (raw ?? "").toUpperCase().trim();
  if (!text) return "";
  let normalized = text.replace(/\s+/g, "");
  normalized = normalized.replace(/_/g, ".");
  normalized = normalized.replace(/-+/g, "-");
  normalized = normalized.replace(/[^\w.\-]/g, "");
  return normalized;
}

export function isLikelySheetPattern(normalized: string): boolean {
  if (!normalized) return false;
  if (/^\d{4}$/.test(normalized)) return false;
  if (/^\d+(\.\d+)?$/.test(normalized)) return false;
  if (!/[A-Z]/.test(normalized)) return false;
  if (!/\d/.test(normalized)) return false;
  return normalized.length >= 2 && normalized.length <= 16;
}

export function extractSheetCandidatesFromText(args: {
  text: string;
  expectedSheet?: string;
  page?: number;
  maxCandidates?: number;
}): RedlineSheetCandidate[] {
  const text = args.text ?? "";
  if (!text.trim()) return [];

  const expected = normalizeSheetNumber(args.expectedSheet ?? "");
  const maxCandidates = Math.max(1, Math.min(40, Number(args.maxCandidates ?? 12) || 12));
  const pattern = /\b([A-Z]{1,4}\s*[-_.]?\s*\d{1,4}(?:\s*[.-]\s*\d{1,3})?)\b/gi;
  type Hit = { key: string; score: number; evidence: string; count: number };
  const hits = new Map<string, Hit>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const raw = (match[1] ?? "").trim();
    const normalized = normalizeSheetNumber(raw);
    if (!isLikelySheetPattern(normalized)) continue;

    const index = typeof match.index === "number" ? match.index : 0;
    const context = text.slice(Math.max(0, index - 28), Math.min(text.length, index + raw.length + 28));
    const hasSheetHint = SHEET_HINT_WORDS.test(context);
    const prefix = (normalized.match(/^[A-Z]+/)?.[0] ?? "").toUpperCase();
    if (NON_SHEET_PREFIXES.has(prefix)) continue;
    if (prefix.length >= 3 && !PREFERRED_DISC_PREFIXES.has(prefix) && !normalized.includes(".") && !normalized.includes("-") && !hasSheetHint) {
      continue;
    }

    let score = 20;
    if (normalized.includes(".")) score += 8;
    if (normalized.includes("-")) score += 4;
    if (normalized.length >= 4 && normalized.length <= 9) score += 2;
    if (hasSheetHint) score += 12;
    if (PREFERRED_DISC_PREFIXES.has(prefix)) score += 6;
    if (expected && normalized === expected) score += 25;

    const previous = hits.get(normalized);
    if (!previous) {
      hits.set(normalized, { key: normalized, score, evidence: truncate(context, 120), count: 1 });
    } else {
      previous.count += 1;
      previous.score = Math.max(previous.score, score) + 1;
      if (previous.evidence.length < 40) previous.evidence = truncate(context, 120);
    }
  }

  return [...hits.values()]
    .sort((a, b) => b.score - a.score || b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, maxCandidates)
    .map((hit) => ({
      sheet_number: hit.key,
      score: hit.score,
      source: "text",
      page: args.page,
      hit_count: hit.count,
      evidence: hit.evidence
    }));
}

export function extractSheetCandidatesFromFilename(args: {
  filePath: string;
  expectedSheet?: string;
  maxCandidates?: number;
}): RedlineSheetCandidate[] {
  const base = path.basename(args.filePath ?? "");
  const stem = base
    .replace(/\.[^.]+$/, "")
    // Upload names commonly preserve a UUID. A UUID group such as `a069`
    // looks like a plausible architectural sheet token but is opaque identity,
    // not user-authored sheet evidence.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, " ");
  if (!stem.trim()) return [];

  const expected = normalizeSheetNumber(args.expectedSheet ?? "");
  const maxCandidates = Math.max(1, Math.min(20, Number(args.maxCandidates ?? 8) || 8));
  const pattern = /(?:^|[^A-Z0-9])([A-Z]{1,4}\s*[-_.]?\s*\d{1,4}(?:\s*[.-]\s*\d{1,3})?)(?=$|[^A-Z0-9])/gi;
  type Hit = { key: string; score: number; count: number };
  const hits = new Map<string, Hit>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(stem)) !== null) {
    const normalized = normalizeSheetNumber((match[1] ?? "").trim());
    if (!isLikelySheetPattern(normalized)) continue;
    const prefix = (normalized.match(/^[A-Z]+/)?.[0] ?? "").toUpperCase();
    if (NON_SHEET_PREFIXES.has(prefix)) continue;
    if (prefix.length >= 3 && !PREFERRED_DISC_PREFIXES.has(prefix) && !normalized.includes(".") && !normalized.includes("-")) continue;

    let score = 62;
    if (normalized.includes(".")) score += 4;
    if (normalized.includes("-")) score += 2;
    if (expected && normalized === expected) score += 18;
    const previous = hits.get(normalized);
    if (!previous) hits.set(normalized, { key: normalized, score, count: 1 });
    else {
      previous.count += 1;
      previous.score = Math.max(previous.score, score) + 1;
    }
  }

  return [...hits.values()]
    .sort((a, b) => b.score - a.score || b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, maxCandidates)
    .map((hit) => ({
      sheet_number: hit.key,
      score: hit.score,
      source: "filename",
      hit_count: hit.count,
      evidence: truncate(`filename=${base}`, 120)
    }));
}

export function mergeSheetCandidates(input: RedlineSheetCandidate[], max = 20): RedlineSheetCandidate[] {
  const candidates = new Map<string, RedlineSheetCandidate>();
  for (const candidate of input) {
    const key = normalizeSheetNumber(candidate.sheet_number);
    if (!key) continue;
    const previous = candidates.get(key);
    if (!previous) {
      candidates.set(key, { ...candidate, sheet_number: key });
      continue;
    }
    previous.score = Math.max(previous.score, candidate.score) + 1;
    previous.hit_count += candidate.hit_count;
    if (!previous.page && candidate.page) previous.page = candidate.page;
    if (!previous.evidence && candidate.evidence) previous.evidence = candidate.evidence;
  }
  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || b.hit_count - a.hit_count)
    .slice(0, max);
}
