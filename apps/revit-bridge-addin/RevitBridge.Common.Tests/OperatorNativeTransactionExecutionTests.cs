using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorNativeTransactionExecutionTests
    {
        private static Dictionary<string, object?> CopyResult() => new Dictionary<string, object?>
        { ["viewId"] = 1542917L, ["name"] = "M-COORDINATION COPY", ["sourceViewId"] = 1363433L, ["withDetailing"] = true };

        [Theory]
        [InlineData("RolledBack", false, "none")]
        [InlineData("Pending", false, "unknown")]
        [InlineData("RolledBack", true, "unknown")]
        public void VisibilityCategoryRejectionSettlesOnlyFromNativeRollback(string rollbackStatus, bool rollbackThrows, string effect)
        {
            int mutations = 0, rollbacks = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("A rejected category must not commit."),
                () => { rollbacks++; if (rollbackThrows) throw new Exception("rollback failed"); return rollbackStatus; },
                () => "Started",
                () => { mutations++; throw new InvalidOperationException("Category 'Rooms' cannot be hidden in view 'L4'."); },
                () => throw new Exception("A rejection must not publish a committed receipt."));
            Assert.Equal(1, mutations);
            Assert.Equal(1, rollbacks);
            Assert.Equal(false, response["success"]);
            Assert.Equal("Category 'Rooms' cannot be hidden in view 'L4'.", response["error"]);
            Assert.False(response.ContainsKey("view"));
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/visibility");
            Assert.Equal(effect, settlement.EffectState);
            Assert.Empty(settlement.AffectedTargetIdentities);
        }

        [Theory]
        [InlineData("Committed", false, "applied", true)]
        [InlineData("Committed", true, "applied", false)]
        [InlineData("RolledBack", false, "none", false)]
        [InlineData("Pending", false, "unknown", false)]
        public void VisibilityReadbackRequiresCommitAndNeverPromotesRequestedIdentity(string commitStatus, bool commitThrows, string effect, bool success)
        {
            int mutations = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => commitThrows ? throw new Exception("commit response failed") : commitStatus,
                () => throw new Exception("Must not roll back an already settled commit."), () => commitStatus,
                () => { mutations++; return new Dictionary<string, object?> {
                    ["status"] = "Success", ["view"] = new { id = 1363433L, scale = 96 } }; },
                () => OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(), Array.Empty<long>(), Array.Empty<long>()),
                nativeModifiedElements: () => new[] { 1363433L });
            Assert.Equal(1, mutations);
            Assert.Equal(success, response["success"]);
            Assert.Equal(commitStatus == "Committed", response.ContainsKey("view"));
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/visibility");
            Assert.Equal(effect, settlement.EffectState);
            Assert.Equal(commitStatus == "Committed", settlement.AffectedTargetIdentities.Contains("element_id:1363433"));
        }

        [Fact]
        public void UnchangedNativeViewReadbackDoesNotMintModifiedIdentity()
        {
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed", () => "RolledBack",
                () => "Committed", () => new Dictionary<string, object?> { ["view"] = new { id = 1363433L, scale = 96 } },
                () => OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(), Array.Empty<long>(), Array.Empty<long>()),
                nativeModifiedElements: () => Array.Empty<long>());
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/visibility");
            Assert.Equal("applied", settlement.EffectState);
            Assert.Empty(settlement.AffectedTargetIdentities);
        }

        [Fact]
        public void HistoricalVisibilityExceptionOrSuccessWithoutReceiptRemainsUnknown()
        {
            foreach (var response in new object[] {
                new { status = "Success", view = new { id = 1363433L } },
                new { success = false, error = "Category 'Rooms' cannot be hidden in view 'L4'." } })
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/visibility").EffectState);
        }

        [Theory]
        [InlineData("Committed", "applied", true)]
        [InlineData("RolledBack", "none", false)]
        [InlineData("Pending", "unknown", false)]
        public void NativeCommitStatusSurvivesHandlerToSettlementBoundary(string status, string effect, bool success)
        {
            int edits = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => status,
                () => throw new Exception("unexpected rollback"), () => status,
                () => { edits++; return CopyResult(); },
                () => OperatorNativeTransactionReceipt.CommittedChanges(new[] { 1542917L, 1542918L }, new[] { 1363433L }, Array.Empty<long>()));
            Assert.Equal(1, edits);
            Assert.Equal(success, response["success"]);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/duplicate-view");
            Assert.Equal(effect, settlement.EffectState);
            if (success)
            {
                Assert.Contains("element_id:1542917", settlement.AffectedTargetIdentities);
                Assert.Contains("element_id:1542918", settlement.AffectedTargetIdentities);
                using var wire = JsonDocument.Parse(JsonSerializer.Serialize(response));
                Assert.Equal(2, wire.RootElement.GetProperty("transaction").GetProperty("added_element_ids").GetArrayLength());
            }
        }

        [Theory]
        [InlineData("Started", "RolledBack", "none", 1)]
        [InlineData("Started", "Pending", "unknown", 1)]
        [InlineData("Committed", "RolledBack", "applied", 0)]
        [InlineData("Pending", "RolledBack", "unknown", 0)]
        public void CommitExceptionUsesNativeStatusWithoutReplay(string currentStatus, string rollbackStatus, string effect, int rollbacks)
        {
            int edits = 0, rollbackCalls = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => throw new Exception("commit response failed"),
                () => { rollbackCalls++; return rollbackStatus; }, () => currentStatus,
                () => { edits++; return CopyResult(); },
                () => OperatorNativeTransactionReceipt.CommittedChanges(new[] { 1542917L }, Array.Empty<long>(), Array.Empty<long>()));
            Assert.Equal(1, edits);
            Assert.Equal(rollbacks, rollbackCalls);
            Assert.Equal(false, response["success"]);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/duplicate-view").EffectState);
        }

        [Fact]
        public void NameFailureRollsBackAndRollbackFailureCannotClaimNoEffect()
        {
            foreach (var failRollback in new[] { false, true })
            {
                var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => throw new Exception("must not commit"),
                    () => failRollback ? throw new Exception("rollback failed") : "RolledBack", () => "Started",
                    () => throw new Exception("name already exists"),
                    () => throw new Exception("must not produce commit receipt"));
                Assert.Equal("name already exists", response["error"]);
                Assert.Equal(failRollback ? "unknown" : "none",
                    OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/duplicate-view").EffectState);
            }
        }

        [Fact]
        public void HistoricalDuplicateSuccessWithoutReceiptStaysUnknown()
        {
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(
                new { success = true, viewId = 1542917L, name = "M-COORDINATION COPY" },
                "apply", "POST", "/revit/duplicate-view").EffectState);
        }

        [Theory]
        [InlineData("Committed", "applied", true)]
        [InlineData("RolledBack", "none", false)]
        [InlineData("Pending", "unknown", false)]
        public void NativeCreatedIdentitySurvivesWithoutDocumentChangedEvidence(string status, string effect, bool retained)
        {
            var createdByNativeApi = new HashSet<long>();
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => status,
                () => "RolledBack", () => status,
                () => { createdByNativeApi.Add(1542917); createdByNativeApi.Add(1542918); return CopyResult(); },
                () => OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(), Array.Empty<long>(), Array.Empty<long>()),
                () => createdByNativeApi);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/duplicate-view");
            Assert.Equal(effect, settlement.EffectState);
            Assert.Equal(retained, settlement.AffectedTargetIdentities.Contains("element_id:1542917"));
            Assert.Equal(retained, settlement.AffectedTargetIdentities.Contains("element_id:1542918"));
            Assert.DoesNotContain("element_id:1363433", settlement.AffectedTargetIdentities);
        }
    }
}
