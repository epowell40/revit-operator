import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __testOnlyClearDirectBridgeAvailabilityCache,
  __testOnlyExtractBridgeImageAttachmentPaths,
  __testOnlyRequestBridgeJson,
  canUseDirectBridgeFastPath,
  readAbsoluteImageDataUrl,
  toToolResultFromDirectBridgeResult
} from "../src/brains/direct_revit_bridge.js";

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
    fetchImpl
  });

  assert.deepEqual(result, { ok: true, count: 2 });
  assert.equal(seenUrl, "http://bridge.local:5000/revit/test");
  assert.equal(seenInit?.method, "POST");
  assert.equal(new Headers(seenInit?.headers).get("X-Operator-Token"), "test-token");
  assert.equal(new Headers(seenInit?.headers).get("Content-Type"), "application/json");
  assert.equal(seenInit?.body, JSON.stringify({ ids: [1, 2] }));
});

test("direct bridge transport preserves response text for HTTP failures", async () => {
  const fetchImpl: typeof fetch = async () => new Response("bridge unavailable", { status: 503 });

  await assert.rejects(
    __testOnlyRequestBridgeJson("GET", "/revit/context", undefined, {
      baseUrl: "http://bridge.local:5000",
      token: "test-token",
      timeoutMs: 100,
      fetchImpl
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
      fetchImpl
    }),
    /aborted by test signal/
  );
});

test("direct bridge availability caches successful probes by bridge URL", async () => {
  __testOnlyClearDirectBridgeAvailabilityCache();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ revit: { connected: true } }), { status: 200 });
  };
  const baseUrl = `http://bridge-cache-${Date.now()}.local:5000`;
  const options = { baseUrl, token: "test-token", timeoutMs: 100, fetchImpl };

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
    method: "POST",
    path: "/revit/export-image",
    result_json: { path: "C:/captures/view.png" },
    duration_ms: 12,
    attachments: [{ kind: "image", mime: "image/png", filename: "view.png", local_path: "C:/captures/view.png" }]
  });

  assert.equal(result.status, "done");
  assert.equal(result.path, "/revit/export-image");
  assert.equal(result.duration_ms, 12);
  assert.equal(result.attachments?.[0]?.filename, "view.png");
});
