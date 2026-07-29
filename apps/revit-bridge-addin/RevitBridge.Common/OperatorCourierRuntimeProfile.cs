using System;

namespace RevitBridge.Common
{
    /// <summary>
    /// Legacy courier execution is deliberately confined to the one explicit
    /// local laboratory profile. Callers must not normalize, default, or infer
    /// these values because that would make v1 executable by accident.
    /// </summary>
    public static class OperatorCourierRuntimeProfile
    {
        public static bool IsExactDevelopmentLaboratory(string? runtimeMode, string? exposureProfile)
        {
            return string.Equals(runtimeMode, "development", StringComparison.Ordinal)
                && string.Equals(exposureProfile, "laboratory", StringComparison.Ordinal);
        }
    }
}
