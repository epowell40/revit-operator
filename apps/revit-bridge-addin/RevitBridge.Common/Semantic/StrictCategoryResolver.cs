using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common.Semantic
{
    public sealed class StrictCategoryDescriptor
    {
        public long Id { get; set; }
        public string Name { get; set; } = string.Empty;
        public string? BuiltInToken { get; set; }
    }

    public sealed class StrictCategoryResolution
    {
        public string RequestedToken { get; set; } = string.Empty;
        public long Id { get; set; }
        public string Name { get; set; } = string.Empty;
        public string? BuiltInToken { get; set; }
    }

    public static class StrictCategoryResolver
    {
        public static string? TryGetEnumName(Type enumType, long value)
        {
            if (enumType == null) throw new ArgumentNullException(nameof(enumType));
            if (!enumType.IsEnum) throw new ArgumentException("Type must be an enum.", nameof(enumType));
            try
            {
                var underlying = Enum.GetUnderlyingType(enumType);
                var typedValue = Convert.ChangeType(value, underlying);
                return Enum.GetName(enumType, typedValue);
            }
            catch (OverflowException)
            {
                return null;
            }
        }

        public static IReadOnlyList<StrictCategoryResolution> Resolve(
            IEnumerable<string>? requestedTokens,
            IEnumerable<StrictCategoryDescriptor>? catalog)
        {
            var requested = (requestedTokens ?? Array.Empty<string>())
                .Select(x => (x ?? string.Empty).Trim())
                .Where(x => x.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            if (requested.Count == 0) return Array.Empty<StrictCategoryResolution>();

            var known = (catalog ?? Array.Empty<StrictCategoryDescriptor>())
                .Where(x => x != null && x.Id != 0 && !string.IsNullOrWhiteSpace(x.Name))
                .ToList();
            var resolved = new List<StrictCategoryResolution>();
            var unresolved = new List<string>();
            var ambiguous = new List<string>();

            foreach (var token in requested)
            {
                var matches = known
                    .Where(x => TokenMatches(token, x))
                    .GroupBy(x => x.Id)
                    .Select(x => x.First())
                    .ToList();
                if (matches.Count == 0)
                {
                    unresolved.Add(token);
                    continue;
                }
                if (matches.Count > 1)
                {
                    ambiguous.Add(token);
                    continue;
                }

                var match = matches[0];
                resolved.Add(new StrictCategoryResolution
                {
                    RequestedToken = token,
                    Id = match.Id,
                    Name = match.Name,
                    BuiltInToken = match.BuiltInToken
                });
            }

            if (unresolved.Count > 0 || ambiguous.Count > 0)
            {
                var details = new List<string>();
                if (unresolved.Count > 0) details.Add($"unknown: {string.Join(", ", unresolved)}");
                if (ambiguous.Count > 0) details.Add($"ambiguous: {string.Join(", ", ambiguous)}");
                throw new ArgumentException($"Category filter could not be applied exactly ({string.Join("; ", details)}). No unfiltered search was run.");
            }

            return resolved
                .GroupBy(x => x.Id)
                .Select(x => x.First())
                .ToList();
        }

        private static bool TokenMatches(string token, StrictCategoryDescriptor candidate)
        {
            if (string.Equals(candidate.Name?.Trim(), token, StringComparison.OrdinalIgnoreCase)) return true;
            var builtIn = (candidate.BuiltInToken ?? string.Empty).Trim();
            if (builtIn.Length == 0) return false;
            if (string.Equals(builtIn, token, StringComparison.OrdinalIgnoreCase)) return true;
            return !token.StartsWith("OST_", StringComparison.OrdinalIgnoreCase) &&
                   string.Equals(builtIn, $"OST_{token}", StringComparison.OrdinalIgnoreCase);
        }
    }
}
