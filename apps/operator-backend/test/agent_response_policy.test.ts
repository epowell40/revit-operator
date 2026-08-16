import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  AGENT_RESPONSE_STYLE_LINES,
  classifyAgentTurn,
  formatAgentTurnContract
} from "../src/agent_response_policy.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ChatResponse } from "../src/contracts.js";
import { __testOnlyFinalizeOpenAiResponseForRequest } from "../src/brains/openai_brain.js";

const repoRoot = path.resolve(process.cwd(), "..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("agent response policy requires natural acknowledgement instead of routine visible plans", () => {
  const policy = AGENT_RESPONSE_STYLE_LINES.join("\n");

  assert.match(policy, /short natural acknowledgement/i);
  assert.match(policy, /Ask one focused clarifying question/i);
  assert.match(policy, /conversational Revit\/BIM expert, not a tool dispatcher/i);
  assert.match(policy, /Ground model-specific answers with the live model/i);
  assert.match(policy, /active view and current selection as starting context, not as a limit/i);
  assert.match(policy, /find an eligible view, sheet, schedule, element, or family yourself/i);
  assert.match(policy, /state the most likely interpretation/i);
  assert.match(policy, /identify the likely requested schedule and where it is placed/i);
  assert.match(policy, /Progress updates should be sparse and useful/i);
  assert.match(policy, /Goal mode should use a natural acknowledgement/i);
  assert.match(policy, /Do not say "Plan:" unless/i);
  assert.match(policy, /one certified typed capability/i);
  assert.match(policy, /composition of a few certified typed capabilities/i);
  assert.match(policy, /bounded task-specific Dynamic Revit program/i);
  assert.match(policy, /Do not route by prompt keywords or regexes/i);
  assert.match(policy, /grants no capability, admission, approval, or authorization/i);
});

test("backend prompts do not force Plan-prefixed action turns", () => {
  const openAiBrain = readRepoFile("operator-backend/src/brains/openai_brain.ts");
  const codexBrain = readRepoFile("operator-backend/src/brains/codex_brain.ts");

  assert.doesNotMatch(openAiBrain, /start with:\s*\\"Plan:/i);
  assert.doesNotMatch(openAiBrain, /If you need to act,\s*start with/i);
  assert.doesNotMatch(codexBrain, /start with:\s*\\"Plan:/i);
  assert.match(openAiBrain, /AGENT_RESPONSE_STYLE_LINES/);
  assert.match(codexBrain, /AGENT_RESPONSE_STYLE_LINES/);
});

test("per-turn teammate contract classifies representative conversation, navigation, inspection, and mutation requests", () => {
  assert.equal(classifyAgentTurn("Can you explain what a shock arrestor does?"), "conversation");
  assert.equal(classifyAgentTurn("Show me the air handling unit schedule."), "navigation");
  assert.equal(
    classifyAgentTurn("Where are the shock arrestors? Provide the room number for each device location."),
    "inspection"
  );
  assert.equal(
    classifyAgentTurn("Add a shock arrestor to the domestic water piping serving the toilet in room 2968T."),
    "mutation"
  );
  assert.equal(
    classifyAgentTurn("Show me exactly what would be affected before deleting anything."),
    "inspection"
  );
  assert.equal(
    classifyAgentTurn("The manufacturer is wrong for shock arrestor B2-G-SA-1. Change it from JOSAM to WATTS."),
    "mutation"
  );
  assert.equal(classifyAgentTurn("The expansion tank is the wrong size."), "mutation");
  assert.equal(classifyAgentTurn("ping"), "inspection");
  assert.equal(classifyAgentTurn("Can you explain how to change a parameter?"), "conversation");
});

test("per-turn teammate contract requires live grounding, focused clarification, tool discovery, and guarded verification", () => {
  const navigation = formatAgentTurnContract("Show me the air handling unit schedule.", {
    revit: {
      schema: "revit-operator.context.v1",
      source: { live: true },
      process_id: 42,
      document: { title: "Duke B200", path: "C:\\models\\duke.rvt" }
    }
  });
  const mutation = formatAgentTurnContract(
    "Add a shock arrestor to the domestic water piping serving the toilet in room 2968T.",
    { ui: { revit_document: { title: "Duke B200", path: "C:\\models\\duke.rvt", process_id: 42 } } }
  );
  const preview = formatAgentTurnContract("Show me what would be affected before deleting anything.");

  assert.match(navigation, /CURRENT TURN CONTRACT \(host-enforced\)/);
  assert.match(navigation, /"turn_kind":"navigation"/);
  assert.match(navigation, /"context_state":"live"/);
  assert.match(navigation, /never mutate the model/i);
  assert.match(mutation, /"turn_kind":"mutation"/);
  assert.match(mutation, /"context_state":"live"/);
  assert.match(mutation, /discover one exact contract/i);
  assert.match(mutation, /"max_apply_attempts":32/);
  assert.match(mutation, /atomic Revit primitives may apply directly/i);
  assert.match(mutation, /verify by readback\/capture/i);
  assert.match(preview, /"turn_kind":"inspection"/);
  assert.match(preview, /"context_state":"missing"/);
  assert.match(preview, /No-write wording is authoritative/i);
  assert.ok(mutation.length <= 1200);
});

test("Codex, OpenAI, and external provider prompts all include the per-turn teammate contract", () => {
  const openAiBrain = readRepoFile("operator-backend/src/brains/openai_brain.ts");
  const codexBrain = readRepoFile("operator-backend/src/brains/codex_brain.ts");
  const codexTurnProfile = readRepoFile("operator-backend/src/brains/codex_turn_profile.ts");
  const externalBrain = readRepoFile("operator-backend/src/brains/external_provider_brain.ts");

  assert.match(openAiBrain, /formatAgentTurnContract\(req\.user_text, req\.context\)/);
  assert.match(codexBrain, /formatCodexRequestEnvelope\(req\)/);
  assert.match(codexTurnProfile, /if \(isCertifiedSidecarRequest\(req\)\)/);
  assert.match(codexTurnProfile, /formatAgentTurnContract\(req\.user_text, req\.context\)/);
  assert.match(externalBrain, /formatAgentTurnContract\(currentUserRequest, req\.context\)/);
});

test("pre-model redline routing uses async recovery bridge", () => {
  const openAiBrain = readRepoFile("operator-backend/src/brains/openai_brain.ts");

  assert.match(openAiBrain, /const preModelBridge = await maybeBuildRedlineExecutionBridge\(currentReq, workbenchResults\);/);
  assert.doesNotMatch(openAiBrain, /maybeBuildRedlineExecutionBridgeCore\(\{\s*req:\s*currentReq/);
});

test("chat UI does not convert tool lifecycle into plan chatter", (t) => {
  const desktopAppPath = path.join(repoRoot, "operator-desktop/public/app.js");
  if (!fs.existsSync(desktopAppPath)) {
    t.skip("The standalone public core does not include the private desktop sidecar.");
    return;
  }
  const desktopApp = fs.readFileSync(desktopAppPath, "utf8");
  const embeddedPane = readRepoFile("revit-bridge-addin/RevitBridge/Operator/OperatorWebUiHtml.cs");

  assert.doesNotMatch(desktopApp, /appendActivityEvent\(`Plan:/);
  assert.doesNotMatch(desktopApp, /Planned actions:/);
  assert.doesNotMatch(embeddedPane, /appendEvent\('Plan: '/);
});

test("routine redline continuation action messages are quieted", () => {
  const response = __testOnlyFinalizeOpenAiResponseForRequest(
    {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: "quiet-redline-session",
      message_id: "m2",
      user_text: "add receptacle where indicated and circuit to same circuit as adjacent receptacle",
      tool_results: [
        {
          action_id: "frame",
          method: "POST" as const,
          path: "/revit/export-view-frame",
          status: "done" as const,
          result_json: { frameId: "frame-1" }
        }
      ]
    },
    {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: "I resolved the exemplar host context and will preview host-aware similar placement.",
      actions: [
        {
          action_id: "place",
          method: "POST",
          path: "/revit/create-similar-from-instance",
          body: { dryRun: true }
        }
      ]
    } satisfies ChatResponse
  );

  assert.equal(response.assistant_message, "");
  assert.equal(response.actions[0]?.path, "/revit/create-similar-from-instance");
});

test("redline blockers and final answers remain visible", () => {
  const baseReq = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "visible-redline-session",
    message_id: "m3",
    user_text: "",
    tool_results: [
      {
        action_id: "audit",
        method: "POST" as const,
        path: "/revit/audit-hosted-instance-placement",
        status: "done" as const,
        result_json: { ok: false }
      }
    ]
  } satisfies ChatRequest;
  const blocker = __testOnlyFinalizeOpenAiResponseForRequest(baseReq, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "The placement audit failed, so I’ll correct the mismatch before final verification.",
    actions: [{ action_id: "fix", method: "POST", path: "/revit/adjust-hosted-instance-on-host", body: {} }]
  });
  const final = __testOnlyFinalizeOpenAiResponseForRequest(baseReq, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Answer: Placed and verified receptacle 1735601.",
    actions: []
  });

  assert.match(blocker.assistant_message, /audit failed/i);
  assert.match(final.assistant_message, /Placed and verified/i);
});

test("identical completed read actions cannot replay within one user turn", () => {
  const sessionId = "read-replay-guard-session";
  const first = __testOnlyFinalizeOpenAiResponseForRequest(
    {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: "user-turn",
      user_text: "Draft existing conditions from this crop.",
      tool_results: []
    },
    {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: "I will inventory the bounded crop.",
      actions: [{
        action_id: "inventory-1",
        method: "POST",
        path: "/revit/export-visible-elements",
        body: { viewId: 12345678, modelBounds: [10, 20, 0, 30, 40, 20] }
      }]
    }
  );
  assert.equal(first.actions.length, 1);

  const replay = __testOnlyFinalizeOpenAiResponseForRequest(
    {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: "user-turn:assistant:2",
      user_text: "Draft existing conditions from this crop.",
      tool_results: [{
        action_id: "inventory-1",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: { ok: true, count: 40 }
      }]
    },
    {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: "I will inventory the bounded crop again.",
      actions: [{
        action_id: "inventory-renamed",
        method: "POST",
        path: "/revit/export-visible-elements",
        body: { viewId: 12345678, modelBounds: [10, 20, 0, 30, 40, 20] }
      }]
    }
  );
  assert.deepEqual(replay.actions, []);
  assert.match(replay.assistant_message, /identical read-only action/i);
});
