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
    public sealed class TitleblockLabelMapHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sheetNumber { get; set; }
            public long? sheetViewId { get; set; }
            public long? titleBlockElementId { get; set; }

            public bool includeParameters { get; set; } = true;
            public bool includeHeuristics { get; set; } = true;
        }

        private sealed class Box2
        {
            public double cx;
            public double cy;
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
            var symbol = titleblock.Symbol;
            if (symbol == null) throw new InvalidOperationException("Titleblock type not found.");

            sheet ??= doc.GetElement(titleblock.OwnerViewId) as ViewSheet;

            var mappings = new List<object>();
            var warnings = new List<string>();

            Document? famDoc = null;
            try
            {
                famDoc = doc.EditFamily(symbol.Family);
                if (famDoc == null) throw new InvalidOperationException("Failed to open titleblock family document.");

                var famParamById = new Dictionary<long, string>();
                try
                {
                    foreach (FamilyParameter fp in famDoc.FamilyManager.Parameters)
                    {
                        try
                        {
                            var idv = RevitBridge.Common.ElementIdCompat.GetValue(fp?.Id);
                            if (idv <= 0) continue;
                            var name = (fp.Definition?.Name ?? "").Trim();
                            if (!string.IsNullOrWhiteSpace(name) && !famParamById.ContainsKey(idv)) famParamById[idv] = name;
                        }
                        catch { }
                    }
                }
                catch
                {
                    warnings.Add("Could not read FamilyManager.Parameters for titleblock family; label drivers may be incomplete.");
                }

                var all = new FilteredElementCollector(famDoc).WhereElementIsNotElementType().ToElements();

                var textNotes = new List<(TextNote tn, string text, Box2 box)>();
                foreach (var e in all)
                {
                    if (e is TextNote tn)
                    {
                        var t = (tn.Text ?? "").Trim();
                        if (string.IsNullOrWhiteSpace(t)) continue;
                        if (t.Length > 80) continue;
                        var bb = tn.get_BoundingBox(null);
                        if (bb == null) continue;
                        textNotes.Add((tn, t, new Box2 { cx = (bb.Min.X + bb.Max.X) * 0.5, cy = (bb.Min.Y + bb.Max.Y) * 0.5 }));
                    }
                }

                var labelEls = new List<(Element el, Box2 box, string? driverParamName)>();
                foreach (var e in all)
                {
                    try
                    {
                        var typeName = e.GetType().Name ?? "";
                        if (!string.Equals(typeName, "Label", StringComparison.OrdinalIgnoreCase) &&
                            !typeName.EndsWith("Label", StringComparison.OrdinalIgnoreCase))
                            continue;

                        var bb = e.get_BoundingBox(null);
                        if (bb == null) continue;
                        var box = new Box2 { cx = (bb.Min.X + bb.Max.X) * 0.5, cy = (bb.Min.Y + bb.Max.Y) * 0.5 };

                        string? driver = null;
                        try
                        {
                            foreach (var pr in e.GetOrderedParameters())
                            {
                                if (pr == null) continue;
                                if (pr.StorageType != StorageType.ElementId) continue;
                                var id = pr.AsElementId();
                                if (id == null || id == ElementId.InvalidElementId) continue;
                                if (famParamById.TryGetValue(RevitBridge.Common.ElementIdCompat.GetValue(id), out var nm))
                                {
                                    driver = nm;
                                    break;
                                }
                            }
                        }
                        catch { }

                        labelEls.Add((e, box, driver));
                    }
                    catch { }
                }

                // Heuristic: treat each short text note as a "caption" (e.g., "Date") and pair it with the nearest "value"
                // to the right: prefer parameter-driven label; otherwise a static text note.
                foreach (var cap in textNotes)
                {
                    var capText = cap.text;
                    string? bestDriver = null;
                    var bestDriverScore = double.MaxValue;
                    string? bestStatic = null;
                    var bestStaticScore = double.MaxValue;

                    foreach (var lab in labelEls)
                    {
                        var dx = lab.box.cx - cap.box.cx;
                        if (dx <= 0) continue; // prefer value label to the right
                        var dy = Math.Abs(lab.box.cy - cap.box.cy);

                        // Conservative gate to avoid weird matches.
                        if (dy > 0.5) continue;

                        var score = dx + dy * 0.5;
                        if (score < bestDriverScore)
                        {
                            bestDriverScore = score;
                            bestDriver = lab.driverParamName;
                        }
                    }

                    foreach (var tn in textNotes)
                    {
                        if (ReferenceEquals(tn.tn, cap.tn)) continue;
                        var dx = tn.box.cx - cap.box.cx;
                        if (dx <= 0) continue;
                        var dy = Math.Abs(tn.box.cy - cap.box.cy);
                        if (dy > 0.5) continue;
                        var score = dx + dy * 0.5;
                        if (score < bestStaticScore)
                        {
                            bestStaticScore = score;
                            bestStatic = tn.text;
                        }
                    }

                    var kind = bestDriver != null ? "parameter" : bestStatic != null ? "static_text" : "unknown";
                    mappings.Add(new
                    {
                        label_text = capText,
                        driver_parameter = bestDriver,
                        driver_kind = kind,
                        static_text = kind == "static_text" ? bestStatic : null,
                        notes = kind == "unknown" ? "No parameter driver detected; value may be static text or heuristic match failed." : null
                    });
                }
            }
            finally
            {
                try { famDoc?.Close(false); } catch { }
            }

            object? paramGroups = null;
            object? hints = null;

            if (p.includeParameters)
            {
                var groups = new Dictionary<string, object>();

                try
                {
                    if (sheet != null)
                    {
                        groups["sheet"] = SnapshotParameters(sheet);
                    }
                }
                catch { }

                try
                {
                    groups["project_information"] = doc.ProjectInformation != null ? SnapshotParameters(doc.ProjectInformation) : new List<object>();
                }
                catch { groups["project_information"] = new List<object>(); }

                try { groups["titleblock_instance"] = SnapshotParameters(titleblock); } catch { }
                try { groups["titleblock_type"] = symbol != null ? SnapshotParameters(symbol) : new List<object>(); } catch { }

                paramGroups = groups;

                if (p.includeHeuristics)
                {
                    try
                    {
                        var dateLike = new List<object>();
                        foreach (var g in groups)
                        {
                            if (!(g.Value is IEnumerable<object> rows)) continue;
                            foreach (var row in rows)
                            {
                                if (row == null) continue;
                                var json = JsonSerializer.Serialize(row);
                                if (json.IndexOf("date", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                    json.IndexOf("issue", StringComparison.OrdinalIgnoreCase) >= 0)
                                {
                                    dateLike.Add(new { group = g.Key, parameter = row });
                                }
                            }
                        }
                        hints = new { likely_date_parameters = dateLike.Take(30).ToList() };
                    }
                    catch { hints = null; }
                }
            }

            return Task.FromResult<object>(new
            {
                sheetNumber = sheet?.SheetNumber,
                sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet?.Id),
                titleBlockElementId = RevitBridge.Common.ElementIdCompat.GetValue(titleblock.Id),
                titleBlockTypeName = symbol.Name,
                titleBlockFamilyName = symbol.FamilyName,
                mappings,
                parameter_groups = paramGroups,
                hints,
                warnings = warnings.Count > 0 ? warnings : null
            });
        }

        private static List<object> SnapshotParameters(Element el)
        {
            var outList = new List<object>();
            if (el == null) return outList;

            IList<Parameter> pars;
            try { pars = el.GetOrderedParameters(); }
            catch { return outList; }

            foreach (var p in pars)
            {
                if (p == null) continue;
                var name = (p.Definition?.Name ?? "").Trim();
                if (string.IsNullOrWhiteSpace(name)) continue;
                outList.Add(new
                {
                    name,
                    storageType = p.StorageType.ToString(),
                    isReadOnly = p.IsReadOnly,
                    value = ParameterValueUtil.SnapshotForWire(p)
                });
            }
            return outList;
        }
    }
}
