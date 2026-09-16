using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorPaneIntegrationContractTests
    {
        [Fact]
        public void ModernPaneUsesOneSidecarAndKeepsInitializationOffTheRevitApiPath()
        {
            var pane = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorEmbeddedPaneControl.cs");
            var provider = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorDockablePaneProvider.cs");
            var launcher = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorDesktopLauncher.cs");
            AssertOrdered(pane, "await OperatorDesktopLauncher.LaunchEmbeddedAsync", "browser.EnsureCoreWebView2Async()", "core.Navigate(url.AbsoluteUri)");
            Assert.Contains("UseEmbeddedPane()", provider);
            Assert.Contains("MinimumWidth = OperatorDesktopLauncher.UseEmbeddedPane() ? 380 : 200", provider);
            Assert.Contains("new OperatorEmbeddedPaneControl()", provider);
            Assert.DoesNotContain("new OperatorPaneControl", pane);
            Assert.DoesNotContain("WebMessageReceived +=", pane);
            Assert.DoesNotContain("AddHostObjectToScript", pane);
            Assert.DoesNotContain("CoreWebView2PermissionState.Allow", pane);
            Assert.Contains("if (_opening || _browser != null || _lifetime.IsCancellationRequested) return;", pane);
            Assert.Contains("current._lifetime.Cancel()", pane);
            Assert.Contains("current.DisposeBrowser()", pane);
            AssertOrdered(launcher, "public static Task<Uri> LaunchEmbeddedAsync", "Task.Run", "LaunchGate.TryEnter", "noBrowser: true", "if (!exited || process.ExitCode != 0)", "WaitForSidecarLiveness");
        }

        [Fact]
        public void ToolResultRequestEffectRoundTripsAsOptionalWireMetadata()
        {
            var result = new OperatorToolResult
            {
                ActionId = "conditional-fix",
                Method = "POST",
                Path = "/revit/fire-damper-audit",
                RequestEffect = "apply",
                Status = "done",
                ResultJson = new { fixed_count = 1 }
            };

            var json = JsonSerializer.Serialize(result);
            Assert.Contains("\"request_effect\":\"apply\"", json);
            var roundTrip = JsonSerializer.Deserialize<OperatorToolResult>(json);
            Assert.NotNull(roundTrip);
            Assert.Equal("apply", roundTrip!.RequestEffect);

            var legacyJson = "{\"action_id\":\"read\",\"method\":\"POST\",\"path\":\"/revit/rooms\",\"status\":\"done\"}";
            var legacy = JsonSerializer.Deserialize<OperatorToolResult>(legacyJson);
            Assert.NotNull(legacy);
            Assert.Null(legacy!.RequestEffect);
        }

        [Fact]
        public void PaneFencesExecutionAndSeparatesExecutionFailureFromPostEffectSettlement()
        {
            var pane = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorPaneControl.cs");
            var client = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorBackendClient.cs");

            AssertOrdered(
                pane,
                "var claimToken = GetJsonString(claim, \"claim_token\", 160);",
                "Batch claim response is missing claim_token; refusing to execute the claimed item.",
                "ProcessClaimedRevitBatchItemAsync(job, item, claimToken");
            AssertOrdered(
                pane,
                "object result;",
                "result = await ExecuteDelegatedRevitBatchItemAsync(job, item, cancellationToken)",
                "FailRevitBatchItemJsonAsync(",
                "return;",
                "_revitBatchCompletionOutbox.Save(",
                "PostAndValidateRevitBatchCompletionAsync(");
            Assert.Matches(new Regex(@"FailRevitBatchItemJsonAsync\([\s\S]{0,220}binding,\s*claimToken,", RegexOptions.IgnoreCase), pane);
            Assert.Contains("Never convert a possibly committed effect into /fail", pane);
            Assert.Contains("Batch completion response did not confirm the same item as succeeded.", pane);
            Assert.DoesNotMatch(new Regex(@"PostAndValidateRevitBatchCompletionAsync\([\s\S]{0,700}FailRevitBatchItemJsonAsync\(", RegexOptions.IgnoreCase), pane);

            AssertOrdered(
                client,
                "CompleteRevitBatchItemJsonAsync(string jobId, string itemId, OperatorRevitBatchBinding binding, string claimToken",
                "claim_token = claimToken",
                "FailRevitBatchItemJsonAsync(string jobId, string itemId, OperatorRevitBatchBinding binding, string claimToken",
                "claim_token = claimToken");
        }

        [Fact]
        public void PaneReconcilesDurableCompletionBeforeClaimingMoreWorkAndReusesOriginalFence()
        {
            var pane = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorPaneControl.cs");

            AssertOrdered(
                pane,
                "FlushOnePendingRevitBatchCompletionAsync()",
                "ClaimNextRevitBatchItemJsonAsync(");
            AssertOrdered(
                pane,
                "var completion = pending[0];",
                "var binding = BindingFromCompletionEnvelope(envelope);",
                "binding,",
                "claimToken,",
                "_revitBatchCompletionOutbox.Acknowledge(completion.JobId)");
            Assert.Contains("BatchCompletionOutbox", pane);
            Assert.Contains("batch.completion.retry_pending", pane);
            Assert.Contains("outcome_unknown = true", pane);
            AssertOrdered(
                pane,
                "AssertClaimedJobBinding(job, binding);",
                "ProcessClaimedRevitBatchItemAsync(job, item, claimToken, binding",
                "EnsureRevitBatchBindingStillLiveAsync(binding, cancellationToken)",
                "ExecuteDelegatedRevitBatchItemAsync(job, item, cancellationToken)");
            Assert.Contains("session_id = binding.SessionId", pane);
            Assert.Contains("project_fingerprint = binding.ProjectFingerprint", pane);
            Assert.Contains("BindingFromCompletionEnvelope(envelope)", pane);
            Assert.Contains("SerializeBatchBoundPayload", ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorBackendClient.cs"));
        }

        [Fact]
        public void PaneRiskDecisionsUseTheOriginalActionBodyAndToolResultsPreserveItsEffect()
        {
            var pane = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorPaneControl.cs");

            var directPolicyCalls = Regex.Matches(pane, @"OperatorApprovalPolicy\.GetRisk\(");
            Assert.Single(directPolicyCalls);
            Assert.Contains("OperatorApprovalPolicy.GetRisk(method, path, GetActionBodyJson(body))", pane);
            Assert.Contains("RequestEffect = OperatorApprovalPolicy.GetEffectWireValue(action.Method, action.Path, bodyJson)", pane);
            Assert.Contains("var risk = GetActionRisk(method, path, body);", pane);
        }

        private static string ReadRepoFile(params string[] relativeSegments)
        {
            var cursor = new DirectoryInfo(AppContext.BaseDirectory);
            while (cursor != null)
            {
                var candidate = Path.Combine(new[] { cursor.FullName }.Concat(relativeSegments).ToArray());
                if (File.Exists(candidate)) return File.ReadAllText(candidate);
                if (relativeSegments.Length > 1 && relativeSegments[0] == "apps")
                {
                    var flatCandidate = Path.Combine(new[] { cursor.FullName }.Concat(relativeSegments.Skip(1)).ToArray());
                    if (File.Exists(flatCandidate)) return File.ReadAllText(flatCandidate);
                }
                cursor = cursor.Parent;
            }

            throw new FileNotFoundException("Could not locate repository source file.", Path.Combine(relativeSegments));
        }

        private static void AssertOrdered(string source, params string[] fragments)
        {
            var offset = 0;
            foreach (var fragment in fragments)
            {
                var found = source.IndexOf(fragment, offset, StringComparison.Ordinal);
                Assert.True(found >= 0, $"Expected source fragment after offset {offset}: {fragment}");
                offset = found + fragment.Length;
            }
        }
    }
}
