export type TeammateVerificationAssertionV2 = Readonly<{
  schema: "revit-operator.teammate-verification-assertion/v2";
  action_id: string;
  mode: "target_bound_readback";
  evidence_sha256: string;
}>;

export function checkedTeammateVerificationAssertionV2(state:Readonly<{verified:boolean;verification_mode:string;verification_action_id:string|null;verification_evidence_sha256:string|null}>,actionId:string):TeammateVerificationAssertionV2|null {
  return state.verified
      && state.verification_mode === "target_bound_readback"
      && state.verification_action_id === actionId
      && state.verification_evidence_sha256
    ? {
        schema: "revit-operator.teammate-verification-assertion/v2",
        action_id: actionId,
        mode: "target_bound_readback",
        evidence_sha256: state.verification_evidence_sha256
      }
    : null;
}
