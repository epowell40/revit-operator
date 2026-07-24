import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AGENT_RESPONSE_STYLE_LINES } from "../src/agent_response_policy.js";
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
  assert.match(policy, /Progress updates should be sparse and useful/i);
  assert.match(policy, /Goal mode should use a natural acknowledgement/i);
  assert.match(policy, /Do not say "Plan:" unless/i);
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
