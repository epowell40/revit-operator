import type http from "node:http";
import type { RequestPrincipal } from "./request_context.js";

export type OperatorAuthMode = "shared_token";

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

export function resolveAuthMode(): OperatorAuthMode {
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

  if (!opts.sharedToken) {
    return { ok: false, mode: opts.mode, status: 500, error: "Server is missing OPERATOR_TOKEN configuration." };
  }

  const got = getHeader(req, "x-operator-token");
  if (!got || got !== opts.sharedToken) {
    return { ok: false, mode: opts.mode, status: 401, error: "Unauthorized (missing/invalid X-Operator-Token)." };
  }

  return { ok: true, mode: opts.mode };
}
