using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class DatumsHandler : IRequestHandler
    {
        public sealed class Point3
        {
            public double x { get; set; }
            public double y { get; set; }
            public double? z { get; set; }
        }

        public sealed class Params
        {
            public string? action { get; set; } // list|get|set_scope_box|clear_scope_box|set_bubble_visibility|create_grid|create_level
            public long? viewId { get; set; }
            public string? datumType { get; set; } // grid|level|all
            public long[]? datumIds { get; set; }
            public string? nameContains { get; set; }
            public int? max { get; set; }
            public long? scopeBoxId { get; set; }
            public string? scopeBoxName { get; set; }
            public bool? bubbleVisible { get; set; }
            public string? bubbleEnd { get; set; } // start|end|both
            public Point3? p1 { get; set; }
            public Point3? p2 { get; set; }
            public double? elevation { get; set; }
            public string? name { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var action = NormalizeAction(p.action);
            var view = ResolveView(doc, p.viewId);

            if (action == "list" || action == "get")
            {
                return Task.FromResult<object>(BuildListResponse(doc, view, p, action, "Success"));
            }

            if (action == "create_grid" || action == "create_level")
            {
                var createDryRun = p.dryRun ?? false;
                if (createDryRun)
                {
                    return Task.FromResult<object>(new
                    {
                        status = "Dry Run",
                        action,
                        dryRun = true,
                        plan = BuildCreatePlan(p, action)
                    });
                }

                DatumPlane created;
                using (var tx = new Transaction(doc, "Datum Tools"))
                {
                    tx.Start();
                    created = action == "create_grid"
                        ? CreateGrid(doc, p)
                        : CreateLevel(doc, p);
                    tx.Commit();
                }

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    action,
                    dryRun = false,
                    datum = DescribeDatum(doc, view, created)
                });
            }

            var hasExplicitSelector =
                (p.datumIds != null && p.datumIds.Length > 0) ||
                !string.IsNullOrWhiteSpace(p.nameContains) ||
                !string.IsNullOrWhiteSpace(p.datumType) ||
                p.viewId.HasValue;
            if (!hasExplicitSelector)
            {
                throw new InvalidOperationException("datums mutation actions require an explicit selector (datumIds, datumType, nameContains, or viewId).");
            }

            var targets = ResolveDatums(doc, p).ToList();
            if (targets.Count == 0)
            {
                throw new InvalidOperationException("No matching datum elements found.");
            }

            Element? scopeBox = null;
            if (action == "set_scope_box")
            {
                scopeBox = ResolveScopeBox(doc, p.scopeBoxId, p.scopeBoxName);
                if (scopeBox == null)
                {
                    throw new InvalidOperationException("datums.set_scope_box requires scopeBoxId or scopeBoxName matching an existing scope box.");
                }
            }

            if (action == "set_bubble_visibility")
            {
                if (view == null) throw new InvalidOperationException("datums.set_bubble_visibility requires viewId or an active view.");
                if (!p.bubbleVisible.HasValue) throw new InvalidOperationException("datums.set_bubble_visibility requires bubbleVisible.");
            }

            var dryRun = p.dryRun ?? false;
            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    action,
                    dryRun = true,
                    view = view == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(view.Id), name = view.Name },
                    scopeBox = scopeBox == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(scopeBox.Id), name = scopeBox.Name },
                    targetCount = targets.Count,
                    targets = targets
                        .Take(50)
                        .Select(d => DescribeDatum(doc, view, d))
                        .ToArray()
                });
            }

            var changed = 0;
            var unchanged = 0;
            var errors = new List<object>();
            using (var tx = new Transaction(doc, "Datum Tools"))
            {
                tx.Start();

                foreach (var datum in targets)
                {
                    try
                    {
                        var datumChanged = false;
                        switch (action)
                        {
                            case "set_scope_box":
                                if (TrySetScopeBox(datum, scopeBox!.Id)) datumChanged = true;
                                break;
                            case "clear_scope_box":
                                if (TrySetScopeBox(datum, ElementId.InvalidElementId)) datumChanged = true;
                                break;
                            case "set_bubble_visibility":
                            {
                                if (view == null) throw new InvalidOperationException("View is required.");
                                var ends = ResolveBubbleEnds(p.bubbleEnd);
                                foreach (var end in ends)
                                {
                                    if (TrySetBubbleVisibility(datum, view, end, p.bubbleVisible!.Value))
                                    {
                                        datumChanged = true;
                                    }
                                }
                                break;
                            }
                            default:
                                throw new InvalidOperationException("datums.action must be list|get|set_scope_box|clear_scope_box|set_bubble_visibility|create_grid|create_level.");
                        }

                        if (datumChanged) changed++;
                        else unchanged++;
                    }
                    catch (Exception ex)
                    {
                        unchanged++;
                        errors.Add(new { datumId = RevitBridge.Common.ElementIdCompat.GetValue(datum.Id), datumName = datum.Name, error = ex.Message });
                    }
                }

                tx.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                action,
                dryRun = false,
                view = view == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(view.Id), name = view.Name },
                scopeBox = scopeBox == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(scopeBox.Id), name = scopeBox.Name },
                summary = new
                {
                    requested = targets.Count,
                    changed,
                    unchanged,
                    errorCount = errors.Count
                },
                errors = errors.Take(50).ToArray(),
                datums = targets.Take(100).Select(d => DescribeDatum(doc, view, d)).ToArray()
            });
        }

        private static object BuildListResponse(Document doc, View? view, Params p, string action, string status)
        {
            var datums = ResolveDatums(doc, p).ToList();
            return new
            {
                status,
                action,
                view = view == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(view.Id), name = view.Name },
                count = datums.Count,
                datums = datums.Select(d => DescribeDatum(doc, view, d)).ToArray()
            };
        }

        private static object BuildCreatePlan(Params p, string action)
        {
            if (action == "create_grid")
            {
                if (p.p1 == null || p.p2 == null)
                {
                    throw new InvalidOperationException("datums.create_grid requires p1 and p2.");
                }

                var p1 = ToXyz(p.p1);
                var p2 = ToXyz(p.p2);
                if (p1.DistanceTo(p2) < 1e-6)
                {
                    throw new InvalidOperationException("datums.create_grid requires distinct p1 and p2.");
                }

                return new
                {
                    kind = "grid",
                    p1 = new { x = p.p1.x, y = p.p1.y, z = p.p1.z },
                    p2 = new { x = p.p2.x, y = p.p2.y, z = p.p2.z },
                    name = string.IsNullOrWhiteSpace(p.name) ? null : p.name.Trim()
                };
            }

            if (action == "create_level")
            {
                if (!p.elevation.HasValue)
                {
                    throw new InvalidOperationException("datums.create_level requires elevation.");
                }

                return new
                {
                    kind = "level",
                    elevation = p.elevation.Value,
                    name = string.IsNullOrWhiteSpace(p.name) ? null : p.name.Trim()
                };
            }

            throw new InvalidOperationException("Unsupported datum create action.");
        }

        private static Grid CreateGrid(Document doc, Params p)
        {
            if (p.p1 == null || p.p2 == null)
            {
                throw new InvalidOperationException("datums.create_grid requires p1 and p2.");
            }

            var start = ToXyz(p.p1);
            var end = ToXyz(p.p2);
            if (start.DistanceTo(end) < 1e-6)
            {
                throw new InvalidOperationException("datums.create_grid requires distinct p1 and p2.");
            }

            var line = Line.CreateBound(start, end);
            var grid = Grid.Create(doc, line);
            var name = (p.name ?? "").Trim();
            if (name.Length > 0)
            {
                grid.Name = name;
            }

            return grid;
        }

        private static Level CreateLevel(Document doc, Params p)
        {
            if (!p.elevation.HasValue)
            {
                throw new InvalidOperationException("datums.create_level requires elevation.");
            }

            var level = Level.Create(doc, p.elevation.Value);
            var name = (p.name ?? "").Trim();
            if (name.Length > 0)
            {
                level.Name = name;
            }

            return level;
        }

        private static XYZ ToXyz(Point3 p)
        {
            return new XYZ(p.x, p.y, p.z ?? 0.0);
        }

        private static IEnumerable<DatumPlane> ResolveDatums(Document doc, Params p)
        {
            var results = new List<DatumPlane>();
            if (p.datumIds != null && p.datumIds.Length > 0)
            {
                foreach (var id in p.datumIds.Where(x => x > 0))
                {
                    var datum = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id)) as DatumPlane;
                    if (datum != null) results.Add(datum);
                }
            }
            else
            {
                var kind = (p.datumType ?? "").Trim().ToLowerInvariant();
                var wantGrids = kind.Length == 0 || kind == "all" || kind == "any" || kind == "grid" || kind == "grids";
                var wantLevels = kind.Length == 0 || kind == "all" || kind == "any" || kind == "level" || kind == "levels";

                if (wantGrids)
                {
                    results.AddRange(new FilteredElementCollector(doc)
                        .OfClass(typeof(Grid))
                        .Cast<DatumPlane>());
                }

                if (wantLevels)
                {
                    results.AddRange(new FilteredElementCollector(doc)
                        .OfClass(typeof(Level))
                        .Cast<DatumPlane>());
                }
            }

            var nameFilter = (p.nameContains ?? "").Trim();
            if (nameFilter.Length > 0)
            {
                results = results
                    .Where(d => (d.Name ?? "").IndexOf(nameFilter, StringComparison.OrdinalIgnoreCase) >= 0)
                    .ToList();
            }

            var max = p.max ?? 200;
            if (max < 1) max = 1;
            if (max > 1000) max = 1000;

            return results
                .GroupBy(d => RevitBridge.Common.ElementIdCompat.GetValue(d.Id))
                .Select(g => g.First())
                .OrderBy(d => d.Name ?? "", StringComparer.OrdinalIgnoreCase)
                .ThenBy(d => RevitBridge.Common.ElementIdCompat.GetValue(d.Id))
                .Take(max);
        }

        private static object DescribeDatum(Document doc, View? view, DatumPlane datum)
        {
            var scopeBox = TryGetScopeBox(doc, datum);
            bool? bubbleStart = null;
            bool? bubbleEnd = null;
            if (view != null)
            {
                bubbleStart = TryGetBubbleVisibility(datum, view, DatumEnds.End0);
                bubbleEnd = TryGetBubbleVisibility(datum, view, DatumEnds.End1);
            }

            return new
            {
                id = RevitBridge.Common.ElementIdCompat.GetValue(datum.Id),
                datumType = datum is Grid ? "Grid" : datum is Level ? "Level" : datum.GetType().Name,
                name = datum.Name,
                scopeBoxId = RevitBridge.Common.ElementIdCompat.GetValue(scopeBox?.Id),
                scopeBoxName = scopeBox?.Name,
                bubbleStartVisible = bubbleStart,
                bubbleEndVisible = bubbleEnd
            };
        }

        private static Element? TryGetScopeBox(Document doc, DatumPlane datum)
        {
            try
            {
                var p = datum.get_Parameter(BuiltInParameter.DATUM_VOLUME_OF_INTEREST);
                if (p == null || p.StorageType != StorageType.ElementId) return null;
                var id = p.AsElementId();
                if (id == null || id == ElementId.InvalidElementId) return null;
                return doc.GetElement(id);
            }
            catch
            {
                return null;
            }
        }

        private static bool TrySetScopeBox(DatumPlane datum, ElementId scopeBoxId)
        {
            var p = datum.get_Parameter(BuiltInParameter.DATUM_VOLUME_OF_INTEREST);
            if (p == null || p.IsReadOnly || p.StorageType != StorageType.ElementId) return false;
            var current = p.AsElementId();
            if (current != null && current == scopeBoxId) return false;
            return p.Set(scopeBoxId);
        }

        private static bool TrySetBubbleVisibility(DatumPlane datum, View view, DatumEnds end, bool visible)
        {
            bool currentlyVisible;
            try
            {
                currentlyVisible = datum.IsBubbleVisibleInView(end, view);
            }
            catch
            {
                currentlyVisible = !visible;
            }

            if (currentlyVisible == visible) return false;

            if (visible)
            {
                datum.ShowBubbleInView(end, view);
            }
            else
            {
                datum.HideBubbleInView(end, view);
            }
            return true;
        }

        private static bool? TryGetBubbleVisibility(DatumPlane datum, View view, DatumEnds end)
        {
            try
            {
                return datum.IsBubbleVisibleInView(end, view);
            }
            catch
            {
                return null;
            }
        }

        private static Element? ResolveScopeBox(Document doc, long? scopeBoxId, string? scopeBoxName)
        {
            if (scopeBoxId.HasValue && scopeBoxId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(scopeBoxId.Value));
            }

            var name = (scopeBoxName ?? "").Trim();
            if (name.Length == 0) return null;

            try
            {
                return new FilteredElementCollector(doc)
                    .OfCategory(BuiltInCategory.OST_VolumeOfInterest)
                    .WhereElementIsNotElementType()
                    .FirstOrDefault(e => (e.Name ?? "").Trim().Equals(name, StringComparison.OrdinalIgnoreCase));
            }
            catch
            {
                return null;
            }
        }

        private static IEnumerable<DatumEnds> ResolveBubbleEnds(string? raw)
        {
            var key = (raw ?? "both").Trim().ToLowerInvariant();
            return key switch
            {
                "" => new[] { DatumEnds.End0, DatumEnds.End1 },
                "both" => new[] { DatumEnds.End0, DatumEnds.End1 },
                "start" => new[] { DatumEnds.End0 },
                "end0" => new[] { DatumEnds.End0 },
                "end" => new[] { DatumEnds.End1 },
                "end1" => new[] { DatumEnds.End1 },
                _ => throw new InvalidOperationException("datums.bubbleEnd must be start|end|both.")
            };
        }

        private static View? ResolveView(Document doc, long? viewId)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
            }

            return doc.ActiveView;
        }

        private static string NormalizeAction(string? raw)
        {
            var action = (raw ?? "list").Trim().ToLowerInvariant();
            if (action == "get") return "list";
            return action;
        }
    }
}
