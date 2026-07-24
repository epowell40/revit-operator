import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSheetCandidatesFromFilename,
  extractSheetCandidatesFromText,
  isLikelySheetPattern,
  mergeSheetCandidates,
  normalizeSheetNumber
} from "../src/redline/sheet_candidate_classifier.js";

test("sheet classifier normalizes common separators without accepting numeric-only tokens", () => {
  assert.equal(normalizeSheetNumber(" m_5.01 "), "M.5.01");
  assert.equal(isLikelySheetPattern("M5.01"), true);
  assert.equal(isLikelySheetPattern("2026"), false);
  assert.equal(isLikelySheetPattern("101"), false);
});

test("sheet classifier preserves page provenance and expected-sheet ranking", () => {
  const candidates = extractSheetCandidatesFromText({
    text: "Coordinate sheet A2.00, but perform this markup on sheet M601. M601 is the target.",
    expectedSheet: "M601",
    page: 63
  });
  assert.equal(candidates[0]?.sheet_number, "M601");
  assert.equal(candidates[0]?.page, 63);
  assert.equal(candidates[0]?.hit_count, 2);
});

test("sheet classifier rejects room-like filename tokens and keeps discipline sheets", () => {
  const candidates = extractSheetCandidatesFromFilename({ filePath: "ROOM101_M-201_redlines.pdf" });
  assert.deepEqual(candidates.map((candidate) => candidate.sheet_number), ["M-201"]);
});

test("sheet classifier ignores UUID groups in uploaded filenames", () => {
  const candidates = extractSheetCandidatesFromFilename({
    filePath: "codex-clipboard-896bb65c-b1ea-4039-a069-3d6925111aea.png"
  });
  assert.deepEqual(candidates, []);
});

test("sheet candidate merge combines evidence without losing the first known page", () => {
  const merged = mergeSheetCandidates([
    { sheet_number: "m_201", score: 30, source: "text", page: 8, hit_count: 1, evidence: "page text" },
    { sheet_number: "M.201", score: 62, source: "filename", hit_count: 1, evidence: "filename" },
    { sheet_number: "A1.00", score: 40, source: "text", page: 1, hit_count: 1 }
  ]);
  assert.equal(merged[0]?.sheet_number, "M.201");
  assert.equal(merged[0]?.score, 63);
  assert.equal(merged[0]?.hit_count, 2);
  assert.equal(merged[0]?.page, 8);
  assert.equal(merged.length, 2);
});
