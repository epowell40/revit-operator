import { createHmac, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import type { RequestPrincipal } from "./request_context.js";

export type OperatorAuthMode = "shared_token" | "clashpilot_jwt";

export type RequestAuthResult =
  | { ok: true; mode: OperatorAuthMode; principal?: RequestPrincipal }
  | { ok: false; mode: OperatorAuthMode; status: number; error: string };

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
  const secret = (process.env.OPERATOR_CLASHPILOT_JWT_SECRET || "").trim();
  if (!secret) {
    return { ok: false, status: 500, error: "Server is missing OPERATOR_CLASHPILOT_JWT_SECRET configuration." };
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
  const configuredSkew = Number.parseInt(process.env.OPERATOR_CLASHPILOT_JWT_CLOCK_SKEW_SECONDS || "30", 10);
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

  const configuredIssuer = (process.env.OPERATOR_CLASHPILOT_JWT_ISSUER || "").trim();
  if (configuredIssuer && readStringClaim(payload.iss) !== configuredIssuer) {
    return { ok: false, status: 401, error: "Unauthorized (bearer token issuer mismatch)." };
  }
  const configuredAudience = (process.env.OPERATOR_CLASHPILOT_JWT_AUDIENCE || "").trim();
  if (configuredAudience) {
    const audience = payload.aud;
    const matches =
      (typeof audience === "string" && audience.trim() === configuredAudience) ||
      (Array.isArray(audience) && audience.some(value => typeof value === "string" && value.trim() === configuredAudience));
    if (!matches) return { ok: false, status: 401, error: "Unauthorized (bearer token audience mismatch)." };
  }

  const sub = readStringClaim(payload.sub);
  const userId = readStringClaim(payload.user_id) || sub;
  const licenseId = readStringClaim(payload.license_id);
  if (!userId) return { ok: false, status: 401, error: "Unauthorized (bearer token missing sub/user_id claim)." };
  if (!licenseId) return { ok: false, status: 401, error: "Unauthorized (bearer token missing license_id claim)." };

  return {
    ok: true,
    principal: {
      sub: sub || userId,
      user_id: userId,
      license_id: licenseId,
      roles: parseRolesClaim(payload.roles),
      tier: readStringClaim(payload.tier) || null,
      claims: payload
    }
  };
}

export function resolveAuthMode(): OperatorAuthMode {
  if ((process.env.OPERATOR_AUTH_MODE || "").trim().toLowerCase() === "clashpilot_jwt") return "clashpilot_jwt";
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
    return { ok: true, mode: opts.mode };
  }

  const match = getHeader(req, "authorization").match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() || "";
  if (!token) {
    return { ok: false, mode: opts.mode, status: 401, error: "Unauthorized (missing/invalid Authorization: Bearer token)." };
  }
  const verified = verifyBearerJwtHs256(token);
  if (!verified.ok) return { ok: false, mode: opts.mode, status: verified.status, error: verified.error };
  return { ok: true, mode: opts.mode, principal: verified.principal };
}
