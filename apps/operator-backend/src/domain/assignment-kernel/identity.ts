export type AssignmentIdV2 = string;
export type AssignmentRunIdV2 = string;
export type AssignmentGenerationV2 = number;
export type WorkUnitIdV2 = string;
export type OperationIdV2 = string;
export type ObservationIdV2 = string;
export type CriterionIdV2 = string;
export type InputVariableIdV2 = string;
export type SemanticFactIdV2 = string;

export interface AssignmentBindingV2 {
  assignment_id: AssignmentIdV2;
  run_id: AssignmentRunIdV2;
  generation: AssignmentGenerationV2;
  session_id: string;
  principal_id: string;
  document_fingerprint?: string;
}

export function sameAssignmentBindingV2(
  left: AssignmentBindingV2,
  right: AssignmentBindingV2
): boolean {
  return left.assignment_id === right.assignment_id
    && left.run_id === right.run_id
    && left.generation === right.generation
    && left.session_id === right.session_id
    && left.principal_id === right.principal_id
    && left.document_fingerprint === right.document_fingerprint;
}
