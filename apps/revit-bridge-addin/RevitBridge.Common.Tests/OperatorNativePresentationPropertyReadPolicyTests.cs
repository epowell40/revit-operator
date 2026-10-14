using RevitBridge.Common;
using System;
using System.IO;
using System.Text.Json;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorNativePresentationPropertyReadPolicyTests
    {
        [Fact]
        public void RetainedReadFailureIsThePassiveShadingGetterRatherThanAMutation()
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,
                "Fixtures", "native-table-style-passive-getter-rejected.json")));
            var root = fixture.RootElement;
            Assert.Equal(400, root.GetProperty("status").GetInt32());
            Assert.Equal("/revit/native-api-ops", root.GetProperty("route").GetString());
            Assert.False(root.GetProperty("payload").GetProperty("request_dispatched").GetBoolean());
            var found = false;
            foreach (var operation in root.GetProperty("body").GetProperty("operations").EnumerateArray())
            {
                if (!operation.TryGetProperty("property", out var name) || name.GetString() != "IsInactivePhaseload") continue;
                Assert.Equal("get_property", operation.GetProperty("op").GetString());
                Assert.Equal("$style", operation.GetProperty("target").GetString());
                Assert.True(OperatorNativePresentationPropertyReadPolicy.IsPassiveRead(
                    "Autodesk.Revit.DB.TableCellStyle", name.GetString(), "System.Boolean"));
                found = true;
            }
            Assert.True(found);
        }

        [Theory]
        [InlineData("Autodesk.Revit.DB.TableCellStyle", "IsInactivePhaseload")]
        [InlineData("Autodesk.Revit.DB.Electrical.PanelScheduleData", "IsAutoShadingForLoadDisplay")]
        public void CachedSdkShadingFlagsAreReadable(string declaringType, string property)
            => Assert.True(OperatorNativePresentationPropertyReadPolicy.IsPassiveRead(declaringType, property, "System.Boolean"));

        [Theory]
        [InlineData("Autodesk.Revit.DB.Document", "Load", "System.Boolean")]
        [InlineData("Autodesk.Revit.DB.TableCellStyle", "Load", "System.Boolean")]
        [InlineData("Autodesk.Revit.DB.TableCellStyle", "set_IsInactivePhaseload", "System.Boolean")]
        [InlineData("Autodesk.Revit.DB.TableCellStyle", "IsInactivePhaseload", "System.String")]
        [InlineData("Custom.TableCellStyle", "IsInactivePhaseload", "System.Boolean")]
        [InlineData("Autodesk.Revit.DB.Document", "IsInactivePhaseload", "System.Boolean")]
        [InlineData("Autodesk.Revit.DB.Electrical.PanelScheduleData", "Reload", "System.Boolean")]
        [InlineData("Autodesk.Revit.DB.Electrical.PanelScheduleData", "IsAutoShadingForLoadDisplay", "System.Object")]
        [InlineData(null, "IsInactivePhaseload", "System.Boolean")]
        public void SimilarNamesAndExecutableMembersReceiveNoException(string? declaringType, string property, string resultType)
            => Assert.False(OperatorNativePresentationPropertyReadPolicy.IsPassiveRead(declaringType, property, resultType));
    }
}
