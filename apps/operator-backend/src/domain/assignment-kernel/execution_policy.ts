import type { AssignmentSpecV2 } from "./assignment_spec.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";
import {utf8TextSha256V2} from './canonical.js';

export type PdfWorkAllowanceV1 = {
  mode: "marked_pdf_sheets_v1";
  units: number;
  sources: { sha256: string; page_count: number; sheets: { page: number; comments: number; units: number }[] }[];
};

/** Host-owned, creation-time experiment choice. There is no policy-change event. */
export interface LocalAdvisoryExecutionPolicyV1 {
  mode: "local_advisory_v1";
  selected_by: "trusted_local_host";
  session_id: string;
  document_fingerprint: string;
  max_turns: number;
  max_provider_calls: number;
  max_operations: number;
  max_total_tokens: number;
  max_wall_clock_ms: number;
  /** New-task opt-in; ready checklist work is not a final handoff checkpoint. */
  ready_work_handoff?: 'continue_ready_work_v1';
  source_work_allowance?: PdfWorkAllowanceV1;
  /** New-task opt-in: bounded planning from an authoritative native source census. */
  native_scope_planning?: {
    mode:'native_inventory_planning_v1';scope_kind:'schedules';source_request_sha256:string;
    items_per_unit:5;max_units:4;
  };
  /** Frozen at creation; credit never changes write authority or completion truth. */
  progress_allowance?: {
    mode: "verified_native_changes_v1";
    max_provider_calls: number;
    max_operations: number;
    max_total_tokens: number;
    /** Optional creation-time ceiling; absent in historical fixed-clock policies. */
    max_wall_clock_ms?: number;
    /** Absent means historical operation-batch credits. Frozen for new tasks only. */
    credit_unit?: 'distinct_verified_targets_v1';
  };
}

export interface AdvisoryCompletionProposalV1 {
  claimed_completed: readonly string[];
  remaining_work: readonly string[];
  uncertainties: readonly string[];
}

export function advisoryVerificationV2(snapshot: Pick<AssignmentSnapshotV2, "spec">): boolean {
  return snapshot.spec.execution_policy?.mode === "local_advisory_v1";
}

export function validLocalAdvisoryPolicyV1(spec: AssignmentSpecV2): boolean {
  const policy = spec.execution_policy;
  if (!policy) return true;
  const bounded = (value: number, max: number) => Number.isSafeInteger(value) && value > 0 && value <= max;
  const source=policy.source_work_allowance;
  const sourceValid=!source || (source.mode==="marked_pdf_sheets_v1" && spec.requested_effect==="apply"
    && bounded(source.units,24) && Array.isArray(source.sources) && source.sources.length>0 && source.sources.length<=8
    && new Set(source.sources.map(s=>s.sha256)).size===source.sources.length
    && source.sources.every(s=>/^[a-f0-9]{64}$/.test(s.sha256) && bounded(s.page_count,100)
      && Array.isArray(s.sheets) && s.sheets.length>0 && s.sheets.length<=s.page_count
      && new Set(s.sheets.map(p=>p.page)).size===s.sheets.length && s.sheets.every(p=>bounded(p.page,s.page_count)
        && Number.isSafeInteger(p.comments) && p.comments>=0 && p.units===Math.max(1,Math.ceil(p.comments/5))))
    && source.units===source.sources.reduce((n,s)=>n+s.sheets.reduce((sum,p)=>sum+p.units,0),0));
  const callCeiling=source?2048:256,operationCeiling=source?8192:1024,tokenCeiling=source?256_000_000:32_000_000;
  return policy.mode === "local_advisory_v1" && policy.selected_by === "trusted_local_host"
    && policy.session_id === spec.binding.session_id && Boolean(policy.document_fingerprint)
    && policy.document_fingerprint === spec.binding.document_fingerprint
    && sourceValid && bounded(policy.max_turns, 16) && bounded(policy.max_provider_calls, callCeiling)
    && (policy.ready_work_handoff === undefined
      || policy.ready_work_handoff === 'continue_ready_work_v1' && spec.requested_effect === 'apply')
    && (policy.native_scope_planning===undefined||validNativeScopePlanningPolicyV1(spec))
    && bounded(policy.max_operations, operationCeiling) && bounded(policy.max_total_tokens, tokenCeiling)
    && bounded(policy.max_wall_clock_ms, 120 * 60_000)
    && (!policy.progress_allowance || (policy.progress_allowance.mode === "verified_native_changes_v1"
      && spec.requested_effect === "apply"
      && bounded(policy.progress_allowance.max_provider_calls, callCeiling)
      && policy.progress_allowance.max_provider_calls >= policy.max_provider_calls
      && bounded(policy.progress_allowance.max_operations, operationCeiling)
      && policy.progress_allowance.max_operations >= policy.max_operations
      && bounded(policy.progress_allowance.max_total_tokens, tokenCeiling)
      && policy.progress_allowance.max_total_tokens >= policy.max_total_tokens
      && (policy.progress_allowance.credit_unit === undefined
        || policy.progress_allowance.credit_unit === 'distinct_verified_targets_v1')
      && (policy.progress_allowance.max_wall_clock_ms === undefined
        || (bounded(policy.progress_allowance.max_wall_clock_ms,120*60_000)
          && policy.progress_allowance.max_wall_clock_ms >= policy.max_wall_clock_ms))));
}

export function validNativeScopePlanningPolicyV1(spec:AssignmentSpecV2):boolean {
 const p=spec.execution_policy,n=p?.native_scope_planning;
 return !!n&&p?.mode==='local_advisory_v1'&&p.selected_by==='trusted_local_host'&&spec.requested_effect==='apply'
   &&p.progress_allowance?.mode==='verified_native_changes_v1'&&!p.source_work_allowance
   &&n.mode==='native_inventory_planning_v1'&&n.scope_kind==='schedules'&&n.items_per_unit===5&&n.max_units===4
   &&typeof spec.source_user_request==='string'&&!!spec.source_user_request.trim()
   &&n.source_request_sha256===utf8TextSha256V2(spec.source_user_request);
}

export function validAdvisoryProposalV1(proposal: AdvisoryCompletionProposalV1): boolean {
  const fields = [proposal?.claimed_completed, proposal?.remaining_work, proposal?.uncertainties];
  return fields.every(items => Array.isArray(items) && items.length <= 24
    && items.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 1000))
    && fields.some(items => items.length > 0);
}
