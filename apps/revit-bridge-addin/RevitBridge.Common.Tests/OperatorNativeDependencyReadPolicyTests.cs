using System;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorNativeDependencyReadPolicyTests
    {
        private const string Result = "System.Collections.Generic.IList`1<Autodesk.Revit.DB.ElementId>";

        [Fact]
        public void SdkDependencyReadHasOnlyTheDocumentedNullFilterException()
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,
                "Fixtures", "native-dependency-signature-unsupported.json")));
            var old = fixture.RootElement.GetProperty("item");
            Assert.False(old.GetProperty("graph_signature_supported").GetBoolean());
            Assert.False(old.GetProperty("signature_supported").GetBoolean());
            Assert.Equal("method:Autodesk.Revit.DB.Element.GetDependentElements(Autodesk.Revit.DB.ElementFilter)", old.GetProperty("member_id").GetString());
            Assert.True(OperatorNativeDependencyReadPolicy.IsUnfilteredRead("Autodesk.Revit.DB.Element",
                "GetDependentElements", false, Result, new[] { "Autodesk.Revit.DB.ElementFilter" }));
            using var arguments = JsonDocument.Parse("[null]");
            OperatorNativeDependencyReadPolicy.RequireNullFilter(new[] { arguments.RootElement[0] });
        }

        [Theory]
        [InlineData("[]")]
        [InlineData("[null,null]")]
        [InlineData("[{}]")]
        [InlineData("[{\"$ref\":\"filter\"}]")]
        [InlineData("[\"null\"]")]
        [InlineData("[0]")]
        [InlineData("[false]")]
        public void NoImplicitFilterOrReferenceDeserialization(string json)
        {
            using var document = JsonDocument.Parse(json);
            var arguments = new System.Collections.Generic.List<JsonElement>();
            foreach (var value in document.RootElement.EnumerateArray()) arguments.Add(value);
            Assert.Throws<InvalidOperationException>(() => OperatorNativeDependencyReadPolicy.RequireNullFilter(arguments));
        }

        [Theory]
        [InlineData("Custom.Element", "GetDependentElements", false, Result, "Autodesk.Revit.DB.ElementFilter")]
        [InlineData("Autodesk.Revit.DB.Element", "Delete", false, Result, "Autodesk.Revit.DB.ElementFilter")]
        [InlineData("Autodesk.Revit.DB.Element", "GetDependentElements", true, Result, "Autodesk.Revit.DB.ElementFilter")]
        [InlineData("Autodesk.Revit.DB.Element", "GetDependentElements", false, "System.Object", "Autodesk.Revit.DB.ElementFilter")]
        [InlineData("Autodesk.Revit.DB.Element", "GetDependentElements", false, Result, "Custom.ElementFilter")]
        public void SimilarSignaturesReceiveNoException(string type, string method, bool isStatic, string result, string parameter)
            => Assert.False(OperatorNativeDependencyReadPolicy.IsUnfilteredRead(type, method, isStatic, result, new[] { parameter }));

        [Fact]
        public void ArityMustMatchTheExactSdkMethod()
        {
            Assert.False(OperatorNativeDependencyReadPolicy.IsUnfilteredRead("Autodesk.Revit.DB.Element", "GetDependentElements", false, Result, Array.Empty<string>()));
            Assert.False(OperatorNativeDependencyReadPolicy.IsUnfilteredRead("Autodesk.Revit.DB.Element", "GetDependentElements", false, Result, new[] { "Autodesk.Revit.DB.ElementFilter", "System.Boolean" }));
        }
    }
}
