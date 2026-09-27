import fs from "node:fs";
import path from "node:path";
import { isReasoningEffort, isSafeModelId, type AgentModelSettings, type ReasoningEffort } from "../speed_config.js";

export type CodexReportedModelIdentity = Readonly<{
  reported_model: string | null;
  reported_model_source: "raw_response" | "rerouted" | null;
}>;

export type CodexWorkerIdentityV1 = Readonly<{
  provider: "openai_codex";
  configured_billing_mode: "chatgpt" | "api_key" | "unknown";
  requested_model: string | null;
  requested_reasoning_effort: ReasoningEffort | null;
}> & CodexReportedModelIdentity;

function configuredBillingMode(codexHome: string): CodexWorkerIdentityV1["configured_billing_mode"] {
  let descriptor: number | undefined;
  try {
    // The caller supplies the selected client's resolved home. Never infer another login from the environment.
    if (typeof codexHome !== "string" || !path.isAbsolute(codexHome)) return "unknown";
    descriptor = fs.openSync(path.join(codexHome, "auth.json"), "r");
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 65_536) return "unknown";
    const value: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
    const mode = (value as Record<string, unknown>).auth_mode;
    // These are configuration labels, not a credential-validity or current-account assertion.
    return mode === "chatgpt" ? "chatgpt" : mode === "apikey" ? "api_key" : "unknown";
  } catch {
    return "unknown";
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* No credential path or parse diagnostic is published. */ }
    }
  }
}

/** Capture once per admitted attempt; this does not read balances, copy auth, or attest a provider model. */
export function readCodexWorkerIdentity(args: {
  codexHome: string;
  settings: AgentModelSettings;
}): CodexWorkerIdentityV1 {
  return Object.freeze({
    provider: "openai_codex",
    configured_billing_mode: configuredBillingMode(args.codexHome),
    requested_model: isSafeModelId(args.settings.model) ? args.settings.model.trim() : null,
    requested_reasoning_effort: isReasoningEffort(args.settings.reasoning_effort)
      ? args.settings.reasoning_effort.trim().toLowerCase() as ReasoningEffort : null,
    reported_model: null,
    reported_model_source: null
  });
}
