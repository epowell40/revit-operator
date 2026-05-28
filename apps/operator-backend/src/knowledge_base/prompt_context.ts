import { listKnowledgeBaseDocuments, searchKnowledgeBase } from "./service.js";

export function isKnowledgeBaseLikelyQuery(text: string): boolean {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return false;
  const hints = ["knowledge base", "uploaded", "pdf", "standard", "code", "spec", "nfpa", "ibc", "search my", "reference", "handrail", "clearance"];
  return hints.some(h => t.includes(h));
}

export function formatKbLibraryBlock(ownerUserId: string): string | null {
  try {
    const docs = listKnowledgeBaseDocuments(ownerUserId, "user");
    if (!Array.isArray(docs) || docs.length === 0) return null;
    const lines: string[] = [];
    lines.push("Private knowledge base docs (user scope):");
    for (const d of docs.slice(0, 25)) {
      lines.push(`- ${d.title} [${d.status}] pages=${d.pageCount ?? "?"} docId=${d.documentId}`);
    }
    if (docs.length > 25) lines.push(`- … (${docs.length - 25} more docs)`);
    return lines.join("\n");
  } catch {
    return null;
  }
}

export async function maybeBuildKbSearchBlock(ownerUserId: string, query: string): Promise<string | null> {
  try {
    if (!isKnowledgeBaseLikelyQuery(query)) return null;
    const r = await searchKnowledgeBase({ query, ownerUserId, scopeType: "user", maxResults: 5, citationStyle: "short" });
    if (!Array.isArray(r.results) || r.results.length === 0) return "Private KB search: no matching chunks found.";
    const lines: string[] = [];
    lines.push("Private KB search results (ground answers to these; cite title/page/heading/confidence):");
    let i = 0;
    for (const x of r.results) {
      i++;
      const excerpt = String(x.text ?? "").replace(/\s+/g, " ").trim();
      const short = excerpt.length > 700 ? excerpt.slice(0, 700) + "…" : excerpt;
      lines.push(`[KB${i}] ${x.title} p.${x.pageStart}${x.pageEnd && x.pageEnd !== x.pageStart ? `-${x.pageEnd}` : ""}${x.heading ? ` h=${x.heading}` : ""} conf=${x.confidence}`);
      lines.push(short || "(empty excerpt)");
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}
