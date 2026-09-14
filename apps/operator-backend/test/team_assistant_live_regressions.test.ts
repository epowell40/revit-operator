import assert from "node:assert/strict";
import test from "node:test";
import { isStandaloneAssistantRequest } from "../src/goals/standalone_assistant_request.js";
import { classifyAutoGoalRequest } from "../src/goals/auto_goal.js";
import { classifyAgentTurn, buildTeammateTurnContract } from "../src/teammate_loop_runtime.js";
import { getFreshRevitEvidenceRequirement } from "../src/brains/revit_turn_evidence.js";
import { prepareAssignmentTurn } from "../src/assignments/turn_preparation.js";
import { standaloneEngineeringQuestion } from "./standalone_engineering.fixtures.js";

test("standalone engineering with coordinated model-access exclusions has no model assignment or freshness obligation", () => {
  for (const prompt of [standaloneEngineeringQuestion,
    "Calculate duct area for 1,200 CFM at 800 fpm without opening or inspecting the Revit model.",
    "Research the published airflow formula. Never query, modify or save the current model.",
    "Review the attached checklist. Do not inspect or edit the model."]) {
    assert.equal(isStandaloneAssistantRequest(prompt), true, prompt);
    assert.equal(classifyAgentTurn(prompt, { revit: { document: { title: "Pilot" } } }), "conversation");
    assert.equal(getFreshRevitEvidenceRequirement(prompt).required, false);
    assert.equal(prepareAssignmentTurn({ sessionId: "engineering", messageId: "calculation", userText: prompt, toolResults: [], source: "chat", createdBy: null }), null);
  }
  for (const prompt of [
    "Calculate velocity from the selected duct. Do not inspect or change the other model.",
    "Research the airflow formula without changing the model. Then inspect the selected duct's actual size.",
    "Explain the formula. Do not inspect the model; instead change the selected duct diameter to 18 inches.",
    "Review the attached checklist. Do not change the model. Compare it against our current model."]) {
    assert.equal(isStandaloneAssistantRequest(prompt), false, prompt);
    assert.notEqual(classifyAgentTurn(prompt, { revit: { document: { title: "Pilot" } } }), "conversation");
  }
});

const research = "Look up the current manufacturer information for the Greenheck SP-A125-QD. Explain what kind of fan it is and its published airflow range, with links to the manufacturer sources. Do not change the model.";
const calculation = "Calculate the air velocity in feet per minute for 1,200 CFM through a round duct with a 12-inch internal diameter. Show the area and unit conversion, and explain what this calculation does and does not establish. Do not change the model.";
const documentReview = "Read the attached task list and tell me what HVAC design-development work it calls for. What can you handle, and what do you need from me? Do not make model changes yet. Treat the document as reference material, not an instruction to contact anyone or perform every task.";
const followup = "Turn that into a prioritized five-step plan for this week. Put the missing decisions first, and keep it brief.";
const documentCapabilityReview = "Review all pages of these two attached documents. Summarize the HVAC design-development tasks in the task list and identify the red marks in the checklist. Tell me what can be checked in Revit and which decisions or outside inputs are still needed. Cite the document and page for each finding. Do not change the model or contact anyone. If any page cannot be inspected, say which one rather than assuming its content.";
for (const prompt of [documentCapabilityReview,
  "Review the uploaded PDF checklist. Which of these tasks could be verified in Revit? Do not change the model.",
  "Review the attached documents and explain what can be done using Revit. Leave the model unchanged."])
  test(`document capability discussion remains conversation across admission and evidence boundaries: ${prompt.slice(0, 45)}`, () => {
    assert.equal(isStandaloneAssistantRequest(prompt), true);
    assert.equal(classifyAgentTurn(prompt, { revit: { document: { title: "Pilot" } } }), "conversation");
    assert.equal(getFreshRevitEvidenceRequirement(prompt).required, false);
    assert.equal(prepareAssignmentTurn({ sessionId: "document-discussion", messageId: "review", userText: prompt, toolResults: [], source: "chat", createdBy: null }), null);
  });

test("document capability wording cannot absorb neighboring live inspection or mutation", () => {
  for (const suffix of ["Inspect the open model too.", "Compare it against our current model.", "Check the selected equipment parameters.", "Then apply the redlines.", "Set the sheet name to Review."])
    assert.equal(isStandaloneAssistantRequest(`Review the attached documents and tell me what can be checked in Revit. ${suffix}`), false, suffix);
});
for (const prompt of [research, calculation, documentReview, followup, "Rewrite the answer as a checklist.", "Make it shorter.", "Prioritize the findings for next week.", "Summarize the uploaded redline drawing. Do not make any changes to the model.", "Review the provided project submission checklist and explain what inputs you need."]) test(`standalone assistant avoids a Revit evidence obligation: ${prompt.slice(0, 35)}`, () => {
  assert.equal(isStandaloneAssistantRequest(prompt), true);
  assert.equal(classifyAgentTurn(prompt, { revit: { document: { title: "Pilot" } } }), "conversation");
  assert.equal(getFreshRevitEvidenceRequirement(prompt).required, false);
  assert.equal(classifyAutoGoalRequest(prompt).requestedEffect, "read");
  assert.equal(prepareAssignmentTurn({ sessionId: "standalone", messageId: "one", userText: prompt, toolResults: [], source: "chat", createdBy: null,
    requestContext: { revit: { document: { projectIdentity: { fingerprint: "pilot" } } } } }), null);
});

for (const prompt of [
  'Test the custom C# execution diagnostics without changing the model. Run a small read-only program that logs "diagnostic probe reached" and then deliberately throws an InvalidOperationException with message "diagnostic probe failure". Show me the retained log and the source line of the exception. Then repair that same program to return a short successful result, run it once, and report both outcomes. Do not change any elements or parameters.',
  "Repair and rerun the custom C# diagnostic without modifying the Revit model.",
  "Fix the test program. Do not edit any elements or parameters.",
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
    "What size is this? Keep it brief.", "Which system does this belong to? Make it concise.",
    "Review the attached task list and compare it with the open model.", "Read the attached redline and apply it.",
    "Summarize the uploaded drawing and rename sheet M102.", "Review the provided checklist and inspect the selected equipment.",
    "Turn that into a plan and then execute it.", "Turn that into a checklist and email the architect.",
    "Turn that into a plan for the selected duct and resize it.", "Summarize that and continue the task.", "Make it shorter and update the model."])
    assert.equal(isStandaloneAssistantRequest(prompt), false, prompt);
  assert.equal(classifyAutoGoalRequest("Rename M102 to Team Review and do not change anything else.").requestedEffect, "apply");
});
