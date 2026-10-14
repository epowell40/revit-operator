using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common.Electrical
{
    public static class CircuitMatchPolicy
    {
        public const string None = "none";
        public const string MatchSourceSystem = "match_source_system";

        public static void RequireNativeMemberBatch(IEnumerable<long> memberElementIds)
        {
            var members = memberElementIds.ToList();
            RequirePositiveMembers(members);
            if (members.Count > 100 || members.Distinct().Count() != members.Count)
                throw new InvalidOperationException("native_power_circuit_requires_at_most_100_unique_member_ids");
        }

        public static void RequireNativeAssignmentMode(long? sourceElementId, long? electricalSystemId,
            string? createSystemType, bool parameterOnlyFallback, string? panelName, string? circuitNumber)
        {
            if (parameterOnlyFallback || !string.IsNullOrWhiteSpace(panelName) || !string.IsNullOrWhiteSpace(circuitNumber))
                throw new InvalidOperationException("circuit_assignment_requires_native_membership; use set-parameter for explicit label-only changes");
            var modes = (sourceElementId.HasValue ? 1 : 0) + (electricalSystemId.HasValue ? 1 : 0) +
                (!string.IsNullOrWhiteSpace(createSystemType) ? 1 : 0);
            if (modes != 1) throw new InvalidOperationException("select_exactly_one_native_circuit_assignment_mode");
            if (!string.IsNullOrWhiteSpace(createSystemType) && !IsExactPowerCircuitType(createSystemType))
                throw new InvalidOperationException("createSystemType must be PowerCircuit when supplied.");
        }

        public static void RequireSourceAssignmentRequest(long sourceElementId, IEnumerable<long> targetElementIds,
            bool hasOtherAssignmentMode)
        {
            if (sourceElementId <= 0) throw new InvalidOperationException("source_element_id_must_be_positive");
            if (hasOtherAssignmentMode) throw new InvalidOperationException("source_power_circuit_mode_cannot_create_move_or_use_parameter_fallback");
            var targets = targetElementIds.ToList();
            if (targets.Count == 0 || targets.Any(id => id <= 0))
                throw new InvalidOperationException("source_power_circuit_requires_positive_target_element_ids");
        }

        public static void RequireCircuitMoveRequest(long systemElementId, long? panelElementId, int? slotNumber,
            IEnumerable<long> memberElementIds, bool hasOtherAssignmentMode)
        {
            if (systemElementId <= 0) throw new InvalidOperationException("electrical_system_id_must_be_positive");
            if (hasOtherAssignmentMode) throw new InvalidOperationException("existing_power_circuit_move_cannot_mix_assignment_modes");
            if (!panelElementId.HasValue || panelElementId.Value <= 0)
                throw new InvalidOperationException("existing_power_circuit_move_requires_panel_element_id");
            if (!slotNumber.HasValue || slotNumber.Value <= 0)
                throw new InvalidOperationException("existing_power_circuit_move_requires_positive_target_panel_slot_number");
            RequirePositiveMembers(memberElementIds);
        }

        public static void RequireCircuitCreateRequest(IEnumerable<long> memberElementIds, long? panelElementId,
            int? slotNumber, long? connectorId, string? expectedCircuitNumber, bool hasOtherAssignmentMode)
        {
            var members = memberElementIds.ToList();
            RequirePositiveMembers(members);
            if (hasOtherAssignmentMode) throw new InvalidOperationException("new_power_circuit_cannot_mix_assignment_modes");
            if (panelElementId.HasValue && panelElementId.Value <= 0)
                throw new InvalidOperationException("panel_element_id_must_be_positive");
            if (slotNumber.HasValue && (slotNumber.Value <= 0 || !panelElementId.HasValue))
                throw new InvalidOperationException("positive_target_panel_slot_requires_panel_element_id");
            if (!string.IsNullOrWhiteSpace(expectedCircuitNumber) && !slotNumber.HasValue)
                throw new InvalidOperationException("expected_circuit_number_requires_target_panel_slot_number");
            if (connectorId.HasValue && (connectorId.Value < 0 || members.Count != 1))
                throw new InvalidOperationException("electrical_connector_id_requires_exactly_one_member_and_nonnegative_id");
        }

        private static void RequirePositiveMembers(IEnumerable<long> memberElementIds)
        {
            var members = memberElementIds.ToList();
            if (members.Count == 0 || members.Any(id => id <= 0))
                throw new InvalidOperationException("native_power_circuit_requires_positive_member_element_ids");
        }

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
