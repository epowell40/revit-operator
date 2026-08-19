import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import zlib from "node:zlib";
import { writeJson } from "../src/http.js";

function requestRaw(port: number, acceptEncoding?: string): Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/",
      headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {}
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("large JSON responses use negotiated gzip while small responses stay plain", async () => {
  const body = { assignments: Array.from({ length: 500 }, (_, index) => ({ id: `goal:${index}`, summary: "verified assignment evidence ".repeat(8) })) };
  const server = http.createServer((_, res) => writeJson(res, 200, body));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const gzip = await requestRaw(address.port, "gzip, deflate");
    assert.equal(gzip.headers["content-encoding"], "gzip");
    assert.equal(gzip.headers.vary, "Accept-Encoding");
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gzip.body).toString("utf8")), body);
    assert.ok(gzip.body.length < Buffer.byteLength(JSON.stringify(body)) / 4);

    const plain = await requestRaw(address.port, "identity");
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(plain.body.toString("utf8")), body);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
