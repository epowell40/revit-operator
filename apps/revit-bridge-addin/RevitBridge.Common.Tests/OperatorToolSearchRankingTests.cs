using RevitBridge.Common;
using RevitBridge.Operator;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorToolSearchRankingTests
    {
        private const string Candidate22Query = "project-wide element inventory by category grouped by family and type complete count air terminals";

        [Fact]
        public void SheetImageDiscoveryDoesNotRecommendUnsupportedSpatialFrameMapping()
        {
            var image = Assert.Single(OperatorToolManifest.Tools, t => t.Path == "/revit/export-image");
            var frame = Assert.Single(OperatorToolManifest.Tools, t => t.Path == "/revit/export-view-frame");
            Assert.Contains("DrawingSheet", image.Description);
            Assert.Contains("not pixel-to-model", image.Description);
            Assert.Contains("DrawingSheet", frame.Description);
            Assert.Contains("not supported", frame.Description);
            Assert.Contains("/revit/export-image", frame.Description);
            var capabilities = File.ReadAllText(Path.Combine(FindRevitBridgeAddinRoot(), "RevitBridge", "Operator", "OperatorCapabilities.cs"));
            Assert.Contains("capture_current_sheet_or_view = \"/revit/export-image\"", capabilities);
            Assert.DoesNotContain("capture_current_sheet_or_view = \"/revit/export-view-frame\"", capabilities);
            var handler = File.ReadAllText(Path.Combine(FindRevitBridgeAddinRoot(), "RevitBridge.Logic", "Handlers", "Selection", "ExportViewFrameHandler.cs"));
            Assert.Contains("!SelectionUtil.IsSupported2dView(view)", handler);
            Assert.Contains("/revit/export-image", handler);
        }

        [Fact]
        public void LaterEditsToAuthorizedResultHaveDiscoverableTrackedCheckpointSave()
        {
            var tool = Assert.Single(OperatorToolManifest.Tools, t => t.Path == "/revit/save-as");
            Assert.Contains("same authorized result path", tool.Description);
            Assert.Contains("overwrite=true", tool.Description);
            Assert.Contains("new committed edits", tool.Description);
            Assert.Contains("overwrite=false", tool.Description);
            Assert.Contains("never the original input or an unrelated file", tool.Description);
            Assert.Contains("not a retry of an uncertain save", tool.Description);
            Assert.Contains("inspect-exported-files", tool.Description);
            Assert.DoesNotContain("POST /revit/save ", tool.Description);
        }

        [Theory]
        [InlineData("linked document query elements rooms equipment link instance", 2)]
        [InlineData("sheet detail viewport geometry; linked model inventory; find elements include linked document equipment controls", 3)]
        [InlineData("inspect linked equipment in a room using transformed model bounds", 2)]
        public void LinkedSpatialInventoryIsDiscoverableInBoundedSearch(string query, int max)
        {
            var ranked = OperatorToolManifest.Tools
                .Select(tool => new { Tool = tool, Score = OperatorToolSearchRanking.Score(query,
                    tool.Path, tool.Title, tool.Group, tool.Description, tool.Example, tool.Method) })
                .Where(candidate => candidate.Score > 0)
                .OrderByDescending(candidate => candidate.Score)
                .ThenBy(candidate => candidate.Tool.RiskLevel)
                .ThenBy(candidate => candidate.Tool.Path, StringComparer.Ordinal)
                .Take(max).ToList();
            Assert.Contains(ranked, candidate => candidate.Tool.Path == "/revit/export-visible-elements");
        }

        [Fact]
        public void LinkedInventoryDiscoveryRetainsItsSpatialAndCompletenessLimits()
        {
            var tool = Assert.Single(OperatorToolManifest.Tools, t => t.Path == "/revit/export-visible-elements");
            Assert.Contains("includeLinked", tool.Description);
            Assert.Contains("modelBounds", tool.Description);
            Assert.Contains("best-effort", tool.Description);
            Assert.Contains("not exact room membership or project-wide absence proof", tool.Description);
            Assert.DoesNotContain("page, filter", tool.Description);
        }

        [Theory]
        [InlineData("/revit/find-elements")]
        [InlineData("/revit/export-visible-elements")]
        public void PartialInventoryDocumentationPointsToExistingSourceInventoryWithoutClaimingAbsence(string route)
        {
            var tool = Assert.Single(OperatorToolManifest.Tools, item => item.Path == route);
            Assert.Contains("POST /revit/quantify", tool.Description);
            Assert.Contains("scope=links or both", tool.Description);
            Assert.Contains("sourceCoverage", tool.Description);
            Assert.Contains("direct source-document instances", tool.Description);
            Assert.Contains("not room membership or hidden/nested completeness", tool.Description);
            Assert.Equal(OperatorActionRisk.Low, tool.RiskLevel);
            var quantify = Assert.Single(OperatorToolManifest.Tools, item => item.Path == "/revit/quantify");
            Assert.Contains("incomplete coverage cannot prove absence", quantify.Description);
            Assert.Contains("not unshared family-definition contents or room membership", quantify.Description);
        }

        [Fact]
        public void McpLinkedInventoryFixtureMatchesTheCompleteNativeProductMetadata()
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(FindRepositoryRoot(),
                "packages", "revit-tool-search-ranking-v3", "linked-spatial-inventory.v1.json")));
            Assert.Equal("operator.linked_spatial_discovery.v1", fixture.RootElement.GetProperty("schema").GetString());
            var rows = fixture.RootElement.GetProperty("candidates").EnumerateArray().ToList();
            Assert.Equal(OperatorToolManifest.Tools.Count, rows.Count);
            foreach (var tool in OperatorToolManifest.Tools)
            {
                var row = Assert.Single(rows, r => r.GetProperty("method").GetString() == tool.Method
                    && r.GetProperty("path").GetString() == tool.Path);
                Assert.Equal(tool.Title, row.GetProperty("title").GetString());
                Assert.Equal(tool.Description, row.GetProperty("description").GetString());
                Assert.Equal(tool.Example ?? "", row.GetProperty("example").GetString());
                Assert.Equal(tool.Group, row.GetProperty("group").GetString());
                Assert.Equal(tool.RiskLevel.ToString().ToLowerInvariant(), row.GetProperty("risk").GetString());
            }
        }

        [Fact]
        public void RouteDocumentationExplainsExactOneSidedEndpointPrecedence()
        {
            foreach (var route in new[] { "/revit/create-mep-route", "/revit/mep-route-workflow" })
            {
                var tool = Assert.Single(OperatorToolManifest.Tools, item => item.Path == route);
                Assert.Contains("requiredExistingEndpoint", tool.Description);
                Assert.Contains("expectedExistingStartOwnerId", tool.Description);
                Assert.Contains("true alone requires both ends", tool.Description);
            }
        }

        [Theory]
        [InlineData("Read the complete Revit room and space inventory with HVAC load-calculation parameters, validate counts/units/missing values, and export a room-by-room Excel workbook artifact without changing the model.", "/revit/export-elements-xlsx")]
        [InlineData("export element parameters to an Excel spreadsheet workbook", "/revit/export-elements-xlsx")]
        [InlineData("export schedule csv", "/revit/export-schedule-csv")]
        public void WorkbookAndNeighboringExportsRemainDiscoverableAcrossTheProductCatalog(string query, string requiredPath)
        {
            var ranked = OperatorToolManifest.Tools
                .Select(tool => new { Tool = tool, Score = OperatorToolSearchRanking.Score(query, tool.Path, tool.Title, tool.Group, tool.Description, tool.Example, tool.Method) })
                .Where(candidate => candidate.Score > 0)
                .OrderByDescending(candidate => candidate.Score)
                .ThenBy(candidate => candidate.Tool.RiskLevel)
                .ThenBy(candidate => candidate.Tool.Path, StringComparer.Ordinal)
                .Take(4).Select(candidate => candidate.Tool.Path).ToArray();
            Assert.Contains(requiredPath, ranked);
        }

        [Theory]
        [InlineData("room")]
        [InlineData("space")]
        public void SpatialDiscoveryExposesLocalInventoryAndAssociativeTags(string query)
        {
            foreach (var route in new[] { "/revit/find-elements", "/revit/tag-elements" })
            {
                var tool = Assert.Single(OperatorToolManifest.Tools, item => item.Path == route);
                Assert.True(OperatorToolSearchRanking.Score(query, tool.Path, tool.Title, tool.Group, tool.Description, tool.Example, tool.Method) > 0);
            }
            var inventory = Assert.Single(OperatorToolManifest.Tools, item => item.Path == "/revit/find-elements");
            Assert.Contains("document-wide discovery", inventory.Description);
            Assert.Contains("hidden in a view", inventory.Description);
            var tagging = Assert.Single(OperatorToolManifest.Tools, item => item.Path == "/revit/tag-elements");
            Assert.Contains("Linked room IDs are not host element IDs", tagging.Description);
        }

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
        public void Candidate22QueryFindsQuantifyFirstAcrossTheHistoricalImplementedCatalog()
        {
            // Preserve the exact historical ranking regression even when the product
            // inventory excludes its target. A type catalog is not an element count.
            var field = typeof(OperatorToolManifest).GetField("ImplementedTools", BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(field);
            var implemented = Assert.IsAssignableFrom<IEnumerable<OperatorToolInfo>>(field!.GetValue(null));
            var ranked = implemented
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
        public void QuantityRankingCannotReadmitExcludedVisualization()
        {
            Assert.True(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/quantify"));
            Assert.False(OperatorSupportedToolInventory.IsSupportedTool("POST", "/revit/quantify-visualize"));
            Assert.DoesNotContain(OperatorToolManifest.Tools, tool => tool.Path == "/revit/quantify-visualize");
            Assert.All(OperatorToolManifest.Tools, tool =>
                Assert.True(OperatorSupportedToolInventory.IsSupportedTool(tool.Method, tool.Path)));
        }

        [Fact]
        public void Candidate22ProductSearchFindsPlacedInstancesInsteadOfLoadedTypes()
        {
            var ranked = OperatorToolManifest.Tools
                .Where(tool => tool.Method == "POST")
                .Select(tool => new
                {
                    Tool = tool,
                    Score = OperatorToolSearchRanking.Score(Candidate22Query, tool.Path, tool.Title, tool.Group, tool.Description, tool.Example, tool.Method)
                })
                .OrderByDescending(candidate => candidate.Score)
                .ThenBy(candidate => candidate.Tool.RiskLevel)
                .ThenBy(candidate => candidate.Tool.Path, StringComparer.Ordinal)
                .ToList();
            Assert.Equal("/revit/quantify", ranked[0].Tool.Path);
            Assert.Contains("sourceCoverage", ranked[0].Tool.Description);
            Assert.Contains("incomplete coverage cannot prove absence", ranked[0].Tool.Description);
            var find = ranked.Single(candidate => candidate.Tool.Path == "/revit/find-elements");
            Assert.Contains("itemsComplete is true", find.Tool.Description);
            Assert.Contains("truncated result is not a complete inventory", find.Tool.Description);
            Assert.True(find.Score > ranked.Single(candidate => candidate.Tool.Path == "/revit/list-element-types").Score);
            Assert.True(ranked[0].Score > ranked.Single(candidate => candidate.Tool.Path == "/revit/list-element-types").Score);
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
                FindRevitBridgeAddinRoot(),
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

        private static string FindRevitBridgeAddinRoot()
        {
            var repositoryRoot = FindRepositoryRoot();
            var publicCompositionRoot = Path.Combine(repositoryRoot, "apps", "revit-bridge-addin");
            var privateCompositionRoot = Path.Combine(repositoryRoot, "revit-bridge-addin");
            var sourceSegments = new[] { "RevitBridge", "Operator", "OperatorToolIntrospection.cs" };
            var publicSource = Path.Combine(new[] { publicCompositionRoot }.Concat(sourceSegments).ToArray());
            if (File.Exists(publicSource)) return publicCompositionRoot;

            var privateSource = Path.Combine(new[] { privateCompositionRoot }.Concat(sourceSegments).ToArray());
            if (File.Exists(privateSource)) return privateCompositionRoot;

            throw new DirectoryNotFoundException("Could not locate the Revit add-in source root.");
        }
    }
}
