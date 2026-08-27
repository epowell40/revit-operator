import { payloadDigestV2, payloadRepresentationDigestV2 } from "@revitoperator/payload-digest-v2";
import {
  PAYLOAD_PROVENANCE_V2_SCHEMA,
  type PayloadDigestV2,
  type PayloadProvenanceV2
} from "../domain/assignment-kernel/index.js";

function provenance(input: Readonly<{
  source_bytes: Uint8Array;
  source_representation: PayloadDigestV2["representation"];
  normalized_payload: unknown;
  transformation_id: string;
  transformation_version: string;
}>): PayloadProvenanceV2 {
  return {
    schema: PAYLOAD_PROVENANCE_V2_SCHEMA,
    source: payloadRepresentationDigestV2(input.source_bytes, input.source_representation),
    normalized: payloadDigestV2(input.normalized_payload),
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
