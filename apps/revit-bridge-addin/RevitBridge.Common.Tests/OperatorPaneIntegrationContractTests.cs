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
        public void PaneFailsClosedBeforeBatchExecutionAndThreadsExactClaimTokenToBothSettlements()
        {
            var pane = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorPaneControl.cs");
            var client = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorBackendClient.cs");

            AssertOrdered(
                pane,
                "var claimToken = GetJsonString(claim, \"claim_token\", 160);",
                "Batch claim response is missing claim_token; refusing to execute the claimed item.",
                "ProcessClaimedRevitBatchItemAsync(job, item, claimToken");
            Assert.Contains("CompleteRevitBatchItemJsonAsync(jobId, itemId, _revitBatchExecutorId, claimToken, result", pane);
            Assert.Matches(new Regex(@"FailRevitBatchItemJsonAsync\([\s\S]{0,220}_revitBatchExecutorId,\s*claimToken,", RegexOptions.IgnoreCase), pane);

            AssertOrdered(
                client,
                "CompleteRevitBatchItemJsonAsync(string jobId, string itemId, string executorId, string claimToken",
                "claim_token = claimToken",
                "FailRevitBatchItemJsonAsync(string jobId, string itemId, string executorId, string claimToken",
                "claim_token = claimToken");
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
