using RevitBridge.Common;
using RevitBridge.Operator;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorToolSearchRankingTests
    {
        private const string Candidate22Query = "project-wide element inventory by category grouped by family and type complete count air terminals";

        [Fact]
        public void InventoryIntentRanksQuantifyAboveUnrelatedTypeAndRepairTools()
        {
            var quantify = OperatorToolSearchRanking.Score(Candidate22Query, "/revit/quantify", "Quantify", "Query", "Count/list elements in category (supports grouping).", "count doors", "POST");
            var listTypes = OperatorToolSearchRanking.Score(Candidate22Query, "/revit/list-element-types", "List Element Types", "Query", "List loaded element types for a category.", null, "POST");
            var repair = OperatorToolSearchRanking.Score(Candidate22Query, "/revit/repair-duct-continuity-by-scope", "Repair Duct Continuity By Scope", "MEP", "Repair continuity breaks in an exact duct element set.", null, "POST");
            Assert.True(quantify > listTypes, $"quantify {quantify} must exceed list types {listTypes}");
            Assert.True(quantify > repair, $"quantify {quantify} must exceed repair {repair}");
        }

        [Fact]
        public void RankingUsesExactOrdinalTokensInsteadOfSubstringMatches()
        {
            Assert.DoesNotContain("air", OperatorToolSearchRanking.Tokenize("repair"));
            Assert.Equal(new[] { "quantify", "group", "element" }, OperatorToolSearchRanking.Tokenize("inventories grouped elements"));
            Assert.Equal(
                new[] { "text", "note", "element", "id", "dry", "run" },
                OperatorToolSearchRanking.Tokenize("TextNote elementId dryRun"));
        }

        [Fact]
        public void Candidate22QueryFindsQuantifyFirstAcrossTheCertifiedNativeManifest()
        {
            var ranked = OperatorToolManifest.Tools
                .Where(tool => string.Equals(tool.Method, "POST", StringComparison.Ordinal))
                .Select(tool => new
                {
                    Tool = tool,
                    Score = OperatorToolSearchRanking.Score(Candidate22Query, tool.Path, tool.Title, tool.Group, tool.Description, tool.Example, tool.Method)
                })
                .Where(candidate => candidate.Score > 0)
                .OrderByDescending(candidate => candidate.Score)
                .ThenBy(candidate => candidate.Tool.RiskLevel)
                .ThenBy(candidate => candidate.Tool.Path, StringComparer.Ordinal)
                .ToList();

            Assert.NotEmpty(ranked);
            Assert.Equal("/revit/quantify", ranked[0].Tool.Path);
        }

        [Fact]
        public void Candidate58QueryFindsTheIdentityBoundTextNoteMutationFirst()
        {
            const string query = "update existing TextNote text in place by element id without duplication dry run apply";
            var ranked = OperatorToolManifest.Tools
                .Select(tool => new
                {
                    Tool = tool,
                    Score = OperatorToolSearchRanking.Score(query, tool.Path, tool.Title, tool.Group, tool.Description, tool.Example, tool.Method)
                })
                .Where(candidate => candidate.Score > 0)
                .OrderByDescending(candidate => candidate.Score)
                .ThenBy(candidate => candidate.Tool.RiskLevel)
                .ThenBy(candidate => candidate.Tool.Path, StringComparer.Ordinal)
                .ToList();

            Assert.NotEmpty(ranked);
            Assert.Equal("/revit/replace-text-note", ranked[0].Tool.Path);
            Assert.Contains(ranked.Take(5), candidate => candidate.Tool.Path == "/revit/set-text-note-text");
        }

        [Fact]
        public void NativeToolSearchSatisfiesSharedCrossProcessRankingVectors()
        {
            var contractPath = Path.Combine(
                FindRepositoryRoot(),
                "packages",
                "revit-tool-search-ranking-v3",
                "golden-vectors.json");
            using var document = JsonDocument.Parse(File.ReadAllText(contractPath));
            var root = document.RootElement;
            Assert.Equal("revit_operator.tool_search_ranking_golden_vectors/v3", root.GetProperty("schema").GetString());
            Assert.Equal(OperatorToolSearchRanking.ContractVersion, root.GetProperty("ranking_version").GetString());

            var candidates = root.GetProperty("candidates").EnumerateArray().Select(candidate => new GoldenCandidate
            {
                Method = candidate.GetProperty("method").GetString() ?? "",
                Path = candidate.GetProperty("path").GetString() ?? "",
                Risk = candidate.GetProperty("risk").GetString() ?? "",
                Group = candidate.GetProperty("group").GetString() ?? "",
                Title = candidate.GetProperty("title").GetString() ?? "",
                Description = candidate.GetProperty("description").GetString() ?? "",
                Example = candidate.GetProperty("example").GetString() ?? ""
            }).ToList();

            foreach (var vector in root.GetProperty("queries").EnumerateArray())
            {
                var id = vector.GetProperty("id").GetString() ?? "unnamed";
                var query = vector.GetProperty("query").GetString() ?? "";
                var expectedFirst = vector.GetProperty("expected_first").GetString() ?? "";
                var requiredTopFive = vector.GetProperty("required_top_five").EnumerateArray()
                    .Select(value => value.GetString() ?? "")
                    .ToList();
                var expectedScores = vector.GetProperty("expected_scores").EnumerateObject()
                    .ToDictionary(property => property.Name, property => property.Value.GetInt32(), StringComparer.Ordinal);
                var ranked = candidates
                    .Select(candidate => new
                    {
                        Candidate = candidate,
                        Score = OperatorToolSearchRanking.Score(query, candidate.Path, candidate.Title, candidate.Group, candidate.Description, candidate.Example, candidate.Method)
                    })
                    .Where(candidate => candidate.Score > 0)
                    .OrderByDescending(candidate => candidate.Score)
                    .ThenBy(candidate => RiskRank(candidate.Candidate.Risk))
                    .ThenBy(candidate => candidate.Candidate.Path, StringComparer.Ordinal)
                    .ToList();

                Assert.True(ranked.Count > 0, $"{id}: no matches.");
                Assert.True(ranked[0].Candidate.Path == expectedFirst,
                    $"{id}: expected {expectedFirst}, got {ranked[0].Candidate.Path}.");
                var topFive = ranked.Take(5).Select(candidate => candidate.Candidate.Path).ToList();
                foreach (var required in requiredTopFive)
                {
                    Assert.Contains(required, topFive);
                }
                foreach (var expectedScore in expectedScores)
                {
                    var actual = ranked.Single(candidate => candidate.Candidate.Path == expectedScore.Key).Score;
                    Assert.Equal(expectedScore.Value, actual);
                }
            }
        }

        [Fact]
        public void NativeRegistryAndSearchPublishTheSameVersionedRankingFields()
        {
            var source = File.ReadAllText(Path.Combine(
                FindRepositoryRoot(),
                "apps",
                "revit-bridge-addin",
                "RevitBridge",
                "Operator",
                "OperatorToolIntrospection.cs"));

            Assert.Contains("ranking_version = OperatorToolSearchRanking.ContractVersion", source);
            Assert.Contains("group = info?.Group ?? \"\"", source);
            Assert.Contains("example = info?.Example ?? \"\"", source);
            Assert.Contains(".ThenBy(m => m.Tool.Path, StringComparer.Ordinal)", source);
            Assert.DoesNotContain(".ThenBy(m => m.Tool.Path, StringComparer.OrdinalIgnoreCase)", source);
        }

        private sealed class GoldenCandidate
        {
            public string Method { get; set; } = "";
            public string Path { get; set; } = "";
            public string Risk { get; set; } = "";
            public string Group { get; set; } = "";
            public string Title { get; set; } = "";
            public string Description { get; set; } = "";
            public string Example { get; set; } = "";
        }

        private static int RiskRank(string value)
        {
            if (string.Equals(value, "low", StringComparison.Ordinal)) return 0;
            if (string.Equals(value, "medium", StringComparison.Ordinal)) return 1;
            if (string.Equals(value, "high", StringComparison.Ordinal)) return 2;
            return 3;
        }

        private static string FindRepositoryRoot()
        {
            var current = new DirectoryInfo(AppContext.BaseDirectory);
            while (current != null)
            {
                var gitMetadata = Path.Combine(current.FullName, ".git");
                var contract = Path.Combine(current.FullName, "packages", "revit-tool-search-ranking-v3", "golden-vectors.json");
                if ((Directory.Exists(gitMetadata) || File.Exists(gitMetadata)) && File.Exists(contract))
                {
                    return current.FullName;
                }
                current = current.Parent;
            }
            throw new DirectoryNotFoundException("Could not locate the public repository root.");
        }
    }
}
