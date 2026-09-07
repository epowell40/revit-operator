import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { createGeneralRevitRequest } from "../src/benchmark/general_revit_request.js";

test("native benchmark adapter sends no synthetic browser identity and preserves explicit caller headers", async t => {
  const requests: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers);
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end('{"accepted":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = createGeneralRevitRequest(() => null);
  for (const route of ["/api/computer/run", "/api/chat", "/api/chat/stream"]) {
    assert.equal((await request(base, route, { method: "POST", body: "{}" })).accepted, true);
  }
  for (const headers of requests) {
    assert.equal(headers.origin, undefined);
    assert.equal(headers["x-operator-browser-identity"], undefined);
    assert.equal(headers["content-type"], "application/json");
  }
  for (const headers of [{ origin: base, "x-operator-browser-identity": "stale" }, new Headers({ origin: "https://foreign.example", "content-type": "application/custom" })]) {
    await request(base, "/api/computer/run", { method: "POST", body: "{}", headers });
  }
  assert.equal(requests[3]!.origin, base);
  assert.equal(requests[3]!["x-operator-browser-identity"], "stale");
  assert.equal(requests[4]!.origin, "https://foreign.example");
  assert.equal(requests[4]!["content-type"], "application/custom");
});
