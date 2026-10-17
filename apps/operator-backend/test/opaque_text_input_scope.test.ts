import assert from "node:assert/strict";
import test from "node:test";
import { missingOpaqueMutationInputs, mutationIntentBindingDecision } from "../src/teammate_mutation_intent_binding.js";
import { assignmentSpecFromGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import type { GoalRecord } from "../src/goals/service.js";

const graphicalRequests = [
  "Check the equipment schedule for a blank row and correct it. Preserve text sizes. Save a new copy named Schedule Visual Correction Result.rvt.",
  "Update the schedule, preserving the note and text sizes.",
  "Change the text size to 3/32 inch.",
  "Correct the selected note's alignment.",
  "Update the annotation font and keep its text.",
  "Replace the selected grille. Keep the annotation unchanged.",
  "Preserve text. Save the corrected model as Schedule Correction.rvt.",
  "Revise the schedule widths without changing note content."
];

test("graphical work and output filenames cannot invent a replacement-text input", () => {
  for (const prompt of graphicalRequests) assert.deepEqual(missingOpaqueMutationInputs(prompt), [], prompt);
});

test("actual text-content requests still require an authenticated desired value", () => {
  for (const prompt of [
    "Replace the outdated selected note with the current issue wording without creating a duplicate.",
    "Replace Revit TextNote element 1478627 with the approved wording.",
    "Update the selected note to the approved wording.",
    "Correct the selected TextNote using the current wording.",
    "Revise the note.", "Rewrite the annotation.",
    "Find one project TextNote, report its exact identity, and preview a conditional text replacement that would not create a duplicate. Do not apply it.",
    "Replace the selected note with either ISSUE A or ISSUE B."
  ]) assert.deepEqual(missingOpaqueMutationInputs(prompt), ["replacement_text"], prompt);
  for (const prompt of [
    'Replace the selected note with "ISSUE 04".',
    'Append the exact suffix " - VERIFIED" to the selected note.',
    "Change the selected text to uppercase."
  ]) assert.deepEqual(missingOpaqueMutationInputs(prompt), [], prompt);
});

function spec(prompt: string, required_user_inputs: string[] = []) {
  const goal: GoalRecord = {
    title: "Input scope", non_goals: [], created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T00:00:00Z",
    status: "active", progress_summary: "", work_items: [], assumptions: [], evidence_log: [], action_log: [], validation_log: [], artifacts: [],
    id: "input-scope", objective: prompt, acceptance_criteria: ["Requested work is completed and checked."],
    related_session_id: "input-scope-session", created_by: "input-scope-principal",
    work_budget: { requested_effect: "apply", required_user_inputs }
  };
  return assignmentSpecFromGoalV2({ goal, run_id: "input-scope-run", document_fingerprint: "input-scope-document" });
}

test("real assignment factory scopes inferred inputs and retains explicitly declared prerequisites", () => {
  for (const prompt of graphicalRequests) {
    const result = spec(prompt);
    assert.deepEqual(result.input_variables, [], prompt);
    assert(result.work_units.every(unit => unit.input_variable_ids.length === 0));
  }
  assert.deepEqual(spec("Update the selected note to the approved wording.").input_variables.map(v => v.variable_id), ["replacement_text"]);
  assert.deepEqual(spec(graphicalRequests[0]!, ["replacement_text"]).input_variables.map(v => v.variable_id), ["replacement_text"]);
});

test("narrower anticipatory inference never grants an actual text mutation", () => {
  for (const prompt of graphicalRequests) {
    const decision = mutationIntentBindingDecision({ tool: "revit_call_tool", path: "/revit/replace-text-note",
      body: { newText: "MODEL INVENTED VALUE", expectedOldText: "Old note" }, authoritative_user_text: prompt });
    assert.equal(decision.applicable, true); assert.equal(decision.authorized, false);
    assert.deepEqual(decision.missing_fields, ["replacement_text"]);
  }
});
