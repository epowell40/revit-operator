import type { CodexAppServer } from "../codex/app_server.js";
import type { DynamicToolSpec } from "../codex/generated/app_server_0_149_0/v2/DynamicToolSpec.js";
import { appendEvent, getCodexThreadId, setCodexThreadId, getCodexThreadCapabilities, bindCodexThreadCapabilities } from "../memory/sqlite_store.js";
import { codexToolCatalogHash, codexCapabilityHandoff } from "./codex_tool_catalog.js";
import type { AgentModelSettings } from "../speed_config.js";
import { isMissingCodexThreadError } from "./codex_tool_observation.js";
import { codexTelemetryThreadKey } from "./codex_turn_model_telemetry.js";
import type { CodexThreadStartProfile } from "./codex_turn_profile.js";
import { assertConfiguredBenchmarkInstructions } from "../codex/instruction_binding.js";
import { codexResearchConfig } from "../codex/research_config.js";

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
  if (args.monitoringOnly && !existing) throw new Error("There is no existing provider thread to monitor.");
  const tools = args.monitoringOnly ? null : await args.getDynamicTools();
  const toolHash = tools ? codexToolCatalogHash(tools) : null;
  const catalogChanged = Boolean(existing && toolHash && getCodexThreadCapabilities(existing)?.tool_sha256 !== toolHash);
  let previousThreadId: string | null = null;
  if (existing) {
    if (!catalogChanged && client.hasLoadedThread(existing)) {
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
        config: { model_reasoning_effort: settings.reasoning_effort, ...codexResearchConfig(profile.certified) },
        baseInstructions: profile.baseInstructions,
        developerInstructions: profile.developerInstructions,
        excludeTurns: true
      });
      const resumedThreadId = resumed.thread.id;
      if (!args.monitoringOnly) client.assertThreadInstructions(resumedThreadId, profile);
      if (catalogChanged) {
        if (resumed.thread.status?.type !== "idle") throw new Error("The provider tool catalog changed while its prior thread is active. Finish or recover that turn before updating capabilities.");
        previousThreadId = resumedThreadId;
      } else {
        setCodexThreadId(threadKey, resumedThreadId);
        try {
          appendEvent(args.sessionId, "assistant", "codex.thread.resume", profile.certified
            ? { thread_id: resumedThreadId, certified: true, host_instruction_binding: client.getThreadInstructionBinding(resumedThreadId) ?? null }
            : { thread_id: resumedThreadId, host_instruction_binding: client.getThreadInstructionBinding(resumedThreadId) ?? null });
        } catch {
          // The durable thread mapping remains authoritative.
        }
        return resumedThreadId;
      }
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
    config: { model_reasoning_effort: settings.reasoning_effort, ...codexResearchConfig(profile.certified) },
    baseInstructions: profile.baseInstructions,
    developerInstructions: profile.developerInstructions,
    dynamicTools: tools ?? await args.getDynamicTools(),
    experimentalRawEvents: true
  });
  const threadId = response.thread.id;
  bindCodexThreadCapabilities(threadKey, threadId, toolHash ?? codexToolCatalogHash([]), previousThreadId,
    previousThreadId ? codexCapabilityHandoff(args.sessionId, previousThreadId) : "");
  if (previousThreadId) appendEvent(args.sessionId, "assistant", "codex.thread.capabilities_updated", {
    previous_thread_id: previousThreadId, thread_id: threadId, tool_sha256: toolHash,
    conversation_preserved: true, assignment_restarted: false
  });
  try {
    appendEvent(args.sessionId, "assistant", "codex.thread.start", profile.certified
      ? { thread_id: threadId, certified: true, host_instruction_binding: client.getThreadInstructionBinding(threadId) ?? null }
      : { thread_id: threadId, host_instruction_binding: client.getThreadInstructionBinding(threadId) ?? null });
  } catch {
    // The returned thread remains usable if event persistence is unavailable.
  }
  return threadId;
}
