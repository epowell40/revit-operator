namespace RevitBridge.Common
{
    /// <summary>Validates the exact existing-owner obligation before a route starts a transaction.</summary>
    public static class MepRouteEndpointContract
    {
        public static bool TryResolve(bool connectToExisting, bool requireBothLegacy, string? requiredEndpoint,
            long? startOwnerId, long? endOwnerId, out string normalized)
        {
            normalized = (requiredEndpoint ?? "").Trim().ToLowerInvariant();
            if (normalized.Length == 0)
                return !startOwnerId.HasValue && !endOwnerId.HasValue && (!requireBothLegacy || connectToExisting);
            // The explicit endpoint names the precise obligation. The legacy boolean
            // means both ends only when no explicit endpoint was supplied.
            if (!connectToExisting || normalized != "start" && normalized != "end" && normalized != "both") return false;
            if (normalized == "start") return startOwnerId > 0 && !endOwnerId.HasValue;
            if (normalized == "end") return endOwnerId > 0 && !startOwnerId.HasValue;
            return startOwnerId > 0 && endOwnerId > 0;
        }
    }
}
