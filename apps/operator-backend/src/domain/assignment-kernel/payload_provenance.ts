import type { PayloadDigestV2 as SharedPayloadDigestV2 } from "@revitoperator/payload-digest-v2";

export const PAYLOAD_PROVENANCE_V2_SCHEMA = "revit-operator.payload-provenance/v2" as const;

export type PayloadDigestV2 = SharedPayloadDigestV2;

export interface PayloadProvenanceV2 {
  schema: typeof PAYLOAD_PROVENANCE_V2_SCHEMA;
  source: PayloadDigestV2;
  normalized: PayloadDigestV2;
  transformation_id: string;
  transformation_version: string;
}
