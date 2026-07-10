using System;
using System.IO;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class ExportedImagePathResolverTests
    {
        [Fact]
        public void Resolve_ReturnsExactPngWhenPresent()
        {
            var dir = CreateTempDir();
            try
            {
                var requested = Path.Combine(dir, "Revit_1543141_20260630223211");
                var exact = requested + ".png";
                File.WriteAllText(exact, "image");

                Assert.Equal(exact, ExportedImagePathResolver.Resolve(requested));
            }
            finally
            {
                Directory.Delete(dir, recursive: true);
            }
        }

        [Fact]
        public void Resolve_FindsRevitSheetSuffixedExport()
        {
            var dir = CreateTempDir();
            try
            {
                var requested = Path.Combine(dir, "Revit_1543141_20260630223211");
                var actual = requested + " - Sheet - M107 - Plan HVAC L4 CAD.jpg";
                File.WriteAllText(actual, "image");

                Assert.Equal(actual, ExportedImagePathResolver.Resolve(requested));
            }
            finally
            {
                Directory.Delete(dir, recursive: true);
            }
        }

        [Fact]
        public void Resolve_PrefersNewestMatchingExport()
        {
            var dir = CreateTempDir();
            try
            {
                var requested = Path.Combine(dir, "Revit_1543141_20260630223211");
                var older = requested + " - Sheet - M107 - Older.jpg";
                var newer = requested + " - Sheet - M107 - Newer.jpg";
                File.WriteAllText(older, "old");
                File.WriteAllText(newer, "new");
                File.SetLastWriteTimeUtc(older, DateTime.UtcNow.AddMinutes(-2));
                File.SetLastWriteTimeUtc(newer, DateTime.UtcNow.AddMinutes(-1));

                Assert.Equal(newer, ExportedImagePathResolver.Resolve(requested));
            }
            finally
            {
                Directory.Delete(dir, recursive: true);
            }
        }

        private static string CreateTempDir()
        {
            var dir = Path.Combine(Path.GetTempPath(), "revit-operator-export-path-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            return dir;
        }
    }
}
