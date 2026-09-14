import { getWebResearchPolicyFromEnv } from "../web_research/policy.js";

/** Built-in search cannot enforce our domain policy; restricted research uses the existing evidence tools. */
export function codexResearchConfig(certified: boolean, env: NodeJS.ProcessEnv = process.env): { web_search: "live" | "disabled" } {
  const policy = getWebResearchPolicyFromEnv(env);
  return { web_search: !certified && policy.mode === "unrestricted" && policy.denylistDomains.length === 0 ? "live" : "disabled" };
}
