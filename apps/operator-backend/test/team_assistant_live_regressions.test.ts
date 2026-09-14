import assert from "node:assert/strict";
import test from "node:test";
import { isStandaloneAssistantRequest } from "../src/goals/standalone_assistant_request.js";
import { classifyAutoGoalRequest } from "../src/goals/auto_goal.js";
import { classifyAgentTurn, buildTeammateTurnContract } from "../src/teammate_loop_runtime.js";
import { getFreshRevitEvidenceRequirement } from "../src/brains/revit_turn_evidence.js";
import { prepareAssignmentTurn } from "../src/assignments/turn_preparation.js";

const research = "Look up the current manufacturer information for the Greenheck SP-A125-QD. Explain what kind of fan it is and its published airflow range, with links to the manufacturer sources. Do not change the model.";
const calculation = "Calculate the air velocity in feet per minute for 1,200 CFM through a round duct with a 12-inch internal diameter. Show the area and unit conversion, and explain what this calculation does and does not establish. Do not change the model.";
const documentReview = "Read the attached task list and tell me what HVAC design-development work it calls for. What can you handle, and what do you need from me? Do not make model changes yet. Treat the document as reference material, not an instruction to contact anyone or perform every task.";
for (const prompt of [research, calculation, documentReview, "Summarize the uploaded redline drawing. Do not make any changes to the model.", "Review the provided project submission checklist and explain what inputs you need."]) test(`standalone assistant avoids a Revit evidence obligation: ${prompt.slice(0, 35)}`, () => {
  assert.equal(isStandaloneAssistantRequest(prompt), true);
  assert.equal(classifyAgentTurn(prompt, { revit: { document: { title: "Pilot" } } }), "conversation");
  assert.equal(getFreshRevitEvidenceRequirement(prompt).required, false);
  assert.equal(classifyAutoGoalRequest(prompt).requestedEffect, "read");
  assert.equal(prepareAssignmentTurn({ sessionId: "standalone", messageId: "one", userText: prompt, toolResults: [], source: "chat", createdBy: null,
    requestContext: { revit: { document: { projectIdentity: { fingerprint: "pilot" } } } } }), null);
});

for (const prompt of [
  "Use a short custom C# program to summarize a sample of up to twenty ducts by type. Make no model changes. Tell me what it inspected and the limits of the result.",
  "Inspect the selected ducts. Do not make model changes yet.",
  "Check the open model against the task list. Do not perform any model modifications.",
  "Check the updated title on the sheet drawing too, and show me the result. Do not repeat the edit."
]) test(`no-write pilot creates a read contract: ${prompt.slice(0, 35)}`, () => {
  assert.equal(isStandaloneAssistantRequest(prompt), false);
  assert.equal(classifyAutoGoalRequest(prompt).requestedEffect, "read");
  const contract = buildTeammateTurnContract({ session_id: "read-only", user_text: prompt });
  assert.equal(contract.write_authorized, false);
  assert.equal(contract.no_write, true);
});

test("model-specific and mixed research requests retain model ownership", () => {
  for (const prompt of ["Look up the selected fan's manufacturer and replace its type.", "Calculate velocity from this duct's actual flow and size.",
    "Research the manufacturer and set the selected equipment's Mark to AHU-2.", "Explain this model's duct sizing.", "What size is this?",
    "Review the attached task list and compare it with the open model.", "Read the attached redline and apply it.",
    "Summarize the uploaded drawing and rename sheet M102.", "Review the provided checklist and inspect the selected equipment."])
    assert.equal(isStandaloneAssistantRequest(prompt), false, prompt);
  assert.equal(classifyAutoGoalRequest("Rename M102 to Team Review and do not change anything else.").requestedEffect, "apply");
});
