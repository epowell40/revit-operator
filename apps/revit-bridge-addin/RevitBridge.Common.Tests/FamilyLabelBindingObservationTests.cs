using System.IO;
using System;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common.Annotation;
using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class FamilyLabelBindingObservationTests
    {
        [Fact]
        public void RetainedWorkingLabelWithNoObservedDriversIsNotProvenUnbound()
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(System.AppContext.BaseDirectory,
                "Fixtures", "family-label-binding-observation-506.json")));
            var names = fixture.RootElement.GetProperty("labels").EnumerateArray().Select(label =>
                label.GetProperty("driverParameters").EnumerateArray().Select(value => value.GetString()!).ToArray());
            using var actual = JsonDocument.Parse(JsonSerializer.Serialize(
                FamilyLabelBindingObservation.ClassifyDriverNames(names, 0, 0, 0)));
            Assert.Equal(JsonValueKind.Null, actual.RootElement.GetProperty("unboundLabelCount").ValueKind);
            Assert.Equal(1, actual.RootElement.GetProperty("bindingUndeterminedLabelCount").GetInt32());
        }

        [Fact]
        public void ActualModelVisibleToolDescriptionDoesNotTurnMissingDriverNamesIntoAbsenceProof()
        {
            var description = OperatorToolManifest.Tools.Single(tool => tool.Path == "/revit/inspect-family-content").Description;
            Assert.Contains("Empty driverParameters does not prove an unbound label", description);
            Assert.Contains("unboundLabelCount is null", description);
        }

        [Fact]
        public void ObservedReferencesAreRetainedWithoutClaimingCompleteBinding()
        {
            var observation = FamilyLabelBindingObservation.Observe(names =>
            { names.Add(" Mark "); names.Add("Flow"); names.Add("mark"); });
            Assert.Equal(new[] { "Flow", "Mark" }, observation.DriverParameters);
            using var detail = JsonDocument.Parse(JsonSerializer.Serialize(observation.Detail));
            Assert.Equal("references_observed", detail.RootElement.GetProperty("state").GetString());
            Assert.False(detail.RootElement.GetProperty("bindingDetermined").GetBoolean());
            Assert.False(detail.RootElement.GetProperty("coverageComplete").GetBoolean());
            using var classification = JsonDocument.Parse(JsonSerializer.Serialize(
                FamilyLabelBindingObservation.Classify(new[] { observation }, 0, 0, 0)));
            Assert.Equal(1, classification.RootElement.GetProperty("observedDriverReferenceLabelCount").GetInt32());
            Assert.Equal(1, classification.RootElement.GetProperty("parameterDrivenLabelCount").GetInt32());
            Assert.Equal(JsonValueKind.Null, classification.RootElement.GetProperty("unboundLabelCount").ValueKind);
        }

        [Fact]
        public void OmittedParametersDoNotExecuteAReaderOrImplyUnbound()
        {
            var called = false;
            var observation = FamilyLabelBindingObservation.Observe(names => { called = true; }, false);
            Assert.False(called);
            Assert.Empty(observation.DriverParameters);
            using var detail = JsonDocument.Parse(JsonSerializer.Serialize(observation.Detail));
            Assert.Equal("not_requested", detail.RootElement.GetProperty("state").GetString());
            Assert.False(detail.RootElement.GetProperty("parameterReadSucceeded").GetBoolean());
        }

        [Fact]
        public void ReadFailureIsExplicitAndDoesNotDiscardAlreadyObservedReferences()
        {
            var observation = FamilyLabelBindingObservation.Observe(names =>
            { names.Add("Mark"); throw new InvalidOperationException("not returned as native data"); });
            Assert.Equal(new[] { "Mark" }, observation.DriverParameters);
            using var detail = JsonDocument.Parse(JsonSerializer.Serialize(observation.Detail));
            Assert.Equal("read_error", detail.RootElement.GetProperty("state").GetString());
            Assert.Equal("InvalidOperationException", detail.RootElement.GetProperty("error").GetString());
            Assert.False(detail.RootElement.GetProperty("parameterReadSucceeded").GetBoolean());
        }

        [Fact]
        public void EmptySuccessfulReadIsUndeterminedAndCountsOnlyReturnedRows()
        {
            var observation = FamilyLabelBindingObservation.Observe(names => { });
            using var detail = JsonDocument.Parse(JsonSerializer.Serialize(observation.Detail));
            Assert.Equal("binding_undetermined", detail.RootElement.GetProperty("state").GetString());
            Assert.True(detail.RootElement.GetProperty("parameterReadSucceeded").GetBoolean());
            using var classification = JsonDocument.Parse(JsonSerializer.Serialize(
                FamilyLabelBindingObservation.Classify(new[] { observation }, 2, 3, 1)));
            var value = classification.RootElement;
            Assert.Equal("returned_label_rows_only", value.GetProperty("scope").GetString());
            Assert.Equal(2, value.GetProperty("staticTextCount").GetInt32());
            Assert.Equal(3, value.GetProperty("nestedFamilyCount").GetInt32());
            Assert.Equal(1, value.GetProperty("nestedAnnotationCount").GetInt32());
            Assert.False(value.GetProperty("bindingInspectionComplete").GetBoolean());
        }

        [Fact]
        public void NoReturnedLabelsPreservesStaticCountsWithoutClaimingWholeFamilyCoverage()
        {
            using var classification = JsonDocument.Parse(JsonSerializer.Serialize(
                FamilyLabelBindingObservation.ClassifyDriverNames(Array.Empty<string[]>(), 2, 0, 0)));
            Assert.Equal(0, classification.RootElement.GetProperty("unboundLabelCount").GetInt32());
            Assert.Equal(0, classification.RootElement.GetProperty("bindingUndeterminedLabelCount").GetInt32());
            Assert.Equal("returned_label_rows_only", classification.RootElement.GetProperty("scope").GetString());
            Assert.Equal(2, classification.RootElement.GetProperty("staticTextCount").GetInt32());
        }
    }
}
