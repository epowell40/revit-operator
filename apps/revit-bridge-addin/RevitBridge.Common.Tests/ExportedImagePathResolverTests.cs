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

        [Theory]
        [InlineData(".png")]
        [InlineData(" - Sheet - M002 - Notes, Symbols & Schedules.jpg")]
        [InlineData(" - Floor Plan - L4.JPEG")]
        public void RequiredExportBindsTheSingleExactTargetArtifact(string suffix)
        {
            var dir = CreateTempDir();
            try
            {
                var requested = Path.Combine(dir, "Revit_target_unique");
                var actual = requested + suffix;
                File.WriteAllText(actual, "pixels");
                File.WriteAllText(requested + "Other - Sheet - M000.jpg", "unrelated");
                var artifact = ExportedImagePathResolver.ReadRequired(requested);
                Assert.Equal(actual, artifact.Path);
                Assert.Equal(6, artifact.Bytes);
                Assert.Equal("6ec9c2b0eb14010746c8bce8939303b382344b296206612eb8a907a37b2b2f37", artifact.Sha256);
            }
            finally { Directory.Delete(dir, recursive: true); }
        }

        [Fact]
        public void RequiredExportRejectsMissingEmptyAndAmbiguousImagesInsteadOfGuessingNewest()
        {
            var dir = CreateTempDir();
            try
            {
                var requested = Path.Combine(dir, "Revit_target_unique");
                Assert.Throws<InvalidOperationException>(() => ExportedImagePathResolver.ReadRequired(requested));
                File.WriteAllText(requested + ".jpg", "");
                Assert.Throws<InvalidOperationException>(() => ExportedImagePathResolver.ReadRequired(requested));
                File.WriteAllText(requested + ".jpg", "pixels");
                File.WriteAllText(requested + " - Sheet - M002.jpg", "other");
                Assert.Throws<InvalidOperationException>(() => ExportedImagePathResolver.ReadRequired(requested));
                Assert.Throws<FileNotFoundException>(() => ExportedImagePathResolver.ReadRequired(Path.Combine(dir, "missing", "target")));
            }
            finally { Directory.Delete(dir, recursive: true); }
        }

        private static string CreateTempDir()
        {
            var dir = Path.Combine(Path.GetTempPath(), "revit-operator-export-path-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            return dir;
        }
    }
}
