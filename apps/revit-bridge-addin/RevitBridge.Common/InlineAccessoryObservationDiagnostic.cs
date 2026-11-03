using System;
using System.Collections.Generic;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Failure explanation only. Never a preservation or mutation receipt.</summary>
    public static class InlineAccessoryObservationDiagnostic
    {
        private static readonly HashSet<string> Stages = new HashSet<string>(StringComparer.Ordinal) {
            "request", "owners", "types", "schedules", "owner_state", "type_parameters",
            "internal_scan", "internal_identity", "internal_parameters", "internal_dependencies",
            "internal_parameter_layout", "internal_parameter_values",
            "internal_category", "internal_type", "internal_location", "internal_bounds", "internal_schema",
            "placement_dependents", "placement_metadata", "placement_owner_parameters",
            "placement_calculated_flows", "placement_assigned_flows", "flow_display_bindings",
            "centerline_dependencies", "centerline_parameters", "system_identity", "system_parameters",
            "system_members", "system_network", "bookkeeping_size", "bookkeeping_validation",
            "bookkeeping_header", "bookkeeping_profile", "bookkeeping_self_dependency",
            "bookkeeping_dependency_closure", "bookkeeping_candidate_identity",
            "bookkeeping_unavailable_profile", "bookkeeping_inventory_bound"
        };
        private static string Code(Exception error) => error.Message switch {
            "Ancillary parameter bound exceeded." => "parameter_bound_exceeded",
            "Ancillary dependency bound exceeded." => "dependency_bound_exceeded",
            "System inventory exceeds bound." => "system_inventory_bound_exceeded",
            "Internal candidate scan exceeds bound." => "candidate_scan_bound_exceeded",
            "Internal candidate cohort exceeds bound." => "candidate_cohort_bound_exceeded",
            "Eligible internal candidate cohort exceeds bound." => "eligible_candidate_cohort_bound_exceeded",
            "Missing logical dependent." => "logical_dependent_missing",
            "Centerline parent binding ambiguous or exceeds bound." => "centerline_binding_unavailable",
            "One current mechanical system is required." => "single_system_unavailable",
            "Missing system type." => "system_type_missing",
            "Ancillary observation exceeds bound." => "observation_size_exceeded",
            "Internal observation exceeds bound." => "observation_size_exceeded",
            "Inline bookkeeping projection changed or is incomplete; rollback required." => "bookkeeping_projection_incomplete",
            "Invalid bounded IDs." => "invalid_dependency_ids",
            "Invalid bounded identities." => "invalid_inventory_identities",
            "Schedule observation incomplete." => "schedule_observation_incomplete",
            _ => "native_observation_failed"
        };
        public static JsonElement Failure(Exception error, string stage)
            => Failure(error, stage, "operator.inline_accessory_state.v1", null);
        public static JsonElement PlacementFailure(Exception error, string stage, long? elementId)
            => Failure(error, stage, "operator.native_accessory_placement_state.v1", elementId);
        private static JsonElement Failure(Exception error, string stage, string schema, long? elementId)
        {
            if (error == null) throw new ArgumentNullException(nameof(error));
            return JsonSerializer.SerializeToElement(new {
                schema, complete = false,
                reason = "native_observation_unavailable", error = error.GetType().Name,
                stage = Stages.Contains(stage ?? "") ? stage : "unknown",
                diagnosticCode = Code(error), diagnosticOnly = true,
                elementId = elementId > 0 ? elementId : null
            });
        }
    }
}
