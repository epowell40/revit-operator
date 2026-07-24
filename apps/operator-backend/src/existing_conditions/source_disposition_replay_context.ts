import {
  OPERATOR_BACKEND_CONTRACT_VERSION,
  type ChatRequest,
  type ChatResponse
} from "../contracts.js";
import {
  listLatestExistingConditionsSourceDispositionsV1,
  type ExistingConditionsSourceDispositionStateV1
} from "./source_disposition_ledger.js";
import {
  latestExistingConditionsSourceTargetManifestV1,
  type ExistingConditionsSourceTargetManifestStateV1,
  type ExistingConditionsSourceTargetV1
} from "./source_target_manifest_ledger.js";

const MAX_REPLAY_FRONTIER_TARGETS = 32;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isSourceDispositionContinuationRequest(req: ChatRequest): boolean {
  const text = String(req.user_text ?? "");
  return /source[\s_-]+disposition/i.test(text) ||
    /(?:source[\s_-]+target|sheet[\s_-]+target)[\s_-]+manifest/i.test(text) ||
    (/existing[\s_-]+conditions/i.test(text) && /\b(?:coverage|accounting|manifest)\b/i.test(text)) ||
    (/existing[\s_-]+conditions/i.test(text) && /\b(?:latest|last|persisted|saved|resume|continue)\b/i.test(text));
}

function isReadOnlyDispositionInspection(req: ChatRequest): boolean {
  const text = String(req.user_text ?? "");
  return isSourceDispositionContinuationRequest(req) &&
    (/\b(?:report|explain|show|tell)\b/i.test(text) ||
      /\b(?:do not|don't|without)\s+(?:modify|change|write|edit|draft)/i.test(text));
}

function requestsWholeDispositionFrontier(req: ChatRequest): boolean {
  const text = String(req.user_text ?? "");
  return /\b(?:all|every|frontier|frontiers|targets|unresolved|coverage|accounting|manifest)\b/i.test(text);
}

function frontierTarget(state: ExistingConditionsSourceDispositionStateV1): Record<string, unknown> {
  return {
    sequence: state.sequence,
    event_key: state.event_key,
    entry_sha256: state.entry_sha256,
    status: state.status,
    target_key: state.disposition.target_key,
    disposition: state.disposition.disposition,
    reason_code: state.disposition.reason_code,
    source_receipt_sha256: state.disposition.source_receipt_sha256,
    registration_context_id: state.disposition.registration_context_id,
    next_repair: state.disposition.next_repair,
    native_write_allowed: false
  };
}

function dispositionForManifestTarget(
  target: ExistingConditionsSourceTargetV1,
  dispositionByTarget: Map<string, ExistingConditionsSourceDispositionStateV1>
): { state: ExistingConditionsSourceDispositionStateV1; migratedFromTargetKey?: string } | null {
  const direct = dispositionByTarget.get(target.target_key.toLowerCase());
  if (direct) return { state: direct };
  const supersededTargetKey = target.supersedes_target_keys?.[0];
  if (!supersededTargetKey) return null;
  const migrated = dispositionByTarget.get(supersededTargetKey.toLowerCase());
  return migrated ? { state: migrated, migratedFromTargetKey: supersededTargetKey } : null;
}

function manifestTarget(
  target: ExistingConditionsSourceTargetV1,
  dispositionByTarget: Map<string, ExistingConditionsSourceDispositionStateV1>
): Record<string, unknown> {
  const match = dispositionForManifestTarget(target, dispositionByTarget);
  const disposition = match?.state;
  return {
    ...target,
    manifest_next_repair: target.next_repair,
    next_repair: disposition?.disposition.next_repair ?? target.next_repair,
    source_progress: target.source_status === "approved_exclusion"
      ? "approved_exclusion"
      : disposition?.disposition.disposition ?? "unregistered",
    ...(disposition ? { source_disposition_event_key: disposition.event_key } : {}),
    ...(match?.migratedFromTargetKey
      ? { source_progress_migrated_from_target_key: match.migratedFromTargetKey }
      : {})
  };
}

function sourceTargetManifestContext(
  state: ExistingConditionsSourceTargetManifestStateV1 | null,
  frontier: ExistingConditionsSourceDispositionStateV1[]
): Record<string, unknown> {
  if (!state) {
    return {
      schema: "operator.existing_conditions.source_target_manifest_context.v1",
      status: "not_found",
      total_targets: 0,
      targets: [],
      native_write_allowed: false
    };
  }
  const dispositionByTarget = new Map(frontier.map(value => [value.disposition.target_key.toLowerCase(), value] as const));
  const ordered = [...state.manifest.targets].sort((left, right) => {
    const leftTerminal = left.source_status === "approved_exclusion" ? 1 : 0;
    const rightTerminal = right.source_status === "approved_exclusion" ? 1 : 0;
    return leftTerminal - rightTerminal || left.target_key.localeCompare(right.target_key);
  });
  const bounded = ordered.slice(0, MAX_REPLAY_FRONTIER_TARGETS);
  const registered = ordered.filter(target => dispositionForManifestTarget(target, dispositionByTarget) !== null).length;
  return {
    schema: "operator.existing_conditions.source_target_manifest_context.v1",
    status: "available",
    sequence: state.sequence,
    event_key: state.event_key,
    entry_sha256: state.entry_sha256,
    package_fingerprint_sha256: state.manifest.package_fingerprint_sha256,
    source_receipt_sha256: state.manifest.source_receipt_sha256,
    source_accounting_closure: state.manifest.source_accounting_closure,
    source_mark_count: state.manifest.source_mark_count ?? state.manifest.target_count,
    total_targets: ordered.length,
    included_targets: bounded.length,
    truncated: bounded.length < ordered.length,
    counts: state.manifest.counts,
    source_mark_counts: state.manifest.source_mark_counts ?? state.manifest.counts,
    registered_source_dispositions: registered,
    unregistered_source_targets: ordered.filter(target =>
      target.source_status !== "approved_exclusion" && dispositionForManifestTarget(target, dispositionByTarget) === null
    ).length,
    targets: bounded.map(target => manifestTarget(target, dispositionByTarget)),
    native_write_allowed: false,
    continuation_contract:
      "The manifest proves complete source-mark accounting only. Select exactly one non-excluded target and perform only its exact next_repair; do not infer native-write authority or discard other targets."
  };
}

export function maybeBuildExistingConditionsSourceDispositionInspection(
  req: ChatRequest
): ChatResponse | null {
  if (!isReadOnlyDispositionInspection(req)) return null;
  const frontier = listLatestExistingConditionsSourceDispositionsV1(req.session_id);
  const manifestState = latestExistingConditionsSourceTargetManifestV1(req.session_id);
  const state = frontier.at(-1) ?? null;
  if (manifestState && (requestsWholeDispositionFrontier(req) || !state)) {
    const dispositionByTarget = new Map(frontier.map(value => [value.disposition.target_key.toLowerCase(), value] as const));
    const ordered = [...manifestState.manifest.targets].sort((left, right) => {
      const leftTerminal = left.source_status === "approved_exclusion" ? 1 : 0;
      const rightTerminal = right.source_status === "approved_exclusion" ? 1 : 0;
      return leftTerminal - rightTerminal || left.target_key.localeCompare(right.target_key);
    });
    const bounded = ordered.slice(0, MAX_REPLAY_FRONTIER_TARGETS);
    const lines = bounded.map((target, index) => {
      const disposition = dispositionForManifestTarget(target, dispositionByTarget)?.state;
      const progress = target.source_status === "approved_exclusion"
        ? "approved_exclusion"
        : disposition?.disposition.disposition ?? "unregistered";
      const effectiveNextRepair = disposition?.disposition.next_repair ?? target.next_repair;
      return `${index + 1}. ${target.target_key}: ${target.source_status}/${target.compilation_decision}/${progress}. Exact next repair: ${effectiveNextRepair}`;
    });
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `Persisted sheet source manifest: closure=1, ${ordered.length} one-action target(s) from ` +
        `${manifestState.manifest.source_mark_count ?? ordered.length} source mark(s); ` +
        `candidate=${manifestState.manifest.counts.candidate}, unresolved=${manifestState.manifest.counts.unresolved}, ` +
        `approved_exclusion=${manifestState.manifest.counts.approved_exclusion}. ${lines.join(" ")} ` +
        "Select exactly one non-excluded target and perform only its exact next repair. This source-accounting report did not dispatch a native Revit action.",
      actions: []
    };
  }
  if (!state) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        "No persisted existing-conditions source disposition exists for this Operator session, so there is no exact next repair to resume. I did not synthesize a source observation or dispatch a native Revit action. Reopen the original session or register a source-supported observation before continuing.",
      actions: []
    };
  }
  if (requestsWholeDispositionFrontier(req)) {
    const bounded = frontier.slice(-MAX_REPLAY_FRONTIER_TARGETS);
    const lines = bounded.map((candidate, index) =>
      `${index + 1}. ${candidate.disposition.target_key}: ${candidate.disposition.disposition} ` +
      `(${candidate.disposition.reason_code}). Exact next repair: ${candidate.disposition.next_repair}`
    );
    const omitted = frontier.length - bounded.length;
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `Persisted source frontier: ${frontier.length} target(s). ` +
        `${omitted > 0 ? `${omitted} older target(s) omitted from this bounded report. ` : ""}` +
        `${lines.join(" ")} Select exactly one target and perform only its exact next repair. ` +
        "This report did not repeat a source search or dispatch a native Revit action.",
      actions: []
    };
  }
  const disposition = state.disposition;
  const dispositionSummary = disposition.disposition === "abstained"
    ? `Target ${disposition.target_key} remains abstained because ${disposition.reason_code}.`
    : `Target ${disposition.target_key} has an accepted source-only observation (${disposition.reason_code}).`;
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message:
      `${dispositionSummary} Exact next repair: ${disposition.next_repair} ` +
      `This report resumed ledger event ${state.event_key}; it did not repeat the source search or dispatch a native Revit action.`,
    actions: []
  };
}

export function withLatestExistingConditionsSourceDispositionContext(
  req: ChatRequest
): ChatRequest {
  const frontier = listLatestExistingConditionsSourceDispositionsV1(req.session_id);
  const manifestState = latestExistingConditionsSourceTargetManifestV1(req.session_id);
  const state = frontier.at(-1) ?? null;
  if (!state) {
    if (!manifestState && !isSourceDispositionContinuationRequest(req)) return req;
    const context = record(req.context);
    const server = record(context.__server);
    return {
      ...req,
      context: {
        ...context,
        __server: {
          ...server,
          existing_conditions_source_disposition: {
            schema: "operator.existing_conditions.source_disposition_replay_context.v1",
            status: "not_found",
            native_write_allowed: false,
            continuation_contract:
              "No persisted source disposition exists for this session. Do not synthesize or register one without source evidence, and do not author a native action from this missing state."
          },
          existing_conditions_source_disposition_frontier: {
            schema: "operator.existing_conditions.source_disposition_frontier_context.v1",
            status: "not_found",
            total_targets: 0,
            targets: [],
            native_write_allowed: false
          },
          existing_conditions_source_target_manifest: sourceTargetManifestContext(manifestState, frontier)
        }
      }
    };
  }
  const context = record(req.context);
  const server = record(context.__server);
  const disposition = state.disposition;
  const boundedFrontier = frontier.slice(-MAX_REPLAY_FRONTIER_TARGETS);
  return {
    ...req,
    context: {
      ...context,
      __server: {
        ...server,
        existing_conditions_source_disposition: {
          schema: "operator.existing_conditions.source_disposition_replay_context.v1",
          sequence: state.sequence,
          event_key: state.event_key,
          entry_sha256: state.entry_sha256,
          status: state.status,
          target_key: disposition.target_key,
          disposition: disposition.disposition,
          reason_code: disposition.reason_code,
          package_fingerprint_sha256: disposition.package_fingerprint_sha256,
          source_receipt_sha256: disposition.source_receipt_sha256,
          source_receipt_schema: disposition.source_receipt_schema,
          source_frame_id: disposition.source_frame_id,
          registration_context_id: disposition.registration_context_id,
          evidence_group_ids: disposition.evidence_group_ids,
          next_repair: disposition.next_repair,
          native_write_allowed: false,
          continuation_contract: disposition.disposition === "abstained"
            ? "Continue from next_repair or another source-supported target. Do not repeat this accepted source search or author a native action for target_key unless a later accepted source observation supersedes event_key."
            : "This is accepted source-only knowledge, not native-write authority. Continue with the next bounded native verification required by next_repair."
        },
        existing_conditions_source_disposition_frontier: {
          schema: "operator.existing_conditions.source_disposition_frontier_context.v1",
          status: "available",
          total_targets: frontier.length,
          included_targets: boundedFrontier.length,
          truncated: boundedFrontier.length < frontier.length,
          targets: boundedFrontier.map(frontierTarget),
          native_write_allowed: false,
          continuation_contract:
            "Select exactly one target and its stored next_repair per turn. Preserve every other target and do not repeat accepted source searches or infer native writes from this source-only frontier."
        },
        existing_conditions_source_target_manifest: sourceTargetManifestContext(manifestState, frontier)
      }
    }
  };
}
