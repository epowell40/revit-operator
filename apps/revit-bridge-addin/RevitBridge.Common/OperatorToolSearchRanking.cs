using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace RevitBridge.Common
{
    public static class OperatorToolSearchRanking
    {
        private static readonly IReadOnlyDictionary<string, string> SemanticTokens =
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["inventory"] = "quantify", ["inventories"] = "quantify",
                ["counting"] = "count", ["counts"] = "count",
                ["grouped"] = "group", ["grouping"] = "group", ["groups"] = "group",
                ["listed"] = "list", ["listing"] = "list",
                ["categories"] = "category", ["elements"] = "element",
                ["families"] = "family", ["terminals"] = "terminal", ["types"] = "type"
            };

        public static IReadOnlyList<string> Tokenize(string? value)
        {
            var tokens = new List<string>();
            var current = new StringBuilder();
            void Flush()
            {
                if (current.Length < 2) { current.Clear(); return; }
                var token = current.ToString().Normalize(NormalizationForm.FormKC).ToLowerInvariant();
                if (SemanticTokens.TryGetValue(token, out var semantic)) token = semantic;
                if (!tokens.Contains(token, StringComparer.Ordinal)) tokens.Add(token);
                current.Clear();
            }
            foreach (var character in (value ?? string.Empty).Normalize(NormalizationForm.FormKC))
            {
                if (char.IsLetterOrDigit(character)) current.Append(char.ToLowerInvariant(character));
                else Flush();
            }
            Flush();
            return tokens;
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
            var normalizedQuery = (query ?? string.Empty).Trim().Normalize(NormalizationForm.FormKC).ToLowerInvariant();
            var queryTokens = Tokenize(normalizedQuery);
            if (queryTokens.Count == 0) return 0;
            var candidateTokens = new HashSet<string>(
                new[] { path, title, group, description, example, method }.SelectMany(Tokenize),
                StringComparer.Ordinal);
            var coverage = queryTokens.Count(candidateTokens.Contains);
            var aggregateIntent = queryTokens.Contains("quantify") || queryTokens.Contains("count");
            var candidateAggregates = candidateTokens.Contains("quantify") || candidateTokens.Contains("count");
            var aggregationBonus = aggregateIntent && candidateAggregates
                ? 100 + (queryTokens.Contains("group") && candidateTokens.Contains("group") ? 140 : 0)
                : 0;
            return ScoreField(path, normalizedQuery, queryTokens, 140, 28)
                + ScoreField(title, normalizedQuery, queryTokens, 120, 30)
                + ScoreField(group, normalizedQuery, queryTokens, 80, 24)
                + ScoreField(description, normalizedQuery, queryTokens, 55, 12)
                + ScoreField(example, normalizedQuery, queryTokens, 45, 10)
                + ScoreField(method, normalizedQuery, queryTokens, 25, 8)
                + (coverage * 20)
                + aggregationBonus;
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
    }
}
