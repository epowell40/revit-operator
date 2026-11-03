using System;
using System.IO;
using System.Security.Cryptography;
using RevitBridge.Logic;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ExportedImageMetadataTests
    {
        private static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=");

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void ExportedImageCanBeDecodedWithoutGdiPathLimitAndReleasesFile(bool longPath)
        {
            var directory = Path.Combine(Path.GetTempPath(), "operator-image-read", Guid.NewGuid().ToString("N"));
            if (longPath) directory = Path.Combine(directory, new string('a', 100), new string('b', 100), "capture");
            var extended = @"\\?\" + directory;
            Directory.CreateDirectory(extended);
            try
            {
                var file = Path.Combine(directory, "export - Section - Main Electrical Distribution.png");
                File.WriteAllBytes(@"\\?\" + file, Png);
                if (longPath) Assert.True(file.Length > 260);
                Assert.Equal((1, 1), ExportedImageMetadata.ReadDimensions(file));
                using (var sha = SHA256.Create())
                    Assert.Equal("sha256:" + BitConverter.ToString(sha.ComputeHash(Png)).Replace("-", "").ToLowerInvariant(), ExportedImageMetadata.ComputeSha256(file));
                using (var exclusive = new FileStream(@"\\?\" + file, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                    Assert.True(exclusive.Length > 0);
                Assert.Equal(Png, File.ReadAllBytes(@"\\?\" + file));
            }
            finally { Directory.Delete(extended, true); }
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void InvalidImageIsRejectedAndFileHandleIsReleased(bool longPath)
        {
            var directory = Path.Combine(Path.GetTempPath(), "operator-image-invalid", Guid.NewGuid().ToString("N"));
            if (longPath) directory = Path.Combine(directory, new string('a', 100), new string('b', 100));
            Directory.CreateDirectory(@"\\?\" + directory);
            var file = Path.Combine(directory, "invalid.png");
            try
            {
                File.WriteAllText(@"\\?\" + file, "not image data");
                Assert.ThrowsAny<Exception>(() => ExportedImageMetadata.ReadDimensions(file));
                using (var exclusive = new FileStream(@"\\?\" + file, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                    Assert.True(exclusive.Length > 0);
            }
            finally { Directory.Delete(@"\\?\" + directory, true); }
        }

        [Fact]
        public void LongRelativePathCannotBecomeADevicePath()
            => Assert.Throws<ArgumentException>(() => ExportedImageMetadata.ReadDimensions(new string('a', 260) + ".png"));

#if NET48
        [Fact]
        public void RevitLegacyFrameworkHostCanReadAnAlreadyExportedLongPath()
        {
            var directory = Path.Combine(Path.GetTempPath(), "operator-image-legacy", Guid.NewGuid().ToString("N"), new string('a', 100), new string('b', 100));
            var file = Path.Combine(directory, "export - Section - Main Electrical Distribution.png");
            Directory.CreateDirectory(@"\\?\" + directory);
            File.WriteAllBytes(@"\\?\" + file, Png);
            var setup = new AppDomainSetup { ApplicationBase = AppDomain.CurrentDomain.BaseDirectory, TargetFrameworkName = ".NETFramework,Version=v4.0" };
            var domain = AppDomain.CreateDomain("revit-legacy-image-" + Guid.NewGuid().ToString("N"), null, setup);
            try
            {
                var reader = (LegacyImageReader)domain.CreateInstanceAndUnwrap(typeof(LegacyImageReader).Assembly.FullName, typeof(LegacyImageReader).FullName);
                Assert.Equal("1x1", reader.Read(file));
                using (var sha = SHA256.Create())
                    Assert.Equal("sha256:" + BitConverter.ToString(sha.ComputeHash(Png)).Replace("-", "").ToLowerInvariant(), reader.Hash(file));
            }
            finally { AppDomain.Unload(domain); Directory.Delete(@"\\?\" + directory, true); }
        }

        public sealed class LegacyImageReader : MarshalByRefObject
        {
            public string Hash(string path) => ExportedImageMetadata.ComputeSha256(path);
            public string Read(string path)
            {
                var dimensions = ExportedImageMetadata.ReadDimensions(path);
                return dimensions.widthPx + "x" + dimensions.heightPx;
            }
        }
#endif
    }
}
