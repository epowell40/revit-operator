using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class TraceConnectedNetworkHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long startElementId { get; set; }

            // Optional filter: only include/traverse elements that match this system name.
            // If omitted and inferSystemFromStart=true, we will attempt to infer from the start element.
            public string? systemName { get; set; }
            public bool inferSystemFromStart { get; set; } = true;

            // Traversal controls (best-effort). These help isolate a run without walking far into branches/transitions.
            public bool stopAtBranchFittings { get; set; } = false;
            public bool stopAtTransitions { get; set; } = false;
            public int? maxHops { get; set; } // null/<=0 means unlimited
            public List<long>? excludeElementIds { get; set; }
            public List<long>? stopAtElementIds { get; set; }
            public List<string>? stopAtCategories { get; set; } // BuiltInCategory tokens or aliases (e.g. "duct_terminals")

            // Output inclusion flags (traversal is always through connected elements; these affect output sets).
            public bool includeDucts { get; set; } = true;
            public bool includeFittings { get; set; } = true;
            public bool includeAccessories { get; set; } = true;
            public bool includeTerminals { get; set; } = true;
            public bool includeEquipment { get; set; } = true;
            public bool includeOtherCategories { get; set; } = false;

            public int maxElements { get; set; } = 5000;

            // Optional audit: compare connected ids vs all elements that claim membership in the same system name.
            // This helps detect continuity breaks after resizing/transitions.
            public bool includeSystemAudit { get; set; } = false;
            public int systemAuditMaxElements { get; set; } = 20000;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.startElementId <= 0) throw new ArgumentException("startElementId is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var start = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.startElementId));
            if (start == null) throw new InvalidOperationException($"Element {p.startElementId} not found.");

            var warnings = new List<string>();
            var systemFilter = (p.systemName ?? "").Trim();
            string? inferredSystem = null;
            if (systemFilter.Length == 0 && p.inferSystemFromStart)
            {
                inferredSystem = MepSystemUtil.TryGetSystemName(start);
                if (!string.IsNullOrWhiteSpace(inferredSystem)) systemFilter = inferredSystem!;
            }

            try
            {
                if (!MepSystemUtil.GetConnectors(start).Any())
                {
                    warnings.Add("Start element has no connectors. Try starting from a duct/fitting/terminal that is definitely connected.");
                }
            }
            catch
            {
                // ignore
            }

            var max = p.maxElements <= 0 ? 5000 : Math.Min(p.maxElements, 50000);
            var maxHops = p.maxHops.HasValue && p.maxHops.Value > 0 ? Math.Min(p.maxHops.Value, 5000) : (int?)null;

            var exclude = new HashSet<long>((p.excludeElementIds ?? new List<long>()).Where(x => x > 0));
            var stopAt = new HashSet<long>((p.stopAtElementIds ?? new List<long>()).Where(x => x > 0));

            var stopCats = new List<BuiltInCategory>();
            var unknownStopCats = new List<string>();
            BuiltInCategoryTokenUtil.ParseMany(p.stopAtCategories, stopCats, unknownStopCats);
            if (unknownStopCats.Count > 0) warnings.Add($"Unknown stopAtCategories ignored: {string.Join(", ", unknownStopCats)}");
            var stopCatIds = new HashSet<long>(stopCats.Select(x => (long)(int)x));

            var visited = new HashSet<int>();
            var queue = new Queue<(ElementId id, int depth)>();
            queue.Enqueue((start.Id, 0));

            var included = new List<object>();
            var orderedIncludedIds = new List<long>();
            var byCategory = new Dictionary<string, List<long>>(StringComparer.OrdinalIgnoreCase);
            var edges = new List<object>();

            while (queue.Count > 0 && visited.Count < max)
            {
                var item = queue.Dequeue();
                var id = item.id;
                var depth = item.depth;
                if (id == null) continue;
                if (!visited.Add(id.IntegerValue)) continue;
                if (exclude.Contains(RevitBridge.Common.ElementIdCompat.GetValue(id))) continue;

                var e = doc.GetElement(id);
                if (e == null) continue;

                var sysName = MepSystemUtil.TryGetSystemName(e);
                // System filter is best-effort. Many elements (especially equipment/accessories) may not expose
                // a system name parameter even when connected. Only prune when we have a non-empty system name.
                if (systemFilter.Length > 0 && !string.IsNullOrWhiteSpace(sysName) && !MepSystemUtil.SystemNameMatches(sysName, systemFilter))
                {
                    // Do not traverse into other systems.
                    continue;
                }

                var catId = RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id);
                var isBoundary =
                    stopAt.Contains(RevitBridge.Common.ElementIdCompat.GetValue(e.Id)) ||
                    (catId != 0 && stopCatIds.Contains(catId)) ||
                    (p.stopAtBranchFittings && IsBranchFitting(e)) ||
                    (p.stopAtTransitions && IsTransitionFitting(e));

                var allowTraverseFurther = !isBoundary && (!maxHops.HasValue || depth < maxHops.Value);
                foreach (var nextId in MepSystemUtil.GetConnectedOwnerElementIds(e))
                {
                    if (exclude.Contains(RevitBridge.Common.ElementIdCompat.GetValue(nextId))) continue;

                    // Record edges best-effort (small cap to avoid huge payloads).
                    if (edges.Count < 20000)
                    {
                        edges.Add(new { fromId = RevitBridge.Common.ElementIdCompat.GetValue(e.Id), toId = RevitBridge.Common.ElementIdCompat.GetValue(nextId) });
                    }

                    if (!allowTraverseFurther) continue;
                    if (!visited.Contains(nextId.IntegerValue))
                    {
                        queue.Enqueue((nextId, depth + 1));
                    }
                }

                if (ShouldIncludeInOutput(e, p))
                {
                    var catToken = SelectionUtil.GetCategoryToken(e) ?? (e.Category?.Name ?? "None");

                    orderedIncludedIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(e.Id));
                    if (!byCategory.TryGetValue(catToken, out var list))
                    {
                        list = new List<long>();
                        byCategory[catToken] = list;
                    }
                    list.Add(RevitBridge.Common.ElementIdCompat.GetValue(e.Id));

                    included.Add(new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                        category = catToken,
                        name = e.Name,
                        systemName = sysName
                    });
                }
            }

            if (visited.Count >= max)
            {
                warnings.Add($"Traversal reached maxElements={max}; results may be truncated.");
            }

            object? systemAudit = null;
            if (p.includeSystemAudit)
            {
                if (systemFilter.Length == 0)
                {
                    warnings.Add("includeSystemAudit requested but systemName is empty (could not infer). System audit skipped.");
                }
                else
                {
                    var sysMax = p.systemAuditMaxElements <= 0 ? 20000 : Math.Min(p.systemAuditMaxElements, 100000);
                    var systemIds = GetSystemElementIdsByName(doc, systemFilter, sysMax);
                    if (systemIds.Count >= sysMax) warnings.Add($"System audit reached systemAuditMaxElements={sysMax}; results may be truncated.");

                    var connected = new HashSet<long>(visited.Select(x => (long)x));
                    var disconnected = systemIds.Where(id => !connected.Contains(id)).ToList();

                    systemAudit = new
                    {
                        systemName = systemFilter,
                        systemElementIds = systemIds,
                        systemCount = systemIds.Count,
                        connectedCount = systemIds.Count - disconnected.Count,
                        disconnectedIds = disconnected,
                        disconnectedCount = disconnected.Count,
                        pass = disconnected.Count == 0
                    };
                }
            }

            return Task.FromResult<object>(new
            {
                status = "Ok",
                startElementId = p.startElementId,
                systemName = systemFilter.Length > 0 ? systemFilter : null,
                inferredSystemName = inferredSystem,
                traversal = new
                {
                    stopAtBranchFittings = p.stopAtBranchFittings,
                    stopAtTransitions = p.stopAtTransitions,
                    maxHops,
                    excludeCount = exclude.Count,
                    stopAtElementIdsCount = stopAt.Count,
                    stopAtCategories = stopCats.Select(x => x.ToString()).Distinct().ToList()
                },
                maxElements = max,
                visitedCount = visited.Count,
                includedCount = orderedIncludedIds.Count,
                elementIdsOrdered = orderedIncludedIds,
                elementIdsByCategory = byCategory.ToDictionary(kv => kv.Key, kv => kv.Value),
                elements = included,
                edges,
                systemAudit,
                warnings
            });
        }

        private static List<long> GetSystemElementIdsByName(Document doc, string systemName, int max)
        {
            var sys = (systemName ?? "").Trim();
            var outIds = new HashSet<long>();
            if (sys.Length == 0) return new List<long>();

            var cats = new[]
            {
                BuiltInCategory.OST_DuctCurves,
                BuiltInCategory.OST_DuctFitting,
                BuiltInCategory.OST_DuctAccessory,
                BuiltInCategory.OST_DuctTerminal,
                BuiltInCategory.OST_MechanicalEquipment
            };

            foreach (var bic in cats)
            {
                if (outIds.Count >= max) break;
                try
                {
                    var col = new FilteredElementCollector(doc)
                        .OfCategory(bic)
                        .WhereElementIsNotElementType();

                    foreach (var e in col)
                    {
                        if (e == null) continue;
                        if (outIds.Count >= max) break;
                        var sn = MepSystemUtil.TryGetSystemName(e);
                        if (!MepSystemUtil.SystemNameMatches(sn, sys)) continue;
                        outIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(e.Id));
                    }
                }
                catch
                {
                    // ignore collector failures per category
                }
            }

            return outIds.ToList();
        }

        private static bool ShouldIncludeInOutput(Element e, Params p)
        {
            if (e == null) return false;

            try
            {
                var catId = RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id);
                if (catId == 0) return p.includeOtherCategories;
                if (catId == (int)BuiltInCategory.OST_DuctCurves) return p.includeDucts;
                if (catId == (int)BuiltInCategory.OST_DuctFitting) return p.includeFittings;
                if (catId == (int)BuiltInCategory.OST_DuctAccessory) return p.includeAccessories;
                if (catId == (int)BuiltInCategory.OST_DuctTerminal) return p.includeTerminals;
                if (catId == (int)BuiltInCategory.OST_MechanicalEquipment) return p.includeEquipment;

                return p.includeOtherCategories;
            }
            catch
            {
                return p.includeOtherCategories;
            }
        }

        private static bool IsBranchFitting(Element e)
        {
            try
            {
                var catId = RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id);
                if (catId != (int)BuiltInCategory.OST_DuctFitting) return false;
                var count = 0;
                foreach (var _ in MepSystemUtil.GetConnectors(e))
                {
                    count++;
                    if (count >= 3) return true;
                }
            }
            catch { }
            return false;
        }

        private static bool IsTransitionFitting(Element e)
        {
            try
            {
                var catId = RevitBridge.Common.ElementIdCompat.GetValue(e.Category?.Id);
                if (catId != (int)BuiltInCategory.OST_DuctFitting) return false;

                var sizes = new List<string>();
                foreach (var c in MepSystemUtil.GetConnectors(e))
                {
                    if (c == null) continue;
                    if (c.Shape == Autodesk.Revit.DB.ConnectorProfileType.Round)
                    {
                        var d = 2.0 * c.Radius;
                        sizes.Add("r:" + d.ToString("G6"));
                    }
                    else if (c.Shape == Autodesk.Revit.DB.ConnectorProfileType.Rectangular)
                    {
                        sizes.Add("x:" + c.Width.ToString("G6") + "x" + c.Height.ToString("G6"));
                    }
                }

                // Transition: two connectors with different sizes (best-effort).
                var distinct = sizes.Distinct().Take(3).ToList();
                return distinct.Count >= 2;
            }
            catch { }
            return false;
        }
    }
}
