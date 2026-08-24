import { createHmac, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import type { RequestPrincipal } from "./request_context.js";
import { isHostedRuntime } from "./runtime_mode.js";
import { createOperatorBackendAuth, type OperatorBackendAuthV1 } from "./operator_backend_auth.js";

export type OperatorAuthMode = "shared_token" | "principal_jwt";

export type RequestAuthResult =
  | { ok: true; mode: OperatorAuthMode; principal?: RequestPrincipal; backend_auth?: OperatorBackendAuthV1 }
  | { ok: false; mode: OperatorAuthMode; status: number; error: string };

const UNAUTHENTICATED_PRINCIPAL_ROUTES = new Set(["GET /health"]);

function getHeader(req: http.IncomingMessage, name: string): string {
  const key = name.toLowerCase();
  const v = req.headers[key];
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v) && v.length > 0) return String(v[0] ?? "").trim();
  return "";
}

function readStringClaim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function configuredClaimName(envName: string, fallback: string): string {
  const configured = (process.env[envName] ?? "").trim();
  return configured || fallback;
}

function parseRolesClaim(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/g) : [];
  const roles: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const role = readStringClaim(value);
    const key = role.toLowerCase();
    if (!role || seen.has(key)) continue;
    seen.add(key);
    roles.push(role);
  }
  return roles;
}

function decodeJsonPart(part: string): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JWT payload must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function verifyHs256Signature(signingInput: string, signaturePart: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signaturePart, "base64url");
  } catch {
    return false;
  }
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function parseNumericDate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function verifyBearerJwtHs256(token: string): { ok: true; principal: RequestPrincipal } | { ok: false; status: number; error: string } {
  const secret = (process.env.OPERATOR_JWT_SECRET || "").trim();
  if (!secret) {
    return { ok: false, status: 500, error: "Server is missing OPERATOR_JWT_SECRET configuration." };
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some(part => !part)) {
    return { ok: false, status: 401, error: "Unauthorized (invalid bearer token format)." };
  }

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJsonPart(parts[0]!);
    payload = decodeJsonPart(parts[1]!);
  } catch {
    return { ok: false, status: 401, error: "Unauthorized (invalid bearer token payload)." };
  }

  if (readStringClaim(header.alg) !== "HS256") {
    return { ok: false, status: 401, error: "Unauthorized (unsupported bearer token algorithm)." };
  }
  if (!verifyHs256Signature(`${parts[0]}.${parts[1]}`, parts[2]!, secret)) {
    return { ok: false, status: 401, error: "Unauthorized (invalid bearer token signature)." };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const configuredSkew = Number.parseInt(process.env.OPERATOR_JWT_CLOCK_SKEW_SECONDS || "30", 10);
  const skewSeconds = Math.max(0, Math.min(300, Number.isFinite(configuredSkew) ? configuredSkew : 30));
  const expiresAt = parseNumericDate(payload.exp);
  if (expiresAt === null) return { ok: false, status: 401, error: "Unauthorized (bearer token missing exp claim)." };
  if (expiresAt <= nowSeconds - skewSeconds) return { ok: false, status: 401, error: "Unauthorized (bearer token expired)." };
  const notBefore = parseNumericDate(payload.nbf);
  if (notBefore !== null && notBefore > nowSeconds + skewSeconds) {
    return { ok: false, status: 401, error: "Unauthorized (bearer token not active yet)." };
  }
  const issuedAt = parseNumericDate(payload.iat);
  if (issuedAt !== null && issuedAt > nowSeconds + skewSeconds) {
    return { ok: false, status: 401, error: "Unauthorized (bearer token issued in the future)." };
  }

  const configuredIssuer = (process.env.OPERATOR_JWT_ISSUER || "").trim();
  if (configuredIssuer && readStringClaim(payload.iss) !== configuredIssuer) {
    return { ok: false, status: 401, error: "Unauthorized (bearer token issuer mismatch)." };
  }
  const configuredAudience = (process.env.OPERATOR_JWT_AUDIENCE || "").trim();
  if (configuredAudience) {
    const audience = payload.aud;
    const matches =
      (typeof audience === "string" && audience.trim() === configuredAudience) ||
      (Array.isArray(audience) && audience.some(value => typeof value === "string" && value.trim() === configuredAudience));
    if (!matches) return { ok: false, status: 401, error: "Unauthorized (bearer token audience mismatch)." };
  }

  const subject = readStringClaim(payload.sub);
  const userClaim = configuredClaimName("OPERATOR_JWT_USER_ID_CLAIM", "user_id");
  const tenantClaim = configuredClaimName("OPERATOR_JWT_TENANT_ID_CLAIM", "tenant_id");
  const rolesClaim = configuredClaimName("OPERATOR_JWT_ROLES_CLAIM", "roles");
  const userId = readStringClaim(payload[userClaim]) || subject;
  const tenantId = readStringClaim(payload[tenantClaim]);
  if (!userId) return { ok: false, status: 401, error: `Unauthorized (bearer token missing sub/${userClaim} claim).` };
  if (!tenantId) return { ok: false, status: 401, error: `Unauthorized (bearer token missing ${tenantClaim} claim).` };

  return {
    ok: true,
    principal: {
      sub: subject || userId,
      user_id: userId,
      tenant_id: tenantId,
      roles: parseRolesClaim(payload[rolesClaim]),
      claims: payload,
      // Compatibility fields for public-core consumers while they migrate to tenant_id.
      license_id: tenantId,
      tier: null
    }
  };
}

export function isPrincipalAuthMode(mode: OperatorAuthMode): boolean {
  return mode === "principal_jwt";
}

export function isUnauthenticatedPrincipalRoute(method: string | undefined, pathname: string): boolean {
  return UNAUTHENTICATED_PRINCIPAL_ROUTES.has(`${(method || "GET").toUpperCase()} ${pathname}`);
}

export function requiresRequestAuthentication(opts: {
  mode: OperatorAuthMode;
  method: string | undefined;
  pathname: string;
  sharedTokenRouteProtected: boolean;
}): boolean {
  if (isPrincipalAuthMode(opts.mode)) {
    return !isUnauthenticatedPrincipalRoute(opts.method, opts.pathname);
  }
  return opts.sharedTokenRouteProtected;
}

export function resolveAuthMode(): OperatorAuthMode {
  const hostedRuntime = isHostedRuntime();
  const configured = (process.env.OPERATOR_AUTH_MODE || "").trim().toLowerCase();
  if (configured === "shared_token") return "shared_token";
  if (configured === "principal_jwt" || configured === "jwt" || configured === "bearer_jwt") return "principal_jwt";
  if (configured) throw new Error(`Unsupported OPERATOR_AUTH_MODE: ${configured}`);

  if (hostedRuntime) return "principal_jwt";
  return "shared_token";
}

export function authenticateRequest(
  req: http.IncomingMessage,
  opts: {
    mode: OperatorAuthMode;
    requireAuth: boolean;
    sharedToken: string;
  }
): RequestAuthResult {
  if (!opts.requireAuth) return { ok: true, mode: opts.mode };

  if (opts.mode === "shared_token") {
    if (!opts.sharedToken) {
      return { ok: false, mode: opts.mode, status: 500, error: "Server is missing OPERATOR_TOKEN configuration." };
    }

    const got = getHeader(req, "x-operator-token");
    if (!got || got !== opts.sharedToken) {
      return { ok: false, mode: opts.mode, status: 401, error: "Unauthorized (missing/invalid X-Operator-Token)." };
    }
    return { ok: true, mode: opts.mode, backend_auth: createOperatorBackendAuth("shared_token", got) };
  }

  const match = getHeader(req, "authorization").match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() || "";
  if (!token) {
    return { ok: false, mode: opts.mode, status: 401, error: "Unauthorized (missing/invalid Authorization: Bearer token)." };
  }
  const verified = verifyBearerJwtHs256(token);
  if (!verified.ok) return { ok: false, mode: opts.mode, status: verified.status, error: verified.error };
  return {
    ok: true,
    mode: opts.mode,
    principal: verified.principal,
    backend_auth: createOperatorBackendAuth("principal_jwt", token)
  };
}
