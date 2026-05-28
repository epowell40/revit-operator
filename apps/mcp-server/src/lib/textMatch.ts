export function normalizeForMatch(input: string): string {
  const s = (input ?? "").toString().toLowerCase();
  const cleaned = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[^a-z0-9]+/g, " ");
  const tokens = cleaned.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);

  // Collapse runs of single-letter tokens (common OCR output: "W S P" => "wsp").
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? "";
    if (tok.length === 1) {
      let run = tok;
      while (i + 1 < tokens.length && (tokens[i + 1] ?? "").length === 1) {
        i++;
        run += tokens[i] ?? "";
      }
      out.push(run);
    } else {
      out.push(tok);
    }
  }

  return out.join(" ").trim();
}

function tokenSet(norm: string): Set<string> {
  const toks = (norm ?? "").split(" ").map(t => t.trim()).filter(Boolean);
  return new Set(toks);
}

export function jaccardTokens(aNorm: string, bNorm: string): number {
  const a = tokenSet(aNorm);
  const b = tokenSet(bNorm);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union <= 0 ? 0 : inter / union;
}

export function levenshtein(a: string, b: string): number {
  const s = a ?? "";
  const t = b ?? "";
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;

  const prev = new Array<number>(m + 1);
  const cur = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const si = s.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = si === t.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= m; j++) prev[j] = cur[j]!;
  }
  return prev[m]!;
}

export function similarityScore(haystack: string, needle: string): number {
  const h = normalizeForMatch(haystack);
  const n = normalizeForMatch(needle);
  if (!n) return 0;
  if (!h) return 0;
  if (h === n) return 1;
  if (h.includes(n)) return 0.95;

  const jac = jaccardTokens(h, n); // 0..1
  const dist = levenshtein(h, n);
  const denom = Math.max(1, Math.max(h.length, n.length));
  const editSim = 1 - dist / denom;

  // Weighted blend, biased toward token overlap (more stable across line breaks/punctuation).
  return Math.max(0, Math.min(1, 0.65 * jac + 0.35 * editSim));
}

export function bestLineReplacement(beforeText: string, matchText: string, replaceText: string): { ok: boolean; after: string; reason?: string; lineIndex?: number; score?: number } {
  const before = (beforeText ?? "").toString();
  const lines = before.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length === 0) return { ok: false, after: before, reason: "empty_text" };

  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const s = similarityScore(lines[i] ?? "", matchText);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }

  if (bestScore < 0.55) {
    return { ok: false, after: before, reason: "no_good_line_match", lineIndex: bestIdx, score: bestScore };
  }

  lines[bestIdx] = replaceText;
  return { ok: true, after: lines.join("\n"), lineIndex: bestIdx, score: bestScore };
}

export function replaceLineRange(beforeText: string, startLine1: number, endLine1: number, replaceText: string): { ok: boolean; after: string; reason?: string } {
  const before = (beforeText ?? "").toString().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = before.split("\n");
  const start = Math.max(1, Math.floor(startLine1 || 1));
  const end = Math.max(start, Math.floor(endLine1 || start));
  if (lines.length === 0) return { ok: false, after: before, reason: "empty_text" };
  if (start > lines.length) return { ok: false, after: before, reason: "start_out_of_range" };

  const replLines = (replaceText ?? "").toString().replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const s0 = start - 1;
  const e0 = Math.min(lines.length - 1, end - 1);
  const out = [...lines.slice(0, s0), ...replLines, ...lines.slice(e0 + 1)];
  return { ok: true, after: out.join("\n") };
}

