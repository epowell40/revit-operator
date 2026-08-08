import { randomBytes } from "node:crypto";
import { assertToolExposure, loadToolExposurePolicy, type ToolExposurePolicyRecord } from "./toolExposurePolicy.js";

export const PROGRESSIVE_CAPABILITY_DISCOVERY_V1 = "revit-operator.progressive-capability-discovery.v1";

const CATALOG = [{
  id: "revit.context.v1", alias: "revit_get_context", method: "GET", path: "/revit/context",
  title: "Live Revit context",
  description: "Read active document and view identity before planning or resolving model work.",
  tags: ["active", "context", "document", "model", "project", "revit", "view"]
}] as const;
const receipts = new Map<string, { expires: number; policyHash: string; trust: "bundled" | "deployment"; ids: Set<string> }>();

export type DiscoveryResult = {
  schemaVersion: typeof PROGRESSIVE_CAPABILITY_DISCOVERY_V1;
  status: "available" | "unavailable";
  policyHash: string;
  policyTrustSource: "bundled" | "deployment";
  capabilities: Array<{ id: string; alias: string; method: string; path: string; title: string; description: string; inputSchema: {}; policyRecordHash: string; evidenceRecordHash: string }>;
  receipt: string;
  expiresAt: string;
  reasonCodes: string[];
};

export class CapabilityDiscoveryError extends Error {
  constructor(readonly code: string, message: string, cause?: unknown) { super(`[${code}] ${message}`, { cause }); }
}

function words(value: string): string[] { return value.toLowerCase().normalize("NFC").split(/[^a-z0-9]+/).filter(Boolean); }
function descriptor(record: ToolExposurePolicyRecord, id: string) {
  const item = CATALOG.find(candidate => candidate.id === id);
  if (!item || item.method !== record.method || item.path !== record.path || !record.typed_mcp_aliases.includes(item.alias)) return null;
  return { id: item.id, alias: item.alias, method: item.method, path: item.path, title: item.title, description: item.description, inputSchema: {}, policyRecordHash: record.policy_record_hash, evidenceRecordHash: record.evidence_record_hash };
}
function pruneReceipts(): void { for (const [receipt, state] of receipts) if (state.expires < Date.now()) receipts.delete(receipt); while (receipts.size > 256) receipts.delete(receipts.keys().next().value!); }

/** Model language is matched only to descriptive tags; policy remains the authority. */
export function discoverCertifiedCapabilities(input: { need: string; maxResults?: number }, env: NodeJS.ProcessEnv = process.env): DiscoveryResult {
  const need = typeof input?.need === "string" ? input.need.trim() : "";
  const maxResults = input?.maxResults ?? 4;
  if (!need || need.length > 480 || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 8) throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_REQUEST_INVALID", "need must be 1-480 characters and maxResults must be an integer from 1-8.");
  let loaded: ReturnType<typeof loadToolExposurePolicy>;
  try { loaded = loadToolExposurePolicy(env); } catch (error) { throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_UNAVAILABLE", "Trusted certification policy is unavailable or invalid; discovery is fail-closed.", error); }
  const query = words(need);
  const capabilities = CATALOG.map(item => {
    const record = loaded.policy.records.find(candidate => candidate.method === item.method && candidate.path === item.path && candidate.visibility !== "workflow_only" && candidate.channels.typed_mcp.exposed && candidate.typed_mcp_aliases.includes(item.alias));
    const result = record ? descriptor(record, item.id) : null;
    const tags = new Set(words([item.title, item.description, ...item.tags].join(" ")));
    return result ? { result, score: query.filter(word => tags.has(word)).length } : null;
  }).filter((item): item is { result: NonNullable<ReturnType<typeof descriptor>>; score: number } => !!item && item.score > 0)
    .sort((a, b) => b.score - a.score || a.result.id.localeCompare(b.result.id)).slice(0, maxResults).map(item => item.result);
  pruneReceipts();
  const expires = Date.now() + 120_000;
  const receipt = randomBytes(24).toString("base64url");
  receipts.set(receipt, { expires, policyHash: loaded.policy.policy_hash, trust: loaded.trustSource, ids: new Set(capabilities.map(item => item.id)) });
  return { schemaVersion: PROGRESSIVE_CAPABILITY_DISCOVERY_V1, status: capabilities.length ? "available" : "unavailable", policyHash: loaded.policy.policy_hash, policyTrustSource: loaded.trustSource, capabilities, receipt, expiresAt: new Date(expires).toISOString(), reasonCodes: capabilities.length ? ["CERTIFIED_CAPABILITIES_FOUND"] : ["CERTIFIED_CAPABILITIES_UNAVAILABLE"] };
}

/** A future wrapper must use this before its existing final call-time authorization. */
export function assertDiscoveredCapability(receipt: string, capabilityId: string, env: NodeJS.ProcessEnv = process.env) {
  const state = receipts.get(receipt);
  if (!state || state.expires < Date.now()) throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_RECEIPT_INVALID", "Discovery receipt is missing, expired, or runtime-issued receipt state was lost.");
  if (!state.ids.has(capabilityId)) throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_CAPABILITY_DENIED", "Capability was not returned by this discovery receipt.");
  const item = CATALOG.find(candidate => candidate.id === capabilityId);
  if (!item) throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_CAPABILITY_DENIED", "Capability identity is not runtime-registered.");
  const loaded = loadToolExposurePolicy(env);
  if (loaded.policy.policy_hash !== state.policyHash || loaded.trustSource !== state.trust) throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_POLICY_DRIFT", "Discovery receipt is stale because trusted policy changed.");
  assertToolExposure({ method: item.method, path: item.path, channel: "typed_mcp", alias: item.alias, env });
  const record = loaded.policy.records.find(candidate => candidate.method === item.method && candidate.path === item.path && candidate.typed_mcp_aliases.includes(item.alias));
  const result = record ? descriptor(record, item.id) : null;
  if (!result) throw new CapabilityDiscoveryError("CAPABILITY_DISCOVERY_CAPABILITY_DENIED", "Capability is no longer certified and exposed.");
  return result;
}
