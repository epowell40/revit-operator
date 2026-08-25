import type { AssignmentOutcomeState, AssignmentRequestedEffect } from "../assignments/control_plane.js";

export const WORK_RETURN_SCHEMA = "revit-operator.work-return/v1" as const;

export type WorkReturnV1 = {
  schema: typeof WORK_RETURN_SCHEMA;
  work_return_id: string;
  work_return_hash: string;
  parent_work_return_id: string | null;
  assignment_id: string;
  run_id: string | null;
  generation: number;
  created_at: string;
  status: AssignmentOutcomeState;
  requested_effect: AssignmentRequestedEffect | null;
  status_reason: string;
  completed: string[];
  primary_artifacts: string[];
  deviations_or_open_items: string[];
  question: string | null;
  clarification_id: string | null;
  recommended_next_step: string;
  affected_targets: string[];
  visual_refs: string[];
  audit_packet_id: string | null;
};

export type PersistedWorkReturn = {
  work_return: WorkReturnV1;
  json_path: string;
  markdown_path: string;
  created: boolean;
};
