using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace RevitBridge.Common
{
    public sealed class ElementIdentityField
    {
        public string Name { get; set; } = "";
        public string? Value { get; set; }
    }

    public sealed class ElementIdentityMatch
    {
        public bool IsMatch { get; set; }
        public double Score { get; set; }
        public string? MatchedTerm { get; set; }
        public List<string> MatchedTokens { get; set; } = new List<string>();
        public List<string> MatchedFields { get; set; } = new List<string>();
    }

    /// <summary>
    /// Bounded lexical matching across the ordinary identity fields a Revit teammate
    /// sees: instance name, family, type, category, and Mark. A multi-word phrase may
    /// match by meaningful token overlap so common user/model vocabulary differences
    /// do not force a broad unfiltered document scan.
    /// </summary>
    public static class ElementIdentitySearchUtil
    {
        private static readonly HashSet<string> StopWords = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "a", "an", "and", "are", "at", "can", "each", "find", "for", "in", "is", "me",
            "of", "on", "or", "project", "tell", "the", "this", "to", "what", "where", "with"
        };

        public static ElementIdentityMatch Match(
            IEnumerable<ElementIdentityField>? fields,
            IEnumerable<string>? rawTerms)
        {
            var candidates = (fields ?? Enumerable.Empty<ElementIdentityField>())
                .Where(field => field != null && !string.IsNullOrWhiteSpace(field.Name) && !string.IsNullOrWhiteSpace(field.Value))
                .Select(field => new
                {
                    Name = field.Name.Trim(),
                    Normalized = Normalize(field.Value!),
                    OrderedTokens = Tokenize(field.Value!).ToList(),
                    Tokens = Tokenize(field.Value!).ToHashSet(StringComparer.OrdinalIgnoreCase)
                })
                .Where(field => field.Normalized.Length > 0)
                .ToList();

            var best = new ElementIdentityMatch();
            foreach (var raw in (rawTerms ?? Enumerable.Empty<string>()).Where(value => !string.IsNullOrWhiteSpace(value)).Take(8))
            {
                var normalizedTerm = Normalize(raw);
                var tokens = Tokenize(raw).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                if (normalizedTerm.Length == 0 || tokens.Count == 0) continue;

                var exactFields = candidates
                    .Where(field => ContainsContiguousTokens(field.OrderedTokens, tokens))
                    .Select(field => field.Name)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList();
                if (exactFields.Count > 0)
                {
                    return new ElementIdentityMatch
                    {
                        IsMatch = true,
                        Score = 1.0,
                        MatchedTerm = raw.Trim(),
                        MatchedTokens = tokens,
                        MatchedFields = exactFields
                    };
                }

                var matchedTokens = tokens
                    .Where(token => candidates.Any(field => field.Tokens.Contains(token)))
                    .ToList();
                var required = Math.Max(1, (int)Math.Ceiling(tokens.Count * 0.5));
                if (matchedTokens.Count < required) continue;

                var score = (double)matchedTokens.Count / tokens.Count;
                if (score <= best.Score) continue;
                var matchedFields = candidates
                    .Where(field => matchedTokens.Any(token => field.Tokens.Contains(token)))
                    .Select(field => field.Name)
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .ToList();
                best = new ElementIdentityMatch
                {
                    IsMatch = true,
                    Score = score,
                    MatchedTerm = raw.Trim(),
                    MatchedTokens = matchedTokens,
                    MatchedFields = matchedFields
                };
            }

            return best;
        }

        private static bool ContainsContiguousTokens(IReadOnlyList<string> candidate, IReadOnlyList<string> query)
        {
            if (candidate == null || query == null || query.Count == 0 || candidate.Count < query.Count) return false;
            for (var start = 0; start <= candidate.Count - query.Count; start++)
            {
                var matched = true;
                for (var offset = 0; offset < query.Count; offset++)
                {
                    if (string.Equals(candidate[start + offset], query[offset], StringComparison.OrdinalIgnoreCase)) continue;
                    matched = false;
                    break;
                }
                if (matched) return true;
            }
            return false;
        }

        public static IReadOnlyList<string> Tokenize(string? value)
        {
            var normalized = Normalize(value);
            if (normalized.Length == 0) return Array.Empty<string>();
            return normalized
                .Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)
                .Where(token => token.Length >= 2 && !StopWords.Contains(token))
                .ToList();
        }

        public static IReadOnlyList<string> BuildAcronyms(IEnumerable<string>? rawTerms)
        {
            var output = new List<string>();
            foreach (var raw in (rawTerms ?? Enumerable.Empty<string>()).Where(value => !string.IsNullOrWhiteSpace(value)).Take(8))
            {
                var tokens = Tokenize(raw);
                if (tokens.Count < 2 || tokens.Count > 8) continue;
                var acronym = string.Concat(tokens.Select(token => token[0])).ToLowerInvariant();
                if (acronym.Length < 2 || acronym.Length > 8) continue;
                if (!output.Contains(acronym, StringComparer.OrdinalIgnoreCase)) output.Add(acronym);
            }
            return output;
        }

        public static bool IsIdentityBearingParameterName(string? value)
        {
            var normalized = Normalize(value);
            return normalized == "mark"
                || normalized == "type mark"
                || normalized == "designation"
                || normalized == "desig"
                || normalized == "tag"
                || normalized == "identifier"
                || normalized == "id"
                || normalized == "asset id"
                || normalized == "equipment id"
                || normalized == "device id"
                || normalized == "number";
        }

        public static bool MatchesIndependentIdentityFilters(
            string? name,
            string? mark,
            string? typeName,
            string? familyName,
            string? requiredName,
            string? requiredMark,
            string? requiredTypeName,
            string? requiredFamilyName)
        {
            return ContainsOptional(name, requiredName)
                && ContainsOptional(mark, requiredMark)
                && ContainsOptional(typeName, requiredTypeName)
                && ContainsOptional(familyName, requiredFamilyName);
        }

        public static bool HasBoundedDocumentPredicate(int resolvedCategoryCount, IEnumerable<string?>? selectors)
        {
            return resolvedCategoryCount > 0
                || (selectors ?? Enumerable.Empty<string?>()).Any(value => Normalize(value).Length > 0);
        }

        private static bool ContainsOptional(string? value, string? required)
        {
            var needle = (required ?? "").Trim();
            return needle.Length == 0
                || (value ?? "").IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        public static string Normalize(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "";
            var input = value!;
            var output = new StringBuilder(input.Length);
            var pendingSpace = false;
            foreach (var c in input.Trim())
            {
                if (char.IsLetterOrDigit(c))
                {
                    if (pendingSpace && output.Length > 0) output.Append(' ');
                    output.Append(char.ToLowerInvariant(c));
                    pendingSpace = false;
                }
                else
                {
                    pendingSpace = true;
                }
            }
            return output.ToString();
        }
    }
}
