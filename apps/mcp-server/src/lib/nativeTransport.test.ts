import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  callNativeTransport,
  NATIVE_TRANSPORT_ALGORITHM,
  NATIVE_TRANSPORT_CONTENT_TYPE,
  NATIVE_TRANSPORT_PATH,
  NATIVE_TRANSPORT_VERSION,
  NativeTransportProtocolError,
  isExactDevelopmentLaboratory,
  openNativeTransportResponse,
  protectNativeTransportRequest,
  readNativeTransportReceipt
} from "./nativeTransport.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const EPOCH = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const REQUEST_ID = "fedcba9876543210fedcba9876543210";
const REQUEST_TIME = 1785345600123;
const RESPONSE_TIME = 1785345600456;
const REQUEST_ENVELOPE = "{\"v\":\"revit-operator.native-transport.v1\",\"alg\":\"A256CBC-HS512\",\"epoch\":\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\",\"dir\":\"request\",\"iv\":\"QEFCQ0RFRkdISUpLTE1OTw\",\"ciphertext\":\"-W4DbKOCrKPoTdu_C_RlTcOB46_wzvZLmTwyt-G9MtdwXRHa_K5YmNUYaSyQE40-TbRQhBilL1OWTfaT9Bnoei9oYhkPOUH4WHVBnDK8gw-MJq0Ugb-XlzUOvoBXTVnplMUawAdKNb39SPpOr1TTBi4SuzUoryj4OQKiK-LywJDwlBRYe5zyLRA02sXXPJixzdoqsm91yK19boib1EHXePWdCcYmRKbTbDNAg5E0NlqsGiHdWTMgg9ZkSKHBxkTNfitSDttCWQyzM4xqWCv6ryxU51iIJ65_31zhMEeuZtXHJ5c3WsqkEN7jSAw4MM8N_4xfPcStHgMSaiBtDWFQixwP6KFcB_CAjxZaHfy-8Ufr0fQ4IiPVXsZwDt4fDOTV4ZIdwj35Rtxcpq-a-dzx6Q\",\"tag\":\"OpENiO5foy5aliWUb8ONQCAlCbd1Mgt0XVt1blb2e6U\"}";
const RESPONSE_ENVELOPE = "{\"v\":\"revit-operator.native-transport.v1\",\"alg\":\"A256CBC-HS512\",\"epoch\":\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\",\"dir\":\"response\",\"iv\":\"YGFiY2RlZmdoaWprbG1ubw\",\"ciphertext\":\"pEM9pnNnjmvYWJnT02ktf4OIzoNFGl_uT1bILY8oUY6eqnDGE4zu78JxJ3-jJIJdTKiP-azhpHsvVhIOFMBOLh9Qsr-cBK6dXMFQBYWXYTH62yp_oGZnq4O9Ec8m-2o2mP0z--f5YkB3xpHLtmp77La0DJn9PgizHml0jYZ1m9yBpbSZjSUCdvxMfcg6zIYZI0KCXAsmZ69jbh3S1N1zKdqscXy0WG3rTHWB3pUoyZWgkDeKF34DyBMaeoB76zG2hVA68O9tLXt4y2OkchJfwn3aiZ1FbsMhalbdG8XY9TUw_807F-xLxhOjL8cKG2SG\",\"tag\":\"drUlfD17QYEhMihSyLNVUvhUuBZEbcKIIMIehfYM5zg\"}";

function sequence(start: number, length: number): Buffer {
  return Buffer.from(Array.from({ length }, (_, index) => start + index));
}

function testKeys(token: string, epoch: string, direction: "request" | "response") {
  const prk = createHmac("sha512", Buffer.from(epoch, "base64url")).update(token, "utf8").digest();
  const info = Buffer.from(`${NATIVE_TRANSPORT_VERSION}\0${direction}\0${NATIVE_TRANSPORT_ALGORITHM}`, "utf8");
  const okm = createHmac("sha512", prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  return { mac: okm.subarray(0, 32), enc: okm.subarray(32, 64) };
}

function testTag(key: Buffer, epoch: string, direction: "request" | "response", iv: Buffer, ciphertext: Buffer): Buffer {
  const aad = Buffer.from(`${NATIVE_TRANSPORT_VERSION}\n${NATIVE_TRANSPORT_ALGORITHM}\n${epoch}\n${direction}\nPOST\n${NATIVE_TRANSPORT_PATH}`, "utf8");
  const bits = Buffer.alloc(8);
  bits.writeBigUInt64BE(BigInt(aad.length) * 8n);
  return createHmac("sha512", key).update(Buffer.concat([aad, iv, ciphertext, bits])).digest().subarray(0, 32);
}

function testProtectedResponse(requestEnvelopeJson: string, statusCode: number, bodyJson: string) {
  const envelope = JSON.parse(requestEnvelopeJson);
  const requestIv = Buffer.from(envelope.iv, "base64url");
  const requestCiphertext = Buffer.from(envelope.ciphertext, "base64url");
  const requestKeys = testKeys(TOKEN, envelope.epoch, "request");
  const requestTag = Buffer.from(envelope.tag, "base64url");
  assert.equal(timingSafeEqual(requestTag, testTag(requestKeys.mac, envelope.epoch, "request", requestIv, requestCiphertext)), true);
  const decipher = createDecipheriv("aes-256-cbc", requestKeys.enc, requestIv);
  const innerRequest = JSON.parse(Buffer.concat([decipher.update(requestCiphertext), decipher.final()]).toString("utf8"));
  const innerResponse = Buffer.from(JSON.stringify({
    request_id: innerRequest.request_id,
    request_nonce: innerRequest.request_nonce,
    issued_at_unix_ms: Date.now(),
    status_code: statusCode,
    body_json: bodyJson
  }), "utf8");
  const responseIv = randomBytes(16);
  const responseKeys = testKeys(TOKEN, envelope.epoch, "response");
  const cipher = createCipheriv("aes-256-cbc", responseKeys.enc, responseIv);
  const responseCiphertext = Buffer.concat([cipher.update(innerResponse), cipher.final()]);
  return {
    innerRequest,
    envelopeJson: JSON.stringify({
      v: NATIVE_TRANSPORT_VERSION,
      alg: NATIVE_TRANSPORT_ALGORITHM,
      epoch: envelope.epoch,
      dir: "response",
      iv: responseIv.toString("base64url"),
      ciphertext: responseCiphertext.toString("base64url"),
      tag: testTag(responseKeys.mac, envelope.epoch, "response", responseIv, responseCiphertext).toString("base64url")
    })
  };
}

function vectorRequest() {
  return protectNativeTransportRequest({
    operatorToken: TOKEN,
    serverEpoch: EPOCH,
    method: "POST",
    path: "/revit/set-parameter",
    bodyJson: "{\"elementId\":42,\"value\":\"AHU-1\"}",
    writeGrant: "grant-v1-test",
    issuedAtUnixMs: REQUEST_TIME,
    requestId: REQUEST_ID,
    requestNonce: sequence(0x20, 32),
    iv: sequence(0x40, 16)
  });
}

function writeReceipt(root: string, url: string, overrides: Record<string, unknown> = {}): void {
  const directory = path.join(root, "RevitOperator");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "bridge_transport.v1.json"), JSON.stringify({
    version: NATIVE_TRANSPORT_VERSION,
    algorithm: NATIVE_TRANSPORT_ALGORITHM,
    transport_path: NATIVE_TRANSPORT_PATH,
    url,
    server_epoch: EPOCH,
    ...overrides
  }), "utf8");
}

async function listen(server: http.Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

test("Node request and response exactly match the executable C# ROSB/1 vector", () => {
  const request = vectorRequest();
  assert.equal(request.envelopeJson, REQUEST_ENVELOPE);
  assert.doesNotMatch(request.envelopeJson, /set-parameter|AHU-1|grant-v1-test|fedcba/);

  const response = openNativeTransportResponse({
    operatorToken: TOKEN,
    request,
    envelopeBytes: Buffer.from(RESPONSE_ENVELOPE, "utf8"),
    nowUnixMs: RESPONSE_TIME
  });
  assert.deepEqual(response, {
    statusCode: 403,
    bodyJson: "{\"ok\":false,\"error\":\"approval required\"}"
  });
});

test("only exact raw development plus laboratory enables legacy transport", () => {
  assert.equal(isExactDevelopmentLaboratory({ REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" }), true);
  for (const env of [
    { REVIT_OPERATOR_MODE: "Development", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" },
    { REVIT_OPERATOR_MODE: "development ", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" },
    { REVIT_OPERATOR_MODE: "development", OPERATOR_TOOL_EXPOSURE_PROFILE: "LABORATORY" },
    { REVIT_OPERATOR_MODE: "local", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" }
  ]) assert.equal(isExactDevelopmentLaboratory(env), false);
});

test("request protection mirrors the native request fence for strict JSON, normalization, depth, and size", () => {
  const protectBody = (bodyJson: string) => protectNativeTransportRequest({
    operatorToken: TOKEN,
    serverEpoch: EPOCH,
    method: "POST",
    path: "/revit/ping",
    bodyJson
  });
  assert.throws(() => protectBody("{\"nested\":{\"a\":1,\"a\":2}}"), NativeTransportProtocolError);
  assert.throws(() => protectBody("{\"value\":\"e\\u0301\"}"), NativeTransportProtocolError);
  assert.throws(() => protectBody("{\"value\":\"line\\rbreak\"}"), NativeTransportProtocolError);
  assert.throws(() => protectBody(`${"[".repeat(64)}0${"]".repeat(64)}`), NativeTransportProtocolError);
  assert.throws(() => protectBody(JSON.stringify("x".repeat(2 * 1024 * 1024))), NativeTransportProtocolError);
});

test("response authentication rejects tamper, reflection, binding mismatch, stale data, plaintext, and oversize", () => {
  const request = vectorRequest();
  const tampered = JSON.parse(RESPONSE_ENVELOPE);
  tampered.tag = `${tampered.tag[0] === "A" ? "B" : "A"}${tampered.tag.slice(1)}`;
  const rejectsResponse = (envelope: Uint8Array, boundRequest = request, nowUnixMs = RESPONSE_TIME) => assert.throws(
    () => openNativeTransportResponse({ operatorToken: TOKEN, request: boundRequest, envelopeBytes: envelope, nowUnixMs }),
    (error: unknown) => error instanceof NativeTransportProtocolError && error.phase === "response"
  );

  rejectsResponse(Buffer.from(JSON.stringify(tampered), "utf8"));
  rejectsResponse(Buffer.from(REQUEST_ENVELOPE, "utf8"));
  rejectsResponse(Buffer.from(RESPONSE_ENVELOPE, "utf8"), { ...request, requestId: "a".repeat(32) });
  rejectsResponse(Buffer.from(RESPONSE_ENVELOPE, "utf8"), { ...request, requestNonce: Buffer.alloc(32, 9).toString("base64url") });
  rejectsResponse(Buffer.from(RESPONSE_ENVELOPE, "utf8"), { ...request, serverEpoch: Buffer.alloc(32, 10).toString("base64url") });
  rejectsResponse(Buffer.from(RESPONSE_ENVELOPE, "utf8"), request, RESPONSE_TIME + 30_001);
  rejectsResponse(Buffer.from("{\"ok\":true}", "utf8"));
  rejectsResponse(Buffer.alloc(48 * 1024 * 1024 + 1));
});

test("receipt discovery requires the exact schema, algorithm, path, canonical epoch, and loopback origin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-transport-receipt-"));
  const env = { LOCALAPPDATA: root } as NodeJS.ProcessEnv;
  writeReceipt(root, "http://127.0.0.1:5000");
  assert.equal(readNativeTransportReceipt(env).url, "http://127.0.0.1:5000");

  for (const overrides of [
    { extra: true },
    { version: "v0" },
    { algorithm: "none" },
    { transport_path: "/revit/ping" },
    { url: "http://example.com:5000" },
    { url: "http://127.0.0.1:5000/path" },
    { server_epoch: `${EPOCH}=` }
  ]) {
    writeReceipt(root, "http://127.0.0.1:5000", overrides);
    assert.throws(() => readNativeTransportReceipt(env), NativeTransportProtocolError);
  }
});

test("protected call uses only the fixed outer route and content type with no raw credentials", async () => {
  let observed: { url?: string; method?: string; headers?: http.IncomingHttpHeaders; body?: string } = {};
  let openedRequest: Record<string, unknown> | undefined;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const protectedRequestBody = Buffer.concat(chunks).toString("utf8");
      observed = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: protectedRequestBody
      };
      const protectedResponse = testProtectedResponse(protectedRequestBody, 403, "{\"ok\":false,\"error\":\"approval required\"}");
      openedRequest = protectedResponse.innerRequest;
      response.statusCode = 200;
      response.setHeader("content-type", NATIVE_TRANSPORT_CONTENT_TYPE);
      response.end(protectedResponse.envelopeJson);
    });
  });
  const port = await listen(server);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-transport-call-"));
  writeReceipt(root, `http://127.0.0.1:${port}`);
  try {
    const result = await callNativeTransport({
      operatorToken: TOKEN,
      method: "POST",
      path: "/revit/set-parameter",
      bodyJson: "{\"elementId\":42,\"value\":\"AHU-1\"}",
      writeGrant: "grant-v1-test",
      env: { LOCALAPPDATA: root }
    });
    assert.equal(result.statusCode, 403);
    assert.equal(observed.url, NATIVE_TRANSPORT_PATH);
    assert.equal(observed.method, "POST");
    assert.equal(observed.headers?.["content-type"], NATIVE_TRANSPORT_CONTENT_TYPE);
    assert.equal(observed.headers?.["x-operator-token"], undefined);
    assert.equal(observed.headers?.["x-operator-correlation-id"], undefined);
    assert.equal(observed.headers?.["x-operator-write-grant"], undefined);
    assert.doesNotMatch(observed.body ?? "", /set-parameter|AHU-1|grant-v1-test/);
    assert.equal(openedRequest?.method, "POST");
    assert.equal(openedRequest?.path, "/revit/set-parameter");
    assert.equal(openedRequest?.body_json, "{\"elementId\":42,\"value\":\"AHU-1\"}");
    assert.equal(openedRequest?.write_grant, "grant-v1-test");
  } finally {
    await close(server);
  }
});

test("protected call rejects a plaintext or hostile outer response before interpreting it", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end("{\"ok\":true,\"token\":\"attacker\"}");
  });
  const port = await listen(server);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-transport-hostile-"));
  writeReceipt(root, `http://127.0.0.1:${port}`);
  try {
    await assert.rejects(
      callNativeTransport({ operatorToken: TOKEN, method: "GET", path: "/revit/ping", env: { LOCALAPPDATA: root } }),
      (error: unknown) => error instanceof NativeTransportProtocolError && error.phase === "response"
    );
  } finally {
    await close(server);
  }
});
