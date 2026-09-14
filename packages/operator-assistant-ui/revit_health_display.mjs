/** Display-only polling must never occupy Revit's serialized API queue. */
export function cachedRevitHealthForDisplay(snapshot) {
  return {
    ...(snapshot || { ok: false, context: null, checked_at: null }),
    cached: true,
    deferred: true,
    authority: 'display_only',
    reason: snapshot ? 'caller_preferred_cached_health' : 'no_cached_health_available'
  };
}
