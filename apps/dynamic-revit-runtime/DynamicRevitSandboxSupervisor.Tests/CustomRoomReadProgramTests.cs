using System.Text.Json;
using RevitOperator.DynamicRevitSdk;
using RevitOperator.DynamicRevitWorker;
using Xunit;

namespace RevitOperator.DynamicRevitSandboxSupervisor.Tests;

// Synthetic supplied DTOs exercise actual compiled generated code, not native inventory coverage.
public sealed class CustomRoomReadProgramTests
{
    private const string Source = """
        using System;
        using System.Linq;
        using RevitOperator.DynamicRevitSdk;
        public sealed class ToiletRoomReport : IDynamicRevitProgram {
          public DynamicProgramResult Execute(DynamicRevitContext c) {
            var matches = c.Elements.Where(e => e.Category == "Rooms" &&
              e.Parameters.TryGetValue("Name", out var name) && name != null &&
              string.Equals(name.Trim(), "Toilet", StringComparison.OrdinalIgnoreCase))
              .OrderBy(e => e.ElementId).ToArray();
            c.Report("InspectedRows", c.Elements.Count.ToString());
            c.Report("MatchingRows", matches.Length.ToString());
            c.Report("ReturnedRows", Math.Min(matches.Length, 20).ToString());
            c.Report("OmittedMatches", Math.Max(0, matches.Length - 20).ToString());
            c.Report("MissingNames", c.Elements.Count(e => e.Category == "Rooms" &&
              (!e.Parameters.TryGetValue("Name", out var name) || name == null)).ToString());
            c.Report("Scope", c.Input.Coverage == null ? "Supplied snapshot only; native completeness is not established by this program."
              : c.Input.Coverage.HasMore ? "Partial active-document cohort; additional rooms may match."
              : "Complete active-document category enumeration; missing name values remain unknown; linked models excluded.");
            foreach (var room in matches.Take(20))
              c.Report("Room:" + room.ElementId, room.UniqueId);
            return c.Complete();
          }
        }
        """;

    [Fact]
    public void CompiledCustomReadFiltersTwoThousandRowsAndReturnsOnlyTwentyMatches()
    {
        var rows = Enumerable.Range(1, 2000).Select(i => Room(i, i % 100 == 0 ? " TOILET " : "Office")).ToArray();
        var output = Run(rows.Reverse().ToArray());
        Assert.Equal("2000", output.Report["InspectedRows"]);
        Assert.Equal("20", output.Report["MatchingRows"]);
        Assert.Equal("0", output.Report["OmittedMatches"]);
        Assert.Equal(Enumerable.Range(1, 20).Select(i => "room-" + i * 100),
            output.Report.Where(p => p.Key.StartsWith("Room:", StringComparison.Ordinal)).Select(p => p.Value));
        Assert.True(JsonSerializer.Serialize(output.Report).Length < 1800);
    }

    [Fact]
    public void MissingNullNamesAndOtherCategoriesDoNotBecomeMatches()
    {
        var absent = Room(1, "Toilet"); absent.Parameters.Clear();
        var wrongCategory = Room(3, "Toilet"); wrongCategory.Category = "Spaces";
        var output = Run(new[] { absent, Room(2, null), wrongCategory, Room(4, "Toilet storage"), Room(5, "Toilet") });
        Assert.Equal("1", output.Report["MatchingRows"]);
        Assert.Equal("2", output.Report["MissingNames"]);
        Assert.Equal("room-5", output.Report["Room:5"]);
    }

    [Theory]
    [InlineData(0, 0, 0)]
    [InlineData(2000, 20, 1980)]
    public void OutputLimitIsExplicitAndDoesNotLoseTheMatchingCount(int count, int returned, int omitted)
    {
        var output = Run(Enumerable.Range(1, count).Select(i => Room(i, "Toilet")).ToArray());
        Assert.Equal(count.ToString(), output.Report["MatchingRows"]);
        Assert.Equal(returned.ToString(), output.Report["ReturnedRows"]);
        Assert.Equal(omitted.ToString(), output.Report["OmittedMatches"]);
        Assert.Contains("completeness is not established", output.Report["Scope"]);
    }

    [Theory]
    [InlineData(true, "Partial active-document cohort")]
    [InlineData(false, "Complete active-document category enumeration")]
    public void ActualCompiledProgramUsesBoundCoverageAndKeepsUnknownParameterLimits(bool hasMore, string expected)
    {
        var rows = Enumerable.Range(1, 2000).Select(i => Room(i, i % 100 == 0 ? "Toilet" : "Office")).ToArray();
        var output = Run(rows, DynamicSnapshotCoverage.Create("OST_Rooms", new[] { "Name" }, 2000, 2000, hasMore));
        Assert.StartsWith(expected, output.Report["Scope"]);
        Assert.Equal("20", output.Report["MatchingRows"]);
    }

    private static WorkerOutput Run(DynamicElementDto[] rows, DynamicSnapshotCoverage? coverage = null)
    {
        var output = WorkerExecutor.Execute(new WorkerInput { Source = Source,
            Input = new DynamicTaskInput { Elements = rows, OperationBudget = 1, Coverage = coverage } });
        Assert.True(output.Ok, string.Join("; ", output.Diagnostics.Select(d => d.Message)));
        Assert.True(output.DeterministicReplayVerified);
        Assert.Empty(output.Graph!.Operations);
        using var graph = JsonDocument.Parse("{\"operations\":[]}");
        RevitOperator.DynamicRevitSandboxSupervisor.Program.ValidateReadOnlyGraph(true, graph.RootElement);
        return output;
    }

    private static DynamicElementDto Room(int id, string? name) => new() {
        ElementId = id, UniqueId = "room-" + id, Category = "Rooms",
        Parameters = new Dictionary<string, string?> { ["Name"] = name }
    };
}
