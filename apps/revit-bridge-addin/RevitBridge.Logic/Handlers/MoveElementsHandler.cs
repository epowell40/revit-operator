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
    public class MoveElementsHandler : IRequestHandler
    {
        public sealed class Options
        {
            public bool failOnPinned { get; set; } = true;
            public bool unpinIfAllowed { get; set; } = false;
        }

        public sealed class Params
        {
            public List<long> ids { get; set; } = new List<long>();
            public string mode { get; set; } = "vector"; // vector | fromTo

            // vector
            public double vectorX { get; set; }
            public double vectorY { get; set; }
            public double vectorZ { get; set; }

            // fromTo
            public double fromX { get; set; }
            public double fromY { get; set; }
            public double fromZ { get; set; }
            public double toX { get; set; }
            public double toY { get; set; }
            public double toZ { get; set; }

            public bool dryRun { get; set; } = true;
            public string? behavior { get; set; } = "allOrNothing"; // allOrNothing | bestEffort
            public Options? options { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? throw new ArgumentException("Invalid JSON payload.");
            if (p.ids == null || p.ids.Count == 0) throw new ArgumentException("ids must be a non-empty array.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var mode = (p.mode ?? "").Trim();
            if (string.IsNullOrWhiteSpace(mode)) mode = "vector";

            XYZ vector;
            if (string.Equals(mode, "vector", StringComparison.OrdinalIgnoreCase))
            {
                vector = new XYZ(p.vectorX, p.vectorY, p.vectorZ);
            }
            else if (string.Equals(mode, "fromTo", StringComparison.OrdinalIgnoreCase))
            {
                vector = new XYZ(p.toX - p.fromX, p.toY - p.fromY, p.toZ - p.fromZ);
            }
            else
            {
                throw new ArgumentException($"Unsupported mode '{p.mode}'. Supported: vector, fromTo");
            }

            var opts = p.options ?? new Options();
            var bestEffort = string.Equals(p.behavior, "bestEffort", StringComparison.OrdinalIgnoreCase);

            var warnings = new List<string>();
            var movedIds = new List<long>();
            var skipped = new List<object>();
            var snapshots = new List<object>();

            var error = (string?)null;

            using (var t = new Transaction(doc, p.dryRun ? "Move Elements (Dry Run)" : "Move Elements"))
            {
                t.Start();
                try
                {
                    foreach (var id in p.ids.Distinct())
                    {
                        var eid = RevitBridge.Common.ElementIdCompat.Create(id);
                        var e = doc.GetElement(eid);
                        if (e == null)
                        {
                            skipped.Add(new { id, reason = "NotFound" });
                            if (!bestEffort)
                            {
                                throw new Exception($"Element {id} not found.");
                            }
                            continue;
                        }

                        bool wasPinned = false;
                        bool unpinned = false;

                        if (TryIsPinned(e, out var pinned) && pinned)
                        {
                            wasPinned = true;
                            if (opts.unpinIfAllowed)
                            {
                                try
                                {
                                    e.Pinned = false;
                                    unpinned = true;
                                    warnings.Add($"Element {id} was pinned; unpinned for move.");
                                }
                                catch
                                {
                                    if (opts.failOnPinned)
                                    {
                                        skipped.Add(new { id, reason = "Pinned" });
                                        if (!bestEffort)
                                        {
                                            throw new Exception($"Element {id} is pinned.");
                                        }
                                        continue;
                                    }
                                }
                            }
                            else if (opts.failOnPinned)
                            {
                                skipped.Add(new { id, reason = "Pinned" });
                                if (!bestEffort)
                                {
                                    throw new Exception($"Element {id} is pinned.");
                                }
                                continue;
                            }
                        }

                        var before = SnapshotLocation(e);
                        try
                        {
                            ElementTransformUtils.MoveElement(doc, eid, vector);
                        }
                        catch (Exception ex)
                        {
                            skipped.Add(new { id, reason = ex.Message });
                            if (!bestEffort)
                            {
                                throw new Exception($"Move failed for element {id}: {ex.Message}", ex);
                            }
                            continue;
                        }
                        finally
                        {
                            if (!p.dryRun && wasPinned && unpinned)
                            {
                                try { e.Pinned = true; }
                                catch { warnings.Add($"Element {id} was pinned before move but could not be re-pinned."); }
                            }
                        }

                        var after = SnapshotLocation(e);
                        movedIds.Add(id);
                        snapshots.Add(new { id, before, after });

                        TryAddJoinWarning(doc, e, warnings);
                    }

                    if (p.dryRun)
                    {
                        t.RollBack();
                        return Task.FromResult<object>(new
                        {
                            status = "Dry Run",
                            movedIds,
                            skipped,
                            warnings,
                            snapshots,
                            rolledBack = true
                        });
                    }

                    if (!bestEffort && skipped.Count > 0)
                    {
                        // All-or-nothing: treat any skip as failure.
                        t.RollBack();
                        return Task.FromResult<object>(new
                        {
                            status = "Failed",
                            movedIds,
                            skipped,
                            warnings,
                            snapshots,
                            rolledBack = true,
                            error = "allOrNothing: move rolled back due to failures."
                        });
                    }

                    t.Commit();
                    return Task.FromResult<object>(new
                    {
                        status = "Moved",
                        movedIds,
                        skipped,
                        warnings,
                        snapshots,
                        rolledBack = false
                    });
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                    try { t.RollBack(); } catch { }
                }
            }

            return Task.FromResult<object>(new
            {
                status = p.dryRun ? "Dry Run" : "Failed",
                movedIds,
                skipped,
                warnings,
                snapshots,
                rolledBack = true,
                error
            });
        }

        private static bool TryIsPinned(Element e, out bool pinned)
        {
            pinned = false;
            try
            {
                pinned = e.Pinned;
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static object SnapshotLocation(Element e)
        {
            try
            {
                if (e.Location is LocationPoint lp)
                {
                    var pt = lp.Point;
                    return new
                    {
                        kind = "LocationPoint",
                        pointXyz = new[] { pt.X, pt.Y, pt.Z }
                    };
                }

                if (e.Location is LocationCurve lc)
                {
                    var c = lc.Curve;
                    var p0 = c.GetEndPoint(0);
                    var p1 = c.GetEndPoint(1);
                    return new
                    {
                        kind = "LocationCurve",
                        startXyz = new[] { p0.X, p0.Y, p0.Z },
                        endXyz = new[] { p1.X, p1.Y, p1.Z }
                    };
                }
            }
            catch
            {
                // fall back to bbox
            }

            try
            {
                var bb = e.get_BoundingBox(null);
                if (bb != null)
                {
                    var c = (bb.Min + bb.Max) * 0.5;
                    return new
                    {
                        kind = "BboxCenter",
                        centerXyz = new[] { c.X, c.Y, c.Z }
                    };
                }
            }
            catch { }

            return new { kind = "Unknown" };
        }

        private static void TryAddJoinWarning(Document doc, Element e, List<string> warnings)
        {
            try
            {
                if (e is not Wall) return;
                var joined = JoinGeometryUtils.GetJoinedElements(doc, e);
                if (joined == null) return;
                var count = joined.Count;
                if (count > 0) warnings.Add($"Wall {RevitBridge.Common.ElementIdCompat.GetValue(e.Id)} is joined to {count} element(s); geometry may update.");
            }
            catch
            {
                // ignore
            }
        }
    }
}
