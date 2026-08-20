export type AuthoritativeWebEvidenceRequirement = {
  required: boolean;
  prompt: string;
};

export type AuthoritativeWebEvidenceAttempt = {
  url: string;
  success: boolean;
  result: unknown;
  error: string | null;
  evidence_summary: string;
};

type WebEvidenceRuntime = {
  callTool(tool: string, args: unknown): Promise<unknown>;
};

const AUTHORITATIVE_CUE =
  /\b(?:authoritative|official|primary[- ]source|current|latest|newest|up[- ]to[- ]date|version[- ]specific|20\d{2}|ashrae|nfpa|ibc|imc|iec|iso)\b/i;
const EXTERNAL_RESEARCH_CUE =
  /\b(?:research|look\s+up|search(?:\s+the)?\s+web|documentation|docs?|reference|standard|code|regulation|api|release\s+notes?|breaking\s+change|migration|manufacturer|specification)\b/i;

export const AUTHORITATIVE_WEB_EVIDENCE_FAILURE =
  "I could not verify the requested authoritative external information because no cited primary-source page was fetched successfully. I have not presented remembered claims as verified research.";

export function getAuthoritativeWebEvidenceRequirement(userText: string): AuthoritativeWebEvidenceRequirement {
  const text = (userText ?? "").toString().trim();
  const required = Boolean(text && AUTHORITATIVE_CUE.test(text) && EXTERNAL_RESEARCH_CUE.test(text));
  return {
    required,
    prompt: required
      ? "AUTHORITATIVE WEB EVIDENCE REQUIRED: before finalizing, successfully call `web_fetch_evidence` for every primary-source URL you rely on. A remembered citation is not evidence. If you draft an answer before fetching, include the exact primary-source URL so the host can fetch and preserve it, then report the saved evidence paths."
      : ""
  };
}

export function extractCitedHttpUrls(markdown: string, limit = 3): string[] {
  const matches = (markdown ?? "").match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const candidate = match.replace(/[\])}>.,;:!?]+$/g, "");
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      const normalized = parsed.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      urls.push(normalized);
      if (urls.length >= Math.max(1, limit)) break;
    } catch {
      // Ignore malformed citations; the caller will fail closed if none remain.
    }
  }
  return urls;
}

function textContent(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = Array.isArray((result as { content?: unknown }).content)
    ? (result as { content: unknown[] }).content
    : [];
  return content
    .map(item => item && typeof item === "object" && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string"
      ? (item as { text: string }).text
      : "")
    .filter(Boolean)
    .join("\n");
}

export function isSuccessfulAuthoritativeWebEvidenceCall(call: {
  tool?: unknown;
  success?: unknown;
  status?: unknown;
  error?: unknown;
}): boolean {
  if (typeof call.tool !== "string" || call.tool.trim() !== "web_fetch_evidence") return false;
  const status = typeof call.status === "string" ? call.status.trim().toLowerCase() : "";
  return call.success === true
    || (call.success !== false && !call.error && ["success", "ok", "done", "completed"].includes(status));
}

export async function fetchCitedAuthoritativeWebEvidence(
  runtime: WebEvidenceRuntime,
  assistantText: string,
  limit = 3
): Promise<AuthoritativeWebEvidenceAttempt[]> {
  const urls = extractCitedHttpUrls(assistantText, limit);
  const attempts: AuthoritativeWebEvidenceAttempt[] = [];
  for (const url of urls) {
    try {
      const result = await runtime.callTool("web_fetch_evidence", { url });
      const failed = Boolean(result && typeof result === "object" && (result as { isError?: unknown }).isError === true);
      const evidenceText = textContent(result);
      const evidenceSummary = evidenceText
        .split(/\r?\n/)
        .filter(line => /^(?:Source|URL|Final URL|Evidence folder|Metadata|Extracted text|Snapshot):/i.test(line.trim()))
        .slice(0, 8)
        .join("\n");
      attempts.push({
        url,
        success: !failed,
        result,
        error: failed ? evidenceText || "Web evidence fetch failed." : null,
        evidence_summary: evidenceSummary
      });
    } catch (error) {
      attempts.push({
        url,
        success: false,
        result: null,
        error: error instanceof Error ? error.message : String(error),
        evidence_summary: ""
      });
    }
  }
  return attempts;
}

export function formatAuthoritativeWebEvidenceAppendix(attempts: AuthoritativeWebEvidenceAttempt[]): string {
  const successful = attempts.filter(attempt => attempt.success);
  if (successful.length === 0) return "";
  return [
    "## Preserved primary-source evidence",
    ...successful.map(attempt => attempt.evidence_summary || `URL: ${attempt.url}`)
  ].join("\n\n");
}
