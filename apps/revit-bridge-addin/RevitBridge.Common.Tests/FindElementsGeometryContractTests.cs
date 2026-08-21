using System;
using System.IO;
using System.Linq;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class FindElementsGeometryContractTests
    {
        [Fact]
        public void FindElementsUsesSourceOrOwnerViewWhenModelSpaceGeometryIsUnavailable()
        {
            var source = ReadSharedSource(
                "revit-bridge-addin", "RevitBridge.Logic", "Handlers", "FindElementsHandler.cs");

            Assert.Equal(2, CountOccurrences(
                source,
                "BuildGeometrySummary(e, ResolveGeometryView(doc, candidate))"));
            Assert.Contains("var sourceViewId = TryGetElementIdValue(candidate.SourceViewId);", source);
            Assert.Contains("var ownerViewId = TryGetElementIdValue(candidate.Element.OwnerViewId);", source);
            AssertOrdered(
                source,
                "var box = e.get_BoundingBox(null);",
                "if (box == null && viewContext != null)",
                "box = e.get_BoundingBox(viewContext);");
        }

        private static int CountOccurrences(string source, string fragment)
        {
            var count = 0;
            var offset = 0;
            while ((offset = source.IndexOf(fragment, offset, StringComparison.Ordinal)) >= 0)
            {
                count += 1;
                offset += fragment.Length;
            }
            return count;
        }

        private static string FindRepositoryRoot()
        {
            var cursor = new DirectoryInfo(AppContext.BaseDirectory);
            while (cursor != null)
            {
                if (File.Exists(Path.Combine(cursor.FullName, "AGENTS.md"))) return cursor.FullName;
                cursor = cursor.Parent;
            }

            throw new DirectoryNotFoundException("Repository root not found.");
        }

        private static string ReadSharedSource(params string[] relativeSegments)
        {
            var root = FindRepositoryRoot();
            var publicCandidate = Path.Combine(new[] { root, "apps" }.Concat(relativeSegments).ToArray());
            if (File.Exists(publicCandidate)) return File.ReadAllText(publicCandidate);

            var privateCandidate = Path.Combine(new[] { root }.Concat(relativeSegments).ToArray());
            return File.ReadAllText(privateCandidate);
        }

        private static void AssertOrdered(string source, params string[] fragments)
        {
            var offset = 0;
            foreach (var fragment in fragments)
            {
                var found = source.IndexOf(fragment, offset, StringComparison.Ordinal);
                Assert.True(found >= 0, $"Expected source fragment after offset {offset}: {fragment}");
                offset = found + fragment.Length;
            }
        }
    }
}
