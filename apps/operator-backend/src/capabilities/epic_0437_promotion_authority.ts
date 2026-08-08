import { constants, createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJson, type CertificationLevel, type JsonValue } from "./tool_certification.js";
import type { TrustedNativeAttestationBinding } from "../courier/laboratory_execution_receipt.js";

export const EPIC_0437_PROMOTION_AUTHORITY_KEY_ID = "sha256:6b8b8759e02420bf90dafea4f33c5425639edf33073719a48ea6762702378d53";
export const EPIC_0437_PROMOTION_AUTHORITY_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAoGvPi+S12ktyeEKU+oik
ZtrlL09dFHxmwBqu+fHl0GY1ir/aU4x7LIWhHKcWjobVlIHJOdRDNLI3IDrKeJEi
xzLbITi8KJGQjc1Cl63z4jaoURD9RgSJsSC7QbRzomwCaYZ6eMTnLi+hCcQfzVCl
jl16M6KUk9W79Nlyum2NunzT6QIuYmWX6+G5D1DsZvrNJYKS0mFLBxn9FV3Cr1f7
VpNUsPPoKycB2YYvjpJ/Yr/dNk6ZES4TNHmELfION5KNXA70NoSBEEV79v8rzvqg
wcla9Nx/ZpHBzo5oe7KSqvEJvpm3zggdCvHikJ2NT4LKPl2t7SBBBGEQlA4G+7P+
XD7WL52jaGViDB0QxYQoHd4h/l8faFh3GVFM7sjG4/cCEvDJmS7k3qXSbpdQVKRr
YX+WVZ631u2MgGzwyjBFCk+Cxd0n15zgk1pZ0vNyOph1if4lrxQroZBV6cqnZFGT
yMvnHMCU6q0a2kkee98+l0KYbb8qakBitdlTMpe5R55ZAgMBAAE=
-----END PUBLIC KEY-----
`;

export type Epic0437PromotionPayload = {
  schema: "revit-operator.epic-0437-promotion-payload.v1";
  evidence_run_id: string;
  level: Extract<CertificationLevel, "L3" | "L4">;
  candidate_source_hash: string;
  policy_hash: string;
  native_build_manifest_path: string;
  native_build_manifest_sha256: string;
  run_receipt_path: string;
  run_receipt_sha256: string;
  candidate: { method: string; path: string; request_hash: string; effect_hash: string };
  capability: "observation_readback" | "move_preview" | "move_apply";
  native_attestation: TrustedNativeAttestationBinding;
  issued_at_utc: string;
};

export type Epic0437PromotionAuthorization = {
  schema: "revit-operator.epic-0437-promotion-authorization.v1";
  algorithm: "PS256";
  key_id: typeof EPIC_0437_PROMOTION_AUTHORITY_KEY_ID;
  payload: Epic0437PromotionPayload;
  signature_base64url: string;
};

function exact(value: Record<string, unknown>, keys: readonly string[], location: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${location} keys are not exact`);
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  return value as Record<string, unknown>;
}

function sha(value: unknown, location: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${location} must be an exact SHA-256 identity`);
  return value;
}

export function parseAndVerifyEpic0437PromotionAuthorization(value: unknown): Epic0437PromotionAuthorization {
  const authorization = object(value, "EPIC-0437 promotion authorization");
  exact(authorization, ["schema", "algorithm", "key_id", "payload", "signature_base64url"], "EPIC-0437 promotion authorization");
  if (authorization.schema !== "revit-operator.epic-0437-promotion-authorization.v1" || authorization.algorithm !== "PS256"
    || authorization.key_id !== EPIC_0437_PROMOTION_AUTHORITY_KEY_ID || typeof authorization.signature_base64url !== "string"
    || !/^[A-Za-z0-9_-]+$/.test(authorization.signature_base64url)) throw new Error("EPIC-0437 promotion authorization identity is invalid");
  const payload = object(authorization.payload, "EPIC-0437 promotion payload");
  exact(payload, ["schema", "evidence_run_id", "level", "candidate_source_hash", "policy_hash", "native_build_manifest_path", "native_build_manifest_sha256", "run_receipt_path", "run_receipt_sha256", "candidate", "capability", "native_attestation", "issued_at_utc"], "EPIC-0437 promotion payload");
  if (payload.schema !== "revit-operator.epic-0437-promotion-payload.v1" || !/^[0-9a-f]{32}$/.test(String(payload.evidence_run_id))
    || (payload.level !== "L3" && payload.level !== "L4") || typeof payload.native_build_manifest_path !== "string"
    || typeof payload.run_receipt_path !== "string" || !["observation_readback", "move_preview", "move_apply"].includes(String(payload.capability))
    || !Number.isFinite(Date.parse(String(payload.issued_at_utc)))) throw new Error("EPIC-0437 promotion payload identity is invalid");
  sha(payload.candidate_source_hash, "promotion candidate source hash");
  sha(payload.policy_hash, "promotion policy hash");
  sha(payload.native_build_manifest_sha256, "promotion build manifest hash");
  sha(payload.run_receipt_sha256, "promotion run hash");
  const candidate = object(payload.candidate, "EPIC-0437 promotion candidate");
  exact(candidate, ["method", "path", "request_hash", "effect_hash"], "EPIC-0437 promotion candidate");
  if (typeof candidate.method !== "string" || typeof candidate.path !== "string") throw new Error("EPIC-0437 promotion candidate route is invalid");
  sha(candidate.request_hash, "promotion request hash");
  sha(candidate.effect_hash, "promotion effect hash");
  const native = object(payload.native_attestation, "EPIC-0437 promotion native attestation");
  exact(native, ["algorithm", "key_id", "modulus_base64url", "exponent_base64url"], "EPIC-0437 promotion native attestation");
  if (native.algorithm !== "RS256" || typeof native.modulus_base64url !== "string" || native.exponent_base64url !== "AQAB") throw new Error("EPIC-0437 promotion native attestation is invalid");
  sha(native.key_id, "promotion native key id");
  const publicKey = createPublicKey(EPIC_0437_PROMOTION_AUTHORITY_PUBLIC_KEY_PEM);
  const normalizedPublic = publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = `sha256:${createHash("sha256").update(normalizedPublic, "utf8").digest("hex")}`;
  if (keyId !== EPIC_0437_PROMOTION_AUTHORITY_KEY_ID) throw new Error("EPIC-0437 compiled promotion authority key identity is invalid");
  const signature = Buffer.from(authorization.signature_base64url, "base64url");
  if (signature.toString("base64url") !== authorization.signature_base64url
    || !verify("sha256", Buffer.from(canonicalJson(payload as JsonValue), "utf8"), {
      key: publicKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32
    }, signature)) throw new Error("EPIC-0437 promotion authorization signature is invalid");
  return authorization as unknown as Epic0437PromotionAuthorization;
}
