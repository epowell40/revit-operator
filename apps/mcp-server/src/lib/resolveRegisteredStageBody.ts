type Binding = { assignment_id: string; run_id: string; generation: number; session_id: string };
type Resolver = { resolveRegisteredExistingConditionsStage(input: unknown): Promise<unknown> };

export async function resolveRegisteredStageBody(
  body: unknown, binding: Binding | null, resolver: Resolver
): Promise<unknown> {
  const reference = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown> : null;
  if (!reference || !Object.hasOwn(reference, "registered_stage_key")) return body;
  if (!binding) throw new Error("registered_existing_conditions_stage_v2_binding_required");
  const phase = reference.stage_phase;
  if (Object.keys(reference).sort().join(",") !== "dryRun,registered_stage_key,stage_phase"
      || typeof reference.registered_stage_key !== "string"
      || !reference.registered_stage_key.trim()
      || (phase !== "dry_run" && phase !== "apply")
      || reference.dryRun !== (phase === "dry_run")) {
    throw new Error("registered_existing_conditions_stage_reference_invalid");
  }
  const resolved = await resolver.resolveRegisteredExistingConditionsStage({
    assignment_id: binding.assignment_id, assignment_run_id: binding.run_id,
    assignment_generation: binding.generation, session_id: binding.session_id,
    registered_stage_key: reference.registered_stage_key, stage_phase: phase
  }) as Record<string, unknown>;
  if (resolved.stage_key !== reference.registered_stage_key
      || resolved.phase !== phase
      || !resolved.native_body || typeof resolved.native_body !== "object") {
    throw new Error("registered_existing_conditions_stage_reference_response_mismatch");
  }
  return resolved.native_body;
}
