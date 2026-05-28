import test from "node:test";
import assert from "node:assert/strict";
import { buildRevitBridgePreflightReport } from "../src/benchmark/revit_preflight.js";

test("Revit bridge preflight reports ok when ping and context pass", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    checkedBridgeUrls: ["http://localhost:5000", "http://localhost:5010"],
    ping: { ok: true, status: 200, body: { status: "Ok" } },
    context: { ok: true, status: 200, body: { documentTitle: "Demo" } }
  });

  assert.equal(report.ok, true);
  assert.equal(report.diagnosis, "ok");
  assert.deepEqual(report.checked_bridge_urls, ["http://localhost:5000", "http://localhost:5010"]);
  assert.match(report.next_steps.join("\n"), /discover-revit-demo/);
});

test("Revit bridge preflight identifies a non-bridge service on the configured port", () => {
  const generic404 = "<!doctype html><html lang=en><title>404 Not Found</title><p>The requested URL was not found on the server.</p>";
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: false, status: 404, body: generic404 },
    context: { ok: false, status: 404, body: generic404 }
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "wrong_service");
  assert.match(report.message, /does not expose the Operator Revit bridge endpoints/);
});

test("Revit bridge preflight identifies unreachable bridge URL", () => {
  const report = buildRevitBridgePreflightReport({
    bridgeUrl: "http://localhost:5000",
    ping: { ok: false, error: "fetch failed" },
    context: { ok: false, error: "fetch failed" }
  });

  assert.equal(report.ok, false);
  assert.equal(report.diagnosis, "unreachable");
  assert.match(report.next_steps.join("\n"), /Start Revit/);
});
