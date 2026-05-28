import test from "node:test";
import assert from "node:assert/strict";
import { normalizeForMatch, similarityScore, bestLineReplacement, replaceLineRange } from "./textMatch.js";

test("normalizeForMatch collapses punctuation/whitespace and letter-runs", () => {
  assert.equal(normalizeForMatch("MEP\nENGINEERS:   W S P,  Inc."), "mep engineers wsp inc");
});

test("similarityScore is high for substring-ish matches", () => {
  const s = similarityScore("MEP Design and Modeling:\nDroffats Consulting Services, LLC", "Droffats consulting services llc");
  assert.ok(s > 0.7);
});

test("bestLineReplacement replaces only the best matching line", () => {
  const before = "MEP Design and Modeling:\nDroffats Consulting Services, LLC\nPhone: 555-1234";
  const r = bestLineReplacement(before, "Droffats consulting services llc", "WSP USA Buildings Inc.");
  assert.equal(r.ok, true);
  assert.equal(r.after, "MEP Design and Modeling:\nWSP USA Buildings Inc.\nPhone: 555-1234");
});

test("replaceLineRange replaces line spans and preserves others", () => {
  const before = "Header\nLine2\nLine3\nFooter";
  const r = replaceLineRange(before, 2, 3, "A\nB");
  assert.equal(r.ok, true);
  assert.equal(r.after, "Header\nA\nB\nFooter");
});

