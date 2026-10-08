namespace RevitBridge.Common.Annotation
{
    public static class TagWorkPolicy
    {
        // Cooperative boundary between targets; a single Revit call cannot be preempted.
        public static bool DeferGeometryTarget(bool geometryAware, int attemptedCount, long elapsedMilliseconds)
            => geometryAware && (attemptedCount >= 5 || elapsedMilliseconds >= 20000);

        public static bool RequiresFamilyResolution(bool dryRun, int plannedToTag)
        {
            return dryRun || plannedToTag > 0;
        }

        public static bool KeepCreatedTag(bool geometryAware, bool hasMeasurableGeometry, bool collisionFree)
        {
            return !geometryAware || (hasMeasurableGeometry && collisionFree);
        }

        public static bool CanPrepareMeasuredLeader(
            bool leaderApplied,
            int taggedReferenceCount,
            bool isAlreadyFree,
            bool canAssignFree)
        {
            return leaderApplied && taggedReferenceCount == 1 && (isAlreadyFree || canAssignFree);
        }
    }
}
