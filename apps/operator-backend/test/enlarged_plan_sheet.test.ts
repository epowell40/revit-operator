import assert from "node:assert/strict";
import test from "node:test";
import { parseDeterministicEnlargedPlanRequest } from "../src/deterministic/enlarged_plan_sheet.js";

test("parses explicit enlarged plan sheet request", () => {
  const parsed = parseDeterministicEnlargedPlanRequest(
    "Create a new enlarged plans sheet E401 for Unit 403 with power and lighting plans from Level 4."
  );
  assert.equal(parsed?.unitNumber, "403");
  assert.equal(parsed?.sheetNumber, "E401");
  assert.deepEqual(parsed?.kinds, ["POWER", "LIGHTING"]);
  assert.equal(parsed?.levelToken, "L4");
});

test("does not trigger without unit and sheet", () => {
  assert.equal(parseDeterministicEnlargedPlanRequest("Create some enlarged plans."), null);
});
