import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

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

export function createPrincipalBoundSessionId(principal: RequestPrincipal): string {
  return `ps1_${principalSessionScope(principal)}_${randomUUID()}`;
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
