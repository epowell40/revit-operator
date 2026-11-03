using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using RevitBridge.Common.Annotation;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorRouteExamplesTests
    {
        private static JsonElement Example(string path)
        {
            using var catalog = JsonDocument.Parse(File.ReadAllText(
                Path.Combine(AppContext.BaseDirectory, "Fixtures", "native-tool-examples.json")));
            return catalog.RootElement.GetProperty("tools").EnumerateArray()
                .Single(tool => tool.GetProperty("method").GetString() == "POST"
                    && tool.GetProperty("path").GetString() == path)
                .GetProperty("examples")[0].GetProperty("request").Clone();
        }

        [Fact]
        public void PublishedInteractivePlacementExamplePassesTheActualNativeRequestParser()
        {
            var request = NativeInteractiveAccessoryRequest.Parse(
                Example("/revit/place-mep-accessory-interactively").GetRawText());
            Assert.Single(request.targetHosts);
            Assert.Equal(1, request.maximumPlacements);
        }

        [Fact]
        public void PublishedLabelEditUsesTheInspectedSessionAndActualStylePrecondition()
        {
            var inspection = Example("/revit/inspect-family-label-styles");
            var edit = FamilyLabelStylePolicy.Parse(Example("/revit/set-family-label-style").GetRawText());
            Assert.Equal(inspection.GetProperty("familyDocumentId").GetString(), edit.familyDocumentId);
            Assert.Equal(inspection.GetProperty("labelTypeId").GetInt64(), edit.labelTypeId);
            Assert.False(edit.expectedStyle.underline);
            Assert.True(edit.style.underline);
            Assert.False(edit.dryRun);
        }
    }
}
