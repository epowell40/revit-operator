using RevitBridge.Common;
using RevitBridge.Operator;
using System;
using System.Linq;
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
                .ThenBy(candidate => candidate.Tool.Path, StringComparer.Ordinal)
                .ToList();

            Assert.NotEmpty(ranked);
            Assert.Equal("/revit/quantify", ranked[0].Tool.Path);
        }
    }
}
