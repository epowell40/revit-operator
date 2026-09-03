function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const EXCLUDED_EVIDENCE_CONTAINERS = new Set([
  "arguments", "body", "canonicalattemptsettlement", "control", "input", "meta", "metadata",
  "operationresultv2", "payloadprovenance", "provenance", "request", "requestbody", "requestinput"
]);

function normalizedKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Returns only the immutable Observation payload when an MCP result carries a
 * V2 envelope. Request metadata and result-control wrappers are never evidence.
 */
export function verificationObservationPayloadV2(value: unknown): unknown {
  const root = objectValue(value);
  const structured = objectValue(root.structuredContent ?? root.structured_content);
  const observation = objectValue(structured.observation);
  if (Object.prototype.hasOwnProperty.call(observation, "raw_payload")) return observation.raw_payload;
  if (Object.prototype.hasOwnProperty.call(root, "result_json")) return root.result_json;
  return value;
}

const VERIFIER_CONTAINERS = new Set(["assertion", "postcondition", "verification", "verificationresult"]);

function explicitVerificationNodeV2(value: unknown, depth: number, verifierScope: boolean, documentRoot: boolean): boolean {
  if (depth > 8) return false;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length < 2 || text.length > 1_000_000 || (!text.startsWith("{") && !text.startsWith("["))) return false;
    try { return explicitVerificationNodeV2(JSON.parse(text), depth + 1, false, true); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some(item => explicitVerificationNodeV2(item, depth + 1, verifierScope, false));
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizedKey(key);
    if (EXCLUDED_EVIDENCE_CONTAINERS.has(normalized)) continue;
    const childVerifierScope = verifierScope || VERIFIER_CONTAINERS.has(normalized);
    if (normalized === "verified" && item === true && (documentRoot || verifierScope)) return true;
    if (childVerifierScope && ["allpassed", "passed", "satisfied"].includes(normalized) && item === true) return true;
    if (verifierScope && normalized === "status" && typeof item === "string"
        && ["pass", "passed", "verified"].includes(item.trim().toLowerCase())) return true;
    if (explicitVerificationNodeV2(item, depth + 1, childVerifierScope, false)) return true;
  }
  return false;
}

/** A capability receipt may explicitly assert its own postcondition, but
 * generic completion/availability fields and request/control echoes cannot. */
export function explicitVerificationV2(value: unknown): boolean {
  return explicitVerificationNodeV2(verificationObservationPayloadV2(value), 0, false, true);
}

/** Deletion proof requires an explicit absence assertion and no contradictory
 * non-empty result collection in the same authoritative Observation. */
export function explicitTargetAbsenceV2(value: unknown): boolean {
  let absent = false;
  let contradictoryCollection = false;
  const resultCollections = new Set(["elements", "items", "matches", "results"]);
  const visit = (node: unknown, key = "", depth = 0): void => {
    if (node === null || node === undefined || depth > 8) return;
    if (typeof node === "string" && /^[\[{]/.test(node.trim())) {
      try { visit(JSON.parse(node), key, depth + 1); } catch {}
      return;
    }
    if (Array.isArray(node)) {
      if (resultCollections.has(normalizedKey(key)) && node.length > 0) contradictoryCollection = true;
      for (const item of node) visit(item, key, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
      const normalized = normalizedKey(childKey);
      if (EXCLUDED_EVIDENCE_CONTAINERS.has(normalized)) continue;
      if ((normalized === "exists" || normalized === "found") && child === false) absent = true;
      if ((normalized === "notexists" || normalized === "notfound") && child === true) absent = true;
      visit(child, childKey, depth + 1);
    }
  };
  visit(verificationObservationPayloadV2(value));
  return absent && !contradictoryCollection;
}

export function substantiveReadbackV2(value: unknown, depth = 0): boolean {
  if (value === null || value === undefined || depth > 8) return false;
  if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
    try { return substantiveReadbackV2(JSON.parse(value), depth + 1); } catch { return false; }
  }
  if (Array.isArray(value)) return value.length > 0 && value.some(item => substantiveReadbackV2(item, depth + 1));
  if (typeof value !== "object") return false;
  const ignored = new Set(["ok", "success", "status", "action", "message", "open_prints_folder_url"]);
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
    if (ignored.has(key.toLowerCase())) return false;
    if (item === null || item === undefined || item === "") return false;
    if (Array.isArray(item)) return item.length > 0;
    if (typeof item === "object") return Object.keys(item as Record<string, unknown>).length > 0;
    return true;
  });
}
