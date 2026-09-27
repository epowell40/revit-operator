import { kernelAssertV2 } from "./errors.js";
import type { AdvisoryCompletionProposalV1 } from "./execution_policy.js";

/** Assistant-owned memory, never native evidence or a completion gate. */
export type AdvisoryFollowupV2 = Readonly<{
  item_id: string; kind: "remaining_work" | "uncertainties"; text: string;
  source_version: number; source_field: "remaining_work" | "uncertainties" | "replacements"; source_index: number;
  parent_item_id?: string; last_mentioned_version: number;
  version: number; state: "open" | "resolved" | "deferred" | "superseded";
  verified: false; disposition_reason?: string;
}>;
export type AdvisoryFollowupDispositionV2 = Readonly<{
  command_id: string; item_id: string; expected_version: number;
  disposition: "resolved" | "deferred" | "superseded"; reason: string;
  replacements?: readonly Readonly<{ kind: "remaining_work" | "uncertainties"; text: string }>[];
}>;

/** Identity preserves exact kind/text and points into the immutable source event.
 * Omission does nothing. A repeated unfinished claim reopens a closed item. */
export function retainAdvisoryFollowupsV2(previous: readonly AdvisoryFollowupV2[] | undefined,
  proposal: AdvisoryCompletionProposalV1, version: number): readonly AdvisoryFollowupV2[] {
  const items = [...(previous ?? [])];
  for (const kind of ["remaining_work", "uncertainties"] as const) {
    proposal[kind].forEach((text, index) => {
      const at = items.findIndex(item => item.kind === kind && item.text === text);
      if (at < 0) items.push({ item_id: "followup:" + version + ":" + kind + ":" + index, kind, text,
        source_version: version, source_field: kind, source_index: index, last_mentioned_version: version,
        version, state: "open", verified: false });
      else {
        const old = items[at]!;
        const state = old.state === "deferred" ? "deferred" : "open";
        items[at] = { ...old, version, last_mentioned_version: version, state,
          ...(state === "open" ? { disposition_reason: undefined } : {}) };
      }
    });
  }
  return items;
}

export function dispositionAdvisoryFollowupV2(items: readonly AdvisoryFollowupV2[] | undefined,
  value: AdvisoryFollowupDispositionV2, version: number): readonly AdvisoryFollowupV2[] {
  kernelAssertV2(Boolean(value) && typeof value.command_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.command_id)
    && typeof value.item_id === "string" && value.item_id.length <= 100
    && Number.isSafeInteger(value.expected_version) && value.expected_version > 0
    && ["resolved", "deferred", "superseded"].includes(value.disposition)
    && typeof value.reason === "string" && value.reason.trim().length > 0 && value.reason.length <= 1000
    && Object.keys(value).every(key => ["command_id", "item_id", "expected_version", "disposition", "reason", "replacements"].includes(key)),
    "advisory_followup_disposition_invalid", "A bounded explicit unverified disposition and reason are required.");
  const item = items?.find(item => item.item_id === value.item_id);
  kernelAssertV2(item && item.version === value.expected_version, "advisory_followup_stale", "Read the current item before recording its disposition.");
  kernelAssertV2(item.state === "open" || item.state === "deferred", "advisory_followup_closed", "Only unfinished items accept a new disposition.");
  kernelAssertV2(value.disposition === "superseded"
    ? Array.isArray(value.replacements) && value.replacements.length > 0 && value.replacements.length <= 8
      && value.replacements.every(replacement => replacement && ["remaining_work", "uncertainties"].includes(replacement.kind)
        && typeof replacement.text === "string" && replacement.text.trim().length > 0 && replacement.text.length <= 1000
        && Object.keys(replacement).every(key => key === "kind" || key === "text")
        && !(replacement.kind === item.kind && replacement.text === item.text))
    : value.replacements === undefined,
    "advisory_followup_replacements_invalid", "Supersession must atomically retain one to eight bounded unfinished replacements, excluding the parent itself.");
  const next: AdvisoryFollowupV2[] = items!.map(item => item.item_id === value.item_id
    ? { ...item, state: value.disposition, disposition_reason: value.reason, version, verified: false } : item);
  for (const [index, replacement] of (value.replacements ?? []).entries()) {
    const at = next.findIndex(item => item.kind === replacement.kind && item.text === replacement.text);
    if (at < 0) next.push({ item_id: "followup:" + version + ":replacements:" + index, ...replacement,
      source_version: version, source_field: "replacements", source_index: index, parent_item_id: item.item_id,
      last_mentioned_version: version, version, state: "open", verified: false });
    else next[at] = { ...next[at]!, last_mentioned_version: version, version,
      state: next[at]!.state === "deferred" ? "deferred" : "open",
      ...(next[at]!.state === "deferred" ? {} : { disposition_reason: undefined }) };
  }
  return next;
}
