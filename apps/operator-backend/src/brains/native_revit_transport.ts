import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const NATIVE_TRANSPORT_VERSION = "revit-operator.native-transport.v1";
export const NATIVE_TRANSPORT_ALGORITHM = "A256CBC-HS512";
export const NATIVE_TRANSPORT_PATH = "/revit/operator-transport/v1";
export const NATIVE_TRANSPORT_CONTENT_TYPE = "application/vnd.revit-operator.native-transport+json";

const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_ENVELOPE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_ENVELOPE_BYTES = 48 * 1024 * 1024;
const MAX_MESSAGE_AGE_MS = 30_000;
const MAX_FUTURE_SKEW_MS = 10_000;
const EXACT_RECEIPT_FIELDS = ["version", "algorithm", "transport_path", "url", "server_epoch"];
const EXACT_ENVELOPE_FIELDS = ["v", "alg", "epoch", "dir", "iv", "ciphertext", "tag"];
const EXACT_REQUEST_FIELDS = ["request_id", "request_nonce", "issued_at_unix_ms", "method", "path", "body_present", "body_json", "channel", "alias", "write_grant"];
const EXACT_RESPONSE_FIELDS = ["request_id", "request_nonce", "issued_at_unix_ms", "status_code", "body_json"];
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

type TransportDirection = "request" | "response";

type NativeTransportReceipt = {
  version: string;
  algorithm: string;
  transport_path: string;
  url: string;
  server_epoch: string;
};

type ProtectedRequest = {
  envelopeJson: string;
  requestId: string;
  requestNonce: string;
  serverEpoch: string;
};

export type NativeBridgeTransportOptions = {
  token: string;
  baseUrl?: string;
  writeGrant?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  receiptPath?: string;
};

export type NativeBridgeHttpResult = {
  statusCode: number;
  bodyText: string;
};

type DeterministicProtectOptions = {
  requestId?: string;
  requestNonce?: Buffer;
  iv?: Buffer;
  issuedAtUnixMs?: number;
};

export function isExactDevelopmentLaboratory(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REVIT_OPERATOR_MODE === "development"
    && env.OPERATOR_TOOL_EXPOSURE_PROFILE === "laboratory";
}

export function assertExactDevelopmentLaboratoryNativeTransport(
  env: NodeJS.ProcessEnv = process.env,
  caller = "Raw native Revit transport"
): void {
  if (!isExactDevelopmentLaboratory(env)) {
    throw new Error(`${caller} is available only when REVIT_OPERATOR_MODE=development and OPERATOR_TOOL_EXPOSURE_PROFILE=laboratory exactly.`);
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function strictUtf8(value: string, location: string): Buffer {
  if (hasUnpairedSurrogate(value)) throw new Error(`${location} is not strict UTF-8.`);
  return Buffer.from(value, "utf8");
}

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64url");
}

function base64UrlDecode(value: unknown, exactBytes: number | null, location: string): Buffer {
  if (typeof value !== "string" || !value || value.includes("=") || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error(`Protected native transport ${location} is invalid.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if ((exactBytes !== null && decoded.length !== exactBytes) || base64UrlEncode(decoded) !== value) {
    throw new Error(`Protected native transport ${location} is invalid.`);
  }
  return decoded;
}

function exactObject(value: unknown, fields: readonly string[], location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Protected native transport ${location} is invalid.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== fields.length || actual.some(key => !fields.includes(key))) {
    throw new Error(`Protected native transport ${location} is invalid.`);
  }
  return record;
}

function scanTopLevelKeys(json: string): string[] {
  let index = 0;
  const keys: string[] = [];
  const whitespace = () => { while (/\s/.test(json[index] ?? "")) index += 1; };
  const scanString = (): string => {
    const start = index;
    if (json[index] !== '"') throw new Error("invalid JSON object key");
    index += 1;
    let escaped = false;
    while (index < json.length) {
      const char = json[index++];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') return JSON.parse(json.slice(start, index)) as string;
    }
    throw new Error("unterminated JSON string");
  };
  whitespace();
  if (json[index++] !== "{") throw new Error("JSON root is not an object");
  whitespace();
  if (json[index] === "}") { index += 1; whitespace(); if (index !== json.length) throw new Error("trailing JSON"); return keys; }
  while (index < json.length) {
    whitespace();
    keys.push(scanString());
    whitespace();
    if (json[index++] !== ":") throw new Error("missing JSON colon");
    whitespace();
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; index < json.length; index += 1) {
      const char = json[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        if (char === "}" && depth === 0) break;
        depth -= 1;
        if (depth < 0) throw new Error("invalid JSON nesting");
      } else if (char === "," && depth === 0) break;
    }
    whitespace();
    if (json[index] === ",") { index += 1; continue; }
    if (json[index] === "}") { index += 1; whitespace(); if (index !== json.length) throw new Error("trailing JSON"); return keys; }
    throw new Error("invalid JSON object delimiter");
  }
  throw new Error("unterminated JSON object");
}

function parseExactJsonObject(bytes: Buffer, fields: readonly string[], location: string): Record<string, unknown> {
  try {
    const text = strictUtf8Decoder.decode(bytes);
    const keys = scanTopLevelKeys(text);
    if (keys.length !== fields.length || new Set(keys).size !== keys.length || keys.some(key => !fields.includes(key))) {
      throw new Error("unexpected JSON fields");
    }
    return exactObject(JSON.parse(text) as unknown, fields, location);
  } catch {
    throw new Error(`Protected native transport ${location} is invalid.`);
  }
}

function deriveKeys(token: string, direction: TransportDirection, epoch: Buffer): { mac: Buffer; enc: Buffer } {
  const tokenBytes = strictUtf8(token, "Operator token");
  if (tokenBytes.length < 32 || tokenBytes.length > 4096) {
    throw new Error("Operator token is unavailable or invalid for protected native transport.");
  }
  const prk = createHmac("sha512", epoch).update(tokenBytes).digest();
  const info = Buffer.concat([
    Buffer.from(`${NATIVE_TRANSPORT_VERSION}\0${direction}\0${NATIVE_TRANSPORT_ALGORITHM}`, "utf8"),
    Buffer.from([1])
  ]);
  const okm = createHmac("sha512", prk).update(info).digest();
  return { mac: okm.subarray(0, 32), enc: okm.subarray(32, 64) };
}

function computeTag(macKey: Buffer, epoch: string, direction: TransportDirection, iv: Buffer, ciphertext: Buffer): Buffer {
  const aad = Buffer.from([
    NATIVE_TRANSPORT_VERSION,
    NATIVE_TRANSPORT_ALGORITHM,
    epoch,
    direction,
    "POST",
    NATIVE_TRANSPORT_PATH
  ].join("\n"), "utf8");
  const bitLength = Buffer.alloc(8);
  bitLength.writeBigUInt64BE(BigInt(aad.length) * 8n);
  return createHmac("sha512", macKey)
    .update(Buffer.concat([aad, iv, ciphertext, bitLength]))
    .digest()
    .subarray(0, 32);
}

function protectPlaintext(token: string, epoch: string, direction: TransportDirection, plaintext: Buffer, iv: Buffer): string {
  const epochBytes = base64UrlDecode(epoch, 32, "server epoch");
  if (iv.length !== 16) throw new Error("Protected native transport IV is invalid.");
  const keys = deriveKeys(token, direction, epochBytes);
  const cipher = createCipheriv("aes-256-cbc", keys.enc, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = computeTag(keys.mac, epoch, direction, iv, ciphertext);
  return JSON.stringify({
    v: NATIVE_TRANSPORT_VERSION,
    alg: NATIVE_TRANSPORT_ALGORITHM,
    epoch,
    dir: direction,
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(ciphertext),
    tag: base64UrlEncode(tag)
  });
}

function openPlaintext(token: string, expectedEpoch: string, direction: TransportDirection, envelopeBytes: Buffer): Buffer {
  const envelope = parseExactJsonObject(envelopeBytes, EXACT_ENVELOPE_FIELDS, "envelope");
  if (envelope.v !== NATIVE_TRANSPORT_VERSION || envelope.alg !== NATIVE_TRANSPORT_ALGORITHM
    || envelope.epoch !== expectedEpoch || envelope.dir !== direction) {
    throw new Error("Protected native transport authentication failed.");
  }
  try {
    const epochBytes = base64UrlDecode(expectedEpoch, 32, "server epoch");
    const iv = base64UrlDecode(envelope.iv, 16, "IV");
    const ciphertext = base64UrlDecode(envelope.ciphertext, null, "ciphertext");
    const tag = base64UrlDecode(envelope.tag, 32, "tag");
    if (!ciphertext.length || ciphertext.length % 16 !== 0) throw new Error("invalid ciphertext");
    const keys = deriveKeys(token, direction, epochBytes);
    const expectedTag = computeTag(keys.mac, expectedEpoch, direction, iv, ciphertext);
    if (!timingSafeEqual(expectedTag, tag)) throw new Error("invalid tag");
    const decipher = createDecipheriv("aes-256-cbc", keys.enc, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Protected native transport authentication failed.");
  }
}

function validateRequest(method: "GET" | "POST", pathname: string, body: unknown): { bodyPresent: boolean; bodyJson: string } {
  if (!/^\/revit\/[a-z0-9][a-z0-9._~/-]*$/.test(pathname) || pathname.endsWith("/") || pathname.includes("//")
    || pathname.split("/").some(segment => segment === "." || segment === "..")
    || strictUtf8(pathname, "Native request path").length > 512) {
    throw new Error("Certified native Revit requests require an exact lowercase canonical /revit path.");
  }
  if (method === "GET") {
    if (body !== undefined) throw new Error("Certified native Revit GET requests cannot include a body.");
    return { bodyPresent: false, bodyJson: "" };
  }
  const bodyJson = JSON.stringify(body);
  if (typeof bodyJson !== "string" || strictUtf8(bodyJson, "Native request body").length === 0) {
    throw new Error("Certified native Revit POST requests require a present JSON body.");
  }
  if (Buffer.byteLength(bodyJson, "utf8") > MAX_REQUEST_BODY_BYTES) {
    throw new Error("Certified native Revit request body exceeds the 2 MiB UTF-8 limit.");
  }
  const requireNormalized = (value: unknown, depth = 0): void => {
    if (depth > 64) throw new Error("Native request JSON exceeds the maximum depth.");
    const policyNormalized = (text: string) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
    if (typeof value === "string" && policyNormalized(value) !== value) throw new Error("Native request JSON is not policy-normalized.");
    if (Array.isArray(value)) value.forEach(child => requireNormalized(child, depth + 1));
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (policyNormalized(key) !== key) throw new Error("Native request JSON is not policy-normalized.");
        requireNormalized(child, depth + 1);
      }
    }
  };
  requireNormalized(JSON.parse(bodyJson) as unknown);
  return { bodyPresent: true, bodyJson };
}

function protectRequest(
  token: string,
  epoch: string,
  method: "GET" | "POST",
  pathname: string,
  body: unknown,
  writeGrant: string,
  deterministic: DeterministicProtectOptions = {}
): ProtectedRequest {
  const prepared = validateRequest(method, pathname, body);
  if (strictUtf8(writeGrant, "Native write grant").length > 16 * 1024) {
    throw new Error("Protected native write grant exceeds its limit.");
  }
  const requestId = deterministic.requestId ?? randomBytes(16).toString("hex");
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(requestId)) throw new Error("Protected native request ID is invalid.");
  const nonceBytes = deterministic.requestNonce ?? randomBytes(32);
  if (nonceBytes.length !== 32) throw new Error("Protected native request nonce is invalid.");
  const requestNonce = base64UrlEncode(nonceBytes);
  const inner = strictUtf8(JSON.stringify({
    request_id: requestId,
    request_nonce: requestNonce,
    issued_at_unix_ms: deterministic.issuedAtUnixMs ?? Date.now(),
    method,
    path: pathname,
    body_present: prepared.bodyPresent,
    body_json: prepared.bodyJson,
    channel: "generic_call",
    alias: "revit_call_tool",
    write_grant: writeGrant
  }), "Protected native request");
  const envelopeJson = protectPlaintext(token, epoch, "request", inner, deterministic.iv ?? randomBytes(16));
  if (Buffer.byteLength(envelopeJson, "utf8") > MAX_REQUEST_ENVELOPE_BYTES) {
    throw new Error("Protected native request envelope exceeds its limit.");
  }
  return { envelopeJson, requestId, requestNonce, serverEpoch: epoch };
}

function openResponse(token: string, request: ProtectedRequest, envelopeBytes: Buffer, nowUnixMs = Date.now()): NativeBridgeHttpResult {
  if (!envelopeBytes.length || envelopeBytes.length > MAX_RESPONSE_ENVELOPE_BYTES) {
    throw new Error("Protected native response envelope size is invalid.");
  }
  const plaintext = openPlaintext(token, request.serverEpoch, "response", envelopeBytes);
  const response = parseExactJsonObject(plaintext, EXACT_RESPONSE_FIELDS, "response");
  if (response.request_id !== request.requestId || response.request_nonce !== request.requestNonce) {
    throw new Error("Protected native response does not bind the exact request.");
  }
  const issuedAt = response.issued_at_unix_ms;
  if (!Number.isSafeInteger(issuedAt)
    || (issuedAt as number) > nowUnixMs + MAX_FUTURE_SKEW_MS
    || (issuedAt as number) < nowUnixMs - MAX_MESSAGE_AGE_MS) {
    throw new Error("Protected native response timestamp is outside the accepted window.");
  }
  const statusCode = response.status_code;
  if (!Number.isInteger(statusCode) || (statusCode as number) < 100 || (statusCode as number) > 599) {
    throw new Error("Protected native response status is invalid.");
  }
  if (typeof response.body_json !== "string" || strictUtf8(response.body_json, "Protected native response body").length > MAX_RESPONSE_BODY_BYTES) {
    throw new Error("Protected native response body exceeds its limit.");
  }
  return { statusCode: statusCode as number, bodyText: response.body_json };
}

function defaultReceiptPath(env: NodeJS.ProcessEnv): string {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData || localAppData !== localAppData.trim()) {
    throw new Error("LOCALAPPDATA is unavailable; protected native transport receipt cannot be read.");
  }
  return path.join(localAppData, "RevitOperator", "bridge_transport.v1.json");
}

function isLoopbackReceiptUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const ipKind = net.isIP(hostname);
    const loopback = hostname === "localhost"
      || (ipKind === 4 && hostname.split(".")[0] === "127")
      || (ipKind === 6 && (hostname === "::1" || /^::ffff:(?:127(?:\.\d{1,3}){3}|7f[0-9a-f]{2}:[0-9a-f]{1,4})$/u.test(hostname)));
    return loopback && url.protocol === "http:" && !url.username && !url.password && !!url.port
      && url.pathname === "/" && !url.search && !url.hash && url.origin === raw;
  } catch {
    return false;
  }
}

function readReceipt(receiptPath: string): NativeTransportReceipt {
  const bytes = fs.readFileSync(receiptPath);
  if (!bytes.length || bytes.length > 16 * 1024) throw new Error("Protected native transport receipt size is invalid.");
  let value: Record<string, unknown>;
  try {
    value = parseExactJsonObject(bytes, EXACT_RECEIPT_FIELDS, "receipt");
  } catch {
    throw new Error("Protected native transport receipt is invalid.");
  }
  if (value.version !== NATIVE_TRANSPORT_VERSION || value.algorithm !== NATIVE_TRANSPORT_ALGORITHM
    || value.transport_path !== NATIVE_TRANSPORT_PATH || typeof value.url !== "string" || !isLoopbackReceiptUrl(value.url)
    || typeof value.server_epoch !== "string") {
    throw new Error("Protected native transport receipt is invalid.");
  }
  base64UrlDecode(value.server_epoch, 32, "server epoch");
  return value as NativeTransportReceipt;
}

async function fetchWithOptionalTimeout(url: string, init: RequestInit, options: NativeBridgeTransportOptions): Promise<Response> {
  if (options.timeoutMs === undefined) return await (options.fetchImpl ?? fetch)(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs));
  try {
    return await (options.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedResponse(response: Response): Promise<Buffer> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_RESPONSE_ENVELOPE_BYTES) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw new Error("Protected native response envelope size is invalid.");
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = Buffer.from(item.value);
      total += chunk.length;
      if (total > MAX_RESPONSE_ENVELOPE_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new Error("Protected native response envelope size is invalid.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function sendNativeBridgeRequest(
  method: "GET" | "POST",
  pathname: string,
  body: unknown,
  options: NativeBridgeTransportOptions
): Promise<NativeBridgeHttpResult> {
  const env = options.env ?? process.env;
  if (isExactDevelopmentLaboratory(env)) {
    const headers: Record<string, string> = { "X-Operator-Token": options.token };
    if (options.writeGrant) headers["X-Operator-Write-Grant"] = options.writeGrant;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchWithOptionalTimeout(`${options.baseUrl ?? "http://localhost:5000"}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }, options);
    return { statusCode: response.status, bodyText: await response.text() };
  }

  const token = options.token.trim();
  const receipt = readReceipt(options.receiptPath ?? defaultReceiptPath(env));
  const request = protectRequest(token, receipt.server_epoch, method, pathname, body, options.writeGrant?.trim() ?? "");
  const response = await fetchWithOptionalTimeout(`${receipt.url}${NATIVE_TRANSPORT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": NATIVE_TRANSPORT_CONTENT_TYPE },
    body: request.envelopeJson
  }, options);
  if (response.status !== 200) throw new Error("Protected native transport rejected a plaintext or unauthenticated outer response.");
  const responseContentType = response.headers.get("Content-Type")?.trim() ?? "";
  if (responseContentType !== NATIVE_TRANSPORT_CONTENT_TYPE) {
    throw new Error("Protected native transport response content type is invalid.");
  }
  const responseBytes = await readLimitedResponse(response);
  return openResponse(token, request, responseBytes);
}

export function __testOnlyProtectNativeRequest(
  token: string,
  epoch: string,
  method: "GET" | "POST",
  pathname: string,
  body: unknown,
  writeGrant: string,
  deterministic: DeterministicProtectOptions
): ProtectedRequest {
  return protectRequest(token, epoch, method, pathname, body, writeGrant, deterministic);
}

export function __testOnlyProtectNativeResponse(
  token: string,
  request: ProtectedRequest,
  statusCode: number,
  bodyJson: string,
  issuedAtUnixMs: number,
  iv: Buffer
): string {
  const inner = strictUtf8(JSON.stringify({
    request_id: request.requestId,
    request_nonce: request.requestNonce,
    issued_at_unix_ms: issuedAtUnixMs,
    status_code: statusCode,
    body_json: bodyJson
  }), "Protected native response");
  return protectPlaintext(token, request.serverEpoch, "response", inner, iv);
}

export function __testOnlyOpenNativeRequest(
  token: string,
  epoch: string,
  envelopeJson: string
): { protectedRequest: ProtectedRequest; inner: Record<string, unknown> } {
  const inner = parseExactJsonObject(
    openPlaintext(token, epoch, "request", Buffer.from(envelopeJson, "utf8")),
    EXACT_REQUEST_FIELDS,
    "request"
  );
  if (typeof inner.request_id !== "string" || typeof inner.request_nonce !== "string") {
    throw new Error("Protected native transport request is invalid.");
  }
  return {
    protectedRequest: {
      envelopeJson,
      requestId: inner.request_id,
      requestNonce: inner.request_nonce,
      serverEpoch: epoch
    },
    inner
  };
}

export function __testOnlyOpenNativeResponse(
  token: string,
  request: ProtectedRequest,
  envelopeJson: string,
  nowUnixMs: number
): NativeBridgeHttpResult {
  return openResponse(token, request, Buffer.from(envelopeJson, "utf8"), nowUnixMs);
}
