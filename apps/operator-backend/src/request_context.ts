import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { OperatorBackendAuthV1 } from "./operator_backend_auth.js";

export type RequestPrincipal = {
  sub: string;
  user_id: string;
  tenant_id?: string;
  /** @deprecated Use tenant_id. Retained for compatibility with older public-core consumers. */
  license_id: string;
  roles: string[];
  /** @deprecated Hosted products may interpret plan claims outside the public core. */
  tier: string | null;
  claims: Record<string, unknown>;
};

export type RequestContext = {
  principal?: RequestPrincipal;
  operator_backend_auth?: OperatorBackendAuthV1;
};

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

function identityPathSegment(value: string, fallback: string): string {
  const raw = (value ?? "").toString();
  const display = raw.trim();
  const slug = display.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || fallback;
  // Principal claim identity is intentionally case-sensitive. Hash the exact
  // UTF-8 claim bytes before slugging or truncation so Windows path folding
  // and display-slug collisions cannot merge distinct principals.
  const hashInput = raw || `\u0000missing:${fallback}`;
  const digest = createHash("sha256").update("operator-principal-path-v1\u0000", "utf8").update(hashInput, "utf8").digest("hex");
  return `${slug}--${digest}`;
}

export function getScopedWorkspaceRoot(baseRoot: string, principal?: RequestPrincipal): string {
  if (!principal) return baseRoot;
  const tenantId = identityPathSegment(principal.tenant_id || principal.license_id, "unknown_tenant");
  const userId = identityPathSegment(principal.user_id, "unknown_user");
  return path.join(baseRoot, "tenants", tenantId, "users", userId, "Workspace");
}

function principalSessionScope(principal: RequestPrincipal): string {
  const tenantId = (principal.tenant_id || principal.license_id || "").trim();
  const userId = (principal.user_id || "").trim();
  return createHash("sha256").update(`${tenantId}\u0000${userId}`, "utf8").digest("base64url").slice(0, 20);
}

function deterministicSessionUuid(scope: string, clientRequestId: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update("revit-operator.session-new.v1\u0000", "utf8")
      .update(scope, "utf8")
      .update("\u0000", "utf8")
      .update(clientRequestId, "utf8")
      .digest()
      .subarray(0, 16)
  );
  // RFC 4122 variant with a version-5 marker. The digest namespace above is
  // product-owned; this is deterministic identity, not a claim of SHA-1 use.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createPrincipalBoundSessionId(principal: RequestPrincipal): string {
  return `ps1_${principalSessionScope(principal)}_${randomUUID()}`;
}

/**
 * Returns the same principal-bound session identity when a caller must retry a
 * lost `/session/new` response. The request id is scoped to the authenticated
 * principal, so equal caller ids cannot merge sessions across principals.
 */
export function createPrincipalBoundSessionIdForRequest(principal: RequestPrincipal, clientRequestId: string): string {
  const scope = principalSessionScope(principal);
  return `ps1_${scope}_${deterministicSessionUuid(scope, clientRequestId)}`;
}

/** Local-token mode has no principal scope but still needs response-loss-safe creation. */
export function createUnboundSessionIdForRequest(clientRequestId: string): string {
  return deterministicSessionUuid("local-token", clientRequestId);
}

export function resolveSessionCreationId(
  body: unknown,
  principal: RequestPrincipal | null | undefined
): { sessionId: string } | { error: string } {
  if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
    return { error: "Session creation body must be a JSON object." };
  }
  const rawClientRequestId = body && typeof body === "object"
    ? (body as Record<string, unknown>).client_request_id
    : undefined;
  const clientRequestId = typeof rawClientRequestId === "string" ? rawClientRequestId.trim() : "";
  if (rawClientRequestId !== undefined && !/^[A-Za-z0-9._:-]{1,200}$/.test(clientRequestId)) {
    return { error: "client_request_id must contain 1-200 safe identifier characters." };
  }
  return {
    sessionId: clientRequestId
      ? principal
        ? createPrincipalBoundSessionIdForRequest(principal, clientRequestId)
        : createUnboundSessionIdForRequest(clientRequestId)
      : principal
        ? createPrincipalBoundSessionId(principal)
        : randomUUID()
  };
}

export function isSessionIdBoundToPrincipal(sessionId: string, principal: RequestPrincipal): boolean {
  const match = /^ps1_([A-Za-z0-9_-]{20})_[0-9a-f-]{36}$/i.exec((sessionId || "").trim());
  return Boolean(match && match[1] === principalSessionScope(principal));
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function getRequestPrincipal(): RequestPrincipal | undefined {
  return requestContextStorage.getStore()?.principal;
}

export function getRequestOperatorBackendAuth(): OperatorBackendAuthV1 | undefined {
  return requestContextStorage.getStore()?.operator_backend_auth;
}
