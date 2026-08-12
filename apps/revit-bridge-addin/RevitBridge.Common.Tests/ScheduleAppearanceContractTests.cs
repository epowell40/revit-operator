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

        private static string ReadRepoFile(params string[] relativeSegments)
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory != null)
            {
                var candidate = Path.Combine(new[] { directory.FullName }.Concat(relativeSegments).ToArray());
                if (File.Exists(candidate)) return File.ReadAllText(candidate);
                directory = directory.Parent;
            }
            throw new FileNotFoundException("Could not locate repository source file.", Path.Combine(relativeSegments));
        }
    }
}
