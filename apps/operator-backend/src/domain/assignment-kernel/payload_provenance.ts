export const PAYLOAD_PROVENANCE_V2_SCHEMA = "revit-operator.payload-provenance/v2" as const;

export interface PayloadDigestV2 {
  algorithm: "sha256";
  digest: string;
  representation: "native_bytes" | "utf8_json_bytes" | "canonical_json";
  byte_count: number;
}

export interface PayloadProvenanceV2 {
  schema: typeof PAYLOAD_PROVENANCE_V2_SCHEMA;
  source: PayloadDigestV2;
  normalized: PayloadDigestV2;
  transformation_id: string;
  transformation_version: string;
}
