using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorDelegatedBatchTruthTests
    {
        [Theory]
        [InlineData("none", true, false)]
        [InlineData("applied", false, true)]
        [InlineData("unknown", false, true)]
        public void FailedWorkCarriesEffectAndRetryTruth(string effect, bool retryable, bool reconcile)
        {
            var failed = OperatorRevitBatchTerminalOutcome.Failed("stopped", "max_rounds_exhausted", effect, "", Array.Empty<object>());
            var wire = Assert.IsAssignableFrom<IDictionary<string, object?>>(failed.WireResult);
            Assert.False(failed.Ok);
            Assert.Equal(retryable, failed.Retryable);
            Assert.Equal(reconcile, failed.ReconciliationRequired);
            Assert.Equal(false, wire["ok"]);
            Assert.Equal(effect, wire["effect_state"]);
            Assert.Equal(retryable, wire["retryable"]);
            Assert.Equal(reconcile, wire["reconciliation_required"]);
        }

        [Fact]
        public void OnlySuccessfulTerminalWorkCanEnterCompletionOutbox()
        {
            var pane = PaneSource();
            var start = pane.IndexOf("private async Task ProcessClaimedRevitBatchItemAsync", StringComparison.Ordinal);
            Assert.True(start >= 0);
            var end = pane.IndexOf("\n        private ", start + 1, StringComparison.Ordinal);
            var process = pane.Substring(start, end - start);
            Ordered(process, "OperatorRevitBatchTerminalOutcome outcome;", "ExecuteDelegatedRevitBatchItemAsync(job, item, binding, cancellationToken)",
                "if (!outcome.Ok)", "FailRevitBatchItemJsonAsync(", "outcome.WireResult", "return;", "var result = outcome.WireResult;",
                "_revitBatchCompletionOutbox.Save(", "PostAndValidateRevitBatchCompletionAsync(");
            Assert.DoesNotContain("object result;", process);
            Ordered(process, "var delegationStarted = false;", "delegationStarted = true;", "ExecuteDelegatedRevitBatchItemAsync(job, item, binding, cancellationToken)",
                "catch (Exception ex)", "delegationStarted ? \"unknown\" : \"none\"");
        }

        [Fact]
        public void EachRoundAndActionRetainDocumentFenceAndFailedToolTruth()
        {
            var pane = PaneSource();
            var start = pane.IndexOf("private async Task<OperatorRevitBatchTerminalOutcome> ExecuteDelegatedRevitBatchItemAsync", StringComparison.Ordinal);
            Assert.True(start >= 0);
            var delegated = pane.Substring(start);
            Ordered(delegated, "for (int round", "EnsureRevitBatchBindingStillLiveAsync(binding, cancellationToken)", "_backendClient.ChatAsync(");
            Ordered(delegated, "foreach (var plannedAction in actions)", "plannedAction.ExpectedDocumentTitle = binding.DocumentTitle;",
                "plannedAction.ExpectedDocumentPath = binding.DocumentPath;", "EnsureRevitBatchBindingStillLiveAsync(binding, cancellationToken)", "ExecuteActionAsync(plannedAction, cancellationToken)",
                "TryGetTopLevelHandlerFailure(result, out var handlerError)", "toolResult.Status = \"failed\";", "executedToolResults.Add(toolResult)");
            Assert.Contains("\"unresolved_prior_tool_failure\"", delegated);
            Assert.Contains("\"repeated_action_loop\"", delegated);
            Assert.Contains("\"max_rounds_exhausted\"", delegated);
            Assert.Contains("SummarizeDelegatedBatchEffectState(executedToolResults)", delegated);
        }

        [Fact]
        public void HandlerFailureCannotBeHiddenByNestedSuccessOrInventedFromNestedFailure()
        {
            Assert.True(OperatorRevitBatchTerminalOutcome.TryGetTopLevelHandlerFailure(new { ok = false, error = "native failure", items = new[] { new { ok = true } } }, out var error));
            Assert.Equal("native failure", error);
            Assert.False(OperatorRevitBatchTerminalOutcome.TryGetTopLevelHandlerFailure(new { ok = true, items = new[] { new { ok = false } } }, out _));
        }

        private static string PaneSource()
        {
            var cursor = new DirectoryInfo(AppContext.BaseDirectory);
            while (cursor != null)
            {
                foreach (var prefix in new[] { "apps", "" })
                {
                    var path = Path.Combine(cursor.FullName, prefix, "revit-bridge-addin", "RevitBridge", "Operator", "OperatorPaneControl.cs");
                    if (File.Exists(path)) return File.ReadAllText(path).Replace("\r\n", "\n");
                }
                cursor = cursor.Parent;
            }
            throw new FileNotFoundException("Native pane source not found.");
        }

        private static void Ordered(string source, params string[] fragments)
        {
            var offset = 0;
            foreach (var fragment in fragments)
            {
                var at = source.IndexOf(fragment, offset, StringComparison.Ordinal);
                Assert.True(at >= 0, "Missing ordered execution boundary: " + fragment);
                offset = at + fragment.Length;
            }
        }
    }
}
