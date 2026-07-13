import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ExternalWriteGrantMode = "once" | "session";

export type ExternalWriteGrantFile = {
  version: 1;
  token: string;
  mode: ExternalWriteGrantMode;
  issued_at_utc: string;
  expires_at_utc: string;
  uses_remaining: number | null;
  sig: string;
};

export function createExternalWriteGrant(options: {
  operatorToken: string;
  mode: ExternalWriteGrantMode;
  ttlMinutes?: number;
  now?: Date;
  grantToken?: string;
}): ExternalWriteGrantFile {
  const operatorToken = options.operatorToken.trim();
  if (!operatorToken) throw new Error("An existing Operator token is required. Start Revit with the Revit Operator add-in first.");
  const mode = options.mode;
  if (mode !== "once" && mode !== "session") throw new Error("External write grants support only 'once' or 'session'.");

  const maxTtlMinutes = mode === "once" ? 10 : 15;
  const ttlMinutes = options.ttlMinutes ?? maxTtlMinutes;
  if (!Number.isFinite(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > maxTtlMinutes) {
    throw new Error(`${mode} grants require ttlMinutes between 1 and ${maxTtlMinutes}.`);
  }

  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Grant issue time is invalid.");
  const expires = new Date(now.getTime() + Math.round(ttlMinutes * 60_000));
  const grant: ExternalWriteGrantFile = {
    version: 1,
    token: (options.grantToken ?? crypto.randomUUID().replace(/-/g, "")).trim(),
    mode,
    issued_at_utc: now.toISOString(),
    expires_at_utc: expires.toISOString(),
    uses_remaining: mode === "once" ? 1 : null,
    sig: ""
  };
  if (!grant.token) throw new Error("Grant token is invalid.");

  const key = crypto.createHash("sha256").update(`write_grant|${operatorToken}`, "utf8").digest();
  const payload = `${grant.version}|${grant.token}|${grant.mode}|${grant.issued_at_utc}|${grant.expires_at_utc}|${grant.uses_remaining ?? ""}`;
  grant.sig = crypto.createHmac("sha256", key).update(payload, "utf8").digest("base64");
  return grant;
}

export function writeExternalWriteGrant(workspaceRoot: string, grant: ExternalWriteGrantFile): string {
  const root = path.resolve(workspaceRoot);
  fs.mkdirSync(root, { recursive: true });
  const grantPath = path.join(root, "write_grant.json");
  fs.writeFileSync(grantPath, JSON.stringify(grant, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return grantPath;
}
