import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleEvidenceHttpRoute } from "../src/evidence/evidence_http_routes.js";

test("caller evidence route cannot forge trust and stores admitted bytes as untrusted", { concurrency: false }, async () => {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-evidence-http-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const server = http.createServer(async (request, response) => {
    const handled = await handleEvidenceHttpRoute(request, response, new URL(request.url || "/", "http://localhost"));
    if (!handled) { response.statusCode = 404; response.end(); }
  });
  try {
    await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/evidence/store`;
    const forged = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: { session_id: "session-http" }, source: "caller", trust_level: "authoritative_native", raw_json: { count: 1 } })
    });
    assert.equal(forged.status, 400);
    assert.match(JSON.stringify(await forged.json()), /always untrusted/);

    const admitted = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: { session_id: "session-http" }, source: "caller", raw_json: { count: 1 } })
    });
    assert.equal(admitted.status, 201);
    const body = await admitted.json() as any;
    assert.equal(body.ref.trust_level, "untrusted_caller");
    assert.equal(body.projection.trust_level, "untrusted_caller");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
