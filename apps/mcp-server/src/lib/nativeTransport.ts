import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  assertIssuedFamilyEnvelopeForDispatch,
  type FamilyCertificationEnvelope
} from "./certifiedExecutionEnvelope.js";

export const NATIVE_TRANSPORT_VERSION = "revit-operator.native-transport.v1";
export const NATIVE_TRANSPORT_ALGORITHM = "A256CBC-HS512";
export const NATIVE_TRANSPORT_PATH = "/revit/operator-transport/v1";
export const NATIVE_TRANSPORT_CONTENT_TYPE = "application/vnd.revit-operator.native-transport+json";

const MAXIMUM_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const MAXIMUM_REQUEST_ENVELOPE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
const MAXIMUM_RESPONSE_ENVELOPE_BYTES = 48 * 1024 * 1024;
const MAXIMUM_MESSAGE_AGE_MS = 30_000;
const MAXIMUM_FUTURE_SKEW_MS = 10_000;
const MAXIMUM_RECEIPT_BYTES = 16 * 1024;
const REQUEST_ID = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;
const CANONICAL_REVIT_PATH = /^\/revit\/[a-z0-9][a-z0-9._~/-]*$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const RECEIPT_FIELDS = ["version", "algorithm", "transport_path", "url", "server_epoch"] as const;
const ENVELOPE_FIELDS = ["v", "alg", "epoch", "dir", "iv", "ciphertext", "tag"] as const;
const RESPONSE_FIELDS = ["request_id", "request_nonce", "issued_at_unix_ms", "status_code", "body_json"] as const;

type NativeTransportReceipt = Readonly<{
  version: typeof NATIVE_TRANSPORT_VERSION;
  algorithm: typeof NATIVE_TRANSPORT_ALGORITHM;
  transport_path: typeof NATIVE_TRANSPORT_PATH;
  url: string;
  server_epoch: string;
}>;

type ProtectedRequest = Readonly<{
  envelopeJson: string;
  requestId: string;
  requestNonce: string;
  serverEpoch: string;
}>;

export type NativeTransportResult = Readonly<{
  statusCode: number;
  bodyJson: string;
  /** Locally generated identity authenticated by the protected response. */
  requestId: string;
  receiptPath: string;
  receiptSha256: string;
}>;

export class NativeTransportProtocolError extends Error {
  readonly phase: "pre_dispatch" | "response";
  readonly requestId?: string;

  constructor(message: string, phase: "pre_dispatch" | "response", cause?: unknown, requestId?: string) {
    super(message, { cause });
    this.name = "NativeTransportProtocolError";
    this.phase = phase;
    this.requestId = requestId;
  }
}

export function isExactDevelopmentLaboratory(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REVIT_OPERATOR_MODE === "development"
    && env.OPERATOR_TOOL_EXPOSURE_PROFILE === "laboratory";
}

export function nativeTransportReceiptPath(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || localAppData.length === 0 || localAppData !== localAppData.trim()) {
    throw new NativeTransportProtocolError(
      "Certified native Revit transport requires an exact LOCALAPPDATA path for discovery.",
      "pre_dispatch"
    );
  }
  return path.join(localAppData, "RevitOperator", "bridge_transport.v1.json");
}

function readNativeTransportReceiptSnapshot(env: NodeJS.ProcessEnv): Readonly<{ receipt: NativeTransportReceipt; path: string; raw: string }> {
  const receiptPath = nativeTransportReceiptPath(env);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(receiptPath);
  } catch (error) {
    throw new NativeTransportProtocolError(
      `Certified native Revit transport receipt is unavailable at ${receiptPath}.`,
      "pre_dispatch",
      error
    );
  }
  if (bytes.length === 0 || bytes.length > MAXIMUM_RECEIPT_BYTES) {
    throw new NativeTransportProtocolError("Certified native Revit transport receipt size is invalid.", "pre_dispatch");
  }

  const raw = decodeUtf8(bytes, "transport receipt", "pre_dispatch");
  const receipt = parseExactObject(raw, RECEIPT_FIELDS, "transport receipt", "pre_dispatch");
  if (receipt.version !== NATIVE_TRANSPORT_VERSION
    || receipt.algorithm !== NATIVE_TRANSPORT_ALGORITHM
    || receipt.transport_path !== NATIVE_TRANSPORT_PATH
    || typeof receipt.url !== "string"
    || typeof receipt.server_epoch !== "string") {
    throw new NativeTransportProtocolError("Certified native Revit transport receipt is incompatible.", "pre_dispatch");
  }
  requireLoopbackOrigin(receipt.url);
  decodeCanonicalBase64Url(receipt.server_epoch, 32, "server epoch", "pre_dispatch");
  return Object.freeze({ receipt: receipt as NativeTransportReceipt, path: receiptPath, raw });
}

export function readNativeTransportReceipt(env: NodeJS.ProcessEnv = process.env): NativeTransportReceipt {
  return readNativeTransportReceiptSnapshot(env).receipt;
}

export function protectNativeTransportRequest(input: {
  operatorToken: string;
  serverEpoch: string;
  method: string;
  path: string;
  bodyJson?: string;
  writeGrant?: string;
  channel?: "search" | "generic_call" | "typed_mcp";
  alias?: string;
  certificationEnvelope?: FamilyCertificationEnvelope;
  issuedAtUnixMs?: number;
  requestId?: string;
  requestNonce?: Buffer;
  iv?: Buffer;
}): ProtectedRequest {
  const method = input.method;
  validateRequest(method, input.path, input.bodyJson);
  const requestId = input.requestId ?? crypto.randomBytes(16).toString("hex");
  if (!REQUEST_ID.test(requestId)) {
    throw new NativeTransportProtocolError("Protected native request_id is invalid.", "pre_dispatch");
  }
  const nonceBytes = requireBytes(input.requestNonce ?? crypto.randomBytes(32), 32, "request nonce", "pre_dispatch");
  const iv = requireBytes(input.iv ?? crypto.randomBytes(16), 16, "request IV", "pre_dispatch");
  const requestNonce = encodeBase64Url(nonceBytes);
  const issuedAtUnixMs = input.issuedAtUnixMs ?? Date.now();
  if (!Number.isSafeInteger(issuedAtUnixMs)) {
    throw new NativeTransportProtocolError("Protected native request timestamp is invalid.", "pre_dispatch");
  }
  const writeGrant = input.writeGrant ?? "";
  const writeGrantBytes = encodeUtf8(writeGrant, "protected write grant", "pre_dispatch");
  if (writeGrantBytes.length > 16 * 1024) {
    throw new NativeTransportProtocolError("Protected native write grant exceeds its limit.", "pre_dispatch");
  }
  const channel = input.channel ?? "generic_call";
  const alias = input.alias ?? "revit_call_tool";
  if ((channel !== "search" && channel !== "generic_call" && channel !== "typed_mcp")
    || !/^[a-z][a-z0-9_]*$/.test(alias)
    || (channel === "generic_call" && alias !== "revit_call_tool")
    || (channel !== "generic_call" && alias === "revit_call_tool")) {
    throw new NativeTransportProtocolError("Protected native request channel or alias is invalid.", "pre_dispatch");
  }
  let certificationEnvelope: FamilyCertificationEnvelope | undefined;
  try {
    certificationEnvelope = input.certificationEnvelope
      ? assertIssuedFamilyEnvelopeForDispatch({
        envelope: input.certificationEnvelope,
        method,
        path: input.path,
        bodyJson: input.bodyJson,
        channel,
        alias
      })
      : undefined;
  } catch (error) {
    throw new NativeTransportProtocolError("Protected native request-family admission is invalid.", "pre_dispatch", error);
  }

  const inner = JSON.stringify({
    request_id: requestId,
    request_nonce: requestNonce,
    issued_at_unix_ms: issuedAtUnixMs,
    method,
    path: input.path,
    body_present: method === "POST",
    body_json: input.bodyJson ?? "",
    channel,
    alias,
    ...(certificationEnvelope ? { certification_envelope: certificationEnvelope } : {}),
    write_grant: writeGrant
  });
  const epoch = encodeBase64Url(decodeCanonicalBase64Url(input.serverEpoch, 32, "server epoch", "pre_dispatch"));
  const envelopeJson = protect(
    input.operatorToken,
    epoch,
    "request",
    encodeUtf8(inner, "protected native request", "pre_dispatch"),
    iv,
    "pre_dispatch"
  );
  if (Buffer.byteLength(envelopeJson, "utf8") > MAXIMUM_REQUEST_ENVELOPE_BYTES) {
    throw new NativeTransportProtocolError("Protected native request envelope exceeds its limit.", "pre_dispatch");
  }
  return { envelopeJson, requestId, requestNonce, serverEpoch: epoch };
}

export function openNativeTransportResponse(input: {
  operatorToken: string;
  request: ProtectedRequest;
  envelopeBytes: Uint8Array;
  nowUnixMs?: number;
}): Omit<NativeTransportResult, "receiptPath" | "receiptSha256"> {
  const envelopeBytes = Buffer.from(input.envelopeBytes);
  if (envelopeBytes.length === 0 || envelopeBytes.length > MAXIMUM_RESPONSE_ENVELOPE_BYTES) {
    throw new NativeTransportProtocolError("Protected native response envelope size is invalid.", "response");
  }
  const plaintext = open(
    input.operatorToken,
    input.request.serverEpoch,
    "response",
    envelopeBytes,
    "response"
  );
  const innerRaw = decodeUtf8(plaintext, "protected native response", "response");
  const inner = parseExactObject(innerRaw, RESPONSE_FIELDS, "protected native response", "response");
  if (inner.request_id !== input.request.requestId || inner.request_nonce !== input.request.requestNonce) {
    throw new NativeTransportProtocolError("Protected native response does not bind the exact request.", "response");
  }
  if (!Number.isSafeInteger(inner.issued_at_unix_ms)) {
    throw new NativeTransportProtocolError("Protected native response timestamp is invalid.", "response");
  }
  const now = input.nowUnixMs ?? Date.now();
  if (!Number.isSafeInteger(now)
    || inner.issued_at_unix_ms > now + MAXIMUM_FUTURE_SKEW_MS
    || inner.issued_at_unix_ms < now - MAXIMUM_MESSAGE_AGE_MS) {
    throw new NativeTransportProtocolError("Protected native response timestamp is outside the accepted window.", "response");
  }
  if (!Number.isSafeInteger(inner.status_code) || inner.status_code < 100 || inner.status_code > 599) {
    throw new NativeTransportProtocolError("Protected native response status is invalid.", "response");
  }
  if (typeof inner.body_json !== "string"
    || encodeUtf8(inner.body_json, "protected native response body", "response").length > MAXIMUM_RESPONSE_BODY_BYTES) {
    throw new NativeTransportProtocolError("Protected native response body exceeds its limit.", "response");
  }
  return { statusCode: inner.status_code, bodyJson: inner.body_json, requestId: input.request.requestId };
}

export async function callNativeTransport(input: {
  operatorToken: string;
  method: string;
  path: string;
  bodyJson?: string;
  writeGrant?: string;
  channel?: "search" | "generic_call" | "typed_mcp";
  alias?: string;
  certificationEnvelope?: FamilyCertificationEnvelope;
  requestId?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): Promise<NativeTransportResult> {
  const environment = input.env ?? process.env;
  const snapshot = readNativeTransportReceiptSnapshot(environment);
  const receiptPath = snapshot.path;
  const receiptRaw = snapshot.raw;
  const receipt = snapshot.receipt;
  const request = protectNativeTransportRequest({
    operatorToken: input.operatorToken,
    serverEpoch: receipt.server_epoch,
    method: input.method,
    path: input.path,
    bodyJson: input.bodyJson,
    writeGrant: input.writeGrant,
    channel: input.channel,
    alias: input.alias,
    certificationEnvelope: input.certificationEnvelope,
    requestId: input.requestId
  });

  let response: Response;
  try {
    response = await fetch(`${receipt.url}${NATIVE_TRANSPORT_PATH}`, {
      method: "POST",
      signal: input.signal,
      headers: { "Content-Type": NATIVE_TRANSPORT_CONTENT_TYPE },
      body: request.envelopeJson
    });
  } catch (error) {
    throw new NativeTransportProtocolError("Protected native transport response was unavailable.", "response", error, request.requestId);
  }
  if (response.status !== 200) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new NativeTransportProtocolError("Protected native transport returned an unauthenticated outer HTTP status.", "response", undefined, request.requestId);
  }
  const responseContentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim();
  if (responseContentType !== NATIVE_TRANSPORT_CONTENT_TYPE) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new NativeTransportProtocolError("Protected native transport returned an unauthenticated content type.", "response", undefined, request.requestId);
  }
  try {
    const bytes = await readLimitedResponse(response, MAXIMUM_RESPONSE_ENVELOPE_BYTES);
    const opened = openNativeTransportResponse({
      operatorToken: input.operatorToken,
      request,
      envelopeBytes: bytes
    });
    return Object.freeze({
      ...opened,
      receiptPath,
      receiptSha256: `sha256:${crypto.createHash("sha256").update(receiptRaw, "utf8").digest("hex")}`
    });
  } catch (error) {
    if (error instanceof NativeTransportProtocolError && error.requestId === request.requestId) throw error;
    throw new NativeTransportProtocolError("Protected native transport response could not be authenticated.", "response", error, request.requestId);
  }
}

function validateRequest(method: string, requestPath: string, bodyJson: string | undefined): void {
  if (method !== "GET" && method !== "POST") {
    throw new NativeTransportProtocolError("Certified native Revit requests require canonical GET or POST.", "pre_dispatch");
  }
  if (!CANONICAL_REVIT_PATH.test(requestPath)
    || requestPath.endsWith("/")
    || requestPath.includes("//")
    || requestPath.split("/").some(segment => segment === "." || segment === "..")
    || encodeUtf8(requestPath, "protected native request path", "pre_dispatch").length > 512) {
    throw new NativeTransportProtocolError("Certified native Revit requests require an exact lowercase canonical /revit path.", "pre_dispatch");
  }
  if (method === "GET" && bodyJson !== undefined) {
    throw new NativeTransportProtocolError("Certified native GET requests cannot carry a body.", "pre_dispatch");
  }
  if (method === "POST" && bodyJson === undefined) {
    throw new NativeTransportProtocolError("Certified native POST requests require a strict JSON body.", "pre_dispatch");
  }
  if (bodyJson !== undefined) {
    const bytes = encodeUtf8(bodyJson, "protected native request body", "pre_dispatch");
    if (bytes.length > MAXIMUM_REQUEST_BODY_BYTES) {
      throw new NativeTransportProtocolError("Certified native Revit request body exceeds the 2 MiB limit.", "pre_dispatch");
    }
    validateStrictRequestJson(bodyJson);
  }
}

function validateStrictRequestJson(raw: string): void {
  let index = 0;
  const skipWhitespace = () => {
    while (raw[index] === " " || raw[index] === "\t" || raw[index] === "\r" || raw[index] === "\n") index += 1;
  };
  const fail = (cause?: unknown): never => {
    throw new NativeTransportProtocolError(
      "Certified native POST requests require strict, NFC, LF-only JSON with depth at most 64 and no duplicate keys.",
      "pre_dispatch",
      cause
    );
  };
  const requireNormalized = (value: string): void => {
    if (value !== value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC")) fail();
  };
  const readString = (): string => {
    const start = index;
    if (raw[index++] !== "\"") fail();
    let escaped = false;
    while (index < raw.length) {
      const character = raw[index++];
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === "\"") {
        try {
          const value = JSON.parse(raw.slice(start, index));
          if (typeof value !== "string") fail();
          requireNormalized(value);
          return value;
        } catch (error) { return fail(error); }
      }
    }
    return fail();
  };
  const parseValue = (depth: number): void => {
    if (depth > 64) fail();
    skipWhitespace();
    const character = raw[index];
    if (character === "\"") { readString(); return; }
    if (character === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (raw[index] === "}") { index += 1; return; }
      while (index < raw.length) {
        skipWhitespace();
        const key = readString();
        const normalizedKey = key.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
        if (keys.has(normalizedKey)) fail();
        keys.add(normalizedKey);
        skipWhitespace();
        if (raw[index++] !== ":") fail();
        parseValue(depth + 1);
        skipWhitespace();
        if (raw[index] === "}") { index += 1; return; }
        if (raw[index++] !== ",") fail();
      }
      fail();
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (raw[index] === "]") { index += 1; return; }
      while (index < raw.length) {
        parseValue(depth + 1);
        skipWhitespace();
        if (raw[index] === "]") { index += 1; return; }
        if (raw[index++] !== ",") fail();
      }
      fail();
    }
    const start = index;
    while (index < raw.length && !/[\s,\]}]/u.test(raw[index] ?? "")) index += 1;
    if (start === index) fail();
    try {
      const scalar = JSON.parse(raw.slice(start, index));
      if (scalar !== null && typeof scalar !== "boolean" && typeof scalar !== "number") fail();
    } catch (error) { fail(error); }
  };

  try {
    skipWhitespace();
    parseValue(1);
    skipWhitespace();
    if (index !== raw.length) fail();
  } catch (error) {
    if (error instanceof NativeTransportProtocolError) throw error;
    fail(error);
  }
}

function protect(
  token: string,
  epoch: string,
  direction: "request" | "response",
  plaintext: Buffer,
  iv: Buffer,
  phase: "pre_dispatch" | "response"
): string {
  const keys = deriveKeys(token, epoch, direction, phase);
  const cipher = crypto.createCipheriv("aes-256-cbc", keys.encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = computeTag(keys.macKey, epoch, direction, iv, ciphertext);
  return JSON.stringify({
    v: NATIVE_TRANSPORT_VERSION,
    alg: NATIVE_TRANSPORT_ALGORITHM,
    epoch,
    dir: direction,
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(ciphertext),
    tag: encodeBase64Url(tag)
  });
}

function open(
  token: string,
  expectedEpoch: string,
  expectedDirection: "request" | "response",
  envelopeBytes: Buffer,
  phase: "pre_dispatch" | "response"
): Buffer {
  try {
    const raw = decodeUtf8(envelopeBytes, "protected native envelope", phase);
    const envelope = parseExactObject(raw, ENVELOPE_FIELDS, "protected native envelope", phase);
    if (envelope.v !== NATIVE_TRANSPORT_VERSION
      || envelope.alg !== NATIVE_TRANSPORT_ALGORITHM
      || envelope.epoch !== expectedEpoch
      || envelope.dir !== expectedDirection
      || typeof envelope.iv !== "string"
      || typeof envelope.ciphertext !== "string"
      || typeof envelope.tag !== "string") {
      throw new Error("envelope binding mismatch");
    }
    const iv = decodeCanonicalBase64Url(envelope.iv, 16, "IV", phase);
    const ciphertext = decodeCanonicalBase64Url(envelope.ciphertext, undefined, "ciphertext", phase);
    const tag = decodeCanonicalBase64Url(envelope.tag, 32, "tag", phase);
    if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) throw new Error("invalid ciphertext length");
    const keys = deriveKeys(token, expectedEpoch, expectedDirection, phase);
    const expectedTag = computeTag(keys.macKey, expectedEpoch, expectedDirection, iv, ciphertext);
    if (tag.length !== expectedTag.length || !crypto.timingSafeEqual(tag, expectedTag)) throw new Error("tag mismatch");
    const decipher = crypto.createDecipheriv("aes-256-cbc", keys.encryptionKey, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    if (error instanceof NativeTransportProtocolError) throw error;
    throw new NativeTransportProtocolError("Protected native transport authentication failed.", phase, error);
  }
}

function deriveKeys(
  token: string,
  epoch: string,
  direction: "request" | "response",
  phase: "pre_dispatch" | "response"
): { macKey: Buffer; encryptionKey: Buffer } {
  const tokenBytes = encodeUtf8(token, "operator token", phase);
  if (tokenBytes.length < 32 || tokenBytes.length > 4096) {
    throw new NativeTransportProtocolError("Operator token is unavailable or too short for protected native transport.", phase);
  }
  const epochBytes = decodeCanonicalBase64Url(epoch, 32, "server epoch", phase);
  const prk = crypto.createHmac("sha512", epochBytes).update(tokenBytes).digest();
  const info = encodeUtf8(`${NATIVE_TRANSPORT_VERSION}\0${direction}\0${NATIVE_TRANSPORT_ALGORITHM}`, "key derivation info", phase);
  const okm = crypto.createHmac("sha512", prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  return { macKey: okm.subarray(0, 32), encryptionKey: okm.subarray(32, 64) };
}

function computeTag(macKey: Buffer, epoch: string, direction: "request" | "response", iv: Buffer, ciphertext: Buffer): Buffer {
  const aad = Buffer.from(
    `${NATIVE_TRANSPORT_VERSION}\n${NATIVE_TRANSPORT_ALGORITHM}\n${epoch}\n${direction}\nPOST\n${NATIVE_TRANSPORT_PATH}`,
    "utf8"
  );
  const aadBits = Buffer.alloc(8);
  aadBits.writeBigUInt64BE(BigInt(aad.length) * 8n);
  return crypto.createHmac("sha512", macKey)
    .update(Buffer.concat([aad, iv, ciphertext, aadBits]))
    .digest()
    .subarray(0, 32);
}

async function readLimitedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw new NativeTransportProtocolError("Protected native response envelope size is invalid.", "response");
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
      if (total > maximumBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new NativeTransportProtocolError("Protected native response envelope size is invalid.", "response");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function requireLoopbackOrigin(raw: string): void {
  if (raw.length === 0 || raw !== raw.trim()) {
    throw new NativeTransportProtocolError("Certified native Revit transport receipt URL is invalid.", "pre_dispatch");
  }
  let url: URL;
  try { url = new URL(raw); } catch (error) {
    throw new NativeTransportProtocolError("Certified native Revit transport receipt URL is invalid.", "pre_dispatch", error);
  }
  if (url.protocol !== "http:"
    || url.username !== ""
    || url.password !== ""
    || url.port === ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || url.origin !== raw) {
    throw new NativeTransportProtocolError("Certified native Revit transport receipt URL must be an exact HTTP loopback origin.", "pre_dispatch");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLocalhost = host === "localhost";
  const ipVersion = net.isIP(host);
  const isIpv4Loopback = ipVersion === 4 && host.split(".")[0] === "127";
  const isIpv4MappedLoopback = /^::ffff:(?:127(?:\.\d{1,3}){3}|7f[0-9a-f]{2}:[0-9a-f]{1,4})$/u.test(host);
  const isIpv6Loopback = ipVersion === 6 && (host === "::1" || isIpv4MappedLoopback);
  if (!isLocalhost && !isIpv4Loopback && !isIpv6Loopback) {
    throw new NativeTransportProtocolError("Certified native Revit transport receipt URL must be loopback-only.", "pre_dispatch");
  }
}

function parseExactObject(
  raw: string,
  expectedFields: readonly string[],
  location: string,
  phase: "pre_dispatch" | "response"
): Record<string, any> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new NativeTransportProtocolError(`${location} is not strict JSON.`, phase, error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NativeTransportProtocolError(`${location} must be an exact JSON object.`, phase);
  }
  const lexicalKeys = topLevelObjectKeys(raw, location, phase);
  if (new Set(lexicalKeys).size !== lexicalKeys.length) {
    throw new NativeTransportProtocolError(`${location} contains duplicate fields.`, phase);
  }
  const actual = Object.keys(parsed as Record<string, unknown>);
  if (actual.length !== expectedFields.length
    || actual.some(key => !expectedFields.includes(key))) {
    throw new NativeTransportProtocolError(`${location} fields are invalid.`, phase);
  }
  return parsed as Record<string, any>;
}

function topLevelObjectKeys(raw: string, location: string, phase: "pre_dispatch" | "response"): string[] {
  const keys: string[] = [];
  let index = 0;
  const skipWhitespace = () => { while (/\s/u.test(raw[index] ?? "")) index += 1; };
  const readString = (): string => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < raw.length) {
      const character = raw[index++];
      if (escaped) { escaped = false; continue; }
      if (character === "\\") { escaped = true; continue; }
      if (character === "\"") return JSON.parse(raw.slice(start, index));
    }
    throw new NativeTransportProtocolError(`${location} contains an unterminated string.`, phase);
  };

  skipWhitespace();
  if (raw[index++] !== "{") throw new NativeTransportProtocolError(`${location} must be an object.`, phase);
  let depth = 1;
  let expectingKey = true;
  while (index < raw.length && depth > 0) {
    skipWhitespace();
    const character = raw[index];
    if (depth === 1 && expectingKey) {
      if (character === "}") { index += 1; depth = 0; break; }
      if (character !== "\"") throw new NativeTransportProtocolError(`${location} has invalid object syntax.`, phase);
      keys.push(readString());
      skipWhitespace();
      if (raw[index++] !== ":") throw new NativeTransportProtocolError(`${location} has invalid object syntax.`, phase);
      expectingKey = false;
      continue;
    }
    if (character === "\"") { readString(); continue; }
    if (character === "{" || character === "[") { depth += 1; index += 1; continue; }
    if (character === "}" || character === "]") { depth -= 1; index += 1; continue; }
    if (depth === 1 && character === ",") { expectingKey = true; index += 1; continue; }
    index += 1;
  }
  return keys;
}

function encodeUtf8(value: string, location: string, phase: "pre_dispatch" | "response"): Buffer {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) {
    throw new NativeTransportProtocolError(`${location} is not strict UTF-8.`, phase);
  }
  return Buffer.from(value, "utf8");
}

function decodeUtf8(value: Uint8Array, location: string, phase: "pre_dispatch" | "response"): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); } catch (error) {
    throw new NativeTransportProtocolError(`${location} is not strict UTF-8.`, phase, error);
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

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeCanonicalBase64Url(
  value: string,
  exactBytes: number | undefined,
  location: string,
  phase: "pre_dispatch" | "response"
): Buffer {
  if (typeof value !== "string" || !BASE64URL.test(value) || value.includes("=")) {
    throw new NativeTransportProtocolError(`Protected native ${location} encoding is invalid.`, phase);
  }
  let decoded: Buffer;
  try { decoded = Buffer.from(value, "base64url"); } catch (error) {
    throw new NativeTransportProtocolError(`Protected native ${location} encoding is invalid.`, phase, error);
  }
  if ((exactBytes !== undefined && decoded.length !== exactBytes) || encodeBase64Url(decoded) !== value) {
    throw new NativeTransportProtocolError(`Protected native ${location} encoding is non-canonical.`, phase);
  }
  return decoded;
}

function requireBytes(
  value: Uint8Array,
  exactBytes: number,
  location: string,
  phase: "pre_dispatch" | "response"
): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.length !== exactBytes) {
    throw new NativeTransportProtocolError(`Protected native ${location} length is invalid.`, phase);
  }
  return bytes;
}
