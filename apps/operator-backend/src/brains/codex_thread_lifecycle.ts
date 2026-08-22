import type { CodexAppServer } from "../codex/app_server.js";
import type { DynamicToolSpec } from "../codex/generated/app_server_0_149_0/v2/DynamicToolSpec.js";
import { appendEvent, getCodexThreadId, setCodexThreadId } from "../memory/sqlite_store.js";
import type { AgentModelSettings } from "../speed_config.js";
import { isMissingCodexThreadError } from "./codex_tool_observation.js";
import { codexTelemetryThreadKey } from "./codex_turn_model_telemetry.js";
import type { CodexThreadStartProfile } from "./codex_turn_profile.js";

export async function getOrCreateCodexThread(args: {
  sessionId: string;
  client: CodexAppServer;
  profile: CodexThreadStartProfile;
  cwd: string;
  settings: AgentModelSettings;
  getDynamicTools: () => Promise<DynamicToolSpec[]>;
}): Promise<string> {
  const { client, profile, settings } = args;
  const threadKey = codexTelemetryThreadKey(profile);
  const existing = getCodexThreadId(threadKey);
  if (existing) {
    if (client.hasLoadedThread(existing)) return existing;
    try {
      const resumed = await client.resumeThread({
        threadId: existing,
        cwd: args.cwd,
        sandbox: profile.sandbox,
        approvalPolicy: profile.approvalPolicy,
        model: settings.model,
        config: { model_reasoning_effort: settings.reasoning_effort },
        baseInstructions: profile.baseInstructions,
        developerInstructions: profile.developerInstructions,
        excludeTurns: true
      });
      const resumedThreadId = resumed.thread.id;
      setCodexThreadId(threadKey, resumedThreadId);
      try {
        appendEvent(args.sessionId, "assistant", "codex.thread.resume", profile.certified
          ? { thread_id: resumedThreadId, certified: true }
          : { thread_id: resumedThreadId });
      } catch {
        // The durable thread mapping remains authoritative.
      }
      return resumedThreadId;
    } catch (error) {
      if (!isMissingCodexThreadError(error)) throw error;
      setCodexThreadId(threadKey, "");
      try {
        appendEvent(args.sessionId, "assistant", "codex.thread.replace_missing", { thread_id: existing });
      } catch {
        // A replacement can still be created if event persistence is unavailable.
      }
    }
  }

  const response = await client.startThread({
    cwd: args.cwd,
    sandbox: profile.sandbox,
    approvalPolicy: profile.approvalPolicy,
    model: settings.model,
    config: { model_reasoning_effort: settings.reasoning_effort },
    baseInstructions: profile.baseInstructions,
    developerInstructions: profile.developerInstructions,
    dynamicTools: await args.getDynamicTools(),
    experimentalRawEvents: true
  });
  const threadId = response.thread.id;
  setCodexThreadId(threadKey, threadId);
  try {
    appendEvent(args.sessionId, "assistant", "codex.thread.start", profile.certified
      ? { thread_id: threadId, certified: true }
      : { thread_id: threadId });
  } catch {
    // The returned thread remains usable if event persistence is unavailable.
  }
  return threadId;
}
