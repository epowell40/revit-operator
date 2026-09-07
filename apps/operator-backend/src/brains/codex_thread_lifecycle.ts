import type { CodexAppServer } from "../codex/app_server.js";
import type { DynamicToolSpec } from "../codex/generated/app_server_0_149_0/v2/DynamicToolSpec.js";
import { appendEvent, getCodexThreadId, setCodexThreadId } from "../memory/sqlite_store.js";
import type { AgentModelSettings } from "../speed_config.js";
import { isMissingCodexThreadError } from "./codex_tool_observation.js";
import { codexTelemetryThreadKey } from "./codex_turn_model_telemetry.js";
import type { CodexThreadStartProfile } from "./codex_turn_profile.js";
import { assertConfiguredBenchmarkInstructions } from "../codex/instruction_binding.js";

export async function getOrCreateCodexThread(args: {
  sessionId: string;
  client: CodexAppServer;
  profile: CodexThreadStartProfile;
  cwd: string;
  settings: AgentModelSettings;
  getDynamicTools: () => Promise<DynamicToolSpec[]>;
  monitoringOnly?: boolean;
}): Promise<string> {
  const { client, profile, settings } = args;
  if (!args.monitoringOnly) assertConfiguredBenchmarkInstructions(profile);
  const threadKey = codexTelemetryThreadKey(profile);
  const existing = getCodexThreadId(threadKey);
  if (existing) {
    if (client.hasLoadedThread(existing)) {
      if (args.monitoringOnly) return existing;
      if (client.getThreadInstructionBinding(existing)) {
        client.assertThreadInstructions(existing, profile);
        return existing;
      }
      // Monitoring can load an active thread without establishing instruction
      // identity. Retry only metadata resume; never replay its previous turn.
    }
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
      if (!args.monitoringOnly) client.assertThreadInstructions(resumedThreadId, profile);
      setCodexThreadId(threadKey, resumedThreadId);
      try {
        appendEvent(args.sessionId, "assistant", "codex.thread.resume", profile.certified
          ? { thread_id: resumedThreadId, certified: true, host_instruction_binding: client.getThreadInstructionBinding(resumedThreadId) ?? null }
          : { thread_id: resumedThreadId, host_instruction_binding: client.getThreadInstructionBinding(resumedThreadId) ?? null });
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
      ? { thread_id: threadId, certified: true, host_instruction_binding: client.getThreadInstructionBinding(threadId) ?? null }
      : { thread_id: threadId, host_instruction_binding: client.getThreadInstructionBinding(threadId) ?? null });
  } catch {
    // The returned thread remains usable if event persistence is unavailable.
  }
  return threadId;
}
