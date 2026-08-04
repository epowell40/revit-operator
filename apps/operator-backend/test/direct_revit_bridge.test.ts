import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DirectBridgeRequestError,
  __testOnlyClearDirectBridgeAvailabilityCache,
  __testOnlyExtractBridgeImageAttachmentPaths,
  __testOnlyRequestBridgeJson,
  canUseDirectBridgeFastPath,
  readAbsoluteImageDataUrl,
  toToolResultFromDirectBridgeResult
} from "../src/brains/direct_revit_bridge.js";
import {
  __testOnlyOpenNativeRequest,
  __testOnlyOpenNativeResponse,
  __testOnlyProtectNativeRequest,
  __testOnlyProtectNativeResponse,
  NATIVE_TRANSPORT_CONTENT_TYPE,
  NATIVE_TRANSPORT_PATH
} from "../src/brains/native_revit_transport.js";

const LAB_ENV = {
  ...process.env,
  REVIT_OPERATOR_MODE: "development",
  OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory"
};
const VECTOR_TOKEN = "0123456789abcdef0123456789abcdef";
const VECTOR_EPOCH = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64url");

test("direct bridge transport forwards auth and JSON body and parses the response", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return new Response(JSON.stringify({ ok: true, count: 2 }), { status: 200 });
  };

  const result = await __testOnlyRequestBridgeJson("POST", "/revit/test", { ids: [1, 2] }, {
    baseUrl: "http://bridge.local:5000",
    token: "test-token",
    timeoutMs: 100,
    fetchImpl,
    env: LAB_ENV
  });

  assert.deepEqual(result, { ok: true, count: 2 });
  assert.equal(seenUrl, "http://bridge.local:5000/revit/test");
  assert.equal(seenInit?.method, "POST");
  assert.equal(new Headers(seenInit?.headers).get("X-Operator-Token"), "test-token");
  assert.equal(new Headers(seenInit?.headers).get("Content-Type"), "application/json");
  assert.equal(new Headers(seenInit?.headers).get("X-Operator-Correlation-Id"), null);
  assert.equal(new Headers(seenInit?.headers).get("X-Operator-Write-Grant"), null);
  assert.equal(seenInit?.body, JSON.stringify({ ids: [1, 2] }));
});

test("direct bridge transport preserves response text for HTTP failures", async () => {
  const fetchImpl: typeof fetch = async () => new Response("bridge unavailable", { status: 503 });

  await assert.rejects(
    __testOnlyRequestBridgeJson("GET", "/revit/context", undefined, {
      baseUrl: "http://bridge.local:5000",
      token: "test-token",
      timeoutMs: 100,
      fetchImpl,
      env: LAB_ENV
    }),
    /bridge unavailable/
  );
});

test("direct bridge transport aborts requests that exceed the configured timeout", async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted by test signal")), { once: true });
    });
  };

  await assert.rejects(
    __testOnlyRequestBridgeJson("GET", "/revit/context", undefined, {
      baseUrl: "http://bridge.local:5000",
      token: "test-token",
      timeoutMs: 10,
      fetchImpl,
      env: LAB_ENV
    }),
    /aborted by test signal/
  );
});

test("direct bridge preserves Revit 408 outcome-unknown as non-retryable", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    ok: false,
    code: "revit_action_deadline_elapsed_outcome_unknown",
    retryable: true,
    outcome_unknown: true
  }), { status: 408 });

  await assert.rejects(
    __testOnlyRequestBridgeJson("POST", "/revit/update-schedule-cell", { value: "new" }, {
      baseUrl: "http://bridge.local:5000",
      token: "test-token",
      timeoutMs: 100,
      fetchImpl,
      env: LAB_ENV
    }),
    (error: unknown) => {
      assert.ok(error instanceof DirectBridgeRequestError);
      assert.equal(error.statusCode, 408);
      assert.equal(error.outcome_unknown, true);
      assert.equal(error.retryable, false);
      assert.equal(error.failure_code, "revit_action_deadline_elapsed_outcome_unknown");
      return true;
    }
  );

  const result = toToolResultFromDirectBridgeResult({
    ok: false,
    method: "POST",
    path: "/revit/update-schedule-cell",
    error: "deadline elapsed",
    retryable: true,
    outcome_unknown: true,
    failure_code: "revit_action_deadline_elapsed_outcome_unknown",
    duration_ms: 12
  });
  assert.equal(result.retryable, false);
  assert.equal(result.outcome_unknown, true);
  assert.equal(result.failure_code, "revit_action_deadline_elapsed_outcome_unknown");
});
test("direct bridge treats a body-only unknown outcome as failed", async () => {
  const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
    ok: false,
    code: "revit_action_deadline_elapsed_outcome_unknown",
    retryable: true,
    outcome_unknown: true
  }), { status: 200 });

  await assert.rejects(
    __testOnlyRequestBridgeJson("POST", "/revit/update-schedule-cell", { value: "new" }, {
      baseUrl: "http://bridge.local:5000",
      token: "test-token",
      timeoutMs: 100,
      fetchImpl,
      env: LAB_ENV
    }),
    (error: unknown) => {
      assert.ok(error instanceof DirectBridgeRequestError);
      assert.equal(error.statusCode, 200);
      assert.equal(error.outcome_unknown, true);
      assert.equal(error.retryable, false);
      return true;
    }
  );
});

test("outcome-unknown direct results are always failed and non-retryable", () => {
  const result = toToolResultFromDirectBridgeResult({
    ok: true,
    action_id: "malformed-unknown",
    method: "POST",
    path: "/revit/update-schedule-cell",
    retryable: true,
    outcome_unknown: true,
    duration_ms: 1
  });
  assert.equal(result.status, "failed");
  assert.equal(result.retryable, false);
  assert.equal(result.outcome_unknown, true);
});
test("direct bridge availability caches successful probes by bridge URL", async () => {
  __testOnlyClearDirectBridgeAvailabilityCache();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ revit: { connected: true } }), { status: 200 });
  };
  const baseUrl = `http://bridge-cache-${Date.now()}.local:5000`;
  const options = { baseUrl, token: "test-token", timeoutMs: 100, fetchImpl, env: LAB_ENV };

  assert.equal(await canUseDirectBridgeFastPath(options), true);
  assert.equal(await canUseDirectBridgeFastPath(options), true);
  assert.equal(calls, 1);
});

test("direct bridge attachment discovery retains export and nested workflow captures", () => {
  assert.deepEqual(
    __testOnlyExtractBridgeImageAttachmentPaths("/revit/export-view-frame", { path: " C:/captures/frame.png " }),
    ["C:/captures/frame.png"]
  );
  assert.deepEqual(
    __testOnlyExtractBridgeImageAttachmentPaths("/revit/mep-route-workflow", {
      visualVerification: {
        capture: { path: "C:/captures/route.jpg" },
        capturePath: "C:/captures/route.jpg"
      }
    }),
    ["C:/captures/route.jpg"]
  );
});

test("direct bridge image reads are type- and size-bounded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "direct-bridge-test-"));
  try {
    const pngPath = path.join(dir, "capture.png");
    const textPath = path.join(dir, "capture.txt");
    const largePath = path.join(dir, "large.jpg");
    fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(textPath, "not an image");
    fs.writeFileSync(largePath, Buffer.alloc(128 * 1024 + 1));

    assert.equal(readAbsoluteImageDataUrl(pngPath), "data:image/png;base64,iVBORw==");
    assert.equal(readAbsoluteImageDataUrl(textPath), null);
    assert.equal(readAbsoluteImageDataUrl(largePath, 128 * 1024), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("direct bridge results normalize to compact tool results", () => {
  const result = toToolResultFromDirectBridgeResult({
    ok: true,
    action_id: "direct-action-test",
    method: "POST",
    path: "/revit/export-image",
    result_json: { path: "C:/captures/view.png" },
    duration_ms: 12,
    attachments: [{ kind: "image", mime: "image/png", filename: "view.png", local_path: "C:/captures/view.png" }]
  });

  assert.equal(result.status, "done");
  assert.equal(result.action_id, "direct-action-test");
  assert.equal(result.path, "/revit/export-image");
  assert.equal(result.duration_ms, 12);
  assert.equal(result.attachments?.[0]?.filename, "view.png");
});

test("ROSB/1 Node request and response match the canonical C# vectors", () => {
  const request = __testOnlyProtectNativeRequest(
    VECTOR_TOKEN,
    VECTOR_EPOCH,
    "POST",
    "/revit/set-parameter",
    { elementId: 42, value: "AHU-1" },
    "grant-v1-test",
    {
      requestId: "fedcba9876543210fedcba9876543210",
      requestNonce: Buffer.from(Array.from({ length: 32 }, (_, index) => 0x20 + index)),
      iv: Buffer.from(Array.from({ length: 16 }, (_, index) => 0x40 + index)),
      issuedAtUnixMs: 1785345600123
    }
  );
  assert.equal(request.envelopeJson, "{\"v\":\"revit-operator.native-transport.v1\",\"alg\":\"A256CBC-HS512\",\"epoch\":\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\",\"dir\":\"request\",\"iv\":\"QEFCQ0RFRkdISUpLTE1OTw\",\"ciphertext\":\"-W4DbKOCrKPoTdu_C_RlTcOB46_wzvZLmTwyt-G9MtdwXRHa_K5YmNUYaSyQE40-TbRQhBilL1OWTfaT9Bnoei9oYhkPOUH4WHVBnDK8gw-MJq0Ugb-XlzUOvoBXTVnplMUawAdKNb39SPpOr1TTBi4SuzUoryj4OQKiK-LywJDwlBRYe5zyLRA02sXXPJixzdoqsm91yK19boib1EHXePWdCcYmRKbTbDNAg5E0NlqsGiHdWTMgg9ZkSKHBxkTNfitSDttCWQyzM4xqWCv6ryxU51iIJ65_31zhMEeuZtXHJ5c3WsqkEN7jSAw4MM8N_4xfPcStHgMSaiBtDWFQi_2uHVgUhsv2zc6Efsou06GPkeMOAnillQUMJ9xLqXCgaAt3HROqMFOF1X1_Owy49PhS1hGWmElOqcYo_wUTXpyh3t-mmOaVghkw6GZ7vZD-bAk1OggasGYWyq3I4rFtSg\",\"tag\":\"8RGpK29AhveBYF5zxYcHWQqVRo2TsAqdvaICDxtS-sM\"}");

  const responseEnvelope = "{\"v\":\"revit-operator.native-transport.v1\",\"alg\":\"A256CBC-HS512\",\"epoch\":\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\",\"dir\":\"response\",\"iv\":\"YGFiY2RlZmdoaWprbG1ubw\",\"ciphertext\":\"pEM9pnNnjmvYWJnT02ktf4OIzoNFGl_uT1bILY8oUY6eqnDGE4zu78JxJ3-jJIJdTKiP-azhpHsvVhIOFMBOLh9Qsr-cBK6dXMFQBYWXYTH62yp_oGZnq4O9Ec8m-2o2mP0z--f5YkB3xpHLtmp77La0DJn9PgizHml0jYZ1m9yBpbSZjSUCdvxMfcg6zIYZI0KCXAsmZ69jbh3S1N1zKdqscXy0WG3rTHWB3pUoyZWgkDeKF34DyBMaeoB76zG2hVA68O9tLXt4y2OkchJfwn3aiZ1FbsMhalbdG8XY9TUw_807F-xLxhOjL8cKG2SG\",\"tag\":\"drUlfD17QYEhMihSyLNVUvhUuBZEbcKIIMIehfYM5zg\"}";
  assert.equal(__testOnlyProtectNativeResponse(
    VECTOR_TOKEN,
    request,
    403,
    "{\"ok\":false,\"error\":\"approval required\"}",
    1785345600456,
    Buffer.from(Array.from({ length: 16 }, (_, index) => 0x60 + index))
  ), responseEnvelope);
  assert.deepEqual(__testOnlyOpenNativeResponse(VECTOR_TOKEN, request, responseEnvelope, 1785345600456), {
    statusCode: 403,
    bodyText: "{\"ok\":false,\"error\":\"approval required\"}"
  });
});

test("secure direct bridge uses only the fixed receipt route and authenticated envelope", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-receipt-test-"));
  const receiptPath = path.join(dir, "bridge_transport.v1.json");
  fs.writeFileSync(receiptPath, JSON.stringify({
    version: "revit-operator.native-transport.v1",
    algorithm: "A256CBC-HS512",
    transport_path: NATIVE_TRANSPORT_PATH,
    url: "http://127.0.0.1:5012",
    server_epoch: VECTOR_EPOCH
  }));
  try {
    let calls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1;
      assert.equal(String(input), `http://127.0.0.1:5012${NATIVE_TRANSPORT_PATH}`);
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Content-Type"), NATIVE_TRANSPORT_CONTENT_TYPE);
      assert.equal(headers.get("X-Operator-Token"), null);
      assert.equal(headers.get("X-Operator-Correlation-Id"), null);
      assert.equal(headers.get("X-Operator-Write-Grant"), null);
      const outer = String(init?.body);
      assert.doesNotMatch(outer, /set-parameter|grant-secret|test-value|fedcba/i);
      const opened = __testOnlyOpenNativeRequest(VECTOR_TOKEN, VECTOR_EPOCH, outer);
      assert.equal(opened.inner.path, "/revit/set-parameter");
      assert.equal(opened.inner.body_json, "{\"value\":\"test-value\"}");
      assert.equal(opened.inner.write_grant, "grant-secret");
      const protectedResponse = __testOnlyProtectNativeResponse(
        VECTOR_TOKEN,
        opened.protectedRequest,
        200,
        "{\"ok\":true}",
        Date.now(),
        Buffer.alloc(16, 0x61)
      );
      return new Response(protectedResponse, { status: 200, headers: { "Content-Type": NATIVE_TRANSPORT_CONTENT_TYPE } });
    };

    const result = await __testOnlyRequestBridgeJson("POST", "/revit/set-parameter", { value: "test-value" }, {
      baseUrl: "http://hostile.example:9999",
      token: VECTOR_TOKEN,
      writeGrant: "grant-secret",
      timeoutMs: 100,
      fetchImpl,
      env: { ...process.env, REVIT_OPERATOR_MODE: "local", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory" },
      receiptPath
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("secure direct bridge rejects tamper, reflection, stale response, and wrong request binding", () => {
  const now = 1785345600456;
  const request = __testOnlyProtectNativeRequest(VECTOR_TOKEN, VECTOR_EPOCH, "POST", "/revit/ping", {}, "", {
    requestId: "fedcba9876543210fedcba9876543210",
    requestNonce: Buffer.alloc(32, 0x20),
    iv: Buffer.alloc(16, 0x40),
    issuedAtUnixMs: now
  });
  const response = __testOnlyProtectNativeResponse(VECTOR_TOKEN, request, 200, "{\"ok\":true}", now, Buffer.alloc(16, 0x60));
  const parsed = JSON.parse(response) as Record<string, string>;
  parsed.tag = `${parsed.tag[0] === "A" ? "B" : "A"}${parsed.tag.slice(1)}`;
  assert.throws(() => __testOnlyOpenNativeResponse(VECTOR_TOKEN, request, JSON.stringify(parsed), now), /authentication failed/i);
  assert.throws(() => __testOnlyOpenNativeResponse(VECTOR_TOKEN, request, request.envelopeJson, now), /authentication failed/i);

  const stale = __testOnlyProtectNativeResponse(VECTOR_TOKEN, request, 200, "{}", now - 30_001, Buffer.alloc(16, 0x61));
  assert.throws(() => __testOnlyOpenNativeResponse(VECTOR_TOKEN, request, stale, now), /outside the accepted window/i);
  const otherRequest = { ...request, requestId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  assert.throws(() => __testOnlyOpenNativeResponse(VECTOR_TOKEN, otherRequest, response, now), /does not bind/i);
});

test("secure direct bridge rejects hostile receipts and plaintext outer responses", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-hostile-test-"));
  const receiptPath = path.join(dir, "bridge_transport.v1.json");
  const env = { ...process.env, REVIT_OPERATOR_MODE: "local" };
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("{\"ok\":true}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    fs.writeFileSync(receiptPath, JSON.stringify({
      version: "revit-operator.native-transport.v1", algorithm: "A256CBC-HS512",
      transport_path: NATIVE_TRANSPORT_PATH, url: "http://example.com:5000", server_epoch: VECTOR_EPOCH
    }));
    await assert.rejects(__testOnlyRequestBridgeJson("GET", "/revit/context", undefined, {
      token: VECTOR_TOKEN, fetchImpl, env, receiptPath
    }), /receipt is invalid/i);
    assert.equal(calls, 0);

    fs.writeFileSync(receiptPath, JSON.stringify({
      version: "revit-operator.native-transport.v1", algorithm: "A256CBC-HS512",
      transport_path: NATIVE_TRANSPORT_PATH, url: "http://127.0.0.1:5000", server_epoch: VECTOR_EPOCH
    }));
    await assert.rejects(__testOnlyRequestBridgeJson("GET", "/revit/context", undefined, {
      token: VECTOR_TOKEN, fetchImpl, env, receiptPath
    }), /content type is invalid/i);
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
