import assert from 'node:assert/strict';
import test from 'node:test';
import { affirmativeRevitLaunchIntent as parse } from './revit_launch_intent.mjs';
test('retained PDF-only verification must not launch Revit from a negated list', () => {
  const retained = 'Verify the existing PDF. The print already happened: do not print again, launch Revit, modify the PDF, or change a model. Inspect the file and its visible contents, confirm whether it contains the Snowdon Towers M000 cover sheet, and report its page count and actual file size. Refresh the PDF viewer if it still shows an error from opening the file before printing finished.';
  assert.equal(parse(retained), null);
});
test('negative coordination is not affirmative launch intent', () => {
  for (const text of ['Do not print again, launch Revit, or change a model.',
    'Never modify the file or launch Revit.', 'Do not print, save, or open Revit 2024.',
    "Don't reprint and launch Revit."])
    assert.equal(parse(text), null, text);
});
test('separate affirmative clauses retain explicit launch intent', () => {
  for (const text of ['Open Revit 2024.', 'Without changing the model, open Revit 2024.',
    'Do not print. Open Revit 2024.', 'Do not print; please launch Revit 2024.',
    'Do not print, but open Revit 2024.'])
    assert.equal(parse(text)?.version, '2024', text);
});

test('Revit-owned UI requests do not authorize launching another application', () => {
  for (const text of [
    "Use computer use to open Revit's Print dialog for the current view, inspect and report the selected printer and print range, then Cancel the dialog and verify that Revit is usable again.",
    'Open Revit’s Print dialog and cancel it without printing.',
    'Open Revit 2024 Print dialog for the active document.',
    'Open Revit export dialog.',
    'Open Revit properties palette for the current view.',
    "Start Revit's print command in the current session."
  ]) assert.equal(parse(text), null, text);
});

test('a later explicit launch retains its version after a UI or negated clause', () => {
  assert.deepEqual(parse("Open Revit's Print dialog and cancel it. Then launch Revit 2024."), {version:'2024'});
  assert.deepEqual(parse('Do not launch Revit 2027. Launch Revit 2024.'), {version:'2024'});
});
