import { callRevitViaCourier } from "./revitCourier.js";
import { createCertifiedCourierAdmission } from "./toolExposurePolicy.js";

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
  if (Object.keys(value).some(key => !["schema", "exitCode", "evidence"].includes(key))
      || value.schema !== "operator.native-program-workstation-result.v1"
      || !Number.isSafeInteger(value.exitCode) || ![0, 1].includes(Number(value.exitCode))
      || !value.evidence || typeof value.evidence !== "object" || Array.isArray(value.evidence)
      || Buffer.byteLength(JSON.stringify(value.evidence), "utf8") > 8 * 1024 * 1024)
    throw Error("Native C# workstation result is invalid; reconcile before retrying.");
  return { exitCode: Number(value.exitCode), evidence: value.evidence as Record<string, unknown> };
}
