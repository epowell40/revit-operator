using System;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public sealed class InlineAccessoryObservationDiagnosticTests
    {
        [Theory]
        [InlineData("bookkeeping_profile")][InlineData("bookkeeping_self_dependency")]
        [InlineData("bookkeeping_dependency_closure")][InlineData("bookkeeping_candidate_identity")]
        [InlineData("bookkeeping_unavailable_profile")][InlineData("bookkeeping_header")]
        [InlineData("bookkeeping_inventory_bound")]
        public void InventoryPredicateDiagnosticRemainsFailureOnly(string stage)
        {
            // Actual147 retained the generic message but lost its failing predicate.
            // These stages are synthetic producer boundary cases, not a claim about147's cause.
            var r=InlineAccessoryObservationDiagnostic.PlacementFailure(new InvalidOperationException(
                "Inline bookkeeping projection changed or is incomplete; rollback required."),stage,90);
            Assert.Equal(stage,r.GetProperty("stage").GetString());
            Assert.Equal(90,r.GetProperty("elementId").GetInt64());
            Assert.Equal("bookkeeping_projection_incomplete",r.GetProperty("diagnosticCode").GetString());
            Assert.False(r.GetProperty("complete").GetBoolean());Assert.True(r.GetProperty("diagnosticOnly").GetBoolean());
            Assert.False(r.TryGetProperty("internals",out _));Assert.False(r.TryGetProperty("owners",out _));
        }
        [Theory][InlineData(1485080L,1485080L)][InlineData(0L,null)][InlineData(-1L,null)]
        public void PlacementFailureKeepsOnlyBoundedStageAndPositiveIdentity(long id,long? expected)
        {
            var r=InlineAccessoryObservationDiagnostic.PlacementFailure(new AccessViolationException("private-native-path"),"internal_bounds",id);
            Assert.Equal("operator.native_accessory_placement_state.v1",r.GetProperty("schema").GetString());
            Assert.Equal("internal_bounds",r.GetProperty("stage").GetString());
            Assert.Equal(expected,r.GetProperty("elementId").ValueKind==System.Text.Json.JsonValueKind.Null ? (long?)null:r.GetProperty("elementId").GetInt64());
            Assert.False(r.GetProperty("complete").GetBoolean());Assert.True(r.GetProperty("diagnosticOnly").GetBoolean());
            Assert.False(r.TryGetProperty("owners",out _));Assert.DoesNotContain("private-native-path",r.GetRawText());
        }
        [Fact]
        public void PlacementFailureCannotPromoteAnUnknownStage()
        {
            var r=InlineAccessoryObservationDiagnostic.PlacementFailure(new Exception("private-native-path"),"foreign-stage",null);
            Assert.Equal("unknown",r.GetProperty("stage").GetString());Assert.False(r.GetProperty("complete").GetBoolean());
            Assert.DoesNotContain("private-native-path",r.GetRawText());
        }
        [Theory][InlineData("internal_parameter_layout")][InlineData("internal_parameter_values")]
        [InlineData("internal_type")][InlineData("internal_location")][InlineData("internal_bounds")][InlineData("internal_schema")]
        [InlineData("internal_category")][InlineData("placement_dependents")][InlineData("placement_owner_parameters")][InlineData("flow_display_bindings")]
        public void StagedProducerFailuresRetainTheirBoundedDiagnosticStage(string stage)
        {
            var r=InlineAccessoryObservationDiagnostic.Failure(new AccessViolationException(),stage);
            Assert.Equal(stage,r.GetProperty("stage").GetString());
            Assert.Equal("AccessViolationException",r.GetProperty("error").GetString());
            Assert.False(r.GetProperty("complete").GetBoolean());Assert.True(r.GetProperty("diagnosticOnly").GetBoolean());
            Assert.False(r.TryGetProperty("bookkeeping",out _));Assert.False(r.TryGetProperty("owners",out _));
        }
        [Theory]
        [InlineData("Ancillary dependency bound exceeded.", "internal_dependencies", "dependency_bound_exceeded")]
        [InlineData("Eligible internal candidate cohort exceeds bound.", "bookkeeping_validation", "eligible_candidate_cohort_bound_exceeded")]
        [InlineData("Internal observation exceeds bound.", "bookkeeping_size", "observation_size_exceeded")]
        [InlineData("Ancillary parameter bound exceeded.", "internal_parameters", "parameter_bound_exceeded")]
        [InlineData("One current mechanical system is required.", "system_identity", "single_system_unavailable")]
        [InlineData("Inline bookkeeping projection changed or is incomplete; rollback required.", "bookkeeping_validation", "bookkeeping_projection_incomplete")]
        public void KnownFailuresRemainIncompleteWithBoundedExplanation(string message,string stage,string code)
        {
            var r=InlineAccessoryObservationDiagnostic.Failure(new InvalidOperationException(message),stage);
            Assert.False(r.GetProperty("complete").GetBoolean());Assert.True(r.GetProperty("diagnosticOnly").GetBoolean());
            Assert.Equal("native_observation_unavailable",r.GetProperty("reason").GetString());
            Assert.Equal("InvalidOperationException",r.GetProperty("error").GetString());
            Assert.Equal(stage,r.GetProperty("stage").GetString());Assert.Equal(code,r.GetProperty("diagnosticCode").GetString());
            Assert.False(r.TryGetProperty("owners",out _));Assert.False(r.TryGetProperty("bookkeeping",out _));
        }
        [Theory] [InlineData("foreign-stage")] [InlineData("")] [InlineData(null)]
        public void UnrecognizedNativeDetailsAreNotExposedOrPromoted(string? stage)
        {
            var r=InlineAccessoryObservationDiagnostic.Failure(new InvalidOperationException("private-path-or-arbitrary-native-detail"),stage!);
            Assert.Equal("unknown",r.GetProperty("stage").GetString());
            Assert.Equal("native_observation_failed",r.GetProperty("diagnosticCode").GetString());
            Assert.DoesNotContain("private-path",r.GetRawText());Assert.False(r.GetProperty("complete").GetBoolean());
        }
    }
}
