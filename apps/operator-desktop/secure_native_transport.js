import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const NATIVE_TRANSPORT_VERSION = "revit-operator.native-transport.v1";
export const NATIVE_TRANSPORT_ALGORITHM = "A256CBC-HS512";
export const NATIVE_TRANSPORT_PATH = "/revit/operator-transport/v1";
export const NATIVE_TRANSPORT_CONTENT_TYPE = "application/vnd.revit-operator.native-transport+json";
export const NATIVE_LISTENER_IDENTITY_VERSION = "revit-operator.bridge-listener-identity.v1";

export const NATIVE_TRANSPORT_LIMITS = Object.freeze({
  requestBodyBytes: 2 * 1024 * 1024,
  requestEnvelopeBytes: 8 * 1024 * 1024,
  responseBodyBytes: 16 * 1024 * 1024,
  responseEnvelopeBytes: 48 * 1024 * 1024,
  writeGrantBytes: 16 * 1024,
  receiptBytes: 16 * 1024,
  replayEntries: 4096,
  messageAgeMs: 30_000,
  futureSkewMs: 10_000
});

const RECEIPT_FIELDS = ["version", "algorithm", "transport_path", "url", "server_epoch"];
const LISTENER_IDENTITY_FIELDS = ["version", "url", "server_epoch", "pid", "created_utc"];
const ENVELOPE_FIELDS = ["v", "alg", "epoch", "dir", "iv", "ciphertext", "tag"];
const REQUEST_FIELDS = ["request_id", "request_nonce", "issued_at_unix_ms", "method", "path", "body_present", "body_json", "channel", "alias", "write_grant"];
const RESPONSE_FIELDS = ["request_id", "request_nonce", "issued_at_unix_ms", "status_code", "body_json"];
const REQUEST_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;
const CANONICAL_REVIT_PATH = /^\/revit\/[a-z0-9][a-z0-9._~/-]*$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class NativeTransportError extends Error {
  constructor(code, message, {
    phase = "pre_dispatch",
    requestDispatched = false,
    outcomeUnknown = false,
    retryable = false,
    reconciliationRequired = false,
    cause
  } = {}) {
    super(message, { cause });
    this.name = "NativeTransportError";
    this.code = code;
    this.phase = phase;
    this.request_dispatched = requestDispatched;
    this.outcome_unknown = outcomeUnknown;
    this.retryable = outcomeUnknown ? false : retryable;
    this.reconciliation_required = outcomeUnknown ? true : reconciliationRequired;
  }
}

export function nativeTransportReceiptPath(env = process.env) {
  const localAppData = env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || localAppData.length === 0 || localAppData !== localAppData.trim()) {
    fail("NATIVE_TRANSPORT_DISCOVERY_INVALID", "Certified native Revit transport requires an exact LOCALAPPDATA path.");
  }
  return path.join(localAppData, "RevitOperator", "bridge_transport.v1.json");
}

export function nativeListenerIdentityReceiptPath(env = process.env) {
  const localAppData = env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || localAppData.length === 0 || localAppData !== localAppData.trim()) {
    fail("NATIVE_TRANSPORT_DISCOVERY_INVALID", "Certified Revit listener identity requires an exact LOCALAPPDATA path.");
  }
  return path.join(localAppData, "RevitOperator", "bridge_listener_identity.v1.json");
}
export function readNativeTransportReceipt({ env = process.env, fsApi = fs } = {}) {
  const receiptPath = nativeTransportReceiptPath(env);
  let opened;
  try {
    assertNoReparseTraversal(receiptPath, env.LOCALAPPDATA, fsApi);
    const before = fsApi.lstatSync(receiptPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("not a regular file");
    const flags = fsApi.constants.O_RDONLY | (fsApi.constants.O_NOFOLLOW ?? 0);
    const descriptor = fsApi.openSync(receiptPath, flags);
    try {
      const descriptorBefore = fsApi.fstatSync(descriptor, { bigint: true });
      const bytes = fsApi.readFileSync(descriptor);
      const descriptorAfter = fsApi.fstatSync(descriptor, { bigint: true });
      const after = fsApi.lstatSync(receiptPath, { bigint: true });
      if (!sameFileFacts(before, descriptorBefore)
        || !sameFileFacts(descriptorBefore, descriptorAfter)
        || !sameFileFacts(descriptorAfter, after)) {
        throw new Error("receipt changed while it was read");
      }
      opened = { bytes: Buffer.from(bytes), facts: fileFacts(after) };
    } finally {
      fsApi.closeSync(descriptor);
    }
  } catch (error) {
    throw new NativeTransportError(
      "NATIVE_TRANSPORT_DISCOVERY_UNAVAILABLE",
      "Certified native Revit transport discovery is unavailable or changed during inspection.",
      { cause: error }
    );
  }
  if (opened.bytes.length === 0 || opened.bytes.length > NATIVE_TRANSPORT_LIMITS.receiptBytes) {
    fail("NATIVE_TRANSPORT_DISCOVERY_INVALID", "Certified native Revit transport receipt size is invalid.");
  }
  const raw = decodeUtf8(opened.bytes, "transport receipt", "pre_dispatch");
  const value = parseExactObject(raw, RECEIPT_FIELDS, "transport receipt", "pre_dispatch");
  if (value.version !== NATIVE_TRANSPORT_VERSION
    || value.algorithm !== NATIVE_TRANSPORT_ALGORITHM
    || value.transport_path !== NATIVE_TRANSPORT_PATH
    || typeof value.url !== "string"
    || typeof value.server_epoch !== "string") {
    fail("NATIVE_TRANSPORT_DISCOVERY_INVALID", "Certified native Revit transport receipt is incompatible.");
  }
  const url = requireLoopbackOrigin(value.url);
  const epochBytes = decodeCanonicalBase64Url(value.server_epoch, 32, "server epoch", "pre_dispatch");
  const epoch = encodeBase64Url(epochBytes);
  clearBuffer(epochBytes);
  const identity = Object.freeze({
    content_sha256: crypto.createHash("sha256").update(opened.bytes).digest("hex"),
    ...opened.facts
  });
  return Object.freeze({
    version: NATIVE_TRANSPORT_VERSION,
    algorithm: NATIVE_TRANSPORT_ALGORITHM,
    transport_path: NATIVE_TRANSPORT_PATH,
    url,
    server_epoch: epoch,
    identity
  });
}

export function readNativeListenerIdentityReceipt({ env = process.env, fsApi = fs } = {}) {
  const receiptPath = nativeListenerIdentityReceiptPath(env);
  let opened;
  try {
    assertNoReparseTraversal(receiptPath, env.LOCALAPPDATA, fsApi);
    const before = fsApi.lstatSync(receiptPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("not a regular file");
    const flags = fsApi.constants.O_RDONLY | (fsApi.constants.O_NOFOLLOW ?? 0);
    const descriptor = fsApi.openSync(receiptPath, flags);
    try {
      const descriptorBefore = fsApi.fstatSync(descriptor, { bigint: true });
      const bytes = fsApi.readFileSync(descriptor);
      const descriptorAfter = fsApi.fstatSync(descriptor, { bigint: true });
      const after = fsApi.lstatSync(receiptPath, { bigint: true });
      if (!sameFileFacts(before, descriptorBefore)
        || !sameFileFacts(descriptorBefore, descriptorAfter)
        || !sameFileFacts(descriptorAfter, after)) {
        throw new Error("receipt changed while it was read");
      }
      opened = { bytes: Buffer.from(bytes), facts: fileFacts(after) };
    } finally {
      fsApi.closeSync(descriptor);
    }
  } catch (error) {
    throw new NativeTransportError(
      "NATIVE_TRANSPORT_DISCOVERY_UNAVAILABLE",
      "Certified Revit listener identity discovery is unavailable or changed during inspection.",
      { cause: error }
    );
  }
  if (opened.bytes.length === 0 || opened.bytes.length > NATIVE_TRANSPORT_LIMITS.receiptBytes) {
    fail("NATIVE_TRANSPORT_DISCOVERY_INVALID", "Certified Revit listener identity receipt size is invalid.");
  }
  const raw = decodeUtf8(opened.bytes, "listener identity receipt", "pre_dispatch");
  const value = parseExactObject(raw, LISTENER_IDENTITY_FIELDS, "listener identity receipt", "pre_dispatch");
  if (value.version !== NATIVE_LISTENER_IDENTITY_VERSION
    || typeof value.url !== "string"
    || typeof value.server_epoch !== "string"
    || !Number.isInteger(value.pid)
    || value.pid <= 0
    || value.pid > 0x7fffffff
    || typeof value.created_utc !== "string") {
    fail("NATIVE_TRANSPORT_DISCOVERY_INVALID", "Certified Revit listener identity receipt is incompatible.");
  }
  const url = requireLoopbackOrigin(value.url);
  const epochBytes = decodeCanonicalBase64Url(value.server_epoch, 32, "listener identity server epoch", "pre_dispatch");
  const epoch = encodeBase64Url(epochBytes);
  clearBuffer(epochBytes);
  const createdAt = Date.parse(value.created_utc);
  if (!Number.isFinite(createdAt) || new Date(createdAt).toISOString() !== value.created_utc) {
    fail("NATIVE_TRANSPORT_DISCOVERY_INVALID", "Certified Revit listener identity start time is invalid.");
  }
  return Object.freeze({
    version: NATIVE_LISTENER_IDENTITY_VERSION,
    url,
    server_epoch: epoch,
    pid: value.pid,
    created_utc: value.created_utc,
    identity: Object.freeze({
      content_sha256: crypto.createHash("sha256").update(opened.bytes).digest("hex"),
      ...opened.facts
    })
  });
}
export function sameNativeTransportReceipt(left, right) {
  return !!left && !!right
    && left.version === right.version
    && left.algorithm === right.algorithm
    && left.transport_path === right.transport_path
    && left.url === right.url
    && left.server_epoch === right.server_epoch
    && left.identity?.content_sha256 === right.identity?.content_sha256
    && left.identity?.dev === right.identity?.dev
    && left.identity?.ino === right.identity?.ino
    && left.identity?.size === right.identity?.size
    && left.identity?.mtimeNs === right.identity?.mtimeNs
    && left.identity?.ctimeNs === right.identity?.ctimeNs;
}

export function normalizeNativeListenerSnapshot(value, receipt) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("NATIVE_TRANSPORT_LISTENER_UNTRUSTED", "The certified Revit listener identity is unavailable.");
  }
  const port = Number(new URL(receipt.url).port);
  const snapshot = {
    pid: value.pid,
    port: value.port,
    process_name: `${value.process_name ?? ""}`,
    executable_path: `${value.executable_path ?? ""}`,
    created_utc: `${value.created_utc ?? ""}`,
    owner_sid: `${value.owner_sid ?? ""}`,
    signature_status: `${value.signature_status ?? ""}`,
    signer_subject: `${value.signer_subject ?? ""}`
  };
  if (!Number.isInteger(snapshot.pid) || snapshot.pid < 1 || snapshot.pid > 0x7fffffff
    || snapshot.port !== port
    || snapshot.process_name.toLowerCase() !== "revit.exe"
    || !/^c:\\program files\\autodesk\\revit 20[2-3]\d\\revit\.exe$/i.test(snapshot.executable_path)
    || !Number.isFinite(Date.parse(snapshot.created_utc))
    || new Date(Date.parse(snapshot.created_utc)).toISOString() !== snapshot.created_utc
    || !snapshot.owner_sid
    || snapshot.signature_status !== "Valid"
    || !/Autodesk,\s*Inc\./i.test(snapshot.signer_subject)) {
    fail("NATIVE_TRANSPORT_LISTENER_UNTRUSTED", "The certified Revit listener identity is invalid.");
  }
  return Object.freeze(snapshot);
}

export function sameNativeListenerSnapshot(left, right) {
  return !!left && !!right && Object.keys(left).every((key) => left[key] === right[key]);
}

export function protectNativeTransportRequest({
  operatorToken,
  serverEpoch,
  method,
  path: requestPath,
  bodyJson,
  writeGrant = "",
  channel = "generic_call",
  alias = "revit_call_tool",
  issuedAtUnixMs = Date.now(),
  requestId = crypto.randomBytes(16).toString("hex"),
  requestNonce = crypto.randomBytes(32),
  iv = crypto.randomBytes(16)
}) {
  validateRequest(method, requestPath, bodyJson);
  validateRequestBinding(channel, alias);
  if (!REQUEST_ID.test(requestId)) fail("NATIVE_TRANSPORT_REQUEST_ID_INVALID", "Protected native request identity is invalid.");
  if (!Number.isSafeInteger(issuedAtUnixMs)) fail("NATIVE_TRANSPORT_TIMESTAMP_INVALID", "Protected native request timestamp is invalid.");
  const nonceBytes = requireBytes(requestNonce, 32, "request nonce", "pre_dispatch");
  const ivBytes = requireBytes(iv, 16, "request IV", "pre_dispatch");
  const requestNonceText = encodeBase64Url(nonceBytes);
  let writeGrantBytes;
  let epochBytes;
  let plaintext;
  try {
    writeGrantBytes = encodeUtf8(writeGrant, "protected write grant", "pre_dispatch");
    if (writeGrantBytes.length > NATIVE_TRANSPORT_LIMITS.writeGrantBytes) {
      fail("NATIVE_TRANSPORT_WRITE_GRANT_SIZE_INVALID", "Protected native write grant exceeds its limit.");
    }
    const inner = JSON.stringify({
      request_id: requestId,
      request_nonce: requestNonceText,
      issued_at_unix_ms: issuedAtUnixMs,
      method,
      path: requestPath,
      body_present: method === "POST",
      body_json: bodyJson ?? "",
      channel,
      alias,
      write_grant: writeGrant
    });
    epochBytes = decodeCanonicalBase64Url(serverEpoch, 32, "server epoch", "pre_dispatch");
    const epoch = encodeBase64Url(epochBytes);
    plaintext = Buffer.from(inner, "utf8");
    const envelopeJson = protect(operatorToken, epoch, "request", plaintext, ivBytes, "pre_dispatch");
    if (Buffer.byteLength(envelopeJson, "utf8") > NATIVE_TRANSPORT_LIMITS.requestEnvelopeBytes) {
      fail("NATIVE_TRANSPORT_ENVELOPE_SIZE_INVALID", "Protected native request envelope exceeds its limit.");
    }
    return Object.freeze({ envelopeJson, requestId, requestNonce: requestNonceText, serverEpoch: epoch });
  } finally {
    clearBuffer(nonceBytes);
    clearBuffer(ivBytes);
    clearBuffer(writeGrantBytes);
    clearBuffer(epochBytes);
    clearBuffer(plaintext);
  }
}

export function openNativeTransportRequest({
  operatorToken,
  serverEpoch,
  envelopeBytes,
  nowUnixMs = Date.now(),
  replayCache
}) {
  const bytes = Buffer.from(envelopeBytes);
  if (bytes.length === 0 || bytes.length > NATIVE_TRANSPORT_LIMITS.requestEnvelopeBytes) {
    fail("NATIVE_TRANSPORT_ENVELOPE_SIZE_INVALID", "Protected native request envelope size is invalid.");
  }
  let plaintext;
  try {
    plaintext = open(operatorToken, serverEpoch, "request", bytes, "pre_dispatch");
    const inner = parseExactObject(decodeUtf8(plaintext, "protected native request", "pre_dispatch"), REQUEST_FIELDS, "protected native request", "pre_dispatch");
    if (!REQUEST_ID.test(inner.request_id)
      || typeof inner.request_nonce !== "string"
      || !Number.isSafeInteger(inner.issued_at_unix_ms)
      || typeof inner.method !== "string"
      || typeof inner.path !== "string"
      || typeof inner.body_present !== "boolean"
      || typeof inner.body_json !== "string"
      || typeof inner.channel !== "string"
      || typeof inner.alias !== "string"
      || typeof inner.write_grant !== "string") {
      fail("NATIVE_TRANSPORT_REQUEST_INVALID", "Protected native request fields are invalid.");
    }
    const requestNonceBytes = decodeCanonicalBase64Url(inner.request_nonce, 32, "request nonce", "pre_dispatch");
    clearBuffer(requestNonceBytes);
    if (inner.issued_at_unix_ms > nowUnixMs + NATIVE_TRANSPORT_LIMITS.futureSkewMs
      || inner.issued_at_unix_ms < nowUnixMs - NATIVE_TRANSPORT_LIMITS.messageAgeMs) {
      fail("NATIVE_TRANSPORT_REQUEST_EXPIRED", "Protected native request timestamp is outside the accepted window.");
    }
    validateRequest(inner.method, inner.path, inner.body_present ? inner.body_json : undefined);
    validateRequestBinding(inner.channel, inner.alias);
    if (inner.body_present !== (inner.method === "POST")
      || (!inner.body_present && inner.body_json !== "")
      || Buffer.byteLength(inner.write_grant, "utf8") > NATIVE_TRANSPORT_LIMITS.writeGrantBytes) {
      fail("NATIVE_TRANSPORT_REQUEST_INVALID", "Protected native request body binding is invalid.");
    }
    replayCache?.consume(`${serverEpoch}:${inner.request_id}:${inner.request_nonce}`, nowUnixMs);
    return Object.freeze({
      requestId: inner.request_id,
      requestNonce: inner.request_nonce,
      serverEpoch,
      issuedAtUnixMs: inner.issued_at_unix_ms,
      method: inner.method,
      path: inner.path,
      bodyJson: inner.body_present ? inner.body_json : undefined,
      channel: inner.channel,
      alias: inner.alias,
      writeGrant: inner.write_grant
    });
  } finally {
    clearBuffer(plaintext);
  }
}

export function protectNativeTransportResponse({
  operatorToken,
  request,
  statusCode,
  bodyJson,
  issuedAtUnixMs = Date.now(),
  iv = crypto.randomBytes(16)
}) {
  let bodyBytes;
  let ivBytes;
  let plaintext;
  try {
    if (typeof bodyJson !== "string") {
      fail("NATIVE_TRANSPORT_RESPONSE_INVALID", "Protected native response fields are invalid.", "response");
    }
    bodyBytes = encodeUtf8(bodyJson, "protected native response body", "response");
    if (!Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 599
      || bodyBytes.length > NATIVE_TRANSPORT_LIMITS.responseBodyBytes
      || !Number.isSafeInteger(issuedAtUnixMs)) {
      fail("NATIVE_TRANSPORT_RESPONSE_INVALID", "Protected native response fields are invalid.", "response");
    }
    const inner = JSON.stringify({
      request_id: request.requestId,
      request_nonce: request.requestNonce,
      issued_at_unix_ms: issuedAtUnixMs,
      status_code: statusCode,
      body_json: bodyJson
    });
    plaintext = Buffer.from(inner, "utf8");
    ivBytes = requireBytes(iv, 16, "response IV", "response");
    return protect(operatorToken, request.serverEpoch, "response", plaintext, ivBytes, "response");
  } finally {
    clearBuffer(bodyBytes);
    clearBuffer(ivBytes);
    clearBuffer(plaintext);
  }
}

export function openNativeTransportResponse({ operatorToken, request, envelopeBytes, nowUnixMs = Date.now() }) {
  const bytes = Buffer.from(envelopeBytes);
  if (bytes.length === 0 || bytes.length > NATIVE_TRANSPORT_LIMITS.responseEnvelopeBytes) {
    fail("NATIVE_TRANSPORT_RESPONSE_SIZE_INVALID", "Protected native response envelope size is invalid.", "response");
  }
  let plaintext;
  let bodyBytes;
  try {
    plaintext = open(operatorToken, request.serverEpoch, "response", bytes, "response");
    const inner = parseExactObject(decodeUtf8(plaintext, "protected native response", "response"), RESPONSE_FIELDS, "protected native response", "response");
    if (inner.request_id !== request.requestId || inner.request_nonce !== request.requestNonce) {
      fail("NATIVE_TRANSPORT_RESPONSE_BINDING_INVALID", "Protected native response does not bind the exact request.", "response");
    }
    if (!Number.isSafeInteger(inner.issued_at_unix_ms)
      || inner.issued_at_unix_ms > nowUnixMs + NATIVE_TRANSPORT_LIMITS.futureSkewMs
      || inner.issued_at_unix_ms < nowUnixMs - NATIVE_TRANSPORT_LIMITS.messageAgeMs) {
      fail("NATIVE_TRANSPORT_RESPONSE_EXPIRED", "Protected native response timestamp is outside the accepted window.", "response");
    }
    if (!Number.isSafeInteger(inner.status_code) || inner.status_code < 100 || inner.status_code > 599
      || typeof inner.body_json !== "string") {
      fail("NATIVE_TRANSPORT_RESPONSE_INVALID", "Protected native response fields are invalid.", "response");
    }
    bodyBytes = encodeUtf8(inner.body_json, "protected native response body", "response");
    if (bodyBytes.length > NATIVE_TRANSPORT_LIMITS.responseBodyBytes) {
      fail("NATIVE_TRANSPORT_RESPONSE_INVALID", "Protected native response fields are invalid.", "response");
    }
    return Object.freeze({ statusCode: inner.status_code, bodyJson: inner.body_json });
  } finally {
    clearBuffer(bodyBytes);
    clearBuffer(plaintext);
  }
}

export class NativeTransportReplayCache {
  #entries = new Map();

  consume(key, nowUnixMs = Date.now()) {
    for (const [candidate, expires] of this.#entries) if (expires < nowUnixMs) this.#entries.delete(candidate);
    if (this.#entries.has(key)) fail("NATIVE_TRANSPORT_REQUEST_REPLAY", "Protected native request was already consumed.");
    if (this.#entries.size >= NATIVE_TRANSPORT_LIMITS.replayEntries) {
      throw new NativeTransportError(
        "NATIVE_TRANSPORT_REPLAY_CACHE_FULL",
        "Protected native request replay cache is full; retry with a fresh request.",
        { retryable: true }
      );
    }
    // The public Revit receiver reserves a nonce through the inclusive freshness
    // boundary, then releases it on the first later clock tick.
    this.#entries.set(key, nowUnixMs + NATIVE_TRANSPORT_LIMITS.messageAgeMs + NATIVE_TRANSPORT_LIMITS.futureSkewMs);
  }
}

export async function callNativeTransport({
  operatorToken,
  method,
  path: requestPath,
  bodyJson,
  writeGrant = "",
  timeoutMs = 120_000,
  signal,
  channel = "generic_call",
  alias = "revit_call_tool",
  requestId,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  inspectListener,
  readReceipt = () => readNativeTransportReceipt({ env }),
  preverifiedReceipt,
  preverifiedListener
}) {
  if (typeof fetchImpl !== "function" || typeof inspectListener !== "function") {
    fail("NATIVE_TRANSPORT_CONFIGURATION_INVALID", "Certified native transport requires fixed discovery and listener inspection.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    fail("NATIVE_TRANSPORT_CONFIGURATION_INVALID", "Certified native transport timeout is invalid.");
  }
  if (signal?.aborted) fail("NATIVE_TRANSPORT_ABORTED", "Certified native transport was cancelled before dispatch.");

  let selectedReceipt;
  let selectedListener;
  let dispatchReceipt;
  let dispatchListener;
  try {
    if ((preverifiedReceipt === undefined) !== (preverifiedListener === undefined)) {
      fail("NATIVE_TRANSPORT_CONFIGURATION_INVALID", "Certified native transport requires a complete preverified listener binding.");
    }
    selectedReceipt = preverifiedReceipt || readReceipt();
    selectedListener = preverifiedListener
      ? normalizeNativeListenerSnapshot(preverifiedListener, selectedReceipt)
      : normalizeNativeListenerSnapshot(await inspectListener(selectedReceipt.url), selectedReceipt);
    dispatchReceipt = readReceipt();
    dispatchListener = normalizeNativeListenerSnapshot(await inspectListener(dispatchReceipt.url), dispatchReceipt);
  } catch (error) {
    if (error instanceof NativeTransportError) throw error;
    throw new NativeTransportError(
      "NATIVE_TRANSPORT_LISTENER_UNTRUSTED",
      "The certified Revit listener identity could not be verified before dispatch.",
      { cause: error }
    );
  }
  if (!sameNativeTransportReceipt(selectedReceipt, dispatchReceipt)
    || !sameNativeListenerSnapshot(selectedListener, dispatchListener)) {
    fail("NATIVE_TRANSPORT_DISCOVERY_CHANGED", "Certified native transport discovery changed before dispatch.");
  }
  const request = protectNativeTransportRequest({
    operatorToken,
    serverEpoch: dispatchReceipt.server_epoch,
    method,
    path: requestPath,
    bodyJson,
    channel,
    alias,
    writeGrant,
    requestId
  });

  const deadline = new AbortController();
  let deadlineElapsed = false;
  const timer = setTimeout(() => { deadlineElapsed = true; deadline.abort(); }, Math.floor(timeoutMs));
  const onExternalAbort = () => deadline.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  let requestDispatched = false;
  try {
    let pending;
    if (signal?.aborted) {
      throw new NativeTransportError(
        "NATIVE_TRANSPORT_ABORTED",
        "Certified native transport was cancelled before dispatch."
      );
    }
    try {
      pending = fetchImpl(`${dispatchReceipt.url}${NATIVE_TRANSPORT_PATH}`, {
        method: "POST",
        redirect: "error",
        signal: deadline.signal,
        headers: { "Content-Type": NATIVE_TRANSPORT_CONTENT_TYPE },
        body: request.envelopeJson
      });
      requestDispatched = true;
    } catch (error) {
      throw new NativeTransportError(
        "NATIVE_TRANSPORT_UNAVAILABLE",
        "Certified native transport could not start the fixed request.",
        { retryable: true, cause: error }
      );
    }
    const response = await pending;
    if (response.redirected || response.url && response.url !== `${dispatchReceipt.url}${NATIVE_TRANSPORT_PATH}`) {
      throw new Error("redirected response");
    }
    if (response.status !== 200
      || (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim() !== NATIVE_TRANSPORT_CONTENT_TYPE) {
      try { await response.body?.cancel(); } catch {}
      throw new Error("unauthenticated outer response");
    }
    const bytes = await readLimitedResponse(response, NATIVE_TRANSPORT_LIMITS.responseEnvelopeBytes, deadline.signal);
    return openNativeTransportResponse({ operatorToken, request, envelopeBytes: bytes });
  } catch (error) {
    if (error instanceof NativeTransportError && !requestDispatched) throw error;
    if (error instanceof NativeTransportError && error.outcome_unknown) throw error;
    throw new NativeTransportError(
      deadlineElapsed ? "NATIVE_TRANSPORT_TIMEOUT" : signal?.aborted ? "NATIVE_TRANSPORT_ABORTED" : "NATIVE_TRANSPORT_RESPONSE_INVALID",
      deadlineElapsed
        ? "Certified native transport timed out after dispatch; the Revit outcome is unknown."
        : signal?.aborted
          ? "Certified native transport was interrupted after dispatch; the Revit outcome is unknown."
          : "Certified native transport response was unavailable or invalid after dispatch; the Revit outcome is unknown.",
      {
        phase: "response",
        requestDispatched,
        outcomeUnknown: requestDispatched,
        retryable: !requestDispatched,
        cause: error
      }
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

function validateRequestBinding(channel, alias) {
  if ((channel !== "search" && channel !== "generic_call" && channel !== "typed_mcp")
    || typeof alias !== "string"
    || !/^[a-z][a-z0-9_]*$/.test(alias)
    || Buffer.byteLength(alias, "utf8") > 128
    || (channel === "generic_call" && alias !== "revit_call_tool")
    || (channel !== "generic_call" && alias === "revit_call_tool")) {
    fail(
      "NATIVE_TRANSPORT_REQUEST_INVALID",
      "Certified native requests require an exact channel and tool alias binding."
    );
  }
}
function validateRequest(method, requestPath, bodyJson) {
  if (method !== "GET" && method !== "POST") fail("NATIVE_TRANSPORT_REQUEST_INVALID", "Certified native requests require canonical GET or POST.");
  if (typeof requestPath !== "string"
    || !CANONICAL_REVIT_PATH.test(requestPath)
    || requestPath.endsWith("/")
    || requestPath.includes("//")
    || requestPath.split("/").some((segment) => segment === "." || segment === "..")
    || Buffer.byteLength(requestPath, "utf8") > 512) {
    fail("NATIVE_TRANSPORT_REQUEST_INVALID", "Certified native requests require an exact lowercase canonical /revit path.");
  }
  if (method === "GET" && bodyJson !== undefined) fail("NATIVE_TRANSPORT_REQUEST_INVALID", "Certified native GET requests cannot carry a body.");
  if (method === "POST" && bodyJson === undefined) fail("NATIVE_TRANSPORT_REQUEST_INVALID", "Certified native POST requests require a strict JSON body.");
  if (bodyJson !== undefined) {
    let bodyBytes;
    try {
      bodyBytes = encodeUtf8(bodyJson, "protected native request body", "pre_dispatch");
      if (bodyBytes.length > NATIVE_TRANSPORT_LIMITS.requestBodyBytes) {
        fail("NATIVE_TRANSPORT_REQUEST_SIZE_INVALID", "Certified native request body exceeds its limit.");
      }
    } finally {
      clearBuffer(bodyBytes);
    }
    validateStrictRequestJson(bodyJson);
  }
}

function validateStrictRequestJson(raw) {
  // LF-only constrains the JSON source representation. Escaped carriage
  // returns inside decoded domain strings are data, not line endings, and
  // must remain exact across the Sidecar/native boundary.
  if (raw.includes("\r") || raw !== raw.normalize("NFC")) fail("NATIVE_TRANSPORT_REQUEST_JSON_INVALID", "Certified native POST requests require strict NFC JSON using LF-only source bytes with no duplicate keys.");
  parseStrictJson(raw, "protected native request body", "pre_dispatch", true);
}

function protect(token, epoch, direction, plaintext, iv, phase) {
  let keys;
  let cipherHead;
  let cipherTail;
  let ciphertext;
  let tag;
  try {
    keys = deriveKeys(token, epoch, direction, phase);
    const cipher = crypto.createCipheriv("aes-256-cbc", keys.encryptionKey, iv);
    cipherHead = cipher.update(plaintext);
    cipherTail = cipher.final();
    ciphertext = Buffer.concat([cipherHead, cipherTail]);
    tag = computeTag(keys.macKey, epoch, direction, iv, ciphertext);
    return JSON.stringify({
      v: NATIVE_TRANSPORT_VERSION,
      alg: NATIVE_TRANSPORT_ALGORITHM,
      epoch,
      dir: direction,
      iv: encodeBase64Url(iv),
      ciphertext: encodeBase64Url(ciphertext),
      tag: encodeBase64Url(tag)
    });
  } finally {
    clearBuffer(plaintext);
    keys?.clear();
    clearBuffer(cipherHead);
    clearBuffer(cipherTail);
    clearBuffer(ciphertext);
    clearBuffer(tag);
  }
}

function open(token, expectedEpoch, expectedDirection, envelopeBytes, phase) {
  let iv;
  let ciphertext;
  let tag;
  let keys;
  let expectedTag;
  let plainHead;
  let plainTail;
  let plaintext;
  let returning = false;
  try {
    const envelope = parseExactObject(decodeUtf8(envelopeBytes, "protected native envelope", phase), ENVELOPE_FIELDS, "protected native envelope", phase);
    if (envelope.v !== NATIVE_TRANSPORT_VERSION
      || envelope.alg !== NATIVE_TRANSPORT_ALGORITHM
      || envelope.epoch !== expectedEpoch
      || envelope.dir !== expectedDirection
      || typeof envelope.iv !== "string"
      || typeof envelope.ciphertext !== "string"
      || typeof envelope.tag !== "string") throw new Error("binding mismatch");
    iv = decodeCanonicalBase64Url(envelope.iv, 16, "IV", phase);
    ciphertext = decodeCanonicalBase64Url(envelope.ciphertext, undefined, "ciphertext", phase);
    tag = decodeCanonicalBase64Url(envelope.tag, 32, "tag", phase);
    if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) throw new Error("ciphertext length");
    keys = deriveKeys(token, expectedEpoch, expectedDirection, phase);
    expectedTag = computeTag(keys.macKey, expectedEpoch, expectedDirection, iv, ciphertext);
    if (tag.length !== expectedTag.length || !crypto.timingSafeEqual(tag, expectedTag)) throw new Error("tag mismatch");
    const decipher = crypto.createDecipheriv("aes-256-cbc", keys.encryptionKey, iv);
    plainHead = decipher.update(ciphertext);
    plainTail = decipher.final();
    plaintext = Buffer.concat([plainHead, plainTail]);
    returning = true;
    return plaintext;
  } catch (error) {
    if (error instanceof NativeTransportError) throw error;
    throw new NativeTransportError("NATIVE_TRANSPORT_AUTHENTICATION_FAILED", "Protected native transport authentication failed.", { phase, cause: error });
  } finally {
    clearBuffer(iv);
    clearBuffer(ciphertext);
    clearBuffer(tag);
    keys?.clear();
    clearBuffer(expectedTag);
    clearBuffer(plainHead);
    clearBuffer(plainTail);
    if (!returning) clearBuffer(plaintext);
  }
}

function deriveKeys(token, epoch, direction, phase) {
  let tokenBytes;
  let epochBytes;
  let prk;
  let info;
  let counter;
  let expandInput;
  let okm;
  let macKey;
  let encryptionKey;
  let returning = false;
  try {
    tokenBytes = encodeUtf8(token, "operator token", phase);
    if (tokenBytes.length < 32 || tokenBytes.length > 4096) fail("NATIVE_TRANSPORT_TOKEN_INVALID", "Operator token is unavailable or invalid.", phase);
    epochBytes = decodeCanonicalBase64Url(epoch, 32, "server epoch", phase);
    prk = crypto.createHmac("sha512", epochBytes).update(tokenBytes).digest();
    info = Buffer.from(`${NATIVE_TRANSPORT_VERSION}\0${direction}\0${NATIVE_TRANSPORT_ALGORITHM}`, "utf8");
    counter = Buffer.from([1]);
    expandInput = Buffer.concat([info, counter]);
    okm = crypto.createHmac("sha512", prk).update(expandInput).digest();
    macKey = Buffer.alloc(32);
    encryptionKey = Buffer.alloc(32);
    okm.copy(macKey, 0, 0, 32);
    okm.copy(encryptionKey, 0, 32, 64);
    returning = true;
    return {
      macKey,
      encryptionKey,
      clear() {
        clearBuffer(macKey);
        clearBuffer(encryptionKey);
      }
    };
  } finally {
    clearBuffer(tokenBytes);
    clearBuffer(epochBytes);
    clearBuffer(prk);
    clearBuffer(info);
    clearBuffer(counter);
    clearBuffer(expandInput);
    clearBuffer(okm);
    if (!returning) {
      clearBuffer(macKey);
      clearBuffer(encryptionKey);
    }
  }
}

function computeTag(macKey, epoch, direction, iv, ciphertext) {
  let aad;
  let aadBits;
  let macInput;
  let digest;
  let tag;
  let returning = false;
  try {
    aad = Buffer.from(`${NATIVE_TRANSPORT_VERSION}\n${NATIVE_TRANSPORT_ALGORITHM}\n${epoch}\n${direction}\nPOST\n${NATIVE_TRANSPORT_PATH}`, "utf8");
    aadBits = Buffer.alloc(8);
    aadBits.writeBigUInt64BE(BigInt(aad.length) * 8n);
    macInput = Buffer.concat([aad, iv, ciphertext, aadBits]);
    digest = crypto.createHmac("sha512", macKey).update(macInput).digest();
    tag = Buffer.alloc(32);
    digest.copy(tag, 0, 0, 32);
    returning = true;
    return tag;
  } finally {
    clearBuffer(aad);
    clearBuffer(aadBits);
    clearBuffer(macInput);
    clearBuffer(digest);
    if (!returning) clearBuffer(tag);
  }
}

async function readLimitedResponse(response, maximumBytes, signal) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    try { await response.body?.cancel(); } catch {}
    throw new Error("response size");
  }
  if (!response.body) throw new Error("response body unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const cancel = () => { try { void reader.cancel(); } catch {} };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      total += chunk.length;
      if (total > maximumBytes) { cancel(); throw new Error("response size"); }
      chunks.push(chunk);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (declared !== null && Number(declared) !== total) throw new Error("truncated response");
  return Buffer.concat(chunks, total);
}

function parseExactObject(raw, expectedFields, location, phase) {
  const parsed = parseStrictJson(raw, location, phase, false);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("NATIVE_TRANSPORT_JSON_INVALID", `${location} must be an exact JSON object.`, phase);
  const actual = Object.keys(parsed);
  if (actual.length !== expectedFields.length || actual.some((key) => !expectedFields.includes(key))) {
    fail("NATIVE_TRANSPORT_JSON_INVALID", `${location} fields are invalid.`, phase);
  }
  return parsed;
}

function parseStrictJson(raw, location, phase, requireNfcStrings) {
  let index = 0;
  const skip = () => { while (/[\x20\x09\x0a\x0d]/u.test(raw[index] ?? "")) index += 1; };
  const invalid = (cause) => fail("NATIVE_TRANSPORT_JSON_INVALID", `${location} is not strict JSON or contains duplicate fields.`, phase, cause);
  const readString = () => {
    const start = index;
    if (raw[index++] !== "\"") invalid();
    let escaped = false;
    while (index < raw.length) {
      const character = raw[index++];
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === "\"") {
        try {
          const value = JSON.parse(raw.slice(start, index));
          if (typeof value !== "string" || hasUnpairedSurrogate(value)
            || requireNfcStrings && value !== value.normalize("NFC")) invalid();
          return value;
        } catch (error) { invalid(error); }
      }
      if (character.charCodeAt(0) < 0x20) invalid();
    }
    invalid();
  };
  const parseValue = (depth) => {
    if (depth > 64) invalid();
    skip();
    const character = raw[index];
    if (character === "\"") { readString(); return; }
    if (character === "{") {
      index += 1; skip();
      const keys = new Set();
      if (raw[index] === "}") { index += 1; return; }
      while (index < raw.length) {
        skip();
        const key = readString();
        if (keys.has(key)) invalid();
        keys.add(key);
        skip(); if (raw[index++] !== ":") invalid();
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
    try {
      const scalar = JSON.parse(raw.slice(start, index));
      if (scalar !== null && typeof scalar !== "boolean" && typeof scalar !== "number") invalid();
    } catch (error) { invalid(error); }
  };
  try {
    skip(); parseValue(1); skip(); if (index !== raw.length) invalid();
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof NativeTransportError) throw error;
    invalid(error);
  }
}

function requireLoopbackOrigin(raw) {
  if (typeof raw !== "string" || !raw || raw !== raw.trim()) fail("NATIVE_TRANSPORT_DISCOVERY_INVALID", "Certified native transport URL is invalid.");
  let url;
  try { url = new URL(raw); } catch (error) { fail("NATIVE_TRANSPORT_DISCOVERY_INVALID", "Certified native transport URL is invalid.", "pre_dispatch", error); }
  if (url.protocol !== "http:" || url.username || url.password || !url.port || url.pathname !== "/" || url.search || url.hash || url.origin !== raw) {
    fail("NATIVE_TRANSPORT_DISCOVERY_INVALID", "Certified native transport URL must be an exact HTTP loopback origin.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipVersion = net.isIP(host);
  const loopback = host === "localhost"
    || ipVersion === 4 && host.split(".")[0] === "127"
    || ipVersion === 6 && (host === "::1" || /^::ffff:127\./u.test(host));
  if (!loopback) fail("NATIVE_TRANSPORT_DISCOVERY_INVALID", "Certified native transport URL must be loopback-only.");
  return raw;
}

function assertNoReparseTraversal(target, root, fsApi) {
  const fullRoot = path.resolve(root);
  const fullTarget = path.resolve(target);
  const relative = path.relative(fullRoot, fullTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path escaped LOCALAPPDATA");
  let current = fullRoot;
  const rootStat = fsApi.lstatSync(current, { bigint: true });
  if (rootStat.isSymbolicLink() || isWindowsReparse(rootStat)) throw new Error("LOCALAPPDATA is a reparse point");
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = fsApi.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink() || isWindowsReparse(stat)) throw new Error("reparse traversal");
  }
}

function isWindowsReparse(stat) {
  const attributes = Number(stat.fileAttributes ?? 0);
  return (attributes & 0x400) !== 0;
}

function sameFileFacts(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function fileFacts(stat) {
  return Object.freeze({
    dev: `${stat.dev}`,
    ino: `${stat.ino}`,
    size: `${stat.size}`,
    mtimeNs: `${stat.mtimeNs ?? BigInt(Math.trunc(Number(stat.mtimeMs) * 1e6))}`,
    ctimeNs: `${stat.ctimeNs ?? BigInt(Math.trunc(Number(stat.ctimeMs) * 1e6))}`
  });
}

function encodeUtf8(value, location, phase) {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) fail("NATIVE_TRANSPORT_UTF8_INVALID", `${location} is not strict UTF-8.`, phase);
  return Buffer.from(value, "utf8");
}

function decodeUtf8(value, location, phase) {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
    if (decoded.charCodeAt(0) === 0xfeff || hasUnpairedSurrogate(decoded)) throw new Error("non-canonical Unicode");
    return decoded;
  } catch (error) {
    fail("NATIVE_TRANSPORT_UTF8_INVALID", `${location} is not strict UTF-8.`, phase, error);
  }
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

function encodeBase64Url(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError("base64url encoding requires an owned buffer");
  return value.toString("base64url");
}

function decodeCanonicalBase64Url(value, exactBytes, location, phase) {
  if (typeof value !== "string" || !BASE64URL.test(value) || value.includes("=")) fail("NATIVE_TRANSPORT_ENCODING_INVALID", `Protected native ${location} encoding is invalid.`, phase);
  const decoded = Buffer.from(value, "base64url");
  if (exactBytes !== undefined && decoded.length !== exactBytes || encodeBase64Url(decoded) !== value) {
    clearBuffer(decoded);
    fail("NATIVE_TRANSPORT_ENCODING_INVALID", `Protected native ${location} encoding is non-canonical.`, phase);
  }
  return decoded;
}

function requireBytes(value, exactBytes, location, phase) {
  const bytes = Buffer.from(value);
  if (bytes.length !== exactBytes) {
    clearBuffer(bytes);
    fail("NATIVE_TRANSPORT_ENCODING_INVALID", `Protected native ${location} length is invalid.`, phase);
  }
  return bytes;
}

function clearBuffer(value) {
  try {
    if (Buffer.isBuffer(value)) Buffer.prototype.fill.call(value, 0);
    else if (value instanceof Uint8Array) Uint8Array.prototype.fill.call(value, 0);
  } catch {}
}

function fail(code, message, phase = "pre_dispatch", cause) {
  throw new NativeTransportError(code, message, { phase, cause });
}
