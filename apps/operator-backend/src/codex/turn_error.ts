import type { CodexErrorInfo } from "./generated/app_server_0_157_0/v2/CodexErrorInfo.js";

const stringCodes = new Set<string>([
  "contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "rateLimitExceeded",
  "serverOverloaded", "cyberPolicy", "misalignmentPolicyViolation", "internalServerError",
  "unauthorized", "badRequest", "threadRollbackFailed", "sandboxError", "other"
] satisfies CodexErrorInfo[]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Retain only the pinned protocol's typed discriminator, never infer one from prose. */
function parseErrorInfo(value: unknown): CodexErrorInfo | null {
  if (typeof value === "string") return stringCodes.has(value) ? value as CodexErrorInfo : null;
  const variant = record(value);
  if (!variant || Object.keys(variant).length !== 1) return null;
  const kind = Object.keys(variant)[0]!;
  const details = record(variant[kind]);
  if (!details) return null;
  if (kind === "activeTurnNotSteerable") {
    const turnKind = details.turnKind;
    return turnKind === "review" || turnKind === "compact"
      ? Object.freeze({ activeTurnNotSteerable: Object.freeze({ turnKind }) }) : null;
  }
  const httpStatusCode = details.httpStatusCode;
  if (httpStatusCode !== null && (typeof httpStatusCode !== "number" || !Number.isInteger(httpStatusCode))) return null;
  const status = Object.freeze({ httpStatusCode });
  switch (kind) {
    case "httpConnectionFailed": return Object.freeze({ httpConnectionFailed: status });
    case "responseStreamConnectionFailed": return Object.freeze({ responseStreamConnectionFailed: status });
    case "responseStreamDisconnected": return Object.freeze({ responseStreamDisconnected: status });
    case "responseTooManyFailedAttempts": return Object.freeze({ responseTooManyFailedAttempts: status });
    default: return null;
  }
}

export type CodexTurnErrorReceipt = Readonly<{ message: string | null; codexErrorInfo: CodexErrorInfo | null }>;

export function codexTurnErrorReceipt(value: unknown): CodexTurnErrorReceipt {
  // String-only observations remain supported for existing callers.
  if (typeof value === "string") return { message: value.slice(0, 2048), codexErrorInfo: null };
  const error = record(value);
  if (!error || typeof error.message !== "string") return { message: null, codexErrorInfo: null };
  return { message: error.message.slice(0, 2048), codexErrorInfo: parseErrorInfo(error.codexErrorInfo) };
}

/** A failed provider turn, not a retry decision or a billing diagnosis. */
export class CodexTurnFailedError extends Error {
  readonly codexErrorInfo: CodexErrorInfo | null;
  constructor(readonly threadId: string, readonly turnId: string, receipt: CodexTurnErrorReceipt) {
    super(receipt.message || "Codex turn failed.");
    this.name = "CodexTurnFailedError";
    this.codexErrorInfo = receipt.codexErrorInfo;
  }
}
