import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";
import { postconditionSatisfiedByPayloadV2 } from "../src/postcondition_verification_v2.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner, guardTeammateMcpCall, recordTeammateMcpResult, teammateLoopReceiptForOwner } from "../src/teammate_loop_runtime.js";
const fixture = (name: string) => JSON.parse(readFileSync(resolve("test/fixtures/air-device-parameter-" + name + ".json"), "utf8").replace(/^\uFEFF/, ""));

test("retained 16-field air-device apply verifies actual values at postcondition and controller boundaries", () => {
  for (const corrupt of [false, true]) {
    const input = fixture("request"), payload = fixture("apply");
    if (corrupt) {
      payload.verification.find((r: any) => r.parameterName === "Description").actual = { storageType: "String", value: "WRONG", valueString: "WRONG" };
      // Remove the alternate authentic readback too: an intact results.after is still evidence.
      payload.results = [];
    }
    assert.equal(postconditionSatisfiedByPayloadV2(input, payload), !corrupt);
    const owner = {};
    const lease = beginTeammateLoopOwner(owner, {
      version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "retained-air", message_id: "air-" + corrupt,
      user_text: "Set the air device type marks and Titus grille parameters, then create an air device schedule.",
      context: { revit: { source: { live: true }, process_id: 70412, courier_executor_id: "fixture", document: { title: "Snowdon Towers Sample HVAC", path: "C:\\lab\\HVAC.rvt", projectIdentity: { fingerprint: "sample" } } } }
    });
    try {
      const gate = guardTeammateMcpCall(owner, { tool: "revit_call_tool", arguments: input });
      assert.equal(gate.allowed, true, gate.message);
      recordTeammateMcpResult(owner, gate, { content: [{ type: "text", text: JSON.stringify(payload) }] });
      assert.equal(teammateLoopReceiptForOwner(owner)?.verified, !corrupt);
      const next = guardTeammateMcpCall(owner, { tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/create-schedule", body: { name: "Air Device Schedule", category: "OST_DuctTerminal", dryRun: true } } });
      assert.equal(next.allowed, !corrupt, next.message);
    } finally { endTeammateLoopOwner(lease); }
  }
});

