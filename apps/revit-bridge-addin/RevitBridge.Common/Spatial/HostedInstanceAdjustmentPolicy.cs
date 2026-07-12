using System;

namespace RevitBridge.Common.Spatial
{
    public static class HostedInstanceAdjustmentPolicy
    {
        public static bool RequiresLinkedFaceReplacement(bool hostIsRevitLink, bool hasResolvedLinkedElement)
            => hostIsRevitLink && hasResolvedLinkedElement;

        public static double ResolveTargetElevationFt(
            double currentElevationFt,
            double resolvedTargetElevationFt,
            bool hasExplicitPoint)
        {
            if (!IsFinite(currentElevationFt)) throw new ArgumentOutOfRangeException(nameof(currentElevationFt));
            if (!IsFinite(resolvedTargetElevationFt)) throw new ArgumentOutOfRangeException(nameof(resolvedTargetElevationFt));
            return hasExplicitPoint ? resolvedTargetElevationFt : currentElevationFt;
        }

        private static bool IsFinite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    }
}
