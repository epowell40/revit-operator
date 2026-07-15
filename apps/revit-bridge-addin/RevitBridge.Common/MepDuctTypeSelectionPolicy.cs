using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public sealed class MepDuctTypeCandidate
    {
        public long Id { get; set; }
        public string Name { get; set; } = string.Empty;
        public string FamilyName { get; set; } = string.Empty;
    }

    public sealed class MepDuctTypeSelection
    {
        public MepDuctTypeCandidate? Selected { get; set; }
        public IReadOnlyList<MepDuctTypeCandidate> Candidates { get; set; } = Array.Empty<MepDuctTypeCandidate>();
        public bool Ambiguous { get; set; }
        public string Error { get; set; } = string.Empty;
    }

    /// <summary>
    /// Selects a duct type without depending on collector ordering. Revit projects
    /// commonly contain several duct types named "Default", so name-only selection
    /// must fail closed unless it resolves to exactly one native type.
    /// </summary>
    public static class MepDuctTypeSelectionPolicy
    {
        public static MepDuctTypeSelection Resolve(
            IEnumerable<MepDuctTypeCandidate>? source,
            long? requestedId,
            string? requestedName)
        {
            var candidates = (source ?? Array.Empty<MepDuctTypeCandidate>())
                .Where(x => x != null)
                .OrderBy(x => x.Id)
                .ToList();

            if (requestedId.HasValue)
            {
                var byId = candidates.Where(x => x.Id == requestedId.Value).ToList();
                if (byId.Count == 1)
                {
                    return new MepDuctTypeSelection { Selected = byId[0], Candidates = byId };
                }

                return new MepDuctTypeSelection
                {
                    Candidates = candidates,
                    Error = $"Duct type id {requestedId.Value} was not found."
                };
            }

            var query = (requestedName ?? string.Empty).Trim();
            if (query.Length == 0)
            {
                if (candidates.Count == 1)
                {
                    return new MepDuctTypeSelection { Selected = candidates[0], Candidates = candidates };
                }

                return new MepDuctTypeSelection
                {
                    Candidates = candidates,
                    Ambiguous = candidates.Count > 1,
                    Error = candidates.Count == 0
                        ? "No duct types are loaded."
                        : "Multiple duct types are loaded; provide ductTypeId or a unique ductType name."
                };
            }

            var exact = candidates.Where(x =>
                    string.Equals(x.Name, query, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(x.FamilyName, query, StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (exact.Count == 1)
            {
                return new MepDuctTypeSelection { Selected = exact[0], Candidates = exact };
            }
            if (exact.Count > 1)
            {
                return new MepDuctTypeSelection
                {
                    Candidates = exact,
                    Ambiguous = true,
                    Error = $"Duct type '{query}' matches {exact.Count} native types; provide ductTypeId."
                };
            }

            var contains = candidates.Where(x =>
                    x.Name.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    x.FamilyName.IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0)
                .ToList();
            if (contains.Count == 1)
            {
                return new MepDuctTypeSelection { Selected = contains[0], Candidates = contains };
            }

            return new MepDuctTypeSelection
            {
                Candidates = contains.Count > 0 ? contains : candidates,
                Ambiguous = contains.Count > 1,
                Error = contains.Count > 1
                    ? $"Duct type query '{query}' matches {contains.Count} native types; provide ductTypeId."
                    : $"Duct type '{query}' was not found."
            };
        }
    }
}
