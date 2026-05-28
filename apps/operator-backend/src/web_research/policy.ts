export type WebResearchMode = "off" | "whitelist" | "unrestricted";

export type WebResearchPolicy = {
  mode: WebResearchMode;
  allowlistDomains: string[];
  denylistDomains: string[];
};

function splitDomains(raw: string | undefined): string[] {
  const parts = (raw ?? "")
    .split(/[,\s]+/g)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  // De-dupe, preserve order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function getWebResearchPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): WebResearchPolicy {
  const rawMode = (env.OPERATOR_WEB_RESEARCH_MODE ?? "unrestricted").toString().trim().toLowerCase();
  const mode: WebResearchMode = rawMode === "off" || rawMode === "whitelist" || rawMode === "unrestricted" ? (rawMode as any) : "unrestricted";
  const allowlistDomains = splitDomains(env.OPERATOR_WEB_RESEARCH_ALLOWLIST_DOMAINS);
  const denylistDomains = splitDomains(env.OPERATOR_WEB_RESEARCH_DENYLIST_DOMAINS);
  return { mode, allowlistDomains, denylistDomains };
}

function hostMatchesRule(host: string, rule: string): boolean {
  const h = host.toLowerCase();
  const r = rule.toLowerCase();
  if (!h || !r) return false;

  // Support "*.example.com" and ".example.com" as suffix rules.
  const suffix = r.startsWith("*.") ? r.slice(2) : r.startsWith(".") ? r.slice(1) : null;
  if (suffix) return h === suffix || h.endsWith("." + suffix);

  // Plain rule: exact domain or subdomain of it.
  return h === r || h.endsWith("." + r);
}

export function isUrlAllowedByPolicy(urlString: string, policy: WebResearchPolicy): { ok: true; host: string } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, error: "Invalid URL." };
  }

  const protocol = url.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return { ok: false, error: "Only http/https URLs are supported." };

  const host = (url.hostname ?? "").toLowerCase();
  if (!host) return { ok: false, error: "URL is missing a host." };

  if (policy.mode === "off") return { ok: false, error: "Web research is disabled (OPERATOR_WEB_RESEARCH_MODE=off)." };

  if (policy.mode === "whitelist") {
    if (!policy.allowlistDomains || policy.allowlistDomains.length === 0) {
      return { ok: false, error: "Web research whitelist mode is enabled, but OPERATOR_WEB_RESEARCH_ALLOWLIST_DOMAINS is empty." };
    }
    const allowed = policy.allowlistDomains.some(r => hostMatchesRule(host, r));
    if (!allowed) return { ok: false, error: `Domain not allowed by whitelist: ${host}` };
    return { ok: true, host };
  }

  // unrestricted: allow everything except denylist.
  const denied = (policy.denylistDomains ?? []).some(r => hostMatchesRule(host, r));
  if (denied) return { ok: false, error: `Domain blocked by denylist: ${host}` };
  return { ok: true, host };
}

