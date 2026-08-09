import { createHash, randomBytes } from "node:crypto";
import { loadToolExposurePolicy, type ToolExposurePolicy, type ToolExposurePolicyRecord } from "./toolExposurePolicy.js";

export const CERTIFIED_CAPABILITY_PROJECTION_V1 = "revit-operator.certified-capability-projection.v1";
type Capability = {
  id: string;
  alias: string;
  method: string;
  path: string;
  title: string;
  description: string;
  inputSchema: {};
  policyRecordHashes: string[];
  evidenceRecordHashes: string[];
  effectHashes: string[];
  requestFamily: { id: string; validatorHash: string } | null;
};
type Receipt = { expires: number; policyHash: string; trust: "bundled" | "deployment"; ids: Set<string> };
const receipts = new Map<string, Receipt>();

export class CertifiedCapabilityProjectionError extends Error {
  constructor(readonly code: string, message: string, cause?: unknown) { super(`[${code}] ${message}`, { cause }); }
}
function words(value: string): string[] { return value.toLowerCase().normalize("NFC").split(/[^a-z0-9]+/).filter(Boolean); }
function groupKey(record: ToolExposurePolicyRecord, alias: string): string {
  const family = record.request_family;
  return family
    ? `${record.method}\n${record.path}\n${alias}\n${family.id}\n${family.validator_hash}`
    : `${record.method}\n${record.path}\n${alias}\n${record.policy_record_hash}`;
}
function descriptor(records: ToolExposurePolicyRecord[], alias: string): Capability {
  const record = records[0]!;
  const label = alias.replace(/^revit_/, "").replace(/_/g, " ");
  const policyRecordHashes = records.map(value => value.policy_record_hash).sort();
  const evidenceRecordHashes = records.map(value => value.evidence_record_hash).sort();
  const effectHashes = records.map(value => value.effect_hash).sort();
  const idMaterial = `${groupKey(record, alias)}\n${policyRecordHashes.join("\n")}`;
  return {
    id: `cap_${createHash("sha256").update(idMaterial, "utf8").digest("hex").slice(0, 32)}`,
    alias,
    method: record.method,
    path: record.path,
    title: label,
    description: `Certified ${record.method} Revit capability for ${record.path}.`,
    inputSchema: {},
    policyRecordHashes,
    evidenceRecordHashes,
    effectHashes,
    requestFamily: record.request_family
      ? { id: record.request_family.id, validatorHash: record.request_family.validator_hash }
      : null
  };
}

/** This is the sole model-facing catalog: a projection of exposed policy records. */
export function projectCertifiedCapabilities(policy: ToolExposurePolicy): Capability[] {
  const grouped = new Map<string, { alias: string; records: ToolExposurePolicyRecord[] }>();
  for (const record of policy.records) {
    if (record.visibility === "workflow_only" || !record.channels.typed_mcp.exposed) continue;
    for (const alias of record.typed_mcp_aliases) {
      const key = groupKey(record, alias);
      const current = grouped.get(key);
      if (current) current.records.push(record);
      else grouped.set(key, { alias, records: [record] });
    }
  }
  return [...grouped.values()].map(group => descriptor(group.records, group.alias)).sort((left, right) => left.id.localeCompare(right.id));
}
function candidates(env: NodeJS.ProcessEnv): { policyHash: string; trust: "bundled" | "deployment"; values: Capability[] } {
  const loaded = loadToolExposurePolicy(env);
  return { policyHash: loaded.policy.policy_hash, trust: loaded.trustSource, values: projectCertifiedCapabilities(loaded.policy) };
}
function prune(): void { for (const [key, value] of receipts) if (value.expires < Date.now()) receipts.delete(key); while (receipts.size > 256) receipts.delete(receipts.keys().next().value!); }

/** A bounded descriptive projection; never reads the raw registry and never authorizes execution. */
export function discoverCertifiedCapabilities(input: { need: string; maxResults?: number }, env: NodeJS.ProcessEnv = process.env) {
  const need = typeof input?.need === "string" ? input.need.trim() : "";
  const maxResults = input?.maxResults ?? 4;
  if (!need || need.length > 480 || !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 8) throw new CertifiedCapabilityProjectionError("CAPABILITY_DISCOVERY_REQUEST_INVALID", "need must be 1-480 characters and maxResults must be an integer from 1-8.");
  let source: ReturnType<typeof candidates>;
  try { source = candidates(env); } catch (error) { throw new CertifiedCapabilityProjectionError("CAPABILITY_DISCOVERY_UNAVAILABLE", "Trusted certification policy is unavailable or invalid; discovery is fail-closed.", error); }
  const query = new Set(words(need));
  const capabilities = source.values.map(value => ({ value, score: words(`${value.alias} ${value.path} ${value.title}`).filter(word => query.has(word)).length }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.value.id.localeCompare(b.value.id)).slice(0, maxResults).map(item => item.value);
  prune(); const expires = Date.now() + 120_000; const receipt = randomBytes(24).toString("base64url");
  receipts.set(receipt, { expires, policyHash: source.policyHash, trust: source.trust, ids: new Set(capabilities.map(item => item.id)) });
  return { schemaVersion: CERTIFIED_CAPABILITY_PROJECTION_V1, status: capabilities.length ? "available" as const : "unavailable" as const, policyHash: source.policyHash, policyTrustSource: source.trust, capabilities, receipt, expiresAt: new Date(expires).toISOString(), reasonCodes: capabilities.length ? ["CERTIFIED_CAPABILITIES_FOUND"] : ["CERTIFIED_CAPABILITIES_UNAVAILABLE"] };
}

/** Receipt membership narrows discovery; exact call-time authorization remains authoritative. */
export function assertDiscoveredCapability(receipt: string, capabilityId: string, env: NodeJS.ProcessEnv = process.env): Capability {
  const state = receipts.get(receipt);
  if (!state || state.expires < Date.now()) throw new CertifiedCapabilityProjectionError("CAPABILITY_DISCOVERY_RECEIPT_INVALID", "Discovery receipt is missing, expired, or was not issued by this runtime.");
  if (!state.ids.has(capabilityId)) throw new CertifiedCapabilityProjectionError("CAPABILITY_DISCOVERY_CAPABILITY_DENIED", "Capability was not returned by this discovery receipt.");
  const source = candidates(env);
  if (source.policyHash !== state.policyHash || source.trust !== state.trust) throw new CertifiedCapabilityProjectionError("CAPABILITY_DISCOVERY_POLICY_DRIFT", "Discovery receipt is stale because trusted policy changed.");
  const capability = source.values.find(value => value.id === capabilityId);
  if (!capability) throw new CertifiedCapabilityProjectionError("CAPABILITY_DISCOVERY_CAPABILITY_DENIED", "Capability is no longer certified and exposed.");
  // Membership in the exact current policy projection is all discovery may
  // assert. Parameterized families have no body at this boundary; the typed
  // wrapper still performs sealed exact-instance authorization at call time.
  return capability;
}
