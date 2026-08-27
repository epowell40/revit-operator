import { createHash } from "node:crypto";

export const PAYLOAD_DIGEST_ALGORITHM_V2 = "sha256";
export const PAYLOAD_CANONICALIZATION_VERSION_V2 = "revit-operator.canonical-json.utf8-ordinal.v2";

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value, stack) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new TypeError("payload_digest_v2_cyclic_value");
    stack.add(value);
    const normalized = value.map(item => item === undefined || typeof item === "function" || typeof item === "symbol"
      ? null
      : canonicalValue(item, stack));
    stack.delete(value);
    return normalized;
  }
  if (value && typeof value === "object") {
    if (stack.has(value)) throw new TypeError("payload_digest_v2_cyclic_value");
    stack.add(value);
    const normalized = Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol")
      .sort(([left], [right]) => ordinalCompare(left, right))
      .map(([key, item]) => [key, canonicalValue(item, stack)]));
    stack.delete(value);
    return normalized;
  }
  throw new TypeError(`payload_digest_v2_unsupported_value:${typeof value}`);
}

export function canonicalPayloadJsonV2(value) {
  return JSON.stringify(canonicalValue(value, new WeakSet()));
}

export function canonicalPayloadBytesV2(value) {
  return Buffer.from(canonicalPayloadJsonV2(value), "utf8");
}

export function payloadRepresentationDigestV2(bytes, representation, canonicalizationVersion = null) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("payload_digest_v2_bytes_required");
  if (typeof representation !== "string" || representation.length === 0) {
    throw new TypeError("payload_digest_v2_representation_required");
  }
  return Object.freeze({
    algorithm: PAYLOAD_DIGEST_ALGORITHM_V2,
    representation,
    canonicalization_version: canonicalizationVersion,
    digest: createHash(PAYLOAD_DIGEST_ALGORITHM_V2).update(bytes).digest("hex"),
    byte_count: bytes.byteLength
  });
}

export function payloadDigestV2(value) {
  return payloadRepresentationDigestV2(
    canonicalPayloadBytesV2(value),
    "canonical_json",
    PAYLOAD_CANONICALIZATION_VERSION_V2
  );
}
