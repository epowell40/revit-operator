export const PAYLOAD_DIGEST_ALGORITHM_V2: "sha256";
export const PAYLOAD_CANONICALIZATION_VERSION_V2: "revit-operator.canonical-json.utf8-ordinal.v2";

export type PayloadRepresentationV2 =
  | "native_bytes"
  | "utf8_json_bytes"
  | "evidence_object_bytes"
  | "canonical_json";

export interface PayloadDigestV2 {
  readonly algorithm: "sha256";
  readonly representation: PayloadRepresentationV2;
  readonly canonicalization_version: string | null;
  readonly digest: string;
  readonly byte_count: number;
}

export function canonicalPayloadJsonV2(value: unknown): string;
export function canonicalPayloadBytesV2(value: unknown): Uint8Array;
export function payloadRepresentationDigestV2(
  bytes: Uint8Array,
  representation: PayloadRepresentationV2,
  canonicalizationVersion?: string | null
): PayloadDigestV2;
export function payloadDigestV2(value: unknown): PayloadDigestV2;
