using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Xunit;
using RevitBridge.Operator;

namespace RevitBridge.Common.Tests
{
    public sealed class NativeApiArgumentDocumentationTests
    {
        [Fact]
        public void GenericPlaceholderExampleFormsAClosedSolidAndPersistsOnlyTheCreatedShape()
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(
                AppContext.BaseDirectory, "Fixtures", "native-tool-examples.json")));
            var tool = document.RootElement.GetProperty("tools").EnumerateArray()
                .Single(item => item.GetProperty("path").GetString() == "/revit/native-api-mutation-ops");
            var example = tool.GetProperty("examples").EnumerateArray()
                .Single(item => item.GetProperty("name").GetString() == "Create a one-foot generic 3D placeholder");
            var request = example.GetProperty("request");
            var operations = request.GetProperty("operations").EnumerateArray().ToArray();
            Assert.InRange(operations.Length, 1, 16);
            var prior = new HashSet<string>(StringComparer.Ordinal);
            foreach (var operation in operations)
            {
                if (operation.TryGetProperty("target", out var target) && target.GetString()!.StartsWith("$"))
                    Assert.Contains(target.GetString()!.Substring(1), prior);
                if (operation.TryGetProperty("args", out var args)) AssertEarlierReferences(args, prior);
                Assert.True(prior.Add(operation.GetProperty("id").GetString()!));
            }
            var byId = operations.ToDictionary(op => op.GetProperty("id").GetString()!);
            Assert.Equal("OST_GenericModel", byId["category"].GetProperty("args")[0].GetString());
            var edgeNames = new[] { "edge_a", "edge_b", "edge_c", "edge_d" };
            for (var index = 0; index < edgeNames.Length; index++)
            {
                var edge = byId[edgeNames[index]];
                Assert.Equal("method:Autodesk.Revit.DB.Line.CreateBound(Autodesk.Revit.DB.XYZ,Autodesk.Revit.DB.XYZ)", edge.GetProperty("memberId").GetString());
                var start = edge.GetProperty("args")[0].EnumerateArray().Select(x => x.GetDouble()).ToArray();
                var end = edge.GetProperty("args")[1].EnumerateArray().Select(x => x.GetDouble()).ToArray();
                var next = byId[edgeNames[(index + 1) % edgeNames.Length]].GetProperty("args")[0]
                    .EnumerateArray().Select(x => x.GetDouble()).ToArray();
                Assert.Equal(next, end);
                Assert.Equal(1d, start.Zip(end, (a, b) => (a - b) * (a - b)).Sum());
                Assert.Equal(0d, start[2]);
            }
            Assert.Equal(edgeNames, byId["loop"].GetProperty("args")[0].EnumerateArray().Select(x => x.GetProperty("$ref").GetString()).ToArray());
            Assert.Equal("loop", byId["solid"].GetProperty("args")[0][0].GetProperty("$ref").GetString());
            Assert.Equal(new[] { 0d, 0d, 1d }, byId["solid"].GetProperty("args")[1].EnumerateArray().Select(x => x.GetDouble()).ToArray());
            Assert.Equal(1d, byId["solid"].GetProperty("args")[2].GetDouble());
            Assert.Contains(".CreateExtrusionGeometry(", byId["solid"].GetProperty("memberId").GetString());
            Assert.Contains(".DirectShape.CreateElement(", byId["placeholder"].GetProperty("memberId").GetString());
            Assert.Contains(".DirectShape.SetShape(", byId["set_shape"].GetProperty("memberId").GetString());
            Assert.Equal("$placeholder", byId["set_shape"].GetProperty("target").GetString());
            Assert.Equal("solid", byId["set_shape"].GetProperty("args")[0][0].GetProperty("$ref").GetString());
            Assert.Equal("placeholder", request.GetProperty("returns")[0].GetString());
            var transaction = request.GetProperty("transaction");
            Assert.Equal("commit", transaction.GetProperty("mode").GetString());
            Assert.True(transaction.GetProperty("allowCreate").GetBoolean());
            Assert.Equal(1, transaction.GetProperty("maxAffectedElements").GetInt32());
            Assert.Empty(transaction.GetProperty("allowedExistingElementIds").EnumerateArray());
            var notes = string.Join(" ", example.GetProperty("notes").EnumerateArray().Select(x => x.GetString()));
            Assert.Contains("exact member ids", notes);
            Assert.Contains("without MEP connectors", notes);
            Assert.Contains("keep explicit read-only requests read-only", notes);
        }

        [Fact]
        public void NativeDiscoveryDocsDistinguishGraphOnlySignaturesFromDirectCalls()
        {
            foreach (var route in new[] { "/revit/native-api-catalog", "/revit/native-api-search" })
            {
                var description = OperatorToolManifest.Tools.Single(tool => tool.Path == route).Description;
                Assert.Contains("graph_signature_supported", description);
                Assert.Contains("graph_allowed", description);
                Assert.Contains("signature_supported/allowed", description);
            }
            var direct = OperatorToolManifest.Tools.Single(tool => tool.Path == "/revit/native-api-call").Description;
            Assert.Contains("graph_allowed does not make a member callable here", direct);
            var graph = OperatorToolManifest.Tools.Single(tool => tool.Path == "/revit/native-api-mutation-ops").Description;
            Assert.Contains("generic 3D placeholder", graph);
            Assert.Contains("Choose commit for authorized application", graph);
            Assert.Contains("not arbitrary objects or ShapeBuilder", graph);
        }

        private static void AssertEarlierReferences(JsonElement value, HashSet<string> prior)
        {
            if (value.ValueKind == JsonValueKind.Array)
                foreach (var item in value.EnumerateArray()) AssertEarlierReferences(item, prior);
            else if (value.ValueKind == JsonValueKind.Object)
            {
                Assert.Single(value.EnumerateObject());
                Assert.Contains(value.GetProperty("$ref").GetString(), prior);
            }
        }

        [Theory]
        [InlineData("/revit/native-api-ops", "Pass a typed Document result into a read-only constructor")]
        [InlineData("/revit/native-api-mutation-ops", "Rollback-test a static mutation using an explicit Document argument reference")]
        public void ProductionExamplesPassTheDocumentAsAPriorTypedResult(string route, string exampleName)
        {
            using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(
                AppContext.BaseDirectory, "Fixtures", "native-tool-examples.json")));
            var tool = document.RootElement.GetProperty("tools").EnumerateArray()
                .Single(item => item.GetProperty("path").GetString() == route);
            var example = tool.GetProperty("examples").EnumerateArray()
                .Single(item => item.GetProperty("name").GetString() == exampleName);
            var request = example.GetProperty("request");
            var operations = request.GetProperty("operations").EnumerateArray().ToArray();
            Assert.Equal("get_property", operations[0].GetProperty("op").GetString());
            Assert.Equal("uidoc", operations[0].GetProperty("target").GetString());
            Assert.Equal("Document", operations[0].GetProperty("property").GetString());
            var reference = operations[1].GetProperty("args")[0];
            Assert.Equal(JsonValueKind.Object, reference.ValueKind);
            Assert.Equal(operations[0].GetProperty("id").GetString(), reference.GetProperty("$ref").GetString());
            Assert.False(operations[1].TryGetProperty("target", out _));
            Assert.Contains("Autodesk.Revit.DB.Document", operations[1].GetProperty("memberId").GetString());
            Assert.InRange(operations.Length, 2, 16);
            if (route == "/revit/native-api-ops")
            {
                Assert.False(request.TryGetProperty("transaction", out _));
                Assert.Contains("WhereElementIsNotElementType", operations[2].GetProperty("memberId").GetString());
                Assert.Equal("$instances", operations[3].GetProperty("target").GetString());
            }
            else
            {
                Assert.Equal("rollback", request.GetProperty("transaction").GetProperty("mode").GetString());
                Assert.Equal(12345, operations[1].GetProperty("args")[1].GetInt32());
                Assert.Equal(12345, request.GetProperty("transaction").GetProperty("allowedExistingElementIds")[0].GetInt32());
            }
        }
    }
}
