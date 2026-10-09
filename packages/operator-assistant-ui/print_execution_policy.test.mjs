import assert from "node:assert/strict";
import test from "node:test";
import { needsPrinterCapableLane, PRINT_EXECUTION_GUIDANCE, PDF_EXPORT_TOOL_GUIDANCE } from "./print_execution_policy.mjs";

test("printer and plot requests retain desktop capability, including PDF drivers", () => {
  for (const text of ["Print M000 using the available printer.", "Print M000 using Microsoft Print to PDF.", "Plot the selected sheets.", "Verify the existing print file; do not print again."]) {
    assert.equal(needsPrinterCapableLane(text), true, text);
  }
  for (const text of ["Export M000 to PDF.", "Inspect the model fingerprint.", "Update the blueprint title.", "", null]) {
    assert.equal(needsPrinterCapableLane(text), false, String(text));
  }
});

test("printer guidance preserves effect uncertainty and requested delivery semantics", () => {
  assert.match(PRINT_EXECUTION_GUIDANCE, /Do not substitute PDF export/);
  assert.match(PRINT_EXECUTION_GUIDANCE, /trusted receipt proves not_started/);
  assert.match(PRINT_EXECUTION_GUIDANCE, /never retry an uncertain or pending attempt/);
  assert.match(PRINT_EXECUTION_GUIDANCE, /Honor requests not to print/);
  assert.match(PDF_EXPORT_TOOL_GUIDANCE, /not a printer-driver/);
});
