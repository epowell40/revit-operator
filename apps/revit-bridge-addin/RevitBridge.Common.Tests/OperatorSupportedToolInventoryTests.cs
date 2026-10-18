using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorSupportedToolInventoryTests
    {
        [Fact]
        public void ExcelSourceInspectionIsDiscoverableWithoutEnablingLegacyMutation()
        {
            const string path = "/revit/inspect-excel-source";
            Assert.True(OperatorSupportedToolInventory.IsSupportedTool("POST", path));
            Assert.True(OperatorActionAllowlist.IsAllowed("POST", path));
            Assert.Equal(OperatorActionRisk.Low, Assert.Single(OperatorToolManifest.Tools, t => t.Method == "POST" && t.Path == path).RiskLevel);
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("GET", path));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/import-excel-table"));
            Assert.True(OperatorConditionalRequestContracts.TryGet(path, out var schema));
            Assert.Equal(4, schema.GetProperty("oneOf").GetArrayLength());
        }
        [Fact]
        public void SourceBoundWordInspectionIsExposedAsReadWithoutAdjacentMutationRoutes()
        {
            const string path = "/revit/inspect-drawing-spec";
            Assert.True(OperatorSupportedToolInventory.IsSupportedTool("POST", path));
            Assert.True(OperatorActionAllowlist.IsAllowed("POST", path));
            var tool = Assert.Single(OperatorToolManifest.Tools, t => t.Method == "POST" && t.Path == path);
            Assert.Equal(OperatorActionRisk.Low, tool.RiskLevel);
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("GET", path));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("POST", path + "-apply"));
        }
        [Fact]
        public void WordSpecificationImportIsDiscoverableThroughExistingMutationAdmission()
        {
            const string path = "/revit/import-drawing-spec";
            Assert.True(OperatorSupportedToolInventory.IsSupportedTool("POST", path));
            Assert.True(OperatorActionAllowlist.IsAllowed("POST", path));
            var tool = Assert.Single(OperatorToolManifest.Tools.Where(t => t.Method == "POST" && t.Path == path));
            Assert.Contains(".docx", tool.Description);
            Assert.Equal(OperatorActionRisk.Medium, tool.RiskLevel);
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("GET", path));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/import-excel-table"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("POST", path + "-unreviewed"));
        }
        [Fact]
        public void CadLinkIsDiscoverableAndAdmittedWithoutOpeningAdjacentRoutes()
        {
            Assert.True(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/link-cad"));
            Assert.True(OperatorActionAllowlist.IsAllowed("POST", "/revit/link-cad"));
            Assert.Single(OperatorToolManifest.Tools.Where(t => t.Method == "POST" && t.Path == "/revit/link-cad"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("GET", "/revit/link-cad"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/link-cad-unreviewed"));
        }
        [Fact]
        public void SharedInstanceParameterCreationAndInspectionAreDiscoverableWithoutWideningOtherRoutes()
        {
            Assert.True(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/project-parameters"));
            Assert.True(OperatorActionAllowlist.IsAllowed("POST", "/revit/project-parameters"));
            Assert.Single(OperatorToolManifest.Tools.Where(t => t.Method == "POST" && t.Path == "/revit/project-parameters"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("GET", "/revit/project-parameters"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/project-parameters-unreviewed"));
        }
        [Fact]
        public void EveryImplementedRouteIsConstrainedAtNativeAdmissionAndDiscovery()
        {
            var field = typeof(OperatorToolManifest).GetField("ImplementedTools", BindingFlags.NonPublic | BindingFlags.Static);
            var implemented = Assert.IsAssignableFrom<IReadOnlyList<OperatorToolInfo>>(field!.GetValue(null));
            Assert.Equal(219, implemented.Count);
            Assert.Equal(114, OperatorToolManifest.Tools.Count);
            Assert.Equal(114, OperatorActionAllowlist.EnumerateAllowed().Count());
            Assert.True(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/locate-elements"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("GET", "/revit/locate-elements"));
            Assert.True(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/connect-existing-mep-branch"));
            Assert.True(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/model-health"));
            Assert.True(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/linked-room-boundaries"));
            Assert.True(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/existing-conditions-mep-draft-workflow"));
            foreach (var route in implemented)
            {
                var supported = OperatorSupportedToolInventory.IsSupportedTool(route.Method, route.Path);
                Assert.Equal(supported, OperatorActionAllowlist.IsAllowed(route.Method, route.Path));
                Assert.Equal(supported, OperatorToolManifest.Tools.Any(t => t.Method == route.Method && t.Path == route.Path));
                if (!OperatorSupportedToolInventory.IsSupportedTransport(route.Method, route.Path))
                {
                    var failure = Assert.Throws<OperatorToolUserErrorException>(() => OperatorSupportedToolInventory.RequireSupportedTransport(route.Method, route.Path));
                    Assert.Equal("PRODUCT_TOOL_NOT_SUPPORTED", failure.Code);
                }
            }
        }

        [Fact]
        public void NativeHostCannotAdmitStandaloneExecutorOrInventedInternalRoute()
        {
            Assert.False(OperatorSupportedToolInventory.IsSupportedTransport("POST", "/revit/certified/sheets/count"));
            Assert.True(OperatorSupportedToolInventory.IsSupportedTransport("POST", "/revit/dynamic-runtime/bootstrap"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/dynamic-runtime/bootstrap"));
            Assert.True(OperatorSupportedToolInventory.IsSupportedTransport("POST", "/revit/computer-use-guard"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/computer-use-guard"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTransport("GET", "/revit/computer-use-guard"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTransport("GET", "/revit/dynamic-runtime/bootstrap"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTransport("POST", "/revit/dynamic-runtime/new-unreviewed-route"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTransport("POST", "/revit/CREATE-VIEW"));
        }
    }
}
