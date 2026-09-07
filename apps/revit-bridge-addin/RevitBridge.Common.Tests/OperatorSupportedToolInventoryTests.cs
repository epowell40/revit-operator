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
        public void EveryImplementedRouteIsConstrainedAtNativeAdmissionAndDiscovery()
        {
            var field = typeof(OperatorToolManifest).GetField("ImplementedTools", BindingFlags.NonPublic | BindingFlags.Static);
            var implemented = Assert.IsAssignableFrom<IReadOnlyList<OperatorToolInfo>>(field!.GetValue(null));
            Assert.Equal(216, implemented.Count);
            Assert.Equal(101, OperatorToolManifest.Tools.Count);
            Assert.Equal(101, OperatorActionAllowlist.EnumerateAllowed().Count());
            foreach (var route in implemented)
            {
                var supported = OperatorSupportedToolInventory.IsSupportedTool(route.Method, route.Path);
                Assert.Equal(supported, OperatorActionAllowlist.IsAllowed(route.Method, route.Path));
                Assert.Equal(supported, OperatorToolManifest.Tools.Any(t => t.Method == route.Method && t.Path == route.Path));
                if (!supported)
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
            Assert.False(OperatorSupportedToolInventory.IsSupportedTransport("GET", "/revit/dynamic-runtime/bootstrap"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTransport("POST", "/revit/dynamic-runtime/new-unreviewed-route"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTransport("POST", "/revit/CREATE-VIEW"));
        }
    }
}
