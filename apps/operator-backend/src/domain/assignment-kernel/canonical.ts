import { payloadRepresentationDigestV2 } from "@revitoperator/payload-digest-v2";

export { canonicalPayloadJsonV2 as canonicalJsonV2 } from "@revitoperator/payload-digest-v2";

/** Exact UTF-8 text identity, without JSON quoting or Unicode/newline normalization. */
export function utf8TextSha256V2(text: string): string {
  return payloadRepresentationDigestV2(new TextEncoder().encode(text), "native_bytes").digest;
}
