using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class TitleblockDateCandidatesHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sheetNumber { get; set; }
            public long? sheetViewId { get; set; }
            public long? titleBlockElementId { get; set; }

            // Filter by name keywords; defaults include date-ish fields.
            public List<string>? keywords { get; set; } = new List<string> { "date", "issue", "stamp", "time" };
            public bool includeReadOnly { get; set; } = false;
            public int maxCandidates { get; set; } = 60;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            ViewSheet? sheet = null;
            if (p.sheetViewId.HasValue && p.sheetViewId.Value != 0)
            {
                sheet = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.sheetViewId.Value)) as ViewSheet;
            }
            else if (!string.IsNullOrWhiteSpace(p.sheetNumber))
            {
                var target = (p.sheetNumber ?? "").Trim();
                sheet = new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewSheet))
                    .Cast<ViewSheet>()
                    .FirstOrDefault(s => string.Equals((s.SheetNumber ?? "").Trim(), target, StringComparison.OrdinalIgnoreCase));
            }

            FamilyInstance? titleblock = null;
            if (p.titleBlockElementId.HasValue && p.titleBlockElementId.Value != 0)
            {
                titleblock = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.titleBlockElementId.Value)) as FamilyInstance;
            }
            else if (sheet != null)
            {
                titleblock = new FilteredElementCollector(doc, sheet.Id)
                    .OfCategory(BuiltInCategory.OST_TitleBlocks)
                    .WhereElementIsNotElementType()
                    .Cast<Element>()
                    .Select(e => e as FamilyInstance)
                    .FirstOrDefault(e => e != null);
            }

            if (titleblock == null) throw new InvalidOperationException("Titleblock not found (provide titleBlockElementId or sheetNumber/sheetViewId).");
            sheet ??= doc.GetElement(titleblock.OwnerViewId) as ViewSheet;
            var symbol = titleblock.Symbol;

            var kw = (p.keywords ?? new List<string> { "date", "issue", "stamp", "time" })
                .Where(s => !string.IsNullOrWhiteSpace(s))
                .Select(s => (s ?? "").Trim().ToLowerInvariant())
                .Distinct()
                .ToList();
            bool NameMatches(string name)
            {
                var n = (name ?? "").Trim().ToLowerInvariant();
                if (string.IsNullOrWhiteSpace(n)) return false;
                foreach (var k in kw)
                {
                    if (n.Contains(k)) return true;
                }
                return false;
            }

            var candidates = new List<object>();
            void AddFrom(string source, Element? el)
            {
                if (el == null) return;
                try
                {
                    foreach (var pr in el.GetOrderedParameters())
                    {
                        try
                        {
                            if (pr == null) continue;
                            var nm = (pr.Definition?.Name ?? "").Trim();
                            if (!NameMatches(nm)) continue;
                            if (!p.includeReadOnly && pr.IsReadOnly) continue;
                            candidates.Add(new
                            {
                                source,
                                elementId = RevitBridge.Common.ElementIdCompat.GetValue(el.Id),
                                parameterName = nm,
                                storageType = pr.StorageType.ToString(),
                                isReadOnly = pr.IsReadOnly,
                                value = ParameterValueUtil.SnapshotForWire(pr)
                            });
                        }
                        catch { }
                    }
                }
                catch { }
            }

            AddFrom("titleblock_instance", titleblock);
            try { AddFrom("titleblock_type", symbol); } catch { }
            try { AddFrom("sheet", sheet); } catch { }
            try { AddFrom("project_information", doc.ProjectInformation); } catch { }

            // Rank: prefer "issue date"/"project issue date" etc.
            int Score(object row)
            {
                try
                {
                    var json = JsonSerializer.Serialize(row);
                    var lower = json.ToLowerInvariant();
                    var s = 0;
                    if (lower.Contains("project issue")) s += 60;
                    if (lower.Contains("sheet issue")) s += 55;
                    if (lower.Contains("issue date")) s += 50;
                    if (lower.Contains("date stamp")) s += 45;
                    if (lower.Contains("timestamp")) s += 40;
                    if (lower.Contains("\"source\":\"titleblock_instance\"")) s += 30;
                    if (lower.Contains("\"source\":\"sheet\"")) s += 20;
                    if (lower.Contains("\"source\":\"project_information\"")) s += 10;
                    return s;
                }
                catch { return 0; }
            }

            var max = Math.Max(0, Math.Min(500, p.maxCandidates));
            var ranked = candidates
                .OrderByDescending(Score)
                .ThenBy(r => JsonSerializer.Serialize(r))
                .Take(max)
                .ToList();

            return Task.FromResult<object>(new
            {
                sheetNumber = sheet?.SheetNumber,
                sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet?.Id),
                titleblockElementId = RevitBridge.Common.ElementIdCompat.GetValue(titleblock.Id),
                titleblockTypeId = RevitBridge.Common.ElementIdCompat.GetValue(symbol?.Id),
                titleblockFamilyName = symbol?.FamilyName,
                titleblockTypeName = symbol?.Name,
                keywords = kw,
                candidates = ranked,
                ok = ranked.Count > 0
            });
        }
    }
}

