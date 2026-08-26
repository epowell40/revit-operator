import { createHash } from "node:crypto";
import {
  PAYLOAD_PROVENANCE_V2_SCHEMA,
  canonicalJsonV2,
  type PayloadDigestV2,
  type PayloadProvenanceV2
} from "../domain/assignment-kernel/index.js";

function digest(bytes: Uint8Array, representation: PayloadDigestV2["representation"]): PayloadDigestV2 {
  return {
    algorithm: "sha256",
    digest: createHash("sha256").update(bytes).digest("hex"),
    representation,
    byte_count: bytes.byteLength
  };
}

function provenance(input: Readonly<{
  source_bytes: Uint8Array;
  source_representation: PayloadDigestV2["representation"];
  normalized_payload: unknown;
  transformation_id: string;
  transformation_version: string;
}>): PayloadProvenanceV2 {
  const normalizedBytes = Buffer.from(canonicalJsonV2(input.normalized_payload), "utf8");
  return {
    schema: PAYLOAD_PROVENANCE_V2_SCHEMA,
    source: digest(input.source_bytes, input.source_representation),
    normalized: digest(normalizedBytes, "canonical_json"),
    transformation_id: input.transformation_id,
    transformation_version: input.transformation_version
  };
}

export function payloadProvenanceFromBytesV2(input: Readonly<{
  source_bytes: Uint8Array;
  normalized_payload: unknown;
  transformation_id: string;
  transformation_version: string;
}>): PayloadProvenanceV2 {
  return provenance({ ...input, source_representation: "native_bytes" });
}

export function payloadProvenanceFromJsonV2(input: Readonly<{
  source_json_bytes: Uint8Array;
  normalized_payload: unknown;
  transformation_id: string;
  transformation_version: string;
}>): PayloadProvenanceV2 {
  return provenance({
    source_bytes: input.source_json_bytes,
    source_representation: "utf8_json_bytes",
    normalized_payload: input.normalized_payload,
    transformation_id: input.transformation_id,
    transformation_version: input.transformation_version
  });
}
