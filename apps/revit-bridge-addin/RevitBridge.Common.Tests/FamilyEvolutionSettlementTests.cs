using System;
using System.Collections.Generic;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class FamilyEvolutionSettlementTests
    {
        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void PersistedDimensionReadbackCannotEraseAnObservedFamilyCommit(bool failReadback)
        {
            // Minimal shape of the retained campaign13 response: Applied alone
            // never established native settlement, despite visible model changes.
            var historical = new Dictionary<string, object?> {
                ["status"] = "Applied", ["instanceId"] = 1542919L,
                ["typeId"] = 1543818L, ["projectChanged"] = true };
            const string route = "/revit/apply-family-evolution";
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(historical, "apply", "POST", route).EffectState);
            int edits = 0;
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed",
                () => throw new Exception("must not replay or rollback committed edit"), () => "Committed",
                () => { edits++; return historical; },
                () => OperatorNativeTransactionReceipt.CommittedChanges(new[] { 1542930L, 1543818L }, new[] { 1542919L }, Array.Empty<long>()));
            OperatorNativeTransactionExecution.ReadCommitted(result, () => {
                if (failReadback) throw new InvalidOperationException("persisted type unavailable");
                return new Dictionary<string, object?> { ["width"] = 3.33333333333333, ["depth"] = 4.03543307086614 };
            }, requestedChangesComplete: false); // clearance still needs its own readback
            Assert.Equal(1, edits);
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", route).EffectState);
            Assert.Equal(false, result["verified"]);
            Assert.Equal(failReadback ? "CommittedWithErrors" : "Applied", OperatorNativeTransactionExecution.OutcomeStatus(result, "Applied"));
            Assert.Equal(!failReadback, result.ContainsKey("width"));
        }

        [Theory]
        [InlineData("RolledBack")]
        [InlineData("Pending")]
        public void SavedFamilyArtifactIsNotErasedByProjectRollback(string status)
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => status,
                () => throw new Exception("no retry"), () => status,
                () => new Dictionary<string, object?>(), () => throw new Exception("no commit"));
            var compoundFailure = new { status = "Failed", projectTransaction = result["transaction"], recoveryArtifact = "retained-family.rfa" };
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(compoundFailure, "apply", "POST", "/revit/apply-family-evolution").EffectState);
        }
    }
}
