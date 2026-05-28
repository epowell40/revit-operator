import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

export type RequestPrincipal = {
  sub: string;
  user_id: string;
  license_id: string;
  roles: string[];
  tier: string | null;
  claims: Record<string, unknown>;
};

export type RequestContext = {
  principal?: RequestPrincipal;
};

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

function sanitizePathSegment(value: string, fallback: string): string {
  const t = (value ?? "").toString().trim();
  const safe = t.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  return safe || fallback;
}

export function getScopedWorkspaceRoot(baseRoot: string, principal?: RequestPrincipal): string {
  if (!principal) return baseRoot;
  const licenseId = sanitizePathSegment(principal.license_id, "unknown_license");
  const userId = sanitizePathSegment(principal.user_id, "unknown_user");
  return path.join(baseRoot, "tenants", licenseId, "users", userId, "Workspace");
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
