using System;
using System.Collections.Generic;
using System.IO;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class InlineAccessorySettlementOrderTests
    {
        [Fact]
        public void FullVerificationRunsAfterChildCommitBeforeOuterSettlement()
        {
            string? source = null;
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null && source == null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, "RevitBridge.Logic/Handlers/MEP/ConnectExistingMepBranchHandler.InlineAccessory.cs");
                    if (File.Exists(file)) { source = File.ReadAllText(file); break; }
                }
            Assert.NotNull(source);
            var start = source!.IndexOf("execution = NativeAtomicTransactionGroup.Execute", StringComparison.Ordinal);
            var end = source.IndexOf("finally { app.Application.DocumentChanged -= Changed; }", start, StringComparison.Ordinal);
            var body = source.Substring(start, end - start);
            var commit = body.IndexOf("if (tx.Commit() != TransactionStatus.Committed)", StringComparison.Ordinal);
            var verify = body.IndexOf("VerifyResult();", StringComparison.Ordinal);
            Assert.True(commit >= 0 && verify > commit, "MEP system metadata must be verified after the child commit, still inside the rollbackable group.");
            Assert.Equal(verify, body.LastIndexOf("VerifyResult();", StringComparison.Ordinal));
            Assert.True(body.IndexOf("InlineAccessoryFootprint.RequireExpected", StringComparison.Ordinal) < verify);
            var observation = body.IndexOf("postCommitDiagnostic = CaptureInlineDiagnostic", StringComparison.Ordinal);
            var failureCatch = body.IndexOf("catch", verify, StringComparison.Ordinal);
            var rethrow = body.IndexOf("throw;", observation, StringComparison.Ordinal);
            var callbackEnd = body.IndexOf("}, () => created.Concat(derivedCreated)", StringComparison.Ordinal);
            Assert.True(observation > failureCatch && failureCatch > verify && rethrow > observation && callbackEnd > rethrow,
                "Failure-only diagnostics must run inside the provisional callback before rethrow triggers outer rollback.");
            Assert.Equal(observation, body.LastIndexOf("postCommitDiagnostic = CaptureInlineDiagnostic", StringComparison.Ordinal));
            Assert.Contains("postCommitDiagnostic,", source);
            Assert.True(body.IndexOf("verified = true", StringComparison.Ordinal) > verify);
            Assert.True(body.IndexOf("NativeTransactionDisposition.Rollback", StringComparison.Ordinal) > verify);
            Assert.Contains("if (currentMetadata != metadata) FailSegment", source);
            Assert.Contains("InlineAccessoryParameterPreservation.Matches", source);
        }

        [Theory]
        [InlineData("712041", "RolledBack", true)]
        [InlineData(null, "RolledBack", false)]
        [InlineData("712042", "RolledBack", false)]
        [InlineData(null, "Pending", false)]
        public void ProvisionalChildCommitCannotBypassExactMetadataOrOuterSettlement(string? resolvedSystem, string rollbackStatus, bool matches)
        {
            var childCommitted = false; var outerCommits = 0; var rollbacks = 0; var groupStatus = "Started"; var capturedBeforeRollback = false;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => { outerCommits++; return groupStatus = "Committed"; },
                () => { rollbacks++; return groupStatus = rollbackStatus; }, () => groupStatus,
                () => {
                    childCommitted = true;
                    try { if (resolvedSystem != "712041") throw new InvalidOperationException("system type preservation failed after child commit"); }
                    catch { capturedBeforeRollback = groupStatus == "Started" && rollbacks == 0; throw; }
                    return new Dictionary<string, object?> { ["success"] = true };
                }, () => OperatorNativeTransactionReceipt.CommittedChanges(new[] { 20L }, new[] { 10L }, Array.Empty<long>()));
            Assert.True(childCommitted);
            Assert.Equal(matches ? 1 : 0, outerCommits);
            Assert.Equal(matches ? 0 : 1, rollbacks);
            Assert.Equal(matches, response["success"]);
            Assert.Equal(!matches, capturedBeforeRollback);
            if (!matches)
            {
                var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/connect-existing-mep-branch");
                Assert.Equal(rollbackStatus == "RolledBack" ? "none" : "unknown", settlement.EffectState);
                Assert.Empty(settlement.AffectedTargetIdentities);
            }
        }
    }
}
