import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  expectedPostconditionValuesV2,
  observedPostconditionValuesV2,
  postconditionSatisfiedByPayloadV2
} from "../src/postcondition_verification_v2.js";

const applyText = (newText: string) => ({
  method: "POST",
  path: "/revit/replace-text-note",
  body: { elementId: 1478627, newText, apply: true }
});

const readText = (text: string) => ({
  ok: true,
  requestedElementIds: [1478627],
  exactElementFilterApplied: true,
  itemsComplete: true,
  items: [{ elementId: 1478627, text }]
});

function sharedTextNoteVectors(): Array<{ id: string; requested: string; actual: string; matches: boolean }> {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    for (const candidate of [
      path.join(cursor, "packages", "text-note-round-trip-v1", "golden-vectors.json"),
      path.join(cursor, "public", "packages", "text-note-round-trip-v1", "golden-vectors.json")
    ]) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8"));
        assert.equal(parsed.schema, "revit-operator.text-note-round-trip/v1");
        return parsed.vectors;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    cursor = path.dirname(cursor);
  }
  throw new Error("Shared TextNote round-trip vectors were not found.");
}

test("shared native/backend TextNote round-trip vectors remain identical", () => {
  for (const vector of sharedTextNoteVectors()) {
    assert.equal(
      postconditionSatisfiedByPayloadV2(applyText(vector.requested), readText(vector.actual)),
      vector.matches,
      vector.id
    );
  }
});

test("Revit TextNote LF, CRLF, CR, and a terminal paragraph marker share one semantic value", () => {
  const expected = "ISSUE 04 - COORDINATION SET - 2026-08-09\nVERIFY AGAINST CURRENT SHEET INDEX";
  for (const observed of [
    expected,
    expected.replace(/\n/g, "\r\n"),
    expected.replace(/\n/g, "\r"),
    expected.replace(/\n/g, "\r") + "\r"
  ]) {
    assert.equal(postconditionSatisfiedByPayloadV2(applyText(expected), readText(observed)), true);
  }
});

test("TextNote comparison admits exactly one Revit-added terminal paragraph marker", () => {
  assert.equal(postconditionSatisfiedByPayloadV2(applyText("one"), readText("one\r")), true);
  assert.equal(postconditionSatisfiedByPayloadV2(applyText("one"), readText("one\r\r")), false);
  assert.equal(postconditionSatisfiedByPayloadV2(applyText("one\n"), readText("one\r\r")), true);
  assert.equal(postconditionSatisfiedByPayloadV2(applyText("one\n"), readText("one\r\r\r")), false);
  assert.equal(postconditionSatisfiedByPayloadV2(applyText("one\\ntwo"), readText("one\rtwo\r")), true);
});

test("TextNote semantic comparison remains strict for content, case, spacing, punctuation, and interior paragraphs", () => {
  const expected = "LINE ONE\nLINE TWO";
  for (const observed of [
    "Line ONE\rLINE TWO\r",
    "LINE ONE \rLINE TWO\r",
    "LINE ONE\rLINE TWO.\r",
    "LINE ONE\r\rLINE TWO\r",
    "LINE ONE\rLINE TWO\r\r"
  ]) {
    assert.equal(postconditionSatisfiedByPayloadV2(applyText(expected), readText(observed)), false);
  }
});

test("newline equivalence is limited to TextNote content and does not weaken arbitrary parameter values", () => {
  assert.equal(postconditionSatisfiedByPayloadV2(
    { body: { elementId: 9, newValue: "A\nB" } },
    { item: { elementId: 9, value: "A\rB" } }
  ), false);
  assert.equal(postconditionSatisfiedByPayloadV2(
    { body: { elementId: 9, newValue: "A\nB" } },
    { item: { elementId: 9, value: "A\nB" } }
  ), true);
});

test("generic parameter verification binds the requested property instead of any coincident scalar", () => {
  const apply = {
    path: "/revit/set-parameters",
    body: { elementIds: [42], parameters: { Manufacturer: "WATTS" }, apply: true }
  };
  assert.equal(postconditionSatisfiedByPayloadV2(apply, {
    items: [{ id: 42, parameters: { Manufacturer: "WATTS" } }]
  }, { path: "/revit/set-parameters" }), true);
  assert.equal(postconditionSatisfiedByPayloadV2(apply, {
    items: [{ id: 42, parameters: { Manufacturer: "JOSAM", Comments: "WATTS" } }]
  }, { path: "/revit/set-parameters" }), false);
});

test("change-list verification binds each parameter name to its requested value", () => {
  const apply = {
    changes: [
      { elementId: 42, parameterName: "Drawn By", value: "EP" },
      { elementId: 42, parameterName: "Checked By", value: "QA" }
    ],
    apply: true
  };
  assert.equal(postconditionSatisfiedByPayloadV2(apply, {
    items: [{ id: 42, parameters: { "Drawn By": "EP", "Checked By": "QA" } }]
  }), true);
  assert.equal(postconditionSatisfiedByPayloadV2(apply, {
    items: [{ id: 42, parameters: { "Drawn By": "QA", "Checked By": "EP" } }]
  }), false);
});

test("change-list verification binds each parameter value to its requested element", () => {
  const apply = {
    changes: [
      { elementId: 42, parameterName: "Mark", value: "ERU-42" },
      { elementId: 43, parameterName: "Mark", value: "ERU-43" }
    ],
    apply: true
  };
  assert.equal(postconditionSatisfiedByPayloadV2(apply, {
    items: [
      { id: 42, parameters: { Mark: "ERU-42" } },
      { id: 43, parameters: { Mark: "ERU-43" } }
    ]
  }), true);
  assert.equal(postconditionSatisfiedByPayloadV2(apply, {
    items: [
      { id: 42, parameters: { Mark: "ERU-43" } },
      { id: 43, parameters: { Mark: "ERU-42" } }
    ]
  }), false);
});

test("TextNote newline semantics require an explicit admitted TextNote operation contract", () => {
  const expected = "ISSUE\nVERIFY";
  const observed = { items: [{ elementId: 1478627, text: "ISSUE\rVERIFY\r" }] };
  assert.equal(postconditionSatisfiedByPayloadV2(
    { body: { newText: expected } },
    observed
  ), false);
  assert.equal(postconditionSatisfiedByPayloadV2(
    { body: { newText: expected } },
    observed,
    { tool: "revit_replace_text_note" }
  ), true);
  assert.equal(postconditionSatisfiedByPayloadV2(
    { path: "/revit/replace-schedule-cell-values", body: { replaceTo: expected } },
    { items: [{ after: "ISSUE\rVERIFY\r" }] }
  ), false);
});

test("request, input, and metadata echoes cannot supply an observed TextNote value", () => {
  const expected = "AUTHENTIC VALUE";
  const echoedOnly = {
    items: [{ elementId: 1478627, text: "wrong" }],
    metadata: { request: { body: { newText: expected } } },
    input: { newText: expected }
  };
  assert.equal(postconditionSatisfiedByPayloadV2(applyText(expected), echoedOnly), false);
});

test("truncated TextNote samples cannot satisfy a postcondition", () => {
  const expected = "AUTHENTIC VALUE";
  assert.equal(postconditionSatisfiedByPayloadV2(applyText(expected), {
    itemsComplete: false,
    textSample: expected,
    textSamples: [expected]
  }), false);
});

test("comparison vectors are deterministic across object and JSON transport representations", () => {
  const expected = "A\nB";
  const input = applyText(expected);
  const output = readText("A\rB\r");
  assert.deepEqual(expectedPostconditionValuesV2(input), expectedPostconditionValuesV2(JSON.parse(JSON.stringify(input))));
  assert.deepEqual([...observedPostconditionValuesV2(output)], [...observedPostconditionValuesV2(JSON.parse(JSON.stringify(output)))]);
  assert.equal(postconditionSatisfiedByPayloadV2(JSON.parse(JSON.stringify(input)), JSON.parse(JSON.stringify(output))), true);
});

test("native Parameter.Set verification admits the assigned argument but not transaction-scope identities", () => {
  const input = {
    operations: [
      { id: "p", op: "call", memberId: "method:Autodesk.Revit.DB.Element.LookupParameter(System.String)", target: "view", args: ["Sheet Name"] },
      { id: "set", op: "call", memberId: "method:Autodesk.Revit.DB.Parameter.Set(System.String)", target: "$p", args: ["NEW NAME"] }
    ],
    transaction: { mode: "commit", allowedExistingElementIds: [10, 11, 12] }
  };
  assert.equal(postconditionSatisfiedByPayloadV2(input, {
    sheetViewId: 10,
    matches: [{ source: "sheet", value: { value: "NEW NAME" } }]
  }, { path: "/revit/native-api-mutation-ops" }), true);
  assert.equal(postconditionSatisfiedByPayloadV2(input, {
    sheetViewId: 10,
    matches: [{ source: "sheet", value: { value: "OLD NAME" } }]
  }, { path: "/revit/native-api-mutation-ops" }), false);
});

test("schedule appearance verification binds the requested property instead of an unrelated true flag", () => {
  const input = { scheduleId: 1542984, appearance: { stripedRows: true }, dryRun: false };
  assert.equal(postconditionSatisfiedByPayloadV2(input, {
    schedule: { id: 1542984 },
    appearance: { stripedRows: true }
  }, { path: "/revit/configure-schedule" }), true);
  assert.equal(postconditionSatisfiedByPayloadV2(input, {
    schedule: { id: 1542984 },
    appearance: { stripedRows: false },
    table: { body: { rows: [{ stripedRows: true }] } }
  }, { path: "/revit/configure-schedule" }), false);
});

test("schedule filter verification requires the actual filter definition, not rows that happen to match", () => {
  const input = {
    scheduleId: 1543072,
    filters: [{ field: "Mark", op: "begins-with", value: "OPERATOR-SMOKE" }],
    replaceFilters: true,
    dryRun: false
  };
  assert.equal(postconditionSatisfiedByPayloadV2(input, {
    schedule: { id: 1543072 },
    table: { body: { rows: [{ cells: ["OPERATOR-SMOKE-001"] }] } }
  }, { path: "/revit/configure-schedule" }), false);
  assert.equal(postconditionSatisfiedByPayloadV2(input, {
    schedule: { id: 1543072 },
    filterDefinitions: [{ field: "mark", op: "begins_with", value: "OPERATOR-SMOKE" }],
    filterDefinitionsComplete: true
  }, { path: "/revit/configure-schedule" }), true);
  assert.equal(postconditionSatisfiedByPayloadV2(input, {
    schedule: { id: 1543072 },
    filterDefinitions: [
      { field: "mark", op: "begins_with", value: "OPERATOR-SMOKE" },
      { field: "level", op: "equals", value: "Level 1" }
    ],
    filterDefinitionsComplete: true
  }, { path: "/revit/configure-schedule" }), false);
  assert.equal(postconditionSatisfiedByPayloadV2(input, {
    schedule: { id: 1543072 },
    metadata: { request: { filters: [{ field: "Mark", op: "begins_with", value: "OPERATOR-SMOKE" }] } }
  }, { path: "/revit/configure-schedule" }), false);
});

test("schedule field and settings verification consume only the typed detail contract", () => {
  const input = {
    scheduleId: 1543072,
    addFields: ["Count"],
    showGrandTotals: true,
    filterBySheet: false,
    dryRun: false
  };
  assert.equal(postconditionSatisfiedByPayloadV2(input, {
    schedule: { id: 1543072 },
    fields: [{ name: "Count" }],
    settings: { showGrandTotals: true, filterBySheet: false }
  }, { path: "/revit/configure-schedule" }), true);
  assert.equal(postconditionSatisfiedByPayloadV2(input, {
    schedule: { id: 1543072 },
    table: { body: { rows: [{ name: "Count", showGrandTotals: true, filterBySheet: false }] } }
  }, { path: "/revit/configure-schedule" }), false);
});
