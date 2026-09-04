using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace RevitBridge.Common
{
    public static class OperatorToolSearchRanking
    {
        public const string ContractVersion = "operator.tool_search_ranking.v3";

        private static readonly IReadOnlyDictionary<string, string> SemanticTokens =
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["inventory"] = "quantify", ["inventories"] = "quantify", ["quantification"] = "quantify",
                ["count"] = "quantify", ["counted"] = "quantify", ["counting"] = "quantify", ["counts"] = "quantify",
                ["grouped"] = "group", ["grouping"] = "group", ["groups"] = "group",
                ["listed"] = "list", ["listing"] = "list",
                ["categories"] = "category", ["elements"] = "element",
                ["families"] = "family", ["terminals"] = "terminal", ["types"] = "type",
                ["notes"] = "note", ["tags"] = "tag", ["ducts"] = "duct", ["pipes"] = "pipe",
                ["views"] = "view", ["sheets"] = "sheet", ["schedules"] = "schedule",
                ["parameters"] = "parameter", ["ids"] = "id", ["connections"] = "connection",
                ["updates"] = "update", ["updated"] = "update", ["updating"] = "update",
                ["edit"] = "update", ["edits"] = "update", ["edited"] = "update", ["editing"] = "update",
                ["replace"] = "update", ["replaces"] = "update", ["replaced"] = "update", ["replacing"] = "update",
                ["change"] = "update", ["changes"] = "update", ["changed"] = "update", ["changing"] = "update",
                ["duplication"] = "duplicate", ["duplicates"] = "duplicate", ["duplicated"] = "duplicate",
                ["deleting"] = "delete", ["deleted"] = "delete",
                ["removes"] = "delete", ["removed"] = "delete", ["removing"] = "delete",
                ["screenshot"] = "capture", ["screenshots"] = "capture"
            };

        private static readonly HashSet<string> StopTokens = new HashSet<string>(new[]
        {
            "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in",
            "into", "is", "it", "of", "on", "or", "please", "that", "the", "this",
            "to", "with", "without", "existing", "current", "revit"
        }, StringComparer.Ordinal);

        // Control flags such as apply, preview, dry, and run describe execution
        // mode. They are deliberately excluded from the domain-action bonus.
        private static readonly HashSet<string> TaskActionTokens = new HashSet<string>(new[]
        {
            "capture", "close", "copy", "create", "delete", "export", "find", "import",
            "inspect", "list", "load", "move", "open", "print", "purge", "quantify",
            "rename", "repair", "resize", "resolve", "save", "set", "sync", "tag",
            "update", "verify"
        }, StringComparer.Ordinal);

        public static IReadOnlyList<string> Tokenize(string? value)
        {
            return TokenSequence(value).Distinct(StringComparer.Ordinal).ToList();
        }

        public static int Score(
            string query,
            string? path,
            string? title,
            string? group,
            string? description,
            string? example,
            string? method)
        {
            var querySequence = TokenSequence(query);
            var queryTokens = querySequence.Distinct(StringComparer.Ordinal).ToList();
            if (queryTokens.Count == 0) return 0;

            var pathSequence = TokenSequence(path);
            var titleSequence = TokenSequence(title);
            var pathTokens = new HashSet<string>(pathSequence, StringComparer.Ordinal);
            var titleTokens = new HashSet<string>(titleSequence, StringComparer.Ordinal);
            var fields = new[]
            {
                new WeightedTokens(pathTokens, 72),
                new WeightedTokens(titleTokens, 64),
                new WeightedTokens(TokenSequence(group), 24),
                new WeightedTokens(TokenSequence(description), 14),
                new WeightedTokens(TokenSequence(example), 12),
                new WeightedTokens(TokenSequence(method), 4)
            };

            var score = 0;
            var pathTitleCoverage = 0;
            foreach (var token in queryTokens)
            {
                score += fields.Where(field => field.Tokens.Contains(token)).Select(field => field.Weight).DefaultIfEmpty(0).Max();
                if (pathTokens.Contains(token) || titleTokens.Contains(token))
                {
                    pathTitleCoverage += 1;
                    if (TaskActionTokens.Contains(token)) score += 260;
                }
            }
            score += pathTitleCoverage * pathTitleCoverage * 24;

            var pathCore = pathSequence.Where(token => !string.Equals(token, "revit", StringComparison.Ordinal)).ToList();
            var orderedMatch = Math.Max(
                LongestContiguousMatch(querySequence, pathCore),
                LongestContiguousMatch(querySequence, titleSequence));
            if (orderedMatch >= 2) score += orderedMatch * orderedMatch * 48;
            return score;
        }

        public static int ScoreField(string? field, string normalizedQuery, IReadOnlyList<string> queryTokens, int exactMatchScore, int tokenMatchScore)
        {
            var value = (field ?? string.Empty).Trim();
            if (value.Length == 0) return 0;
            var score = value.Normalize(NormalizationForm.FormKC).IndexOf(normalizedQuery, StringComparison.OrdinalIgnoreCase) >= 0
                ? exactMatchScore
                : 0;
            var fieldTokens = new HashSet<string>(Tokenize(value), StringComparer.Ordinal);
            return score + (queryTokens.Count(fieldTokens.Contains) * tokenMatchScore);
        }

        public static bool FieldContains(string? field, string normalizedQuery, IReadOnlyList<string> queryTokens)
        {
            var value = (field ?? string.Empty).Trim();
            if (value.Length == 0) return false;
            if (value.Normalize(NormalizationForm.FormKC).IndexOf(normalizedQuery, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            var fieldTokens = new HashSet<string>(Tokenize(value), StringComparer.Ordinal);
            return queryTokens.Any(fieldTokens.Contains);
        }

        private static IReadOnlyList<string> TokenSequence(string? value)
        {
            var normalized = (value ?? string.Empty).Normalize(NormalizationForm.FormKC);
            var separated = new StringBuilder(normalized.Length + 16);
            for (var index = 0; index < normalized.Length; index += 1)
            {
                var character = normalized[index];
                if (!char.IsLetterOrDigit(character))
                {
                    separated.Append(' ');
                    continue;
                }

                if (index > 0 && char.IsLetterOrDigit(normalized[index - 1]))
                {
                    var previous = normalized[index - 1];
                    var nextIsLower = index + 1 < normalized.Length && char.IsLower(normalized[index + 1]);
                    var boundary = (char.IsLower(previous) || char.IsDigit(previous)) && char.IsUpper(character)
                        || char.IsUpper(previous) && char.IsUpper(character) && nextIsLower
                        || char.IsLetter(previous) && char.IsDigit(character)
                        || char.IsDigit(previous) && char.IsLetter(character);
                    if (boundary) separated.Append(' ');
                }
                separated.Append(char.ToLowerInvariant(character));
            }

            var tokens = new List<string>();
            foreach (var raw in separated.ToString().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var token = raw;
                if (SemanticTokens.TryGetValue(token, out var semantic)) token = semantic;
                if (token.Length >= 2 && !StopTokens.Contains(token)) tokens.Add(token);
            }
            return tokens;
        }

        private static int LongestContiguousMatch(IReadOnlyList<string> left, IReadOnlyList<string> right)
        {
            var longest = 0;
            var previous = new int[right.Count + 1];
            for (var leftIndex = 1; leftIndex <= left.Count; leftIndex += 1)
            {
                var current = new int[right.Count + 1];
                for (var rightIndex = 1; rightIndex <= right.Count; rightIndex += 1)
                {
                    if (!string.Equals(left[leftIndex - 1], right[rightIndex - 1], StringComparison.Ordinal)) continue;
                    current[rightIndex] = previous[rightIndex - 1] + 1;
                    if (current[rightIndex] > longest) longest = current[rightIndex];
                }
                previous = current;
            }
            return longest;
        }

        private sealed class WeightedTokens
        {
            public WeightedTokens(IEnumerable<string> tokens, int weight)
            {
                Tokens = new HashSet<string>(tokens, StringComparer.Ordinal);
                Weight = weight;
            }

            public HashSet<string> Tokens { get; }
            public int Weight { get; }
        }
    }
}
