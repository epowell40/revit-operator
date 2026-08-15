using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public sealed class ViewQueryCandidate
    {
        public long Id { get; set; }
        public string Name { get; set; } = "";
        public string ViewType { get; set; } = "";
        public string? LevelName { get; set; }
        public string? Discipline { get; set; }
        public bool IsTemplate { get; set; }
    }

    public sealed class ViewQueryFilter
    {
        public IReadOnlyList<long> ViewIds { get; set; } = Array.Empty<long>();
        public IReadOnlyList<string> LevelNames { get; set; } = Array.Empty<string>();
        public IReadOnlyList<string> ViewTypes { get; set; } = Array.Empty<string>();
        public IReadOnlyList<string> Disciplines { get; set; } = Array.Empty<string>();
        public IReadOnlyList<string> ViewNames { get; set; } = Array.Empty<string>();
        public IReadOnlyList<string> NameContainsAny { get; set; } = Array.Empty<string>();
        public IReadOnlyList<string> SemanticGroups { get; set; } = Array.Empty<string>();
        public bool IncludeTemplates { get; set; }
        public int Offset { get; set; }
        public int Limit { get; set; } = 100;
    }

    public sealed class ViewQueryPage
    {
        public IReadOnlyList<ViewQueryCandidate> Views { get; set; } = Array.Empty<ViewQueryCandidate>();
        public int Total { get; set; }
        public int Offset { get; set; }
        public int Limit { get; set; }
        public bool Truncated { get; set; }
        public IReadOnlyList<string> AppliedFilters { get; set; } = Array.Empty<string>();
    }

    public static class ViewQueryPolicy
    {
        private static readonly HashSet<string> SupportedSemanticGroups = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "power", "lighting", "electrical", "mechanical", "hvac", "plumbing", "fire_alarm", "architectural"
        };

        public static ViewQueryPage Apply(IEnumerable<ViewQueryCandidate> source, ViewQueryFilter filter)
        {
            if (source == null) throw new ArgumentNullException(nameof(source));
            if (filter == null) throw new ArgumentNullException(nameof(filter));
            var ids = NormalizeIds(filter.ViewIds, 64);
            var levels = NormalizeStrings(filter.LevelNames, 32, 160, nameof(filter.LevelNames));
            var types = NormalizeStrings(filter.ViewTypes, 32, 80, nameof(filter.ViewTypes));
            var disciplines = NormalizeStrings(filter.Disciplines, 16, 80, nameof(filter.Disciplines));
            var viewNames = NormalizeStrings(filter.ViewNames, 32, 160, nameof(filter.ViewNames));
            var names = NormalizeStrings(filter.NameContainsAny, 32, 160, nameof(filter.NameContainsAny));
            var groups = NormalizeStrings(filter.SemanticGroups, 8, 80, nameof(filter.SemanticGroups));
            foreach (var group in groups)
                if (!SupportedSemanticGroups.Contains(group)) throw new ArgumentException($"Unsupported semantic view group '{group}'.", nameof(filter.SemanticGroups));
            if (filter.Offset < 0 || filter.Offset > 200000) throw new ArgumentOutOfRangeException(nameof(filter.Offset));
            if (filter.Limit < 1 || filter.Limit > 500) throw new ArgumentOutOfRangeException(nameof(filter.Limit));

            IEnumerable<ViewQueryCandidate> query = source;
            if (!filter.IncludeTemplates) query = query.Where(view => !view.IsTemplate);
            if (ids.Count > 0) query = query.Where(view => ids.Contains(view.Id));
            if (levels.Count > 0) query = query.Where(view => ExactAny(view.LevelName, levels));
            if (types.Count > 0) query = query.Where(view => ExactAny(view.ViewType, types));
            if (disciplines.Count > 0) query = query.Where(view => ExactAny(view.Discipline, disciplines));
            if (viewNames.Count > 0) query = query.Where(view => ExactAny(view.Name, viewNames));
            if (names.Count > 0) query = query.Where(view => ContainsAny(view.Name, names));
            if (groups.Count > 0) query = query.Where(view => MatchesSemanticGroup(view, groups));

            var ordered = query.OrderBy(view => view.LevelName ?? "", StringComparer.OrdinalIgnoreCase)
                .ThenBy(view => view.ViewType ?? "", StringComparer.OrdinalIgnoreCase)
                .ThenBy(view => view.Name ?? "", StringComparer.OrdinalIgnoreCase)
                .ThenBy(view => view.Id)
                .ToList();
            var page = ordered.Skip(filter.Offset).Take(filter.Limit).ToList();
            var applied = new List<string>();
            if (!filter.IncludeTemplates) applied.Add("exclude_templates");
            if (ids.Count > 0) applied.Add("view_ids");
            if (levels.Count > 0) applied.Add("level_names_exact");
            if (types.Count > 0) applied.Add("view_types_exact");
            if (disciplines.Count > 0) applied.Add("disciplines_exact");
            if (viewNames.Count > 0) applied.Add("view_names_exact");
            if (names.Count > 0) applied.Add("name_contains_any");
            if (groups.Count > 0) applied.Add("semantic_groups");
            return new ViewQueryPage
            {
                Views = page,
                Total = ordered.Count,
                Offset = filter.Offset,
                Limit = filter.Limit,
                Truncated = filter.Offset + page.Count < ordered.Count,
                AppliedFilters = applied
            };
        }

        private static HashSet<long> NormalizeIds(IEnumerable<long>? values, int max)
        {
            var ids = (values ?? Array.Empty<long>()).ToList();
            if (ids.Count > max || ids.Any(id => id <= 0)) throw new ArgumentException("View ids must be positive and bounded.");
            return new HashSet<long>(ids);
        }

        private static List<string> NormalizeStrings(IEnumerable<string>? values, int maxItems, int maxLength, string field)
        {
            var raw = (values ?? Array.Empty<string>()).ToList();
            if (raw.Count > maxItems) throw new ArgumentException($"{field} supports at most {maxItems} values.");
            var result = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var value in raw)
            {
                var text = (value ?? "").Trim();
                if (text.Length == 0 || text.Length > maxLength) throw new ArgumentException($"{field} contains an invalid value.");
                if (seen.Add(text)) result.Add(text);
            }
            return result;
        }

        private static bool ExactAny(string? value, IReadOnlyList<string> expected) =>
            !string.IsNullOrWhiteSpace(value) && expected.Any(item => string.Equals(item, value.Trim(), StringComparison.OrdinalIgnoreCase));

        private static bool ContainsAny(string? value, IReadOnlyList<string> expected) =>
            !string.IsNullOrWhiteSpace(value) && expected.Any(item => value.IndexOf(item, StringComparison.OrdinalIgnoreCase) >= 0);

        private static bool MatchesSemanticGroup(ViewQueryCandidate view, IReadOnlyList<string> groups)
        {
            var corpus = $"{view.Name} {view.Discipline}";
            foreach (var group in groups)
            {
                switch (group.ToLowerInvariant())
                {
                    case "power": if (ContainsAny(corpus, new[] { "power", "electrical power" })) return true; break;
                    case "lighting": if (ContainsAny(corpus, new[] { "lighting", "light plan" })) return true; break;
                    case "electrical": if (ContainsAny(corpus, new[] { "electrical", "power", "lighting" })) return true; break;
                    case "mechanical":
                    case "hvac": if (ContainsAny(corpus, new[] { "mechanical", "hvac", "duct", "ventilation" })) return true; break;
                    case "plumbing": if (ContainsAny(corpus, new[] { "plumbing", "domestic", "sanitary" })) return true; break;
                    case "fire_alarm": if (ContainsAny(corpus, new[] { "fire alarm", "fire-alarm", "firealarm" })) return true; break;
                    case "architectural": if (ContainsAny(corpus, new[] { "architectural", "floor plan" })) return true; break;
                }
            }
            return false;
        }
    }
}
