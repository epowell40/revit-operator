namespace RevitBridge.Common.Annotation
{
    public static class TagWorkPolicy
    {
        public static bool RequiresFamilyResolution(bool dryRun, int plannedToTag)
        {
            return dryRun || plannedToTag > 0;
        }
    }
}
