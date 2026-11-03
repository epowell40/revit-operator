using System;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class FamilyInspectionSourceTests
    {
        [Theory]
        [InlineData("{\"elementId\":42}", true)]
        [InlineData("{\"filePath\":\"artifacts/reference/vendor.rfa\"}", true)]
        [InlineData("{\"filePath\":\"artifacts/reference/vendor.RFA\",\"includeParameters\":true}", true)]
        [InlineData("{}", false)]
        [InlineData("{\"elementId\":0}", false)]
        [InlineData("{\"elementId\":-1}", false)]
        [InlineData("{\"elementId\":1.5}", false)]
        [InlineData("{\"elementId\":\"42\"}", false)]
        [InlineData("{\"elementId\":42,\"filePath\":\"x.rfa\"}", false)]
        [InlineData("{\"elementId\":42,\"filePath\":null}", false)]
        [InlineData("{\"filePath\":null}", false)]
        [InlineData("{\"filePath\":\" \"}", false)]
        [InlineData("{\"filePath\":\"x.rvt\"}", false)]
        [InlineData("{\"filePath\":\"x\\u0000.rfa\"}", false)]
        [InlineData("{\"filePath\":\"x.rfa\",\"save\":true}", false)]
        [InlineData("{\"elementId\":42,\"elementId\":43}", false)]
        public void NativeSelectorsAreExclusiveAndDoNotAcceptHiddenActions(string json, bool expected)
        {
            using var body = JsonDocument.Parse(json);
            Assert.Equal(expected, FamilyInspectionSource.Validate(body.RootElement, out _));
        }

        [Fact]
        public void FileReadAcceptsOnlyAnExistingOrdinaryRfaWithinTheWorkspace()
        {
            var root = Path.Combine(Path.GetTempPath(), "family-inspection435-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path.Combine(root, "artifacts"));
            try
            {
                var file = Path.Combine(root, "artifacts", "vendor.rfa");
                File.WriteAllText(file, "source bytes are never changed by path validation");
                var before = File.ReadAllBytes(file);
                Assert.Equal(file, FamilyInspectionSource.ResolveExisting(root, "artifacts/vendor.rfa"));
                Assert.Equal(file, FamilyInspectionSource.ResolveExisting(root, file));
                Assert.Throws<UnauthorizedAccessException>(() => FamilyInspectionSource.ResolveExisting(root, "../outside.rfa"));
                Assert.Throws<UnauthorizedAccessException>(() => FamilyInspectionSource.ResolveExisting(root, "artifacts/vendor.rvt"));
                Assert.Throws<FileNotFoundException>(() => FamilyInspectionSource.ResolveExisting(root, "artifacts/missing.rfa"));
                Assert.Throws<ArgumentException>(() => FamilyInspectionSource.ResolveExisting(root, @"\\server\share\vendor.rfa"));
                Assert.Throws<ArgumentException>(() => FamilyInspectionSource.ResolveExisting(root, "C:vendor.rfa"));
                Assert.Throws<ArgumentException>(() => FamilyInspectionSource.ResolveExisting(root, "artifacts/vendor.rfa:stream"));
                Assert.Equal(before, File.ReadAllBytes(file));
            }
            finally { Directory.Delete(root, true); }
        }

        [Fact]
        public void AdvertisedSchemaRetainsBothExclusiveSourceAlternatives()
        {
            using var schema = JsonDocument.Parse(JsonSerializer.Serialize(FamilyInspectionSource.Schema()));
            var s = schema.RootElement;
            Assert.False(s.GetProperty("additionalProperties").GetBoolean());
            Assert.Equal(2, s.GetProperty("oneOf").GetArrayLength());
            Assert.Equal("elementId", s.GetProperty("oneOf")[0].GetProperty("required")[0].GetString());
            Assert.Equal("filePath", s.GetProperty("oneOf")[1].GetProperty("required")[0].GetString());
            Assert.Equal(1, s.GetProperty("properties").GetProperty("elementId").GetProperty("minimum").GetInt32());
        }
    }
}
