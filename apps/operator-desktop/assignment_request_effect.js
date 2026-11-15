// The backend classifies the user's request once before creating its durable
// assignment. The desktop must never substitute a second permission guess.
export function readCanonicalAssignmentRequestedEffect(goal) {
  const effect = goal?.work_budget?.requested_effect;
  if (!["read", "preview", "apply"].includes(effect)) {
    throw new Error("Canonical Assignment requested effect was not returned by the backend; refusing unbound execution.");
  }
  return effect;
}
