import { clearSafeReadProxySecret, verifySafeReadProxySecretHeader } from "./safe_read_proxy_secret.js";

export const SAFE_READ_PROXY_ORIGIN = "http://127.0.0.1:3907";
export const SAFE_READ_PROXY_SECRET_HEADER = "X-RevitOperator-SafeRead-Proxy-Secret";
export const SAFE_READ_PREAUTHORIZE_PATH = "/api/safe-read/direct/preauthorize";
export const SAFE_READ_AUTHORIZE_EXECUTION_PATH = "/api/safe-read/direct/authorize-execution";
export const SAFE_READ_PROXY_MAX_REQUEST_BYTES = 64 * 1024;
export const SAFE_READ_PROXY_MAX_RESPONSE_BYTES = 64 * 1024;

const PREAUTHORIZE_KEYS = [
  "schema", "route_id", "host_instance_id", "executor_id", "runtime_attestation_sha256",
  "runtime_tuple", "document", "client_session_id", "request_id", "attempt_id", "capability_nonce_sha256"
];
const FINAL_AUTHORIZATION_KEYS = [
  "schema", "route_id", "host_instance_id", "executor_id", "runtime_attestation_sha256",
  "runtime_tuple", "document", "client_session_id", "request_id", "attempt_id", "capability_id", "capability_nonce"
];
const PROXY_PATHS = new Map([
  [SAFE_READ_PREAUTHORIZE_PATH, PREAUTHORIZE_KEYS],
  [SAFE_READ_AUTHORIZE_EXECUTION_PATH, FINAL_AUTHORIZATION_KEYS]
]);
const SUCCESS_ENVELOPE_KEYS = ["ok", "authorization"];
const FINAL_ENVELOPE_KEYS = ["ok", "receipt"];
const FAILURE_ENVELOPE_KEYS = ["ok", "code", "error", "retryable", "request_dispatched", "outcome_unknown"];

export class SafeReadProxyError extends Error {
  constructor(code, message, details = {}) {
    super(message, { cause: details.cause });
    this.name = "SafeReadProxyError";
    this.code = code;
    this.request_dispatched = details.requestDispatched === true;
    this.outcome_unknown = details.outcomeUnknown === true;
    this.retryable = this.outcome_unknown ? false : details.retryable === true;
  }
}

export function createSafeReadAuthorizationProxy({
  secret,
  backendOrigin,
  getAccessToken,
  refreshAccessToken,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 2_500,
  logger = null
}) {
  const clearableSecret = Buffer.isBuffer(secret) || secret instanceof Uint8Array ? secret : null;
  const suppliedSecret = Buffer.isBuffer(secret) ? secret : null;
  let origin;
  try {
    if (!suppliedSecret || suppliedSecret.length !== 32) {
      throw new SafeReadProxyError("SAFE_READ_PROXY_CONFIGURATION_INVALID", "SafeRead proxy secret is invalid.");
    }
    origin = requireBackendOrigin(backendOrigin);
    if (typeof getAccessToken !== "function" || typeof refreshAccessToken !== "function" || typeof fetchImpl !== "function") {
      throw new SafeReadProxyError("SAFE_READ_PROXY_CONFIGURATION_INVALID", "SafeRead proxy hosted authorization is unavailable.");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 30_000) {
      throw new SafeReadProxyError("SAFE_READ_PROXY_CONFIGURATION_INVALID", "SafeRead proxy timeout is invalid.");
    }
    if (logger !== null && (typeof logger !== "object" || Array.isArray(logger)
      || logger.warn !== undefined && typeof logger.warn !== "function")) {
      throw new SafeReadProxyError("SAFE_READ_PROXY_CONFIGURATION_INVALID", "SafeRead proxy logger is invalid.");
    }
  } catch (error) {
    clearSafeReadProxySecret(clearableSecret);
    if (error instanceof SafeReadProxyError) throw error;
    throw new SafeReadProxyError("SAFE_READ_PROXY_CONFIGURATION_INVALID", "SafeRead proxy configuration is invalid.");
  }

  let retainedSecret;
  try {
    retainedSecret = Buffer.from(suppliedSecret);
    if (retainedSecret.length !== 32) {
      throw new SafeReadProxyError("SAFE_READ_PROXY_CONFIGURATION_INVALID", "SafeRead proxy secret copy is invalid.");
    }
    return buildSafeReadAuthorizationProxy({
      retainedSecret,
      origin,
      getAccessToken,
      refreshAccessToken,
      fetchImpl,
      timeoutMs,
      logger
    });
  } catch (error) {
    clearSafeReadProxySecret(retainedSecret);
    if (error instanceof SafeReadProxyError) throw error;
    throw new SafeReadProxyError("SAFE_READ_PROXY_CONFIGURATION_INVALID", "SafeRead proxy configuration is invalid.");
  } finally {
    // Construction consumes the supplied buffer. The returned proxy exclusively
    // owns its retained copy until dispose(), including on constructor failure.
    clearSafeReadProxySecret(clearableSecret);
  }
}

function buildSafeReadAuthorizationProxy({
  retainedSecret,
  origin,
  getAccessToken,
  refreshAccessToken,
  fetchImpl,
  timeoutMs,
  logger
}) {
  let disposed = false;
  const activeRequestBuffers = new Set();

  const handle = async ({ method, target, headers, rawHeaders, body, onAccepted }) => {
    const suppliedBody = Buffer.isBuffer(body) || body instanceof Uint8Array ? body : null;
    if (suppliedBody) activeRequestBuffers.add(suppliedBody);
    let requestBytes;
    let requestText = "";
    let parsed = null;
    try {
      if (disposed) return safeFailure(503, "SAFE_READ_PROXY_UNAVAILABLE", "SafeRead authorization proxy is unavailable.", true, false, false);
      const route = typeof target === "string" && PROXY_PATHS.has(target) ? target : null;
      if (method !== "POST" || !route) {
        return safeFailure(404, "SAFE_READ_PROXY_ROUTE_INVALID", "SafeRead authorization proxy accepts only its two fixed POST routes.", false, false, false);
      }
      const headerBag = normalizeHeaders(headers, rawHeaders);
      if (headerBag.duplicates.size > 0
        || headerBag.values.has("authorization")
        || headerBag.values.has("x-operator-token")
        || !verifySafeReadProxySecretHeader(headerBag.values.get(SAFE_READ_PROXY_SECRET_HEADER.toLowerCase()), retainedSecret)) {
        emitSafeLog(logger, "warn", "SafeRead authorization proxy rejected unauthenticated caller metadata.");
        return safeFailure(403, "SAFE_READ_PROXY_UNAUTHORIZED", "SafeRead authorization proxy caller was not authenticated.", false, false, false);
      }
      if (!isJsonContentType(headerBag.values.get("content-type"))) {
        return safeFailure(415, "SAFE_READ_PROXY_CONTENT_TYPE_INVALID", "SafeRead authorization proxy requires application/json.", false, false, false);
      }
      if (!Buffer.isBuffer(body) || body.length === 0 || body.length > SAFE_READ_PROXY_MAX_REQUEST_BYTES) {
        return safeFailure(413, "SAFE_READ_PROXY_REQUEST_SIZE_INVALID", "SafeRead authorization request size is invalid.", false, false, false);
      }
      requestBytes = Buffer.from(body);
      activeRequestBuffers.add(requestBytes);
      try {
        requestText = strictUtf8(requestBytes);
        parsed = parseStrictJson(requestText);
        assertExactObjectKeys(parsed, PROXY_PATHS.get(route));
      } catch {
        return safeFailure(400, "SAFE_READ_PROXY_REQUEST_INVALID", "SafeRead authorization request is malformed or noncanonical.", false, false, false);
      }
      if (typeof onAccepted === "function") {
        onAccepted(Object.freeze({ route, requestId: parsed.request_id }));
      }

      let accessToken;
      try {
        accessToken = requireAccessToken(await getAccessToken());
      } catch (error) {
        emitSafeLog(logger, "warn", "SafeRead authorization proxy could not obtain hosted credentials.");
        return safeFailure(503, "SAFE_READ_PROXY_AUTH_UNAVAILABLE", "Hosted SafeRead authorization is unavailable before dispatch.", true, false, false);
      }
      if (disposed) return safeFailure(503, "SAFE_READ_PROXY_UNAVAILABLE", "SafeRead authorization proxy is unavailable.", true, false, false);

      const first = await forwardOnce({
        origin, route, requestBytes, accessToken, fetchImpl, timeoutMs
      });
      if (first.status !== 401) return validateBackendResult(first, route);
      clearSafeReadProxySecret(first.body);

      try {
        accessToken = requireAccessToken(await refreshAccessToken());
      } catch {
        emitSafeLog(logger, "warn", "SafeRead authorization proxy could not refresh hosted credentials.");
        return safeFailure(503, "SAFE_READ_PROXY_AUTH_UNAVAILABLE", "Hosted SafeRead authorization is unavailable before dispatch.", true, false, false);
      }
      if (disposed) return safeFailure(503, "SAFE_READ_PROXY_UNAVAILABLE", "SafeRead authorization proxy is unavailable.", true, false, false);
      const retried = await forwardOnce({
        origin, route, requestBytes, accessToken, fetchImpl, timeoutMs
      });
      if (retried.status === 401) {
        clearSafeReadProxySecret(retried.body);
        return safeFailure(503, "SAFE_READ_PROXY_AUTH_UNAVAILABLE", "Hosted SafeRead authorization rejected the refreshed credential before application dispatch.", true, false, false);
      }
      return validateBackendResult(retried, route);
    } finally {
      parsed = null;
      requestText = "";
      activeRequestBuffers.delete(requestBytes);
      activeRequestBuffers.delete(suppliedBody);
      clearSafeReadProxySecret(requestBytes);
      clearSafeReadProxySecret(suppliedBody);
    }
  };

  const expressHandler = async (request, response, lifecycle = null) => {
    let result;
    let body;
    try {
      body = await readBoundedIncomingBody(request, SAFE_READ_PROXY_MAX_REQUEST_BYTES);
      result = await handle({
        method: request.method,
        target: request.originalUrl ?? request.url,
        headers: request.headers,
        rawHeaders: request.rawHeaders,
        body,
        onAccepted: lifecycle?.onAccepted
      });
    } catch (error) {
      const tooLarge = error instanceof SafeReadProxyError && error.code === "SAFE_READ_PROXY_REQUEST_SIZE_INVALID";
      result = safeFailure(
        tooLarge ? 413 : 400,
        tooLarge ? "SAFE_READ_PROXY_REQUEST_SIZE_INVALID" : "SAFE_READ_PROXY_REQUEST_INVALID",
        tooLarge ? "SafeRead authorization request size is invalid." : "SafeRead authorization request body is unavailable.",
        false,
        false,
        false
      );
    } finally {
      clearSafeReadProxySecret(body);
    }
    response.statusCode = result.status;
    response.setHeader("Content-Type", result.contentType);
    response.setHeader("Content-Length", `${result.body.length}`);
    response.setHeader("Cache-Control", "no-store");
    response.end(result.body);
  };

  return Object.freeze({
    handle,
    expressHandler,
    dispose() {
      if (!disposed) {
        clearSafeReadProxySecret(retainedSecret);
        for (const buffer of activeRequestBuffers) clearSafeReadProxySecret(buffer);
        activeRequestBuffers.clear();
      }
      disposed = true;
    }
  });
}

async function forwardOnce({ origin, route, requestBytes, accessToken, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.floor(timeoutMs));
  let requestDispatched = false;
  try {
    let pending;
    try {
      pending = fetchImpl(`${origin}${route}`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: requestBytes
      });
      requestDispatched = true;
    } catch (error) {
      return transportFailure(error, false, false);
    }
    const response = await pending;
    if (response.redirected || response.url && response.url !== `${origin}${route}`) {
      try { await response.body?.cancel(); } catch {}
      return transportFailure(new Error("redirected response"), true, true);
    }
    const contentType = response.headers.get("content-type") ?? "";
    let body;
    try { body = await readBoundedResponse(response, SAFE_READ_PROXY_MAX_RESPONSE_BYTES, controller.signal); }
    catch (error) { return transportFailure(error, true, true); }
    return {
      status: response.status,
      contentType,
      body,
      requestDispatched,
      outcomeUnknown: false,
      transportError: null
    };
  } catch (error) {
    const preDispatch = !timedOut && definitelyPreDispatch(error);
    return transportFailure(error, !preDispatch && requestDispatched, !preDispatch && requestDispatched, timedOut);
  } finally {
    clearTimeout(timer);
  }
}

function validateBackendResult(result, route) {
  if (result.transportError) {
    if (result.outcomeUnknown) {
      return safeFailure(
        504,
        result.timedOut ? "SAFE_READ_PROXY_TIMEOUT" : "SAFE_READ_PROXY_OUTCOME_UNKNOWN",
        result.timedOut
          ? "Hosted SafeRead authorization timed out after dispatch; outcome is unknown."
          : "Hosted SafeRead authorization transport ended after dispatch; outcome is unknown.",
        false,
        true,
        true
      );
    }
    return safeFailure(503, "SAFE_READ_PROXY_BACKEND_UNAVAILABLE", "Hosted SafeRead authorization was unreachable before dispatch.", true, false, false);
  }
  if (!isJsonContentType(result.contentType)) {
    clearSafeReadProxySecret(result.body);
    return safeFailure(502, "SAFE_READ_PROXY_RESPONSE_INVALID", "Hosted SafeRead authorization returned an invalid response after dispatch.", false, true, true);
  }
  try {
    const parsed = parseStrictJson(strictUtf8(result.body));
    if (!isExactBackendEnvelope(parsed, route)) throw new Error("unexpected response envelope");
  } catch {
    clearSafeReadProxySecret(result.body);
    return safeFailure(502, "SAFE_READ_PROXY_RESPONSE_INVALID", "Hosted SafeRead authorization returned an invalid response after dispatch.", false, true, true);
  }
  return Object.freeze({
    status: result.status,
    contentType: result.contentType,
    body: result.body
  });
}

function isExactBackendEnvelope(value, route) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.ok !== "boolean") return false;
  if (value.ok === false) {
    if (!hasExactKeys(value, FAILURE_ENVELOPE_KEYS)
      || typeof value.code !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value.code)
      || typeof value.error !== "string" || !/^[^\u0000-\u001F\u007F]{1,512}$/.test(value.error)
      || typeof value.retryable !== "boolean"
      || typeof value.request_dispatched !== "boolean"
      || typeof value.outcome_unknown !== "boolean") return false;
    return value.outcome_unknown !== true || value.request_dispatched === true && value.retryable === false;
  }
  const expected = route === SAFE_READ_PREAUTHORIZE_PATH ? SUCCESS_ENVELOPE_KEYS : FINAL_ENVELOPE_KEYS;
  const field = route === SAFE_READ_PREAUTHORIZE_PATH ? "authorization" : "receipt";
  return hasExactKeys(value, expected) && value[field] && typeof value[field] === "object" && !Array.isArray(value[field]);
}

function safeFailure(status, code, error, retryable, requestDispatched, outcomeUnknown) {
  const normalizedUnknown = outcomeUnknown === true;
  const body = Buffer.from(JSON.stringify({
    ok: false,
    code,
    error,
    retryable: normalizedUnknown ? false : retryable === true,
    request_dispatched: normalizedUnknown ? true : requestDispatched === true,
    outcome_unknown: normalizedUnknown
  }), "utf8");
  return Object.freeze({ status, contentType: "application/json", body });
}

function transportFailure(error, requestDispatched, outcomeUnknown, timedOut = false) {
  return {
    status: 0,
    contentType: "",
    body: Buffer.alloc(0),
    requestDispatched,
    outcomeUnknown,
    transportError: error,
    timedOut
  };
}

async function readBoundedIncomingBody(request, maximumBytes) {
  if (request.readableEnded || request.complete && request.readable === false) {
    throw new SafeReadProxyError("SAFE_READ_PROXY_REQUEST_INVALID", "SafeRead proxy requires untouched raw request bytes.");
  }
  const declared = singleHeaderValue(request.headers?.["content-length"]);
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new SafeReadProxyError("SAFE_READ_PROXY_REQUEST_SIZE_INVALID", "SafeRead proxy request size is invalid.");
  }
  const chunks = [];
  let total = 0;
  let incoming;
  let combined;
  let returning = false;
  try {
    for await (const item of request) {
      incoming = Buffer.isBuffer(item) || item instanceof Uint8Array ? item : null;
      if (!incoming) throw new SafeReadProxyError("SAFE_READ_PROXY_REQUEST_INVALID", "SafeRead proxy request body is unavailable.");
      if (incoming.byteLength > maximumBytes - total) {
        throw new SafeReadProxyError("SAFE_READ_PROXY_REQUEST_SIZE_INVALID", "SafeRead proxy request size is invalid.");
      }
      total += incoming.byteLength;
      const chunk = Buffer.from(incoming);
      chunks.push(chunk);
      clearSafeReadProxySecret(incoming);
      incoming = null;
    }
    if (declared !== undefined && Number(declared) !== total) throw new SafeReadProxyError("SAFE_READ_PROXY_REQUEST_INVALID", "SafeRead proxy request body is incomplete.");
    combined = Buffer.concat(chunks, total);
    returning = true;
    return combined;
  } finally {
    clearSafeReadProxySecret(incoming);
    for (const chunk of chunks) clearSafeReadProxySecret(chunk);
    if (!returning) clearSafeReadProxySecret(combined);
  }
}

async function readBoundedResponse(response, maximumBytes, signal) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    try { await response.body?.cancel(); } catch {}
    throw new Error("response size invalid");
  }
  if (!response.body) throw new Error("response body unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let incoming;
  let combined;
  let returning = false;
  const cancel = () => { try { void reader.cancel(); } catch {} };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        incoming = item.value instanceof Uint8Array ? item.value : null;
        if (!incoming || incoming.byteLength > maximumBytes - total) { cancel(); throw new Error("response size invalid"); }
        total += incoming.byteLength;
        const chunk = Buffer.from(incoming);
        chunks.push(chunk);
        clearSafeReadProxySecret(incoming);
        incoming = null;
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
    if (declared !== null && Number(declared) !== total) throw new Error("response truncated");
    combined = Buffer.concat(chunks, total);
    returning = true;
    return combined;
  } finally {
    clearSafeReadProxySecret(incoming);
    for (const chunk of chunks) clearSafeReadProxySecret(chunk);
    if (!returning) clearSafeReadProxySecret(combined);
  }
}

function requireBackendOrigin(raw) {
  if (typeof raw !== "string" || !raw || raw !== raw.trim()) throw new SafeReadProxyError("SAFE_READ_PROXY_CONFIGURATION_INVALID", "SafeRead hosted backend origin is invalid.");
  let url;
  try { url = new URL(raw); } catch { throw new SafeReadProxyError("SAFE_READ_PROXY_CONFIGURATION_INVALID", "SafeRead hosted backend origin is invalid."); }
  const loopback = url.protocol === "http:" && /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!(url.protocol === "https:" || loopback)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== raw) {
    throw new SafeReadProxyError("SAFE_READ_PROXY_CONFIGURATION_INVALID", "SafeRead hosted backend must be one exact pathless HTTPS origin.");
  }
  return raw;
}

function requireAccessToken(value) {
  if (typeof value !== "string" || value.length < 16 || value.length > 16 * 1024 || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new SafeReadProxyError("SAFE_READ_PROXY_AUTH_UNAVAILABLE", "Hosted SafeRead credential is unavailable.");
  }
  return value;
}

function normalizeHeaders(headers, rawHeaders) {
  const values = new Map();
  const duplicates = new Set();
  if (Array.isArray(rawHeaders) && rawHeaders.length % 2 === 0) {
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const name = `${rawHeaders[index]}`.toLowerCase();
      const value = `${rawHeaders[index + 1]}`;
      if (values.has(name)) duplicates.add(name);
      else values.set(name, value);
    }
  } else if (headers && typeof headers[Symbol.iterator] === "function") {
    for (const [rawName, rawValue] of headers) {
      const name = `${rawName}`.toLowerCase();
      if (values.has(name)) duplicates.add(name);
      else values.set(name, `${rawValue}`);
    }
  } else {
    for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
      const name = rawName.toLowerCase();
      if (Array.isArray(rawValue)) {
        if (rawValue.length !== 1) duplicates.add(name);
        values.set(name, `${rawValue[0] ?? ""}`);
      } else values.set(name, `${rawValue ?? ""}`);
    }
  }
  return { values, duplicates };
}

function isJsonContentType(value) {
  return typeof value === "string" && /^application\/json(?:;\s*charset=utf-8)?$/i.test(value);
}

function singleHeaderValue(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.length === 1 ? `${value[0]}` : "";
  return `${value}`;
}

function strictUtf8(bytes) {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (value.charCodeAt(0) === 0xfeff || hasUnpairedSurrogate(value)) throw new Error("invalid UTF-8");
  return value;
}

function parseStrictJson(raw) {
  let index = 0;
  const skip = () => { while (/[\x20\x09\x0a\x0d]/u.test(raw[index] ?? "")) index += 1; };
  const invalid = () => { throw new Error("invalid JSON"); };
  const readString = () => {
    const start = index;
    if (raw[index++] !== "\"") invalid();
    let escaped = false;
    while (index < raw.length) {
      const character = raw[index++];
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === "\"") {
        const value = JSON.parse(raw.slice(start, index));
        if (typeof value !== "string" || hasUnpairedSurrogate(value) || value !== value.normalize("NFC") || value.includes("\r")) invalid();
        return value;
      }
      if (character.charCodeAt(0) < 0x20) invalid();
    }
    invalid();
  };
  const parseValue = (depth) => {
    if (depth > 32) invalid();
    skip();
    const character = raw[index];
    if (character === "\"") { readString(); return; }
    if (character === "{") {
      index += 1; skip();
      const keys = new Set();
      if (raw[index] === "}") { index += 1; return; }
      while (index < raw.length) {
        skip(); const key = readString();
        if (keys.has(key)) invalid();
        keys.add(key); skip();
        if (raw[index++] !== ":") invalid();
        parseValue(depth + 1); skip();
        if (raw[index] === "}") { index += 1; return; }
        if (raw[index++] !== ",") invalid();
      }
      invalid();
    }
    if (character === "[") {
      index += 1; skip();
      if (raw[index] === "]") { index += 1; return; }
      while (index < raw.length) {
        parseValue(depth + 1); skip();
        if (raw[index] === "]") { index += 1; return; }
        if (raw[index++] !== ",") invalid();
      }
      invalid();
    }
    const start = index;
    while (index < raw.length && !/[\s,\]}]/u.test(raw[index] ?? "")) index += 1;
    if (start === index) invalid();
    const scalar = JSON.parse(raw.slice(start, index));
    if (scalar !== null && typeof scalar !== "boolean" && typeof scalar !== "number") invalid();
  };
  skip(); parseValue(1); skip(); if (index !== raw.length) invalid();
  return JSON.parse(raw);
}

function assertExactObjectKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value, expected)) throw new Error("unexpected request keys");
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function definitelyPreDispatch(error) {
  const known = new Set(["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
  const pending = [error];
  const visited = new Set();
  const codes = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (typeof current.code === "string") codes.push(current.code);
    if (current.cause !== undefined) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  return codes.length > 0 && codes.every((code) => known.has(code));
}

function emitSafeLog(logger, level, message) {
  try {
    if (logger && typeof logger[level] === "function") logger[level](message);
  } catch {}
}
