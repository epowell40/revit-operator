import type { ChatRequest } from "./contracts.js";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type SpeedRouteKind = "classic" | "planner" | "executor";

export type SpeedSettings = {
  agent_model: string;
  agent_reasoning_effort: ReasoningEffort;
  speed_mode: boolean;
  split_planner_executor: boolean;
  planner_model: string;
  planner_reasoning_effort: ReasoningEffort;
  executor_model: string;
  executor_reasoning_effort: ReasoningEffort;
  force_planner: boolean;
  force_executor: boolean;
  context_diet: boolean;
  max_recent_turns: number;
  include_full_revit_state: boolean;
  include_screenshot_every_turn: boolean;
  verbose_tool_results: boolean;
  batch_execution: boolean;
  persistent_session_mode: boolean;
};

export type AgentModelSettings = {
  model: string;
  reasoning_effort: ReasoningEffort;
};

export type SpeedRouteDecision = {
  route: SpeedRouteKind;
  reason: string;
  model: string;
  reasoning_effort: ReasoningEffort;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  return fallback;
}

function intValue(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(`${value ?? ""}`.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function isSafeModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized);
}

export function normalizeModelId(value: unknown, fallback: string): string {
  return isSafeModelId(value) ? value.trim() : fallback;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "none" || normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "xhigh" || normalized === "max";
}

export function normalizeReasoningEffort(value: unknown, fallback: ReasoningEffort = "medium"): ReasoningEffort {
  return isReasoningEffort(value) ? value.trim().toLowerCase() as ReasoningEffort : fallback;
}

export function resolveSpeedSettings(context: unknown): SpeedSettings {
  const ui = asRecord(asRecord(context).ui);
  const raw = asRecord(ui.speed_settings ?? ui.speedSettings);
  const envSpeed = boolValue(process.env.OPERATOR_SPEED_MODE, true);
  const speedMode = boolValue(raw.speed_mode ?? raw.speedMode, envSpeed);
  const agentModel = normalizeModelId(
    raw.agent_model ?? raw.agentModel,
    normalizeModelId(process.env.OPERATOR_AGENT_MODEL,
      normalizeModelId(process.env.OPERATOR_CODEX_MODEL, "gpt-5.6-sol"))
  );
  const agentReasoningEffort = normalizeReasoningEffort(
    raw.agent_reasoning_effort ?? raw.agentReasoningEffort,
    normalizeReasoningEffort(process.env.OPERATOR_AGENT_REASONING_EFFORT
      ?? process.env.OPERATOR_CODEX_REASONING_EFFORT, "medium")
  );

  return {
    agent_model: agentModel,
    agent_reasoning_effort: agentReasoningEffort,
    speed_mode: speedMode,
    // Compatibility aliases for the explicitly selected legacy OpenAI brain.
    // They deliberately cannot express a split configuration anymore.
    split_planner_executor: false,
    planner_model: agentModel,
    planner_reasoning_effort: agentReasoningEffort,
    executor_model: agentModel,
    executor_reasoning_effort: agentReasoningEffort,
    force_planner: false,
    force_executor: false,
    context_diet: boolValue(raw.context_diet ?? raw.contextDiet, true),
    max_recent_turns: intValue(raw.max_recent_turns ?? raw.maxRecentTurns, 8, 2, 40),
    include_full_revit_state: boolValue(raw.include_full_revit_state ?? raw.includeFullRevitState, !speedMode),
    include_screenshot_every_turn: boolValue(raw.include_screenshot_every_turn ?? raw.includeScreenshotEveryTurn, false),
    verbose_tool_results: boolValue(raw.verbose_tool_results ?? raw.verboseToolResults, !speedMode),
    batch_execution: boolValue(raw.batch_execution ?? raw.batchExecution, false),
    persistent_session_mode: boolValue(raw.persistent_session_mode ?? raw.persistentSessionMode, false)
  };
}

export function resolveAgentModelSettings(context: unknown): AgentModelSettings {
  const settings = resolveSpeedSettings(context);
  return { model: settings.agent_model, reasoning_effort: settings.agent_reasoning_effort };
}

function hasFailedToolResult(req: ChatRequest): boolean {
  return Array.isArray(req.tool_results) && req.tool_results.some((r) => r?.status === "failed");
}

function hasVisualAttachment(req: ChatRequest): boolean {
  const attachments = Array.isArray(req.user_attachments) ? req.user_attachments : [];
  return attachments.some((a) => /\.(png|jpe?g|pdf)$/i.test(`${a?.filename || a?.relative_path || a?.external_path || ""}`));
}

function directCommandReason(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (/\b(select|show|hide|rename|sync|synchronize|place|create|duplicate|export|count|list|find|open|activate|set|change|update|move|rotate|tag)\b/.test(t)) {
    if (/\b(why|decide|design|recommend|compare|strategy|schema|code|debug|troubleshoot|recover|ambiguous|unknown|analyze|interpret)\b/.test(t)) {
      return null;
    }
    return "known direct command";
  }
  return null;
}

function plannerReason(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (/[?]/.test(t)) return "question or ambiguous request";
  if (/\b(plan|design|analyze|interpret|decide|recommend|compare|recover|fix|debug|troubleshoot|why|how should|code|schema|redline|visual|screenshot)\b/.test(t)) {
    return "reasoning or interpretation requested";
  }
  if (t.length > 220) return "long request needs planning";
  return null;
}

export function selectSpeedRoute(req: ChatRequest, settings: SpeedSettings, defaults: { model: string; reasoning_effort: ReasoningEffort }): SpeedRouteDecision {
  if (!settings.speed_mode) {
    return { route: "classic", reason: "speed mode off", model: defaults.model, reasoning_effort: defaults.reasoning_effort };
  }
  if (!settings.split_planner_executor) {
    return { route: "classic", reason: "single-model speed mode", model: settings.executor_model, reasoning_effort: settings.executor_reasoning_effort };
  }
  if (settings.force_planner && !settings.force_executor) {
    return { route: "planner", reason: "force planner enabled", model: settings.planner_model, reasoning_effort: settings.planner_reasoning_effort };
  }
  if (settings.force_executor && !settings.force_planner) {
    return { route: "executor", reason: "force executor enabled", model: settings.executor_model, reasoning_effort: settings.executor_reasoning_effort };
  }
  if (hasFailedToolResult(req)) {
    return { route: "planner", reason: "previous tool call failed", model: settings.planner_model, reasoning_effort: settings.planner_reasoning_effort };
  }
  if (hasVisualAttachment(req)) {
    return { route: "planner", reason: "visual or document attachment needs interpretation", model: settings.planner_model, reasoning_effort: settings.planner_reasoning_effort };
  }
  const text = `${req.user_text ?? ""}`.trim();
  if (Array.isArray(req.tool_results) && req.tool_results.length > 0 && !text) {
    return { route: "executor", reason: "tool-loop continuation", model: settings.executor_model, reasoning_effort: settings.executor_reasoning_effort };
  }
  const direct = directCommandReason(text);
  if (direct) {
    return { route: "executor", reason: direct, model: settings.executor_model, reasoning_effort: settings.executor_reasoning_effort };
  }
  const plan = plannerReason(text);
  if (plan) {
    return { route: "planner", reason: plan, model: settings.planner_model, reasoning_effort: settings.planner_reasoning_effort };
  }
  return { route: "planner", reason: "conservative fallback", model: settings.planner_model, reasoning_effort: settings.planner_reasoning_effort };
}

export function approxPayloadChars(value: unknown): number {
  try {
    return typeof value === "string" ? value.length : JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}
