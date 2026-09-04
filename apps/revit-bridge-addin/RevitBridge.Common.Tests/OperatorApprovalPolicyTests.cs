using System;
using System.IO;
using System.Text.Json;
using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorApprovalPolicyTests
    {
        [Fact]
        public void DirectHttpExactApplyFalsePreviewIsLowWithoutApprovalOrGrant()
        {
            AssertLow(" POST ", " /REVIT/DELETE ", "{\"ids\":[101,202],\"apply\":false}");
        }

        [Fact]
        public void HostedCourierJsonElementPreviewIsLowWithoutApprovalOrGrant()
        {
            using var document = JsonDocument.Parse("{\"ids\":[101,202],\"apply\":false}");
            var bodyJson = document.RootElement.Clone().GetRawText();

            AssertLow("post", "/revit/delete", bodyJson);
        }

        [Theory]
        [InlineData("{\"ids\":[101],\"apply\":true}")]
        [InlineData("{\"ids\":[101]}")]
        [InlineData("{\"ids\":[101],\"dryRun\":true}")]
        public void ActualOrGenericDryRunDeleteRequiresApproval(string body)
        {
            AssertHigh("POST", "/revit/delete", body);
        }

        [Theory]
        [InlineData("{\"ids\":[101],\"apply\":\"false\"}")]
        [InlineData("{\"ids\":[101],\"apply\":0}")]
        [InlineData("{\"ids\":[101],\"apply\":null}")]
        [InlineData("{\"ids\":[101],\"Apply\":false}")]
        [InlineData("{\"ids\":[101],\"APPLY\":false}")]
        [InlineData("{\"ids\":[101],\"dry_run\":false}")]
        [InlineData("{\"ids\":[101],\"apply\":false,\"Apply\":false}")]
        [InlineData("{\"ids\":[101],\"apply\":false,\"apply\":false}")]
        [InlineData("[{\"ids\":[101],\"apply\":false}]")]
        [InlineData("false")]
        [InlineData("null")]
        [InlineData("{\"ids\":[101],\"apply\":false")]
        public void AmbiguousOrUntrustedDeleteBodiesDoNotDowngrade(string body)
        {
            AssertHigh("POST", "/revit/delete", body);
        }

        [Theory]
        [InlineData("PUT", "/revit/delete")]
        [InlineData("POST", "/revit/delete/")]
        [InlineData("POST", "/revit/delete-preview")]
        public void OtherMethodsOrPathsDoNotDowngrade(string method, string path)
        {
            AssertHigh(method, path, "{\"ids\":[101],\"apply\":false}");
        }

        [Theory]
        [InlineData("/revit/fire-damper-audit", "{\"command\":\"audit\"}")]
        [InlineData("/revit/lighting-audit", "{\"command\":\"validate_ies\",\"fix\":false}")]
        [InlineData("/revit/lighting-audit", "{\"command\":\"photometrics\",\"visualize\":false}")]
        [InlineData("/revit/list-element-types", "{}")]
        [InlineData("/revit/list-element-types", "{\"action\":\"list\"}")]
        public void ConditionalRoutesRemainLowForReadOnlyBodies(string path, string body)
        {
            AssertLow("POST", path, body);
            Assert.Equal(OperatorActionEffect.Read, OperatorApprovalPolicy.GetEffect("POST", path, body));
            Assert.Equal("read", OperatorApprovalPolicy.GetEffectWireValue("POST", path, body));
        }

        [Theory]
        [InlineData("{\"action\":\"list\"}")]
        [InlineData("{\"action\":\"detail\",\"scheduleId\":2284420}")]
        public void ScheduleInspectionPostsRemainLowRiskAndReadOnly(string body)
        {
            AssertLow("POST", "/revit/schedules", body);
            Assert.Equal(OperatorActionEffect.Read, OperatorApprovalPolicy.GetEffect(
                "POST", "/revit/schedules", body));
            Assert.Equal("read", OperatorApprovalPolicy.GetEffectWireValue(
                "POST", "/revit/schedules", body));
        }

        [Theory]
        [InlineData("/revit/fire-damper-audit", "{\"command\":\"fix\"}")]
        [InlineData("/revit/lighting-audit", "{\"command\":\"validate_ies\",\"fix\":true}")]
        [InlineData("/revit/lighting-audit", "{\"command\":\"photometrics\",\"visualize\":true}")]
        [InlineData("/revit/list-element-types", "{\"action\":\"rename_types\",\"dryRun\":true}")]
        [InlineData("/revit/list-element-types", "{\"action\":\"purge_unused_in_family\"}")]
        public void ConditionalRoutesAreHighForMutationIntentBodies(string path, string body)
        {
            AssertHigh("POST", path, body);
            var expectedEffect = path == "/revit/list-element-types" && body.Contains("\"dryRun\":true")
                ? OperatorActionEffect.Preview
                : OperatorActionEffect.Apply;
            Assert.Equal(expectedEffect, OperatorApprovalPolicy.GetEffect("POST", path, body));
        }

        [Theory]
        [InlineData("/revit/delete", "{\"ids\":[101],\"apply\":false}")]
        [InlineData("/revit/set-parameters", "{\"elementIds\":[101],\"dryRun\":true}")]
        public void PreviewBodiesRetainPreviewEffect(string path, string body)
        {
            Assert.Equal(OperatorActionEffect.Preview, OperatorApprovalPolicy.GetEffect("POST", path, body));
            Assert.Equal("preview", OperatorApprovalPolicy.GetEffectWireValue("POST", path, body));
        }

        [Fact]
        public void TransactionPlanIsMediumRiskButAlwaysPreview()
        {
            var body = "{\"actions\":[{\"method\":\"POST\",\"path\":\"/revit/set-parameters\",\"body\":{}}]}";

            Assert.Equal(OperatorActionRisk.Medium, OperatorApprovalPolicy.GetRisk(
                "POST", "/revit/transaction-plan", body));
            Assert.Equal(OperatorActionEffect.Preview, OperatorApprovalPolicy.GetEffect(
                "POST", "/revit/transaction-plan", body));
            Assert.Equal("preview", OperatorApprovalPolicy.GetEffectWireValue(
                "POST", "/revit/transaction-plan", body));
            Assert.Equal(OperatorActionEffect.Preview, OperatorApprovalPolicy.GetEffect(
                "POST", "/revit/transaction-plan", null));
        }

        [Fact]
        public void NativeApiPolicyMutationIsHighRiskAndRequiresSafeModeApproval()
        {
            Assert.Equal(
                OperatorActionRisk.Low,
                OperatorApprovalPolicy.GetRisk("GET", "/revit/native-api-policy", null));

            var risk = OperatorApprovalPolicy.GetRisk(
                "POST",
                "/revit/native-api-policy",
                "{\"profile\":\"unrestricted\",\"allowMutating\":true}");

            Assert.Equal(OperatorActionRisk.High, risk);
            Assert.Equal(OperatorActionEffect.Apply, OperatorApprovalPolicy.GetEffect(
                "POST",
                "/revit/native-api-policy",
                "{\"profile\":\"unrestricted\",\"allowMutating\":true}"));
            Assert.True(OperatorApprovalPolicy.RequiresApproval(OperatorApprovalMode.Safe, risk));
        }

        [Fact]
        public void NativeProcessSatisfiesCrossRuntimeActionEffectGoldenVectors()
        {
            var contractPath = Path.Combine(
                FindRepositoryRoot(),
                "packages",
                "revit-action-effect-v1",
                "golden-vectors.json");
            using var document = JsonDocument.Parse(File.ReadAllText(contractPath));
            var root = document.RootElement;
            Assert.Equal("revit_action_effect_v1_golden_vectors", root.GetProperty("schema").GetString());

            foreach (var vector in root.GetProperty("vectors").EnumerateArray())
            {
                var id = vector.GetProperty("id").GetString() ?? "unnamed";
                var method = vector.GetProperty("method").GetString() ?? "";
                var path = vector.GetProperty("path").GetString() ?? "";
                var bodyElement = vector.GetProperty("body");
                var body = bodyElement.ValueKind == JsonValueKind.Null ? null : bodyElement.GetRawText();
                var expected = vector.GetProperty("expected_effect").GetString() ?? "";
                var actual = OperatorApprovalPolicy.GetEffectWireValue(method, path, body);
                Assert.True(
                    string.Equals(expected, actual, StringComparison.Ordinal),
                    $"{id}: expected {expected}, got {actual} for {method} {path}.");
            }
        }

        [Fact]
        public void DeclaredRequestedEffectCannotOverrideTheNativeRequestContract()
        {
            const string previewBody = "{\"elementId\":1421361,\"dryRun\":true,\"apply\":false}";
            const string applyBody = "{\"elementId\":1421361,\"dryRun\":false,\"apply\":true}";

            Assert.Equal("preview", OperatorApprovalPolicy.ResolveRequestedEffectWireValue(
                null, "POST", "/revit/replace-text-note", previewBody));
            Assert.Equal("preview", OperatorApprovalPolicy.ResolveRequestedEffectWireValue(
                "preview", "POST", "/revit/replace-text-note", previewBody));
            Assert.Throws<InvalidOperationException>(() => OperatorApprovalPolicy.ResolveRequestedEffectWireValue(
                "preview", "POST", "/revit/replace-text-note", applyBody));
            Assert.Throws<InvalidOperationException>(() => OperatorApprovalPolicy.ResolveRequestedEffectWireValue(
                "unknown", "POST", "/revit/replace-text-note", previewBody));
        }

        private static void AssertLow(string method, string path, string body)
        {
            var risk = OperatorApprovalPolicy.GetRisk(method, path, body);

            Assert.Equal(OperatorActionRisk.Low, risk);
            Assert.False(OperatorApprovalPolicy.RequiresApproval(OperatorApprovalMode.Safe, risk));
            Assert.False(risk >= OperatorActionRisk.Medium);
        }

        private static void AssertHigh(string method, string path, string body)
        {
            var risk = OperatorApprovalPolicy.GetRisk(method, path, body);

            Assert.Equal(OperatorActionRisk.High, risk);
            Assert.True(OperatorApprovalPolicy.RequiresApproval(OperatorApprovalMode.Safe, risk));
            Assert.True(risk >= OperatorActionRisk.Medium);
        }

        private static string FindRepositoryRoot()
        {
            var current = new DirectoryInfo(AppContext.BaseDirectory);
            while (current != null)
            {
                var gitMetadata = Path.Combine(current.FullName, ".git");
                var contract = Path.Combine(current.FullName, "packages", "revit-action-effect-v1", "golden-vectors.json");
                if ((Directory.Exists(gitMetadata) || File.Exists(gitMetadata)) && File.Exists(contract))
                {
                    return current.FullName;
                }
                current = current.Parent;
            }
            throw new DirectoryNotFoundException("Could not locate the public repository root.");
        }
    }
}
