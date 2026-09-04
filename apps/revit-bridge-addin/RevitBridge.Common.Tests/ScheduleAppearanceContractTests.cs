using System;
using System.IO;
using System.Linq;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ScheduleAppearanceContractTests
    {
        [Fact]
        public void StripedRowsWritesAndReadsBackTheActualViewScheduleProperty()
        {
            var source = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Handlers", "ConfigureScheduleHandler.cs");
            var start = source.IndexOf("if (appearance.stripedRows.HasValue)", StringComparison.Ordinal);
            var end = source.IndexOf("if (appearance.freezeHeaders.HasValue)", start, StringComparison.Ordinal);
            Assert.True(start >= 0 && end > start);
            var block = source.Substring(start, end - start);

            Assert.Contains("TrySetScheduleBoolProperty", block);
            Assert.Contains("new[] { \"HasStripedRows\" }", block);
            Assert.Contains("out var readback", block);
            Assert.Contains("readback });", block);
            Assert.DoesNotContain("UseStripedRowsOnSheets", block);
        }

        [Fact]
        public void ScheduleDetailPublishesTypedConfigurationEvidenceInsteadOfInferringItFromRows()
        {
            var source = ReadRepoFile("apps", "revit-bridge-addin", "RevitBridge", "Handlers", "SchedulesHandler.cs");

            Assert.Contains("filterDefinitions = BuildFilterDefinitions", source);
            Assert.Contains("filterDefinitionsComplete", source);
            Assert.Contains("definition.GetFilter(index)", source);
            Assert.Contains("field = field == null ? null : ReadFieldName(field, doc)", source);
            Assert.Contains("op = NormalizeFilterType(filter.FilterType)", source);
            Assert.Contains("value = ReadFilterValue(filter)", source);
            Assert.Contains("appearance = BuildAppearance(schedule)", source);
            Assert.Contains("settings = BuildSettings(schedule)", source);
        }

        private static string ReadRepoFile(params string[] relativeSegments)
        {
            var layouts = relativeSegments.Length > 0 && relativeSegments[0] == "apps"
                ? new[] { relativeSegments, relativeSegments.Skip(1).ToArray() }
                : new[] { relativeSegments, new[] { "apps" }.Concat(relativeSegments).ToArray() };
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory != null)
            {
                foreach (var layout in layouts)
                {
                    var candidate = Path.Combine(new[] { directory.FullName }.Concat(layout).ToArray());
                    if (File.Exists(candidate)) return File.ReadAllText(candidate);
                }
                directory = directory.Parent;
            }
            throw new FileNotFoundException("Could not locate repository source file.", Path.Combine(relativeSegments));
        }
    }
}
