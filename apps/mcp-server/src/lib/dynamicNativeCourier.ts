import { callRevitViaCourier } from "./revitCourier.js";
import { createCertifiedCourierAdmission } from "./toolExposurePolicy.js";
import { NATIVE_PROGRAM_EVIDENCE_MAX_BYTES } from "./dynamicNativeProgram.js";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

/** Decode only the bounded transport envelope. This confers no native authority:
 * the existing runner still authenticates source, document and native receipts. */
export function decodeNativeCourierEvidence(value: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(value, "evidenceTransport")) {
    if (Object.hasOwn(value, "evidence") || Buffer.byteLength(JSON.stringify(value), "utf8") > 600_000)
      throw Error("Native C# workstation result is invalid; reconcile before retrying.");
    const t = value.evidenceTransport as Record<string, unknown>;
    if (!t || typeof t !== "object" || Array.isArray(t)
        || Object.keys(t).sort().join(",") !== "data,encoding,sha256,uncompressedBytes"
        || t.encoding !== "gzip+base64" || !Number.isSafeInteger(t.uncompressedBytes)
        || Number(t.uncompressedBytes) < 2 || Number(t.uncompressedBytes) > NATIVE_PROGRAM_EVIDENCE_MAX_BYTES
        || typeof t.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(t.sha256)
        || typeof t.data !== "string" || !t.data.length)
      throw Error("Native C# compressed evidence is invalid; reconcile before retrying.");
    const packed = Buffer.from(t.data, "base64");
    if (packed.toString("base64") !== t.data) throw Error("Native C# evidence encoding is invalid.");
    const bytes = gunzipSync(packed, { maxOutputLength: Number(t.uncompressedBytes) });
    if (bytes.length !== t.uncompressedBytes || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== t.sha256)
      throw Error("Native C# evidence integrity check failed; reconcile before retrying.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const evidence: unknown = JSON.parse(text);
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw Error("Native C# evidence must be an object.");
    return evidence as Record<string, unknown>;
  }
  if (!value.evidence || typeof value.evidence !== "object" || Array.isArray(value.evidence)
      || Buffer.byteLength(JSON.stringify(value.evidence), "utf8") > NATIVE_PROGRAM_EVIDENCE_MAX_BYTES)
    throw Error("Native C# workstation result is invalid; reconcile before retrying.");
  return value.evidence as Record<string, unknown>;
}

export const nativeProgramCourierPath = (mode: "read" | "apply") =>
  `/revit/dynamic-runtime/run-native-${mode}-v1`;

/** Hosted code executes in the authenticated target workstation's existing
 * compiler/native runtime, never in an EC2 subprocess. No caller-supplied paths,
 * executable names, credentials or environment are transported. The runner
 * validates the returned source/document/native receipts before settlement. */
export async function runNativeProgramViaCourier(
  body: { source: string; targetRevitYear: string; expectedDocumentFingerprint: string;
    nativeProgram: unknown; workerDeadlineMs: number },
  mode: "read" | "apply", operationId?: string,
  send = callRevitViaCourier
): Promise<{ exitCode: number; evidence: Record<string, unknown> }> {
  const path = nativeProgramCourierPath(mode);
  const admission = createCertifiedCourierAdmission({ method: "POST", path, body, channel: "typed_mcp" });
  const result = await send<unknown>(path, "POST", body,
    { certifiedAdmission: admission, ...(operationId ? { canonicalOperationId: operationId } : {}) });
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw Error("Native C# workstation result is missing; reconcile before retrying.");
  const value = result as Record<string, unknown>;
  if (Object.keys(value).some(key => !["schema", "exitCode", "evidence", "evidenceTransport"].includes(key))
      || value.schema !== "operator.native-program-workstation-result.v1"
      || !Number.isSafeInteger(value.exitCode) || ![0, 1].includes(Number(value.exitCode)))
    throw Error("Native C# workstation result is invalid; reconcile before retrying.");
  return { exitCode: Number(value.exitCode), evidence: decodeNativeCourierEvidence(value) };
}
