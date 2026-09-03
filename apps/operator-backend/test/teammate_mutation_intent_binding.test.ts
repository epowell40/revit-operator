import assert from "node:assert/strict";
import test from "node:test";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import {
  __testOnlyResetTeammateLoopState,
  beginTeammateLoopOwner,
  buildTeammateTurnContract,
  endTeammateLoopOwner,
  formatTeammateTurnContract,
  guardTeammateMcpCall
} from "../src/teammate_loop_runtime.js";

function request(userText: string): ChatRequest {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: `intent-binding-${Math.random()}`,
    message_id: `message-${Math.random()}`,
    user_text: userText,
    context: {
      revit: {
        source: { live: true },
        version: "Autodesk Revit 2024",
        process_id: 4242,
        courier_executor_id: "test-courier",
        document: {
          title: "Intent Binding Test",
          path: "C:\\fixtures\\intent-binding.rvt",
          projectIdentity: { fingerprint: "document-intent-binding" }
        }
      },
      ui: { authoritative_user_text: userText }
    }
  };
}

function replaceCall(newText: string, extra: Record<string, unknown> = {}) {
  return {
    tool: "revit_call_tool",
    arguments: {
      method: "POST",
      path: "/revit/replace-text-note",
      body: {
        elementId: 1478627,
        expectedOldText: "Chase for Electrical Conduit",
        newText,
        dryRun: true,
        apply: false,
        ...extra
      }
    }
  };
}

function withOwner(prompt: string, body: (owner: object) => void): void {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, request(prompt));
  try {
    body(owner);
  } finally {
    endTeammateLoopOwner(lease);
  }
}

test("underspecified text replacement cannot preview a model-invented desired value", () => {
  const prompt = "Replace the outdated selected note with the current issue wording without creating a duplicate.";
  withOwner(prompt, owner => {
    const grounding = guardTeammateMcpCall(owner, {
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/find-text-notes", body: { viewId: 1363433, elementIds: [1478627] } }
    });
    assert.equal(grounding.allowed, true, "read-only target grounding must remain available before clarification");

    const guessed = guardTeammateMcpCall(owner, replaceCall("Chase for Electrical Conduits"));
    assert.equal(guessed.allowed, false);
    assert.match(guessed.message || "", /desired postcondition.*authenticated user input/i);
    assert.match(formatTeammateTurnContract(request(prompt)), /replacement_text/);
  });
});

test("Candidate 30 nominal text replacement requests create the authenticated-input gap", () => {
  const prompt = "Find one project TextNote, report its exact identity, and preview a conditional text replacement that would not create a duplicate. Do not apply it.";
  const contract = buildTeammateTurnContract(request(prompt));
  assert.equal(contract.turn_kind, "inspection");
  assert.equal(contract.preview_required, true);
  assert.equal(contract.no_write, true);
  assert.equal(contract.stage, "ground");
  assert.deepEqual(contract.required_user_inputs, ["replacement_text"]);
  assert.match(formatTeammateTurnContract(request(prompt)), /operator_request_clarification.*replacement_text/);
});

test("synonymous placeholders do not authorize invented replacement text", () => {
  for (const prompt of [
    "Update the selected note to the approved wording.",
    "Replace the selected annotation with the latest issue text.",
    "Correct the selected TextNote using the current wording."
  ]) {
    withOwner(prompt, owner => {
      const gate = guardTeammateMcpCall(owner, replaceCall("MODEL INVENTED VALUE"));
      assert.equal(gate.allowed, false, prompt);
    });
  }
});

test("multiple user-provided alternatives require a choice before text replacement", () => {
  withOwner("Replace the selected note with either ISSUE A or ISSUE B.", owner => {
    const gate = guardTeammateMcpCall(owner, replaceCall("ISSUE A"));
    assert.equal(gate.allowed, false);
    assert.match(gate.message || "", /choice.*user input|desired postcondition/i);
  });
});

test("an exact authenticated replacement value permits preview and apply", () => {
  const replacement = "ISSUE 04 - COORDINATION SET - 2026-08-09\nVERIFY AGAINST CURRENT SHEET INDEX";
  const prompt = `Use this exact replacement wording:\n${replacement}`;
  withOwner(prompt, owner => {
    const preview = guardTeammateMcpCall(owner, replaceCall(replacement));
    assert.equal(preview.allowed, true);
    assert.equal(preview.call?.effect, "preview");
  });

  withOwner(prompt, owner => {
    const apply = guardTeammateMcpCall(owner, replaceCall(replacement, { dryRun: false, apply: true }));
    assert.equal(apply.allowed, true);
    assert.equal(apply.call?.effect, "apply");
    assert.deepEqual(apply.call?.expected_values, [`revit_text:${JSON.stringify(replacement)}`]);
  });
});

test("an explicitly quoted literal that resembles a placeholder remains authorized", () => {
  withOwner('Set the selected note to the exact literal text "CURRENT ISSUE WORDING".', owner => {
    const gate = guardTeammateMcpCall(owner, replaceCall("CURRENT ISSUE WORDING"));
    assert.equal(gate.allowed, true);
  });
});

test("a deterministic append instruction may authorize its derived exact text", () => {
  withOwner('Append the exact suffix " - VERIFIED" to the selected note.', owner => {
    const gate = guardTeammateMcpCall(owner, replaceCall("Chase for Electrical Conduit - VERIFIED"));
    assert.equal(gate.allowed, true);
  });
});

test("unrelated reads and fully specified parameter mutations are unchanged", () => {
  withOwner("Set selected equipment Mark to TEST-AHU-01.", owner => {
    const read = guardTeammateMcpCall(owner, {
      tool: "revit_get_parameters",
      arguments: { elementIds: [42], names: ["Mark"] }
    });
    assert.equal(read.allowed, true);

    const apply = guardTeammateMcpCall(owner, {
      tool: "revit_set_parameters",
      arguments: { changes: [{ elementId: 42, parameterName: "Mark", value: "TEST-AHU-01" }], apply: true }
    });
    assert.equal(apply.allowed, true);
  });
});
