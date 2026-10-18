using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class RevisionCloudSettlementTests
    {
        private const string Route = "/revit/create-revision-cloud";

        [Fact]
        public void ExactHistoricalOverloadErrorRemainsUnknown()
        {
            var raw = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures",
                "revision-cloud-overload-unsettled204.json"));
            var old = JsonSerializer.Deserialize<Dictionary<string, object?>>(raw)!;
            Assert.Equal("RevisionCloud.Create overload not found for this Revit version.",
                ((JsonElement)old["error"]!).GetString());
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(old, "apply", "POST", Route).EffectState);
        }

        [Fact]
        public void RejectedRevisionBeforeTransactionIsKnownNoEffect()
        {
            var result = Assert.IsType<Dictionary<string, object?>>(NativeMutationPreflightBoundary.Execute(
                enter => throw new InvalidOperationException("Revision is issued.")));
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", Route).EffectState);
            Assert.Equal("not_started", Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]).Status);
        }

        [Theory]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void FailedCreationRetainsObservedRollbackOrPending(string rollbackStatus, string effect)
        {
            var attempts = 0;
            var result = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("must not commit"), () => rollbackStatus, () => "Started",
                () => { attempts++; throw new InvalidOperationException("Cloud curves rejected by native API."); },
                () => throw new Exception("must not create committed inventory"));
            Assert.Equal(1, attempts);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", Route).EffectState);
            Assert.False((bool)result["success"]!);
            Assert.False(result.ContainsKey("revisionCloudId"));
        }

        [Fact]
        public void PostCommitReadbackFailureCannotEraseCreatedCloudOrReplayIt()
        {
            var creates = 0;
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed",
                () => throw new Exception("must not roll back after commit"), () => "Committed",
                () => { creates++; return new Dictionary<string, object?> { ["revisionCloudId"] = 42L }; },
                () => OperatorNativeTransactionReceipt.CommittedChanges(new[] {42L}, new[] {41L}, Array.Empty<long>()));
            OperatorNativeTransactionExecution.ReadCommitted(result,
                () => throw new InvalidOperationException("Cloud sketch unavailable after commit."));
            Assert.Equal(1, creates);
            Assert.Equal(42L, result["revisionCloudId"]);
            Assert.Equal(false, result["success"]);
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", Route).EffectState);
        }

        [Theory]
        [InlineData("RolledBack", "none", true)]
        [InlineData("Pending", "unknown", false)]
        public void PreviewReadbackGateNeverPublishesPersistentCloudIdentity(string rollbackStatus, string effect, bool success)
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("preview must not commit"), () => rollbackStatus, () => rollbackStatus,
                () => new Dictionary<string, object?> { ["curves"] = 4, ["previewExecuted"] = true },
                () => throw new Exception("no committed preview"), () => new[] {42L},
                disposition: NativeTransactionDisposition.Rollback);
            var reads = 0;
            OperatorNativeTransactionExecution.ReadCommitted(result, () =>
            { reads++; return new Dictionary<string, object?> { ["revisionCloudId"] = 42L }; });
            Assert.Equal(0, reads);
            Assert.Equal(success, result["success"]);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", Route).EffectState);
            Assert.False(result.ContainsKey("revisionCloudId"));
        }
    }
}
