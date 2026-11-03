using System;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common.Annotation;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class TagReferenceReadPolicyTests
    {
        [Fact]
        public void BoundedBatchCanResolveEquipmentWithoutOneRequestPerTag()
        {
            Assert.Equal(16, TagReferenceReadPolicy.ValidateRequest(Enumerable.Range(1, 200).Select(x => (long)x), null));
            Assert.Equal(64, TagReferenceReadPolicy.ValidateRequest(new long[] { 10, 11 }, 64));
            Assert.Throws<ArgumentException>(() => TagReferenceReadPolicy.ValidateRequest(Enumerable.Range(1, 201).Select(x => (long)x), null));
        }

        [Fact]
        public void DuplicateInvalidOrUnboundedReferencesAreRejected()
        {
            foreach (var ids in new[] { Array.Empty<long>(), new long[] { 10, 10 }, new long[] { 0 }, new long[] { -1 } })
                Assert.Throws<ArgumentException>(() => TagReferenceReadPolicy.ValidateRequest(ids, null));
            foreach (var limit in new[] { 0, -1, 65, int.MaxValue })
                Assert.Throws<ArgumentException>(() => TagReferenceReadPolicy.ValidateRequest(new long[] { 10 }, limit));
        }

        [Fact]
        public void IdenticalElementIdsInHostAndDifferentLinksDoNotCollide()
        {
            var keys = new[] { TagReferenceReadPolicy.IdentityKey(null, 100), TagReferenceReadPolicy.IdentityKey(2, 100), TagReferenceReadPolicy.IdentityKey(3, 100) };
            Assert.Equal(3, keys.Distinct().Count());
            Assert.Equal("host:100", keys[0]); Assert.Equal("link:2:100", keys[1]);
            Assert.Throws<ArgumentException>(() => TagReferenceReadPolicy.IdentityKey(0, 100));
            Assert.Throws<ArgumentException>(() => TagReferenceReadPolicy.IdentityKey(null, 0));
        }

        [Theory]
        [InlineData(2, 2, 0, false, false, true)]
        [InlineData(2, 1, 0, false, false, false)]
        [InlineData(2, 2, 1, false, false, false)]
        [InlineData(0, 0, 0, true, false, false)]
        [InlineData(0, 0, 0, false, true, false)]
        [InlineData(0, 0, 0, false, false, false)]
        [InlineData(2, 2, 0, true, false, false)]
        public void TruncatedUnloadedOrOrphanedTagsCannotProveAnEmptyOrCompleteCohort(int total, int returned, int unresolved, bool orphaned, bool failed, bool complete)
            => Assert.Equal(complete, TagReferenceReadPolicy.Complete(total, returned, unresolved, orphaned, failed));

        [Theory]
        [InlineData("{\"elementIds\":[10,11],\"includeTagReferences\":true}")]
        [InlineData("{\"ids\":[10],\"includeTagReferences\":true,\"maxTagReferencesPerElement\":64}")]
        [InlineData("{\"elementIds\":[10],\"includeTagReferences\":false}")]
        [InlineData("{\"elementIds\":[10]}")]
        public void WireBoundaryAcceptsPreferredLegacyAndUnchangedSummaryRequests(string json)
        {
            using var doc = JsonDocument.Parse(json);
            TagReferenceReadPolicy.ValidateOptionalRequest(doc.RootElement);
        }

        [Theory]
        [InlineData("{\"elementIds\":[10],\"includeTagReferences\":\"true\"}")]
        [InlineData("{\"elementIds\":[10],\"includeTagReferences\":null}")]
        [InlineData("{\"elementIds\":[10],\"maxTagReferencesPerElement\":16}")]
        [InlineData("{\"elementIds\":[10],\"includeTagReferences\":true,\"maxTagReferencesPerElement\":1.5}")]
        [InlineData("{\"elementIds\":[10,10],\"includeTagReferences\":true}")]
        [InlineData("{\"elementIds\":[\"10\"],\"includeTagReferences\":true}")]
        [InlineData("{\"elementIds\":[],\"includeTagReferences\":true}")]
        [InlineData("{\"includeTagReferences\":true}")]
        public void WireBoundaryRejectsMisleadingFlagsAndNonExactScope(string json)
        {
            using var doc = JsonDocument.Parse(json);
            Assert.Throws<ArgumentException>(() => TagReferenceReadPolicy.ValidateOptionalRequest(doc.RootElement));
        }
    }
}
