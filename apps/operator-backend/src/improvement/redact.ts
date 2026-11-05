import path from "node:path";

export type RedactOptions = {
  workspaceRoot?: string;
};

const CREDENTIAL = "<redacted:credential>";

function credentialField(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (/^(?:has|is)(?:apikey|password|credential|credentials|secret|token)$/.test(normalized)) return false;
  // Match names, not token lengths. Diagnostic flags/counts/IDs are not secrets.
  return /(?:apikey|secret|token|signingkey|secretkey|privatekey|sessionkey|channelkey|encryptionkey|hmackey|accesskeyid|secretaccesskey|password|passwd|passphrase|connectionstring|databaseurl)$/.test(normalized)
    || ["pwd", "token", "secret", "credential", "credentials", "authorization", "proxyauthorization", "cookie", "setcookie"].includes(normalized);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactPaths(s: string, workspaceRoot?: string): string {
  let out = s;

  // Replace explicit workspace root with a stable token (keeps relative structure for debugging).
  if (workspaceRoot) {
    try {
      const root = path.resolve(workspaceRoot);
      const rootWin = root.replaceAll("/", "\\");
      const rootPosix = root.replaceAll("\\", "/");
      const re1 = new RegExp(escapeRegExp(rootWin), "gi");
      const re2 = new RegExp(escapeRegExp(rootPosix), "gi");
      out = out.replace(re1, "<workspace>").replace(re2, "<workspace>");
    } catch {
      // ignore
    }
  }

  // Windows user home (most sensitive path pattern).
  out = out.replace(/[A-Z]:\\Users\\[^\\\s"']+/gi, "<user-home>");
  // UNC paths.
  out = out.replace(/\\\\[A-Z0-9._-]+\\[^\s"']+/gi, "<unc-path>");
  // Any remaining Windows absolute paths.
  out = out.replace(/[A-Z]:\\[^\s"']+/g, "<path>");
  // Common Unix paths (best-effort).
  out = out.replace(/\/Users\/[^/\s"']+/g, "/Users/<user>");
  out = out.replace(/\/home\/[^/\s"']+/g, "/home/<user>");

  return out;
}

export function redactString(input: string, opts?: RedactOptions): string {
  let s = input ?? "";
  // Header lines may contain a scheme or multiple cookie values. Never leave
  // the value behind after removing only 'Basic'/'Bearer' or the first cookie.
  s = s.replace(/(^|[\r\n])([ \t]*(?:proxy-authorization|authorization|cookie|set-cookie)[ \t]*:[ \t]*)[^\r\n]*/gi,
    (_match, start, header) => start + header + CREDENTIAL);
  s = s.replace(/(\b(?:proxy-)?authorization\s*:\s*)(?:Basic|Bearer)\s+[A-Za-z0-9+/_=.-]+/gi,
    (_match, header) => header + CREDENTIAL);
  // Structured JSON, environment assignments and URL query values in text.
  s = s.replace(/(["']?)([a-z][a-z0-9_.-]{0,127})\1(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi,
    (match, quote, key, separator, value) => {
      if (!credentialField(key) || value === "null") return match;
      const valueQuote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
      return quote + key + quote + separator + valueQuote + CREDENTIAL + valueQuote;
    });
  s = redactPaths(s, opts?.workspaceRoot);

  // Emails.
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>");
  // GUIDs.
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<guid>");

  // Authorization headers / bearer tokens.
  s = s.replace(/\bBearer\s+[A-Za-z0-9+/_=.-]+/gi, "Bearer <token>");

  // Long-ish tokens (avoid nuking normal short ids).
  s = s.replace(/\b[A-Za-z0-9+/_=.-]{48,}\b/g, "<token>");
  return s;
}

export function redactUnknown<T>(input: T, opts?: RedactOptions): T {
  const seen = new WeakMap<object, any>();

  const walk = (v: any, depth: number): any => {
    if (depth > 30) return "<redacted:max-depth>";
    if (v === null || v === undefined) return v;
    if (typeof v === "string") return redactString(v, opts);
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "bigint") return "<redacted:bigint>";
    if (typeof v === "function") return "<redacted:function>";
    if (v instanceof Date) return v.toISOString();

    if (Array.isArray(v)) return v.slice(0, 5000).map(x => walk(x, depth + 1));
    if (typeof v === "object") {
      if (seen.has(v)) return seen.get(v);
      const out: Record<string, any> = {};
      seen.set(v, out);
      const keys = Object.keys(v).slice(0, 5000);
      const namedCredential = keys.filter(key => ["name", "key"].includes(key.toLowerCase()))
        .some(key => typeof v[key] === "string" && credentialField(v[key]));
      for (const k of keys) {
        const value = v[k];
        const secret = credentialField(k) || namedCredential && k.toLowerCase() === "value";
        // Defining an own property also avoids interpreting '__proto__' as an
        // object-prototype mutation in an untrusted diagnostic payload.
        Object.defineProperty(out, k, { value: secret && value != null ? CREDENTIAL : walk(value, depth + 1),
          enumerable: true, writable: true, configurable: true });
      }
      return out;
    }

    return redactString(String(v), opts);
  };

  return walk(input, 0) as T;
}

