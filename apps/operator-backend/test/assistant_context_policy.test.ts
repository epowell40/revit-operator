import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { independentEngineeringQuestions } from "./standalone_engineering.fixtures.js";
import { assistantContextPolicy } from "../src/goals/assistant_context_policy.js";
const root = ["../packages/operator-assistant-ui", "../../packages/operator-assistant-ui"].map(p => path.resolve(p))
  .find(p => fs.existsSync(path.join(p, "assistant_context.mjs")))!;
const { resolveInitialChatContext } = await import(pathToFileURL(path.join(root, "assistant_context.mjs")).href);
const request = (user_text: string, extra = {}) => ({ session_id: "session", message_id: "message", user_text, ...extra });

test("general engineering and document conversation bypass a blocked native bootstrap", async () => {
  for (const prompt of [...independentEngineeringQuestions, "What is static pressure in an HVAC duct? Keep it to two sentences.", "Make it shorter.",
    "Read the attached task list and tell me what HVAC design-development work it calls for. What do you need from me? Do not make model changes yet."]) {
    const body = request(prompt);
    assert.equal(assistantContextPolicy(body).requires_revit_context, false, prompt);
    const context = await resolveInitialChatContext(body, { readPolicy: assistantContextPolicy,
      readModelContext: () => { throw new Error("Native context should never be requested"); } });
    assert.equal(context.ui.authoritative_user_text, prompt);
    assert.equal(context.revit, undefined);
    assert.equal(context.ui.model_context_requested, false);
  }
});

test("selected elements, ambiguous references, mutation, and saved-task continuations retain live context", async () => {
  for (const body of [request("What is the diameter of the selected duct?"), request("What size is this? Keep it brief."),
    request("What is this?"), request("Set the selected duct diameter to 6 inches."), request("Continue"), request(""),
    request("Make it shorter.", { assignment_id: "saved" }), request("Make it shorter.", { assignment_generation: 0 }),
    request("Make it shorter.", { tool_results: [{ action_id: "done" }] })]) {
    assert.equal(assistantContextPolicy(body as any).requires_revit_context, true, JSON.stringify(body));
    const context = await resolveInitialChatContext(body, { readPolicy: assistantContextPolicy, readModelContext: () => ({ live: true }) });
    assert.deepEqual(context, { live: true });
  }
});

test("stale or malformed policy cannot skip native context; auth failure and cancellation do not proceed", async () => {
  const body = request("Explain static pressure.");
  const valid = assistantContextPolicy(body);
  for (const policy of [null, {}, { ...valid, message_id: "other" }, { ...valid, requires_revit_context: "false" }]) {
    assert.deepEqual(await resolveInitialChatContext(body, { readPolicy: () => policy, readModelContext: () => ({ live: true }) }), { live: true });
  }
  let calls = 0;
  for (const status of [401, 403]) await assert.rejects(resolveInitialChatContext(body, {
    readPolicy: () => { throw Object.assign(new Error("Forbidden"), { status }); }, readModelContext: () => { calls++; }
  }), /Forbidden/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveInitialChatContext(body, { signal: controller.signal, readPolicy: () => valid, readModelContext: () => { calls++; } }));
  assert.equal(calls, 0);
});
