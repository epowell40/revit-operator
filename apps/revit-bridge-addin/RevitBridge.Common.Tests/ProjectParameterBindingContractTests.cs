using System.Linq;
using System;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ProjectParameterBindingContractTests
    {
        [Fact]
        public void NativeCreateRetainsStageDiagnosticsWithoutReplacingTransactionAuthority()
        {
            var source = ReadRepoFile("Handlers", "ProjectParameterBindingOperations.cs");
            Assert.Contains("stage = \"insert_binding\"", source);
            Assert.Contains("stage = \"lookup_parameter\"", source);
            Assert.Contains("stage = \"read_complete_binding_detail\"", source);
            Assert.Contains("stage = \"compare_old_parameter_values\"", source);
            Assert.Contains("OperatorNativeFailureDiagnostic.Capture(error, stage);", source);
            Assert.Contains("if (failureDiagnostic != null) result[\"failureDiagnostic\"] = failureDiagnostic;", source);
            Assert.Contains("result[\"status\"] = OperatorNativeTransactionExecution.OutcomeStatus", source);
        }

        [Fact]
        public void CompleteCategoryInstanceAndTypeStateIsComparedInsideTheNativeTransaction()
        {
            var scope = ReadRepoFile("Handlers", "ProjectParameterBindingPreservation.cs");
            Assert.Contains("new FilteredElementCollector(doc).OfCategoryId", scope);
            Assert.DoesNotContain("WhereElementIsNotElementType", scope);
            Assert.DoesNotContain("WhereElementIsElementType", scope);
            Assert.Contains("element.Parameters.Cast<Parameter>().Select(Value)", scope);
            Assert.Contains("isType = element is ElementType", scope);
            Assert.Contains("case StorageType.Integer: raw = p.AsInteger();", scope);
            Assert.Contains("case StorageType.ElementId: raw = ElementIdCompat.GetValue(p.AsElementId());", scope);
            var operations = ReadRepoFile("Handlers", "ProjectParameterBindingOperations.cs");
            var before = operations.IndexOf("preservationBefore = Complete(ProjectParameterBindingPreservation.Capture", StringComparison.Ordinal);
            var transaction = operations.IndexOf("NativeSingleTransaction.Execute", before, StringComparison.Ordinal);
            var after = operations.IndexOf("var preserved = after.GetProperty(\"preservation\")", transaction, StringComparison.Ordinal);
            var guard = operations.IndexOf("Existing category instance/type identities or raw parameter values changed; roll back.", after, StringComparison.Ordinal);
            var result = operations.IndexOf("return new Dictionary<string, object?>", guard, StringComparison.Ordinal);
            Assert.True(before >= 0 && transaction > before && after > transaction && guard > after && result > guard);
            Assert.Contains("preservation = ProjectParameterBindingPreservation.Capture(doc, categoryIds, id)", operations);
        }

        private static string ReadRepoFile(params string[] parts)
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            foreach (var prefix in new[] { new[] { "apps", "revit-bridge-addin", "RevitBridge" }, new[] { "revit-bridge-addin", "RevitBridge" } })
            {
                var file = Path.Combine(new[] { dir.FullName }.Concat(prefix).Concat(parts).ToArray());
                if (File.Exists(file)) return File.ReadAllText(file);
            }
            throw new FileNotFoundException("Native binding source unavailable.");
        }

        [Theory]
        [InlineData("{}", true)]
        [InlineData("{\"action\":\"list\",\"query\":\"Office\",\"max\":5000}", true)]
        [InlineData("{\"action\":\"detail\",\"parameterId\":42}", true)]
        [InlineData("{\"action\":\"detail\",\"parameterId\":0}", false)]
        [InlineData("{\"action\":\"detail\",\"parameterId\":9007199254740992}", false)]
        [InlineData("{\"action\":\"detail\",\"parameterId\":\"42\"}", false)]
        [InlineData("{\"action\":\"detail\",\"parameterId\":42,\"instanceBinding\":true}", false)]
        [InlineData("{\"action\":\"list\",\"name\":\"Test\"}", false)]
        [InlineData("{\"action\":\"list\",\"max\":5001}", false)]
        [InlineData("{\"action\":null}", false)]
        [InlineData("[]", false)]
        public void ReadAuthorityRequiresAnExactNonmutatingShape(string json, bool expected)
        {
            using var doc = JsonDocument.Parse(json);
            Assert.Equal(expected, ProjectParameterBindingContract.IsReadOnly(doc.RootElement));
            Assert.Equal(expected ? OperatorActionEffect.Read : OperatorActionEffect.Apply,
                OperatorApprovalPolicy.GetEffect("POST", "/revit/project-parameters", json));
            Assert.Equal(expected ? OperatorActionRisk.Low : OperatorActionRisk.High,
                OperatorApprovalPolicy.GetRisk("POST", "/revit/project-parameters", json));
        }

        [Theory]
        [InlineData("{\"action\":\"create\",\"name\":\"Office Instance Note\",\"categoryNames\":[\"Air Terminals\"],\"instanceBinding\":true,\"dataType\":\"text\"}", true)]
        [InlineData("{\"action\":\"create\",\"name\":\"Office Type Note\",\"categoryNames\":[\"Air Terminals\"],\"instanceBinding\":false,\"dataType\":\"text\"}", true)]
        [InlineData("{\"action\":\"create\",\"name\":\" \",\"categoryNames\":[\"Air Terminals\"]}", false)]
        [InlineData("{\"action\":\"create\",\"name\":\"Note\",\"categoryNames\":[]}", false)]
        [InlineData("{\"action\":\"create\",\"name\":\"Note\",\"categoryNames\":[\"Air Terminals\"],\"instanceBinding\":null}", false)]
        [InlineData("{\"action\":\"create\",\"name\":\"Note\",\"categoryNames\":[\"Air Terminals\"],\"dataType\":\"airflow\"}", false)]
        [InlineData("{\"action\":\"create\",\"name\":\"Note\",\"categoryNames\":[\"Air Terminals\"],\"parameterId\":42}", false)]
        [InlineData("{\"action\":\"create\",\"name\":\"Note\",\"categoryNames\":[\"Air Terminals\"],\"rebindIfExists\":true}", false)]
        public void NewBindingKeepsTypeAndInstanceChoicesExplicitAndDoesNotInventEngineeringTypes(string json, bool expected)
        {
            using var doc = JsonDocument.Parse(json);
            Assert.Equal(expected, ProjectParameterBindingContract.ValidateCreate(doc.RootElement, out _));
        }

        [Fact]
        public void PublishedDetailAndCreateModesCannotLeakFieldsIntoEachOther()
        {
            Assert.True(OperatorConditionalRequestContracts.TryGet("/revit/project-parameters", out var schema));
            var modes = schema.GetProperty("oneOf").EnumerateArray().ToArray();
            var detail = modes.Single(m => m.GetProperty("properties").GetProperty("action").GetProperty("enum")[0].GetString() == "detail");
            var create = modes.Single(m => m.GetProperty("properties").GetProperty("action").GetProperty("enum")[0].GetString() == "create");
            Assert.False(detail.GetProperty("additionalProperties").GetBoolean());
            Assert.False(create.GetProperty("additionalProperties").GetBoolean());
            Assert.False(detail.GetProperty("properties").TryGetProperty("instanceBinding", out _));
            Assert.False(create.GetProperty("properties").TryGetProperty("parameterId", out _));
        }
    }
}
