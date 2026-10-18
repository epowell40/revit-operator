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
        public void DependencyReadExceptionIsSdkBoundGraphOnlyAndRejectsNonNullBeforeInvocation()
        {
            var gateway = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorNativeApiGateway.cs");
            AssertOrdered(gateway, "private static NativeApiMemberDescriptor? BuildDescriptor(",
                "dependencyRead.DeclaringType == typeof(Element)",
                "dependencyRead.DeclaringType.Assembly == typeof(Element).Assembly",
                "OperatorNativeDependencyReadPolicy.IsUnfilteredRead(",
                "!unfilteredDependencyRead && !IsGraphSupportedType(p.ParameterType)",
                "Callable = unsupported.Count == 0", "UnfilteredDependencyRead = unfilteredDependencyRead");
            AssertOrdered(gateway, "var provided = descriptor == null ? new List<JsonElement>() : ReadArgs(operation.args);",
                "OperatorNativeDependencyReadPolicy.RequireNullFilter(provided)",
                "var args = new object?[ps.Length];", "args[i] = null;",
                "raw = propertyInfo != null ? propertyInfo.GetValue(targetObject, null) : InvokeReflectedMember(descriptor!, targetObject, args);");
            Assert.Contains("BoundedNativeSequence.Project(seq, item => ReturnShape(item, depth + 1))", gateway);
            Assert.Contains("native-api-ops v2 is read-only; member is not low-risk", gateway);
        }

        [Fact]
        public void SingleCallGatewayRejectsMutationAndFreezeRiskBeforeReflection()
        {
            var gateway = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorNativeApiGateway.cs");
            AssertOrdered(
                gateway,
                "public static object Invoke(UIApplication app, string memberId, string? target, JsonElement? args, bool dryRun)",
                "if (descriptor.MutatingHint || descriptor.FreezeRiskHint || descriptor.RiskLevel != OperatorActionRisk.Low)",
                "raw = InvokeReflectedMember(descriptor, invokeTarget, values);");
        }

        [Fact]
        public void PassivePropertyExceptionBindsSdkMetadataAndKeepsFreezeGuard()
        {
            var gateway = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorNativeApiGateway.cs");
            AssertOrdered(gateway,
                "private static PropertyInfo ResolveReadableProperty(",
                "var matches = target.GetType()",
                "var property = matches[0];",
                "property.DeclaringType?.Assembly == typeof(Element).Assembly",
                "OperatorNativePresentationPropertyReadPolicy.IsPassiveRead(",
                "property.DeclaringType?.FullName, property.Name, property.PropertyType.FullName",
                "IsFreezeRiskHint(propertyName, target.GetType()) && !passivePresentationRead",
                "is blocked by the freeze-risk policy",
                "return property;");
            // The exception belongs only to a public-property read. Single-call
            // and mutation-graph method risk fences still classify executable calls.
            Assert.Contains("if (descriptor.MutatingHint || descriptor.FreezeRiskHint || descriptor.RiskLevel != OperatorActionRisk.Low)", gateway);
            Assert.Contains("native-api-mutation-ops blocks freeze-risk members:", gateway);
        }

        [Fact]
        public void GraphReceiptsCaptureActualElementReceiverBeforeInvocation()
        {
            var gateway = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorNativeApiGateway.cs");
            AssertOrdered(gateway,
                "targetObject = ResolveOperationTarget(operation.target, descriptor.DeclaringType, app, values, id);",
                "var targetIdentity = CaptureElementReceiverIdentity(targetObject, app.ActiveUIDocument?.Document);",
                "raw = propertyInfo != null ? propertyInfo.GetValue(targetObject, null) : InvokeReflectedMember(descriptor!, targetObject, args);",
                "target_identity = targetIdentity");
            Assert.Contains("schema = \"operator.native_element_receiver.v1\"", gateway);
            Assert.Contains("element_id = ElementIdCompat.GetValue(element.Id)", gateway);
            Assert.Contains("unique_id = element.UniqueId", gateway);
            Assert.Contains("type_name = element.GetType().FullName", gateway);
            Assert.Contains("active_document = activeDocument != null && element.Document.Equals(activeDocument)", gateway);
        }

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

            Assert.Contains("var effectiveMethod = effectiveRequest?.Method ?? req.HttpMethod;", server);
            Assert.Contains("nativeApiPolicyHandler.HandleForMethod(null!, body, effectiveMethod)", server);
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
                if (relativeSegments.Length > 1 && relativeSegments[0] == "apps")
                {
                    var integrationCandidate = Path.Combine(new[] { cursor.FullName }.Concat(relativeSegments.Skip(1)).ToArray());
                    if (File.Exists(integrationCandidate)) return File.ReadAllText(integrationCandidate);
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
