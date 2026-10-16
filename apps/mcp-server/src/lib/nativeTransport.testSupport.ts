import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {createCipheriv,createDecipheriv,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {NATIVE_TRANSPORT_VERSION,NATIVE_TRANSPORT_ALGORITHM,NATIVE_TRANSPORT_PATH} from './nativeTransport.js';
// Shared test-only protocol fixture: authenticates and decrypts the real request;
// responds with the same protected, request/nonce-bound response protocol.
function nativeKeys(token: string, epoch: string, direction: "request" | "response") {
  const epochBytes = Buffer.from(epoch, "base64url");
  const prk = createHmac("sha512", epochBytes).update(token, "utf8").digest();
  const info = Buffer.from(`${NATIVE_TRANSPORT_VERSION}\0${direction}\0${NATIVE_TRANSPORT_ALGORITHM}`, "utf8");
  const okm = createHmac("sha512", prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  return { mac: okm.subarray(0, 32), enc: okm.subarray(32, 64) };
}

function nativeTag(key: Buffer, epoch: string, direction: "request" | "response", iv: Buffer, ciphertext: Buffer): Buffer {
  const aad = Buffer.from(`${NATIVE_TRANSPORT_VERSION}\n${NATIVE_TRANSPORT_ALGORITHM}\n${epoch}\n${direction}\nPOST\n${NATIVE_TRANSPORT_PATH}`, "utf8");
  const bits = Buffer.alloc(8);
  bits.writeBigUInt64BE(BigInt(aad.length) * 8n);
  return createHmac("sha512", key).update(Buffer.concat([aad, iv, ciphertext, bits])).digest().subarray(0, 32);
}

export function protectedSmokeResponse(requestEnvelopeJson: string, token: string, statusCode: number, bodyJson: string | ((request: Record<string, any>) => string)): string {
  const envelope = JSON.parse(requestEnvelopeJson);
  assert.equal(envelope.v, NATIVE_TRANSPORT_VERSION);
  assert.equal(envelope.alg, NATIVE_TRANSPORT_ALGORITHM);
  assert.equal(envelope.dir, "request");
  const requestIv = Buffer.from(envelope.iv, "base64url");
  const requestCiphertext = Buffer.from(envelope.ciphertext, "base64url");
  const requestKeys = nativeKeys(token, envelope.epoch, "request");
  const requestTag = Buffer.from(envelope.tag, "base64url");
  assert.equal(timingSafeEqual(requestTag, nativeTag(requestKeys.mac, envelope.epoch, "request", requestIv, requestCiphertext)), true);
  const decipher = createDecipheriv("aes-256-cbc", requestKeys.enc, requestIv);
  const request = JSON.parse(Buffer.concat([decipher.update(requestCiphertext), decipher.final()]).toString("utf8"));

  const responseInner = Buffer.from(JSON.stringify({
    request_id: request.request_id,
    request_nonce: request.request_nonce,
    issued_at_unix_ms: Date.now(),
    status_code: statusCode,
    body_json: typeof bodyJson === "function" ? bodyJson(request) : bodyJson
  }), "utf8");
  const responseIv = randomBytes(16);
  const responseKeys = nativeKeys(token, envelope.epoch, "response");
  const cipher = createCipheriv("aes-256-cbc", responseKeys.enc, responseIv);
  const responseCiphertext = Buffer.concat([cipher.update(responseInner), cipher.final()]);
  return JSON.stringify({
    v: NATIVE_TRANSPORT_VERSION,
    alg: NATIVE_TRANSPORT_ALGORITHM,
    epoch: envelope.epoch,
    dir: "response",
    iv: responseIv.toString("base64url"),
    ciphertext: responseCiphertext.toString("base64url"),
    tag: nativeTag(responseKeys.mac, envelope.epoch, "response", responseIv, responseCiphertext).toString("base64url")
  });
}

export function writeNativeReceipt(localAppData: string, url: string, epoch: string): void {
  const directory = path.join(localAppData, "RevitOperator");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "bridge_transport.v1.json"), JSON.stringify({
    version: NATIVE_TRANSPORT_VERSION,
    algorithm: NATIVE_TRANSPORT_ALGORITHM,
    transport_path: NATIVE_TRANSPORT_PATH,
    url,
    server_epoch: epoch
  }), "utf8");
}

