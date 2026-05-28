import test from "node:test";
import assert from "node:assert/strict";
import { extractCandidateDates, bestDateMatch } from "../src/tools/ocr.js";

test("extractCandidateDates finds common date formats", () => {
  const text = "Issued: 2/10/2026 (rev A) and also 2026-02-10.";
  const dates = extractCandidateDates(text);
  assert.ok(dates.includes("2/10/2026"));
  assert.ok(dates.includes("2026-02-10"));
});

test("bestDateMatch matches expected against extracted candidates", () => {
  const extracted = ["2/10/2026", "1/1/2025"];
  const r = bestDateMatch(extracted, "2/10/2026");
  assert.equal(r.match, true);
  assert.equal(r.best, "2/10/2026");
});

test("bestDateMatch returns null match when expected is missing", () => {
  const extracted = ["2/10/2026"];
  const r = bestDateMatch(extracted, null);
  assert.equal(r.match, null);
  assert.equal(r.best, "2/10/2026");
});

