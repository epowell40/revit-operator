/**
 * Shared boundary between authoritative result evidence and request/control
 * envelopes.  Every verifier-side traversal must use this contract so echoed
 * inputs, provenance, and settlement metadata cannot impersonate observations.
 */

const EXCLUDED_EVIDENCE_CONTAINERS_V2 = new Set([
  "arguments", "body", "canonicalattemptsettlement", "control", "input", "meta", "metadata",
  "operationresultv2", "payloadprovenance", "provenance", "request", "requestbody", "requestinput"
]);

export function normalizedEvidenceKeyV2(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function isExcludedEvidenceContainerV2(value: string): boolean {
  return EXCLUDED_EVIDENCE_CONTAINERS_V2.has(normalizedEvidenceKeyV2(value));
}
