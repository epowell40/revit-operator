using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common.Electrical
{
    public static class CircuitMatchPolicy
    {
        public const string None = "none";
        public const string MatchSourceSystem = "match_source_system";

        public static string NormalizeMode(string? value)
        {
            var mode = (value ?? string.Empty).Trim().ToLowerInvariant();
            if (mode.Length == 0 || mode == None) return None;
            if (mode == MatchSourceSystem) return MatchSourceSystem;
            throw new ArgumentException("Unsupported circuitMode. Expected 'none' or 'match_source_system'.");
        }

        public static bool IsPowerSystemType(string? value)
        {
            var type = (value ?? string.Empty).Trim();
            return type.Equals("PowerCircuit", StringComparison.OrdinalIgnoreCase) ||
                   type.Equals("PowerBalanced", StringComparison.OrdinalIgnoreCase) ||
                   type.Equals("PowerUnBalanced", StringComparison.OrdinalIgnoreCase);
        }

        public static bool HasExactMembership(long expectedSystemId, IEnumerable<long>? actualPowerSystemIds)
        {
            var ids = (actualPowerSystemIds ?? Enumerable.Empty<long>()).Distinct().ToList();
            return expectedSystemId > 0 && ids.Count == 1 && ids[0] == expectedSystemId;
        }

        public static double? FactualDelta(double? before, double? after)
        {
            if (!before.HasValue || !after.HasValue ||
                double.IsNaN(before.Value) || double.IsInfinity(before.Value) ||
                double.IsNaN(after.Value) || double.IsInfinity(after.Value)) return null;
            return after.Value - before.Value;
        }
    }
}
