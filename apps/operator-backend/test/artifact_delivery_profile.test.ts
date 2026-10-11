import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getOperatorAgentBaseInstructions } from "../src/brains/codex_brain_instructions.js";
import { getThinReferenceCodexProfile } from "../src/brains/codex_turn_profile.js";
import { REVIT_ARTIFACT_DELIVERY_GUIDANCE } from "../src/brains/revit_artifact_delivery_guidance.js";
import { hostInstructionBinding, assertHostInstructionBinding, CodexInstructionBindingError } from "../src/codex/instruction_binding.js";

test("artifact delivery requirements reach normal, thin and active advisory profiles exactly once", () => {
  const profiles = [
    { baseInstructions: getOperatorAgentBaseInstructions(), developerInstructions: "" },
    getThinReferenceCodexProfile("artifact-profile"),
    getThinReferenceCodexProfile("artifact-profile", true)
  ];
  for (const profile of profiles) {
    assert.equal(profile.baseInstructions.split(REVIT_ARTIFACT_DELIVERY_GUIDANCE).length, 2);
    assert.ok(profile.baseInstructions.includes("print_settings_restored=true"));
    assert.ok(profile.baseInstructions.includes("/revit/inspect-exported-files"));
    assert.ok(profile.baseInstructions.includes("operator_read_output_pdf"));
    assert.ok(profile.baseInstructions.includes("inspect and reconcile the existing attempt first"));
    const expectedHash = createHash("sha256").update(JSON.stringify(profile.baseInstructions)).digest("hex");
    assert.equal(hostInstructionBinding(profile).prompt_sha256, expectedHash);
    const missing = { ...profile, baseInstructions: profile.baseInstructions.replace(REVIT_ARTIFACT_DELIVERY_GUIDANCE, "") };
    assert.notEqual(hostInstructionBinding(missing).prompt_sha256, expectedHash,
      "delivery receipt must distinguish a profile missing the actual guidance");
    assert.throws(() => assertHostInstructionBinding(hostInstructionBinding(missing), hostInstructionBinding(profile)),
      (error: unknown) => error instanceof CodexInstructionBindingError && error.providerDispatched === false);
    assert.doesNotThrow(() => assertHostInstructionBinding(hostInstructionBinding(profile), hostInstructionBinding(profile)));
  }
});

test("shared delivery guidance preserves user destination and unknown-effect fences", () => {
  assert.match(REVIT_ARTIFACT_DELIVERY_GUIDANCE, /user's destination or the default workspace-relative artifacts\/prints folder/);
  assert.match(REVIT_ARTIFACT_DELIVERY_GUIDANCE, /never invent an OS temp\/test-run directory/);
  assert.match(REVIT_ARTIFACT_DELIVERY_GUIDANCE, /Do not re-export to verify or retry a failed print\/export with unknown effects/);
  assert.match(REVIT_ARTIFACT_DELIVERY_GUIDANCE, /inspect returned page images and coverage/);
});
