import type { TeammateLoopState } from "./teammate_loop_runtime.js";

export function clearVerification(state: TeammateLoopState): void {
  state.verified = false;
  state.verification_mode = "none";
  state.verification_action_id = null;
  state.verification_evidence_sha256 = null;
  state.verification_observed_target_tokens.clear();
  state.verification_observed_values.clear();
  state.verification_has_substantive_readback = false;
}


export function clearKnownNoEffectApply(state: TeammateLoopState): void {
  state.stage_apply_attempts = Math.max(0, state.stage_apply_attempts - 1);
  state.apply_action_id = null;
  state.apply_succeeded = false;
  state.apply_signature = "";
  state.apply_target_tokens.clear();
  state.apply_target_tokens_inferred = false;
  state.apply_expected_values.clear();
  state.apply_call = null;
  clearVerification(state);
  state.blocked_reason = null;
  state.contract.stage = state.successful_preview_signatures.size > 0 ? "preview" : "apply";
}

