import test from "node:test";
import assert from "node:assert/strict";
import { matchExpectedText } from "../src/tools/ocr.js";

test("matchExpectedText ignores punctuation/whitespace/line breaks", () => {
  const ocr = "MEP\nENGINEERS:   W S P,  Inc.";
  assert.equal(matchExpectedText(ocr, "MEP engineers WSP inc"), true);
});

test("matchExpectedText returns null when expected is missing/blank", () => {
  assert.equal(matchExpectedText("Anything", null), null);
  assert.equal(matchExpectedText("Anything", ""), null);
});

test("matchExpectedText returns false when expected is not present", () => {
  const ocr = "Issued: 2/10/2026";
  assert.equal(matchExpectedText(ocr, "Revised"), false);
});

