using System.Text.Json;
using RevitOperator.DynamicRevitSdk;
using RevitOperator.DynamicRevitWorker;
using Xunit;

namespace RevitOperator.DynamicRevitSandboxSupervisor.Tests;

public sealed class ReadOnlyGeneratedProgramTests
{
    [Fact]
    public void DuctTypeSampleCompilesAndReturnsBoundedReportWithoutOperations()
    {
        const string source = """
            using System; using System.Linq; using RevitOperator.DynamicRevitSdk;
            public sealed class SampleReport : IDynamicRevitProgram {
              public DynamicProgramResult Execute(DynamicRevitContext c) {
                c.Report("Inspected", c.Elements.Count.ToString());
                foreach (var group in c.Elements.GroupBy(e => e.TypeName ?? "(unnamed)"))
                  c.Report("Type: " + group.Key, group.Count().ToString());
                c.Report("Limit", "Bounded snapshot sample; not a complete model inventory.");
                return c.Complete();
              }
            }
            """;
        var result = WorkerExecutor.Execute(new WorkerInput { Source = source,
            Input = new DynamicTaskInput { OperationBudget = 1, Elements = Enumerable.Range(0,20)
                .Select(i => new DynamicElementDto { ElementId = i + 1, UniqueId = "duct-" + i, Category = "Ducts", TypeName = i < 12 ? "Rectangular" : "Round" }).ToArray() } });
        Assert.True(result.Ok, string.Join("; ", result.Diagnostics.Select(d => d.Message)));
        Assert.True(result.DeterministicReplayVerified);
        Assert.Empty(result.Graph!.Operations);
        Assert.Equal("20", result.Report["Inspected"]);
        Assert.Equal("12", result.Report["Type: Rectangular"]);
        Assert.Equal("8", result.Report["Type: Round"]);
        Assert.Contains("not a complete model inventory", result.Report["Limit"]);
    }

    [Theory]
    [InlineData("{\"operations\":[{\"kind\":\"move_element\"}]}")]
    [InlineData("{\"operations\":null}")]
    [InlineData("{}")]
    public void ReadOnlyGraphRejectsAnyModelOperationBeforePreview(string json)
    {
        using var graph = JsonDocument.Parse(json);
        Assert.Throws<InvalidOperationException>(() => Program.ValidateReadOnlyGraph(true, graph.RootElement));
    }

    [Fact]
    public void EmptyGraphAndMatchingDocumentAreAcceptedButAnotherDocumentIsRejected()
    {
        using var graph = JsonDocument.Parse("{\"operations\":[]}");
        Program.ValidateReadOnlyGraph(true, graph.RootElement);
        Program.ValidateExpectedDocument(new string('a',64), "sha256:" + new string('a',64));
        Program.ValidateExpectedDocument("sha256:" + new string('a',64), "sha256:" + new string('a',64));
        Assert.Throws<InvalidOperationException>(() => Program.ValidateExpectedDocument(new string('a',64), "sha256:" + new string('b',64)));
    }
}
