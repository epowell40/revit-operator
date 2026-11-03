using System;
using System.Text.Json;
using RevitBridge.Common.Semantic;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class QuantifySourceCoverageTests
    {
        private static QuantifyDocumentCoverage Host(int count = 0) => new QuantifyDocumentCoverage { source = "host", projectUniqueId = "host-project", matchedCount = count };
        private static QuantifyDocumentCoverage Link(long id = 10, int count = 0) => new QuantifyDocumentCoverage { source = "link", projectUniqueId = "electrical-project", linkInstanceId = id, linkUniqueId = "link-" + id, matchedCount = count };

        [Fact] public void CompleteZeroIncludesReadSourcesAndExplicitSemanticLimits()
        {
            var c = QuantifySourceCoverage.Build("both", 1, 0, new[] { Host(), Link() });
            Assert.True(c.complete); Assert.Equal(0, c.matchedCount); Assert.Equal(2, c.documents.Count);
            using var j = JsonDocument.Parse(JsonSerializer.Serialize(c));
            Assert.Equal("operator.quantify_source_coverage.v1", j.RootElement.GetProperty("schema").GetString());
            Assert.Equal("direct_document_instances", j.RootElement.GetProperty("instanceScope").GetString());
            Assert.False(j.RootElement.GetProperty("familyDefinitionContentsInspected").GetBoolean());
            Assert.Equal("electrical-project", j.RootElement.GetProperty("documents")[1].GetProperty("projectUniqueId").GetString());
        }
        [Fact] public void UnloadedLinkedSourceNeverCertifiesAbsence()
        {
            var c = QuantifySourceCoverage.Build("links", 1, 1, Array.Empty<QuantifyDocumentCoverage>());
            Assert.False(c.complete); Assert.Equal(1, c.unavailableLinkInstances); Assert.Equal(0, c.matchedCount);
        }
        [Fact] public void PartialPositiveIsPreservedButIncomplete()
        {
            var c = QuantifySourceCoverage.Build("both", 2, 1, new[] { Host(2), Link(10, 3) });
            Assert.False(c.complete); Assert.Equal(5, c.matchedCount);
        }
        [Fact] public void NestedLinksRemainExplicitlyUninspected()
        {
            var link = Link(); link.nestedLinkInstances = 1;
            var c = QuantifySourceCoverage.Build("links", 1, 0, new[] { link });
            Assert.False(c.complete); Assert.Equal(1, c.nestedLinkInstances);
        }
        [Theory] [InlineData("host")] [InlineData("links")] [InlineData("both")]
        public void FullMatchingSourcesPermitExactCounts(string scope)
        {
            var docs = scope == "host" ? new[] { Host(3) } : scope == "links" ? new[] { Link(10, 4) } : new[] { Host(3), Link(10, 4) };
            var c = QuantifySourceCoverage.Build(scope, scope == "host" ? 0 : 1, 0, docs);
            Assert.True(c.complete); Assert.Equal(scope == "host" ? 3 : scope == "links" ? 4 : 7, c.matchedCount);
        }
        [Fact] public void EmptyLinkSetIsDistinctFromUnavailableLinks()
        { Assert.True(QuantifySourceCoverage.Build("links", 0, 0, Array.Empty<QuantifyDocumentCoverage>()).complete); }
        [Fact] public void MissingSourceIdentityIsNotComplete()
        {
            var h = Host(); h.projectUniqueId = "";
            Assert.False(QuantifySourceCoverage.Build("host", 0, 0, new[] { h }).complete);
            var l = Link(); l.linkUniqueId = null;
            Assert.False(QuantifySourceCoverage.Build("links", 1, 0, new[] { l }).complete);
        }
        [Fact] public void InvalidInventoryAndWrongSourceScopeReject()
        {
            Assert.Throws<ArgumentException>(() => QuantifySourceCoverage.Build("links", 2, 0, new[] { Link() }));
            Assert.Throws<ArgumentException>(() => QuantifySourceCoverage.Build("links", 2, 0, new[] { Link(), Link() }));
            Assert.Throws<ArgumentException>(() => QuantifySourceCoverage.Build("host", 1, 0, new[] { Host(), Link() }));
            Assert.Throws<ArgumentException>(() => QuantifySourceCoverage.Build("both", 1, 0, new[] { Link() }));
            Assert.Throws<ArgumentException>(() => QuantifySourceCoverage.Build("links", 0, 1, Array.Empty<QuantifyDocumentCoverage>()));
            Assert.Throws<ArgumentException>(() => QuantifySourceCoverage.Build("host", 0, 0, new[] { Host(-1) }));
        }
    }
}
