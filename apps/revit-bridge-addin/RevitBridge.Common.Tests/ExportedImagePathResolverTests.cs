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

        [Theory]
        [InlineData(260)]
        [InlineData(280)]
        public void RequiredExportReadsLongSuffixedArtifactWithoutChangingReceiptPath(int pathLength)
        {
            var dir = CreateTempDir();
            try
            {
                var requested = Path.Combine(dir, "Revit_long_unique");
                var actual = requested + " - " + new string('x', pathLength - requested.Length - 7) + ".png";
                Assert.Equal(pathLength, actual.Length);
                File.WriteAllText(@"\\?\" + actual, "pixels");
                var artifact = ExportedImagePathResolver.ReadRequired(requested);
                Assert.Equal(actual, artifact.Path);
                Assert.Equal(6, artifact.Bytes);
                Assert.Equal("6ec9c2b0eb14010746c8bce8939303b382344b296206612eb8a907a37b2b2f37", artifact.Sha256);
                using (var stream = ExportedImageFile.OpenRead(artifact.Path))
                using (var reader = new StreamReader(stream)) Assert.Equal("pixels", reader.ReadToEnd());
                File.WriteAllText(requested + ".jpg", "another exact target match");
                Assert.Throws<InvalidOperationException>(() => ExportedImagePathResolver.ReadRequired(requested));
            }
            finally { Directory.Delete(dir, recursive: true); }
        }

#if NET48
        [Fact]
        public void RequiredArtifactAndDimensionsSurviveLegacyRevitHostTogether()
        {
            var dir = CreateTempDir();
            var requested = Path.Combine(dir, "Revit_legacy_unique");
            var actual = requested + " - " + new string('x', 260 - requested.Length - 7) + ".png";
            var pixels = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=");
            File.WriteAllBytes(@"\\?\" + actual, pixels);
            var setup = new AppDomainSetup { ApplicationBase = AppDomain.CurrentDomain.BaseDirectory, TargetFrameworkName = ".NETFramework,Version=v4.0" };
            var domain = AppDomain.CreateDomain("target-export-legacy-" + Guid.NewGuid().ToString("N"), null, setup);
            try
            {
                var reader = (LegacyTargetReader)domain.CreateInstanceAndUnwrap(typeof(LegacyTargetReader).Assembly.FullName, typeof(LegacyTargetReader).FullName);
                var expectedHash = RevitBridge.Logic.ExportedImageMetadata.ComputeSha256(actual).Substring(7);
                Assert.Equal("1x1|" + actual + "|" + expectedHash, reader.Read(requested));
            }
            finally { AppDomain.Unload(domain); Directory.Delete(@"\\?\" + dir, recursive: true); }
        }

        public sealed class LegacyTargetReader : MarshalByRefObject
        {
            public string Read(string requested)
            {
                var artifact = ExportedImagePathResolver.ReadRequired(requested);
                var dimensions = RevitBridge.Logic.ExportedImageMetadata.ReadDimensions(artifact.Path);
                return dimensions.widthPx + "x" + dimensions.heightPx + "|" + artifact.Path + "|" + artifact.Sha256;
            }
        }
#endif

        private static string CreateTempDir()
        {
            var dir = Path.Combine(Path.GetTempPath(), "revit-operator-export-path-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            return dir;
        }
    }
}
