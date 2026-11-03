import test from "node:test";
import assert from "node:assert/strict";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ChatResponse } from "../src/contracts.js";
import { enforceModeledRedlineGuard } from "../src/verification/model_redline_guard.js";
import { __testOnlyFinalizeDecision } from "../src/brain.js";

const request: ChatRequest = {
  version: OPERATOR_BACKEND_CONTRACT_VERSION,
  session_id: `redline-handoff-${process.pid}`,
  message_id: "handoff",
  user_text: "Apply the marked equipment and duct changes in the attached redlines."
};
const response = (message: string): ChatResponse => ({
  version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: message, actions: []
});

// Synthetic response neighbors reproduce the shared predicate reached by the
// retained partial/rollback trials; they are not original provider transcripts.
const pending = [
  "The family is loaded. No air-device tags were created; placement and verification remain pending.",
  "The native move rolled back. No equipment was modified. The relocation remains pending.",
  "Nothing was created. Placement remains pending.",
  "None were added. The requested work remains pending.",
  "No equipment or ductwork was modified. Work remains pending.",
  "No elements were added, modified or updated. Work remains pending.",
  "No elements were added, modified, or updated. Work remains pending.",
  "None of the requested elements were modified. Work remains pending.",
  "No air‑device tags were created; placement remains pending.",
  "No extra annotation tags have been created. Work remains pending.",
  "No project changes have been implemented. Work remains pending."
];
const unsupported = [
  "The entire mechanical redline is complete.",
  "No tags were created, but the entire mechanical redline is complete.",
  "Nothing was modified. All requested work is completed.",
  "No warnings were found. I created the requested equipment.",
  "No issues were found and I created the requested equipment.",
  "No equipment existed so I created the requested equipment.",
  "No equipment existed so the requested equipment has been created.",
  "No tags were created; I modified the requested ductwork.",
  "Created and verified all requested equipment."
];

for (const [name, boundary] of [
  ["shared guard", enforceModeledRedlineGuard],
  ["backend decision finalization", __testOnlyFinalizeDecision]
] as const) {
  for (const message of pending) test(`${name} retains negative effect handoff: ${message}`, () => {
    const actual = boundary(request, response(message));
    assert.equal(actual.assistant_message, message);
    assert.deepEqual(actual.actions, []);
  });
  for (const message of unsupported) test(`${name} still rejects unsupported positive completion: ${message}`, () => {
    const actual = boundary(request, response(message));
    assert.notEqual(actual.assistant_message, message);
    assert.match(actual.assistant_message, /not valid completion/i);
    assert.deepEqual(actual.actions, []);
  });
}
