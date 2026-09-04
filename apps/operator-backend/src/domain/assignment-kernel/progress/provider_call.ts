import type { AssignmentBindingV2, CriterionIdV2 } from "../identity.js";
import { ASSIGNMENT_PROVIDER_CALL_V2_SCHEMA } from "@revitoperator/assignment-kernel-v2-contracts";

export const PROVIDER_CALL_V2_SCHEMA = ASSIGNMENT_PROVIDER_CALL_V2_SCHEMA;

export type ProviderCallStateV2 =
  | "admitted"
  | "dispatched"
  | "response_started"
  | "usage_received"
  | "completed"
  | "response_transport_completed";

export interface ProviderUsageV2 {
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
}

export interface ProviderCallV2 {
  schema: typeof PROVIDER_CALL_V2_SCHEMA;
  call_id: string;
  controller_turn_id?: string;
  binding: AssignmentBindingV2;
  state: ProviderCallStateV2;
  provider: string;
  model: string;
  reasoning_effort: string | null;
  gap_ids: readonly string[];
  criterion_ids: readonly CriterionIdV2[];
  expected_information: readonly string[];
  admitted_at: string;
  dispatched_at?: string;
  response_started_at?: string;
  usage_received_at?: string;
  completed_at?: string;
  /** Exact provider-only duration from the upstream receipt; null when unavailable. */
  provider_duration_ms?: number | null;
  response_transport_completed_at?: string;
  usage?: ProviderUsageV2;
  success?: boolean;
  error_class?: "provider" | "transport" | "canceled" | "resource_exhausted";
}
