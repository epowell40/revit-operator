using System;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ViewNameParameterWriteTests
    {
        private static string Source(string relative)
        {
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, relative);
                    if (File.Exists(file)) return File.ReadAllText(file);
                }
            throw new FileNotFoundException(relative);
        }

        [Fact]
        public void ViewNameParameterUsesTypedViewPropertyInsteadOfUiCoupledStringSetter()
        {
            var source = Source("RevitBridge.Common/ParameterValueUtil.cs");
            var method = source.Substring(source.IndexOf("public static bool TrySetFromString", StringComparison.Ordinal));
            var branch = method.Substring(method.IndexOf("case StorageType.String:", StringComparison.Ordinal));
            branch = branch.Substring(0, branch.IndexOf("case StorageType.Integer:", StringComparison.Ordinal));
            Assert.Contains("IsNativeViewNameParameter(param)", branch);
            Assert.Contains("view.Name = next", branch);
            Assert.True(branch.IndexOf("view.Name = next", StringComparison.Ordinal) < branch.IndexOf("param.Set(next)", StringComparison.Ordinal));
            Assert.Contains("BuiltInParameter.VIEW_NAME", source);
            Assert.Contains("param.Element is View", source);
            Assert.DoesNotContain("SuppressConfirm", source);
            Assert.DoesNotContain("OverrideResult", source);
        }

        [Fact]
        public void ExistingDedicatedViewRenameUsesTheSameNativeProperty()
        {
            Assert.Contains("view.Name = uniqueName", Source("RevitBridge/Handlers/CreateViewHandler.cs"));
        }

        [Fact]
        public void ParameterGuardsAndCommittedReadbackRemainBeforeAndAfterTheWrite()
        {
            var util = Source("RevitBridge.Common/ParameterValueUtil.cs");
            Assert.True(util.IndexOf("if (param.IsReadOnly)", StringComparison.Ordinal) < util.IndexOf("param.Set(next)", StringComparison.Ordinal));
            Assert.Contains("string.Equals(current, next, StringComparison.Ordinal)", util);
            var handler = Source("RevitBridge/Handlers/SetParameterHandler.cs");
            Assert.True(handler.IndexOf("expected_old_value_mismatch", StringComparison.Ordinal) < handler.IndexOf("ParameterValueUtil.TrySetFromString", StringComparison.Ordinal));
            Assert.Contains("ParameterValueUtil.SnapshotMatchesRequestedValue(actual, target.ExpectedValue)", handler);
            Assert.Contains("changeInventory.Diagnostics()", handler);
            Assert.Contains("AnnotationSchedulePreservation.AttachParameterResult", handler);
        }

        [Fact]
        public void SelectedIdentityObservationUsesStableNativeParameterIdsAndLiteralNames()
        {
            var observation = NativeViewNameObservation.Create(42, "native-view-uid", "View Name", "L2",
                "Family and Type", "Floor Plan: Floor Plan");
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(observation));
            Assert.Equal(42, json.RootElement.GetProperty("elementId").GetInt64());
            Assert.Equal(-1005112, json.RootElement.GetProperty("parameterId").GetInt64());
            Assert.Equal(-1139998, json.RootElement.GetProperty("familyParameterId").GetInt64());
            Assert.Equal("L2", json.RootElement.GetProperty("name").GetString());
            Assert.Equal("native-view-uid", json.RootElement.GetProperty("uniqueId").GetString());
            foreach (var bad in new[] { "", " ", "bad\nname", new string('x', 257) })
                Assert.Throws<ArgumentException>(() => NativeViewNameObservation.Create(42, "native-view-uid", "View Name", bad,
                    "Family and Type", "Floor Plan: Floor Plan"));
            Assert.Throws<ArgumentException>(() => NativeViewNameObservation.Create(0, "uid", "View Name", "L2", "Family and Type", "Floor Plan"));
        }

        [Fact]
        public void BeforeAndCommittedAfterObservationsDoNotSynthesizeIdentityOrSettleMissingReads()
        {
            var source = Source("RevitBridge.Common/NativeViewNameObservation.cs");
            Assert.Contains("view.get_Parameter(BuiltInParameter.VIEW_NAME)", source);
            Assert.Contains("view.get_Parameter(BuiltInParameter.VIEW_FAMILY_AND_TYPE_SCHEDULES)", source);
            Assert.Contains("view.UniqueId", source);
            Assert.Contains("name.AsString() != view.Name", source);
            var handler = Source("RevitBridge/Handlers/SetParameterHandler.cs");
            Assert.Contains("if (!committed || targets.Count == 0) return payload", handler);
            Assert.Contains("before.Count == targets.Count", handler);
            Assert.Contains("catch { complete = false; }", handler);
            Assert.DoesNotContain("DialogBoxShowing", handler);
            Assert.DoesNotContain("OverrideResult", handler);
        }
    }
}
