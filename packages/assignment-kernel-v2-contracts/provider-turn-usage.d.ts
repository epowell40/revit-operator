export declare const PROVIDER_TURN_USAGE_V1_SCHEMA: "revit-operator.provider-turn-usage/v1";
export declare const PROVIDER_USAGE_COVERAGE_V1_SCHEMA: "revit-operator.provider-usage-coverage/v1";
export type ProviderTurnUsageV1 = {
  schema: typeof PROVIDER_TURN_USAGE_V1_SCHEMA;
  session_id: string;
  message_id: string;
  thread_id: string | null;
  turn_id: string | null;
  disposition: "not_started" | "completed" | "interrupted" | "failed";
  raw_response_ids: string[];
};
export type ProviderUsageAttemptV1 = { session_id: string | null; message_id: string | null;
  provider_turn_usage: ProviderTurnUsageV1 | null; conflicted: boolean; complete: boolean; missing_raw_response_ids: string[] };
export type ProviderUsageCoverageV1 = { schema: typeof PROVIDER_USAGE_COVERAGE_V1_SCHEMA;
  request_count: number; attempts: ProviderUsageAttemptV1[]; unassigned_raw_response_ids: string[];
  complete: boolean; no_provider_invocation: boolean };
export declare function parseProviderTurnUsageV1(value: unknown): ProviderTurnUsageV1;
export declare function buildProviderUsageCoverageV1(attempts: unknown, receipts: unknown): ProviderUsageCoverageV1;
export declare function createProviderUsageLedgerV1(): {
  begin(sessionId: string, messageId: string): void;
  observe(sessionId: string, messageId: string, response: unknown): void;
  snapshot(receipts: unknown): ProviderUsageCoverageV1 & { overflow: boolean };
};
