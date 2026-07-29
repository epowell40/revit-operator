using System;
using System.IO;
using System.Linq;
using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class NativeApiPolicyMethodBoundaryContractTests
    {
        [Fact]
        public void HandlerUsesMethodTruthBeforeInspectingAnAdversarialGetBody()
        {
            var handler = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Handlers", "NativeApiHandlers.cs");

            AssertOrdered(
                handler,
                "var normalizedMethod = (method ?? \"\").Trim().ToUpperInvariant();",
                "if (normalizedMethod == \"GET\")",
                "OperatorNativeApiPolicy.GetStatus()",
                "if (normalizedMethod != \"POST\")",
                "JsonSerializer.Deserialize<Params>(jsonData",
                "OperatorNativeApiPolicy.SetPolicy(");
            Assert.Contains("return HandleForMethod(app, jsonData, \"GET\");", handler);
        }

        [Fact]
        public void DirectHttpAndActionRunnerPassTheirExactMethodsToThePolicyHandler()
        {
            var server = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Server", "RevitHttpServer.cs");
            var runner = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorActionRunner.cs");

            Assert.Contains("nativeApiPolicyHandler.HandleForMethod(null!, body, req.HttpMethod)", server);
            Assert.Contains("nativeApiPolicyHandler.HandleForMethod(null!, jsonBody, method)", runner);
        }

        [Fact]
        public void ManifestAndRuntimeAgreeThatPolicyPostIsHighRiskWhileGetIsLowRisk()
        {
            var manifest = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorToolManifest.cs");

            Assert.Contains(
                "\"POST\", \"/revit/native-api-policy\", \"Set Native API Policy\", OperatorActionRisk.High",
                manifest);
            Assert.Equal(OperatorActionRisk.High, OperatorApprovalPolicy.GetRisk(
                "POST",
                "/revit/native-api-policy",
                "{\"profile\":\"unrestricted\",\"allowMutating\":true}"));
            Assert.Equal(OperatorActionRisk.Low, OperatorApprovalPolicy.GetRisk(
                "GET",
                "/revit/native-api-policy",
                "{\"profile\":\"unrestricted\",\"allowMutating\":true}"));
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
