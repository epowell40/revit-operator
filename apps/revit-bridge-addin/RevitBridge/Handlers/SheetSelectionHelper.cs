using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace RevitBridge.Handlers
{
    internal static class SheetSelectionHelper
    {
        internal static List<ViewSheet> ResolveSheets(
            Document doc,
            List<long>? sheetIds,
            List<string>? sheetNumbers,
            string? query,
            bool exact,
            int max,
            bool all)
        {
            var cap = all ? 5000 : Math.Max(1, Math.Min(max, 5000));
            var candidates = new List<ViewSheet>();

            if (sheetIds != null && sheetIds.Count > 0)
            {
                foreach (var rawId in sheetIds)
                {
                    if (rawId <= 0) continue;
                    var sheet = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(rawId)) as ViewSheet;
                    if (sheet != null && !sheet.IsPlaceholder)
                    {
                        candidates.Add(sheet);
                    }
                }
            }
            else
            {
                var allSheets = new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewSheet))
                    .Cast<ViewSheet>()
                    .Where(s => s != null && !s.IsPlaceholder)
                    .ToList();

                var numberSet = new HashSet<string>(
                    (sheetNumbers ?? new List<string>())
                        .Select(x => (x ?? "").Trim())
                        .Where(x => !string.IsNullOrWhiteSpace(x)),
                    StringComparer.OrdinalIgnoreCase);

                var q = (query ?? "").Trim();

                IEnumerable<ViewSheet> filtered = allSheets;
                if (!all)
                {
                    if (numberSet.Count > 0)
                    {
                        filtered = filtered.Where(s => numberSet.Contains((s.SheetNumber ?? "").Trim()));
                    }
                    else if (!string.IsNullOrWhiteSpace(q))
                    {
                        filtered = filtered.Where(s =>
                        {
                            var sn = (s.SheetNumber ?? "").Trim();
                            var name = (s.Name ?? "").Trim();
                            if (exact)
                            {
                                return sn.Equals(q, StringComparison.OrdinalIgnoreCase) ||
                                       name.Equals(q, StringComparison.OrdinalIgnoreCase);
                            }

                            return sn.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0 ||
                                   name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0;
                        });
                    }
                    else
                    {
                        filtered = Enumerable.Empty<ViewSheet>();
                    }
                }

                candidates.AddRange(filtered);
            }

            var seen = new HashSet<long>();
            var distinct = new List<ViewSheet>(candidates.Count);
            foreach (var s in candidates)
            {
                if (s == null) continue;
                var id = RevitBridge.Common.ElementIdCompat.GetValue(s.Id);
                if (id <= 0) continue;
                if (seen.Add(id)) distinct.Add(s);
            }

            return distinct
                .OrderBy(s => s.SheetNumber, StringComparer.OrdinalIgnoreCase)
                .ThenBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .Take(cap)
                .ToList();
        }
    }
}
