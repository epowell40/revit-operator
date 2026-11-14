import assert from "node:assert/strict";
import test from "node:test";
import { deterministicNamedObjectTopologyTask } from "../src/aec_semantic_task_interpreter.js";
import { resolveAecTaskIntentHttp } from "../src/aec_task_intent_http.js";

const drafting = "In a new drafting view named Airflow Schematic Round2, draw a clear left-to-right 2D schematic with a rectangular FILTER, a circular FAN, and a rectangular COIL. Connect them with straight centerlines and show airflow arrows pointing toward the coil. Put each name beneath its symbol, with a title AIRFLOW SCHEMATIC above. Use native editable Revit detail lines/curves and text, not a raster image. Choose sensible spacing and a readable scale. Inspect the completed drawing and correct any overlapping labels or missing connections. Keep existing views and model contents unchanged. Do not save yet. Report what you completed and any limitations.";
const mixed = [drafting,
  "Inspect the pump connections, then connect the loose pipe.",
  "What are the pumps connected to? Draw a schematic of them.",
  "Inspect the drawing and correct the missing connections.",
  "Trace the pump connections. Rotate the pump.",
  "Put a fan beside the filter. Inspect the fan connectors.",
  "What is the pump connected to? Also inspect the lighting plans."];

test("topology classifier does not capture an inspection clause from a construction or broader task", () => {
  for (const prompt of mixed) assert.equal(deterministicNamedObjectTopologyTask(prompt), null, prompt);
});

test("HTTP routing preserves the full drafting task for the ordinary owner without a provider preflight", async () => {
  let providerCalls = 0;
  for (const user_text of mixed) {
    const result = await resolveAecTaskIntentHttp({user_text}, {async interpret() {providerCalls++; return null;}});
    assert.equal(result.body.handled, false, user_text);
    assert.equal(result.body.workflow_id, null);
  }
  assert.equal(providerCalls, 0);
});

test("bounded whole-request topology questions retain literal identity and readonly constraints", async () => {
  for (const [prompt, identity] of [
    ["What are the shock arrestors connected to? Summarize the pipe system and flag any that aren't connected. Don't change anything.", "shock arrestors"],
    ["Please inspect the pump connectors. Do not modify the model.", "pump"],
    ["What do the VAV boxes connect to?", "vav boxes"],
    ["Which duct system are the supply diffusers connected to?", "supply diffusers"],
    ["Are any expansion tanks disconnected?", "expansion tanks"]
  ]) {
    const task = deterministicNamedObjectTopologyTask(prompt);
    assert.deepEqual(task?.subject.terms, [identity], prompt);
    const result = await resolveAecTaskIntentHttp({user_text:prompt});
    assert.equal(result.body.workflow_id, "query.document_elements", prompt);
    assert.equal(task?.mutation.requested, false);
  }
});
