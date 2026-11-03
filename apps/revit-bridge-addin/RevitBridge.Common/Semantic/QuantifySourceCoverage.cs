using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common.Semantic
{
    public sealed class QuantifyDocumentCoverage
    {
        public string source { get; set; } = "";
        public string projectUniqueId { get; set; } = "";
        public long? linkInstanceId { get; set; }
        public string? linkUniqueId { get; set; }
        public int matchedCount { get; set; }
        public int nestedLinkInstances { get; set; }
    }

    // Completeness concerns the native instance collection only. It does not
    // certify family-definition contents, room membership or design semantics.
    public sealed class QuantifySourceCoverage
    {
        public string schema => "operator.quantify_source_coverage.v1";
        public string scope { get; private set; } = "";
        public string instanceScope => "direct_document_instances";
        public bool familyDefinitionContentsInspected => false;
        public int directLinkInstances { get; private set; }
        public int unavailableLinkInstances { get; private set; }
        public int nestedLinkInstances { get; private set; }
        public int matchedCount { get; private set; }
        public bool complete { get; private set; }
        public IReadOnlyList<QuantifyDocumentCoverage> documents { get; private set; } = Array.Empty<QuantifyDocumentCoverage>();

        public static QuantifySourceCoverage Build(string scope, int discoveredLinks, int unavailableLinks,
            IReadOnlyList<QuantifyDocumentCoverage> documents)
        {
            if (scope != "host" && scope != "links" && scope != "both") throw new ArgumentException("Invalid quantify scope.");
            if (discoveredLinks < 0 || unavailableLinks < 0 || unavailableLinks > discoveredLinks) throw new ArgumentException("Invalid source counts.");
            var host = documents.Where(x => x.source == "host").ToList();
            var links = documents.Where(x => x.source == "link").ToList();
            if (host.Count + links.Count != documents.Count || documents.Any(x => x.matchedCount < 0 || x.nestedLinkInstances < 0))
                throw new ArgumentException("Invalid source observation.");
            if (host.Count != (scope == "links" ? 0 : 1) || scope == "host" && (discoveredLinks != 0 || links.Count != 0))
                throw new ArgumentException("Source scope mismatch.");
            if (links.Count + unavailableLinks != discoveredLinks || links.Any(x => !x.linkInstanceId.HasValue || x.linkInstanceId.Value <= 0)
                || links.Select(x => x.linkInstanceId).Distinct().Count() != links.Count)
                throw new ArgumentException("Linked source inventory mismatch.");
            var nested = documents.Sum(x => x.nestedLinkInstances);
            return new QuantifySourceCoverage {
                scope = scope, directLinkInstances = discoveredLinks, unavailableLinkInstances = unavailableLinks,
                nestedLinkInstances = nested, matchedCount = documents.Sum(x => x.matchedCount), documents = documents.ToArray(),
                complete = unavailableLinks == 0 && nested == 0
                    && documents.All(x => !string.IsNullOrWhiteSpace(x.projectUniqueId))
                    && links.All(x => !string.IsNullOrWhiteSpace(x.linkUniqueId))
            };
        }
    }
}
