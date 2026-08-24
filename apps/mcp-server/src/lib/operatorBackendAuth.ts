import { AsyncLocalStorage } from "node:async_hooks";
import { getOrCreateOperatorToken } from "./workspace.js";

export const OPERATOR_BACKEND_AUTH_V1 = "revit-operator.operator-backend-auth/v1" as const;
export const OPERATOR_BACKEND_AUTH_META_KEY = "revit-operator/backend-auth" as const;

export type OperatorBackendAuthMode = "shared_token" | "principal_jwt";
export type OperatorBackendAuthV1 = {
  schema: typeof OPERATOR_BACKEND_AUTH_V1;
  mode: OperatorBackendAuthMode;
  credential: string;
  allowed_origin: string;
};

export type OperatorBackendAuthErrorCode =
  | "OPERATOR_BACKEND_AUTH_INVALID"
  | "OPERATOR_BACKEND_AUTH_MISSING"
  | "OPERATOR_BACKEND_AUTH_CONFLICT"
  | "OPERATOR_BACKEND_AUTH_ORIGIN_DENIED"
  | "OPERATOR_BACKEND_AUTH_INSECURE_BEARER";

export class OperatorBackendAuthError extends Error {
  constructor(readonly code: OperatorBackendAuthErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "OperatorBackendAuthError";
  }
}

const authStorage = new AsyncLocalStorage<OperatorBackendAuthV1>();

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizedOrigin(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) {
    throw new OperatorBackendAuthError("OPERATOR_BACKEND_AUTH_INVALID", "The allowed backend origin is missing or invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OperatorBackendAuthError("OPERATOR_BACKEND_AUTH_INVALID", "The allowed backend origin is not a valid URL.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new OperatorBackendAuthError("OPERATOR_BACKEND_AUTH_INVALID", "The allowed backend origin is not a credential-free http(s) origin.");
  }
  return parsed.origin;
}

export function parseOperatorBackendAuth(value: unknown): OperatorBackendAuthV1 {
  const row = record(value);
  if (!row || row.schema !== OPERATOR_BACKEND_AUTH_V1) {
    throw new OperatorBackendAuthError("OPERATOR_BACKEND_AUTH_INVALID", "The internal backend auth envelope is missing or unsupported.");
  }
  if (row.mode !== "shared_token" && row.mode !== "principal_jwt") {
    throw new OperatorBackendAuthError("OPERATOR_BACKEND_AUTH_INVALID", "The internal backend auth mode is unsupported.");
  }
  const credential = typeof row.credential === "string" ? row.credential.trim() : "";
  if (!credential || credential.length > 32_768) {
    throw new OperatorBackendAuthError("OPERATOR_BACKEND_AUTH_INVALID", "The internal backend credential is missing or invalid.");
  }
  const allowed = new Set(["schema", "mode", "credential", "allowed_origin"]);
  if (Object.keys(row).some(key => !allowed.has(key))) {
    throw new OperatorBackendAuthError("OPERATOR_BACKEND_AUTH_CONFLICT", "The internal backend auth envelope contains conflicting credential fields.");
  }
  return Object.freeze({
    schema: OPERATOR_BACKEND_AUTH_V1,
    mode: row.mode,
    credential,
    allowed_origin: normalizedOrigin(row.allowed_origin)
  });
}

export function operatorBackendAuthFromMeta(meta: unknown): OperatorBackendAuthV1 | undefined {
  const row = record(meta);
  if (!row || !(OPERATOR_BACKEND_AUTH_META_KEY in row)) return undefined;
  return parseOperatorBackendAuth(row[OPERATOR_BACKEND_AUTH_META_KEY]);
}

export function runWithOperatorBackendAuth<T>(meta: unknown, fn: () => T): T {
  const auth = operatorBackendAuthFromMeta(meta);
  return auth ? authStorage.run(auth, fn) : fn();
}

export function currentOperatorBackendAuth(): OperatorBackendAuthV1 | undefined {
  return authStorage.getStore();
}

function configuredMode(env: NodeJS.ProcessEnv): OperatorBackendAuthMode {
  const value = (env.OPERATOR_BACKEND_AUTH_MODE || env.OPERATOR_AUTH_MODE || "shared_token").trim().toLowerCase();
  if (value === "shared_token") return "shared_token";
  if (value === "principal_jwt" || value === "jwt" || value === "bearer_jwt" || value === "clashpilot_jwt") return "principal_jwt";
  throw new OperatorBackendAuthError("OPERATOR_BACKEND_AUTH_INVALID", "The configured internal backend auth mode is unsupported.");
}

export function resolveOperatorBackendAuth(input: {
  auth?: OperatorBackendAuthV1;
  authMode?: OperatorBackendAuthMode;
  token?: string;
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
}): OperatorBackendAuthV1 {
  if (input.auth && (input.authMode || input.token)) {
    throw new OperatorBackendAuthError("OPERATOR_BACKEND_AUTH_CONFLICT", "Provide one internal backend auth source, not multiple credential forms.");
  }
  if (input.auth) return parseOperatorBackendAuth(input.auth);
  const contextual = currentOperatorBackendAuth();
  if (contextual) return contextual;
  const env = input.env ?? process.env;
  const mode = input.authMode ?? configuredMode(env);
  const credential = (input.token ?? (mode === "shared_token" ? getOrCreateOperatorToken() : "")).trim();
  if (!credential) {
    throw new OperatorBackendAuthError("OPERATOR_BACKEND_AUTH_MISSING", `The ${mode} credential is unavailable before request dispatch.`);
  }
  return parseOperatorBackendAuth({
    schema: OPERATOR_BACKEND_AUTH_V1,
    mode,
    credential,
    allowed_origin: new URL(input.baseUrl).origin
  });
}

function isLoopback(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "[::1]" || lower === "::1";
}

export function buildOperatorBackendAuthHeaders(authValue: OperatorBackendAuthV1, targetUrl: string): Headers {
  const auth = parseOperatorBackendAuth(authValue);
  const target = new URL(targetUrl);
  if (target.origin !== auth.allowed_origin) {
    throw new OperatorBackendAuthError("OPERATOR_BACKEND_AUTH_ORIGIN_DENIED", "Refused to forward an Operator backend credential to a different origin.");
  }
  if (auth.mode === "principal_jwt" && target.protocol !== "https:" && !isLoopback(target.hostname)) {
    throw new OperatorBackendAuthError("OPERATOR_BACKEND_AUTH_INSECURE_BEARER", "Refused to forward a principal credential over an insecure non-loopback origin.");
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  if (auth.mode === "shared_token") headers.set("X-Operator-Token", auth.credential);
  else headers.set("Authorization", `Bearer ${auth.credential}`);
  return headers;
}

export function redactOperatorBackendAuthText(value: string, auth: OperatorBackendAuthV1): string {
  let safe = value.replaceAll(auth.credential, "[REDACTED]");
  safe = safe.replace(/authorization\s*:\s*bearer\s+[^\s,;]+/gi, "Authorization: Bearer [REDACTED]");
  safe = safe.replace(/x-operator-token\s*:\s*[^\s,;]+/gi, "X-Operator-Token: [REDACTED]");
  return safe.slice(0, 4_096);
}
