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

        public static bool IsExactPowerCircuitType(string? value)
        {
            return (value ?? string.Empty).Trim().Equals("PowerCircuit", StringComparison.OrdinalIgnoreCase);
        }

        public static bool HasExactMembership(long expectedSystemId, IEnumerable<long>? actualPowerSystemIds)
        {
            var ids = (actualPowerSystemIds ?? Enumerable.Empty<long>()).Distinct().ToList();
            return expectedSystemId > 0 && ids.Count == 1 && ids[0] == expectedSystemId;
        }

        public static bool HasExactElementSet(IEnumerable<long>? expectedElementIds, IEnumerable<long>? actualElementIds)
        {
            var expected = (expectedElementIds ?? Enumerable.Empty<long>()).OrderBy(id => id).ToList();
            var actual = (actualElementIds ?? Enumerable.Empty<long>()).OrderBy(id => id).ToList();
            return expected.Count > 0
                && expected.All(id => id > 0)
                && expected.Distinct().Count() == expected.Count
                && actual.All(id => id > 0)
                && actual.Distinct().Count() == actual.Count
                && expected.SequenceEqual(actual);
        }

        public static bool HasExactOptionalElementIdentity(long? expectedElementId, long? actualElementId)
        {
            if (!expectedElementId.HasValue) return !actualElementId.HasValue;
            return expectedElementId.Value > 0
                && actualElementId.HasValue
                && actualElementId.Value == expectedElementId.Value;
        }

        public static bool HasFactualLoadReadback(double? trueLoad, double? apparentLoad)
        {
            return IsFinite(trueLoad) || IsFinite(apparentLoad);
        }

        public static double? FactualDelta(double? before, double? after)
        {
            if (!before.HasValue || !after.HasValue ||
                double.IsNaN(before.Value) || double.IsInfinity(before.Value) ||
                double.IsNaN(after.Value) || double.IsInfinity(after.Value)) return null;
            return after.Value - before.Value;
        }

        private static bool IsFinite(double? value)
        {
            return value.HasValue && !double.IsNaN(value.Value) && !double.IsInfinity(value.Value);
        }
    }
}
