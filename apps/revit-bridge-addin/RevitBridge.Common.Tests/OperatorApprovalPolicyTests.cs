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
    }
}
