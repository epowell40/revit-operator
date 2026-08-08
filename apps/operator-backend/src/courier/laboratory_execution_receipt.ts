import { createHash, createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { canonicalJson, type JsonValue } from "../capabilities/tool_certification.js";
import {
  parseLaboratoryEvidenceDispatch,
  type LaboratoryEvidenceDispatch
} from "./laboratory_evidence.js";

export const LABORATORY_EXECUTION_RECEIPT_SCHEMA = "revit-operator.laboratory-execution-receipt.v1";
export const LABORATORY_EXECUTION_RECEIPT_FIELD = "laboratory_execution_receipt";

const HASH = /^sha256:[0-9a-f]{64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECEIPT_FIELDS = [
  "schema", "request_id", "dispatch_id", "transport_request_nonce", "transport_server_epoch",
  "transport_issued_at_utc", "laboratory_evidence", "laboratory_evidence_hash",
  "laboratory_move_evidence", "method", "path", "body_present", "raw_body_sha256",
  "canonical_body_sha256", "phase", "effect_id", "effect_hash", "channel", "alias",
  "document_fingerprint", "document_session_id", "revit_process_id", "revit_process_start_utc",
  "revit_process_image_path", "native_attestation_algorithm",
  "native_common_assembly_path", "native_common_assembly_sha256",
  "native_logic_assembly_path", "native_logic_assembly_sha256",
  "native_bridge_assembly_path", "native_bridge_assembly_sha256",
  "native_attestation_key_id", "native_attestation_modulus_base64url",
  "native_attestation_exponent_base64url", "result_hash", "outcome", "outcome_unknown",
  "issued_at_utc", "native_attestation_signature"
] as const;

export type TrustedNativeAttestationBinding = {
  algorithm: "RS256";
  key_id: string;
  modulus_base64url: string;
  exponent_base64url: "AQAB";
};

export type VerifiedLaboratoryExecutionReceipt = {
  receipt: Record<string, unknown>;
  evidence: LaboratoryEvidenceDispatch;
  result: Record<string, unknown>;
  key: TrustedNativeAttestationBinding;
};

function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], location: string): void {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) throw new Error(`${location} has missing or unknown fields.`);
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function decodeBase64Url(value: unknown, bytes: number, location: string): Buffer {
  if (typeof value !== "string" || !B64URL.test(value) || value.includes("=") || value.length % 4 === 1) throw new Error(`${location} is invalid.`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) throw new Error(`${location} is invalid.`);
  return decoded;
}

function string(value: Record<string, unknown>, key: string, pattern?: RegExp): string {
  const result = value[key];
  if (typeof result !== "string" || !result || (pattern && !pattern.test(result))) throw new Error(`laboratory receipt ${key} is invalid.`);
  return result;
}

function sameTrustedKey(left: TrustedNativeAttestationBinding, right: TrustedNativeAttestationBinding): boolean {
  return left.algorithm === right.algorithm && left.key_id === right.key_id
    && left.modulus_base64url === right.modulus_base64url && left.exponent_base64url === right.exponent_base64url;
}

export function verifyLaboratoryExecutionReceipt(
  attachedResult: unknown,
  options: {
    trustedNativeAttestation?: TrustedNativeAttestationBinding;
    expectedEvidence?: LaboratoryEvidenceDispatch;
    method?: string;
    path?: string;
    bodyJson?: string;
    body?: unknown;
    channel?: string;
    alias?: string;
  } = {}
): VerifiedLaboratoryExecutionReceipt {
  const attached = object(attachedResult, "native laboratory result");
  const receipt = object(attached[LABORATORY_EXECUTION_RECEIPT_FIELD], LABORATORY_EXECUTION_RECEIPT_FIELD);
  exact(receipt, RECEIPT_FIELDS, LABORATORY_EXECUTION_RECEIPT_FIELD);
  if (receipt.schema !== LABORATORY_EXECUTION_RECEIPT_SCHEMA || receipt.outcome_unknown !== false) {
    throw new Error("Native laboratory receipt does not prove a known successful outcome.");
  }
  const evidence = parseLaboratoryEvidenceDispatch(receipt.laboratory_evidence);
  const evidenceHash = string(receipt, "laboratory_evidence_hash", HASH);
  if (evidenceHash !== sha256Text(canonicalJson(evidence as unknown as JsonValue))) throw new Error("Native laboratory receipt evidence hash is invalid.");
  if (options.expectedEvidence && canonicalJson(evidence as unknown as JsonValue) !== canonicalJson(options.expectedEvidence as unknown as JsonValue)) {
    throw new Error("Native laboratory receipt does not bind the expected dispatch evidence.");
  }

  const modulus = string(receipt, "native_attestation_modulus_base64url");
  decodeBase64Url(modulus, 256, "native laboratory RSA modulus");
  const exponent = string(receipt, "native_attestation_exponent_base64url");
  if (exponent !== "AQAB") throw new Error("Native laboratory RSA exponent is invalid.");
  const keyId = string(receipt, "native_attestation_key_id", HASH);
  const expectedKeyId = sha256Text(canonicalJson({
    algorithm: "RS256",
    exponent_base64url: exponent,
    modulus_base64url: modulus
  }));
  if (keyId !== expectedKeyId || receipt.native_attestation_algorithm !== "RS256") throw new Error("Native laboratory attestation key binding is invalid.");
  const key: TrustedNativeAttestationBinding = {
    algorithm: "RS256",
    key_id: keyId,
    modulus_base64url: modulus,
    exponent_base64url: "AQAB"
  };
  if (options.trustedNativeAttestation && !sameTrustedKey(key, options.trustedNativeAttestation)) {
    throw new Error("Native laboratory receipt is not signed by the independently trusted live process key.");
  }

  const signature = decodeBase64Url(receipt.native_attestation_signature, 256, "native laboratory signature");
  const signed: Record<string, unknown> = {};
  for (const keyName of RECEIPT_FIELDS) if (keyName !== "native_attestation_signature") signed[keyName] = receipt[keyName];
  const publicKey = createPublicKey({ key: { kty: "RSA", n: modulus, e: exponent }, format: "jwk" });
  if (!verify("RSA-SHA256", Buffer.from(canonicalJson(signed as JsonValue), "utf8"), publicKey, signature)) {
    throw new Error("Native laboratory receipt signature is invalid.");
  }

  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attached)) if (name !== LABORATORY_EXECUTION_RECEIPT_FIELD) result[name] = value;
  if (string(receipt, "result_hash", HASH) !== sha256Text(canonicalJson(result as JsonValue))) throw new Error("Native laboratory result hash is invalid.");
  if (!ISO_UTC.test(string(receipt, "transport_issued_at_utc")) || !ISO_UTC.test(string(receipt, "issued_at_utc"))) throw new Error("Native laboratory receipt time is invalid.");
  if (!Number.isSafeInteger(receipt.revit_process_id) || Number(receipt.revit_process_id) <= 0
    || !ISO_UTC.test(string(receipt, "revit_process_start_utc"))) throw new Error("Native laboratory Revit process identity is invalid.");
  for (const name of ["revit_process_image_path", "native_common_assembly_path", "native_logic_assembly_path", "native_bridge_assembly_path"] as const) {
    const value = string(receipt, name);
    if (!path.win32.isAbsolute(value) || value.includes("\0")) throw new Error(`Native laboratory ${name} is not one exact absolute Windows path.`);
  }
  if (typeof receipt.body_present !== "boolean" || typeof receipt.outcome !== "string" || !receipt.outcome) throw new Error("Native laboratory receipt outcome/body binding is invalid.");
  for (const name of ["raw_body_sha256", "canonical_body_sha256", "effect_hash", "document_fingerprint", "native_common_assembly_sha256", "native_logic_assembly_sha256", "native_bridge_assembly_sha256"] as const) string(receipt, name, HASH);
  for (const name of ["request_id", "dispatch_id", "transport_request_nonce", "transport_server_epoch", "method", "path", "phase", "effect_id", "channel", "alias", "document_session_id"] as const) string(receipt, name);
  if (receipt.request_id !== receipt.dispatch_id) throw new Error("Native laboratory request/dispatch identity is inconsistent.");
  if (receipt.channel !== evidence.channel || receipt.alias !== evidence.alias) throw new Error("Native laboratory receipt channel/alias differs from its authenticated dispatch evidence.");
  if (options.method !== undefined && receipt.method !== options.method) throw new Error("Native laboratory receipt method mismatch.");
  if (options.path !== undefined && receipt.path !== options.path) throw new Error("Native laboratory receipt path mismatch.");
  if (options.channel !== undefined && receipt.channel !== options.channel) throw new Error("Native laboratory receipt channel mismatch.");
  if (options.alias !== undefined && receipt.alias !== options.alias) throw new Error("Native laboratory receipt alias mismatch.");
  if (options.bodyJson !== undefined) {
    if (receipt.raw_body_sha256 !== sha256Text(options.bodyJson)) throw new Error("Native laboratory receipt raw body mismatch.");
    const canonicalBody = options.bodyJson === "" ? "" : canonicalJson(JSON.parse(options.bodyJson) as JsonValue);
    if (receipt.canonical_body_sha256 !== sha256Text(canonicalBody)) throw new Error("Native laboratory receipt canonical body mismatch.");
  } else if (options.body !== undefined) {
    if (receipt.canonical_body_sha256 !== sha256Text(canonicalJson(options.body as JsonValue))) {
      throw new Error("Native laboratory receipt canonical body mismatch.");
    }
  }
  return { receipt, evidence, result, key };
}
