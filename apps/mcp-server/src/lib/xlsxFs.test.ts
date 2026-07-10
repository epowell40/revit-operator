import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as xlsx from "xlsx";

xlsx.set_fs(fs);

test("SheetJS ESM filesystem adapter supports workbook read and write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revit-operator-xlsx-"));
  const output = path.join(dir, "table.xlsx");
  try {
    const workbook = xlsx.utils.book_new();
    const sheet = xlsx.utils.aoa_to_sheet([
      ["Room", "CFM"],
      ["101", 120]
    ]);
    xlsx.utils.book_append_sheet(workbook, sheet, "Vent");
    xlsx.writeFile(workbook, output);

    const readback = xlsx.readFile(output);
    const rows = xlsx.utils.sheet_to_json(readback.Sheets.Vent, { header: 1 });
    assert.deepEqual(rows.slice(0, 2), [["Room", "CFM"], ["101", 120]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
