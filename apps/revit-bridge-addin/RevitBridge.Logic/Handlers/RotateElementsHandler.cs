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
    public class RotateElementsHandler : IRequestHandler
    {
        public sealed class Options
        {
            public bool failOnPinned { get; set; } = true;
            public bool unpinIfAllowed { get; set; } = false;
        }

        public sealed class Axis
        {
            // zThroughPoint uses pointX/Y/Z and an implicit +Z direction.
            // throughPoints uses pointX/Y/Z plus endPointX/Y/Z.
            public string mode { get; set; } = "zThroughPoint";
            public double pointX { get; set; }
            public double pointY { get; set; }
            public double pointZ { get; set; }
            public double endPointX { get; set; }
            public double endPointY { get; set; }
            public double endPointZ { get; set; }
        }

        public sealed class Params
        {
            public List<long> ids { get; set; } = new List<long>();
            public double angleDegrees { get; set; }
            public Axis? axis { get; set; }
            public bool dryRun { get; set; } = true;
            public string? behavior { get; set; } = "allOrNothing"; // allOrNothing | bestEffort
            public Options? options { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? throw new ArgumentException("Invalid JSON payload.");
            if (p.ids == null || p.ids.Count == 0) throw new ArgumentException("ids must be a non-empty array.");
            if (p.axis == null) throw new ArgumentException("axis is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var bestEffort = string.Equals(p.behavior, "bestEffort", StringComparison.OrdinalIgnoreCase);
            var opts = p.options ?? new Options();

            var axisMode = (p.axis.mode ?? "").Trim();
            if (string.IsNullOrWhiteSpace(axisMode)) axisMode = "zThroughPoint";

            var axisPoint = new XYZ(p.axis.pointX, p.axis.pointY, p.axis.pointZ);
            XYZ axisEndPoint;
            if (string.Equals(axisMode, "zThroughPoint", StringComparison.OrdinalIgnoreCase))
            {
                axisEndPoint = axisPoint + XYZ.BasisZ;
            }
            else if (string.Equals(axisMode, "throughPoints", StringComparison.OrdinalIgnoreCase))
            {
                axisEndPoint = new XYZ(p.axis.endPointX, p.axis.endPointY, p.axis.endPointZ);
                if (axisPoint.DistanceTo(axisEndPoint) < 1e-9)
                {
                    throw new ArgumentException("axis throughPoints requires two distinct points.");
                }
            }
            else
            {
                throw new ArgumentException($"Unsupported axis.mode '{p.axis.mode}'. Supported: zThroughPoint, throughPoints");
            }

            var axisLine = Line.CreateBound(axisPoint, axisEndPoint);
            var angleRadians = p.angleDegrees * (Math.PI / 180.0);

            var warnings = new List<string>();
            var rotatedIds = new List<long>();
            var skipped = new List<object>();
            var snapshots = new List<object>();
            var error = (string?)null;

            using (var t = new Transaction(doc, p.dryRun ? "Rotate Elements (Dry Run)" : "Rotate Elements"))
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
                            if (!bestEffort) throw new Exception($"Element {id} not found.");
                            continue;
                        }

                        if (e is ElementType)
                        {
                            skipped.Add(new { id, reason = "ElementTypeNotSupported" });
                            if (!bestEffort) throw new Exception($"Element {id} is an element type and cannot be rotated.");
                            continue;
                        }

                        if (e.GroupId != ElementId.InvalidElementId)
                        {
                            skipped.Add(new { id, reason = "InGroup" });
                            if (!bestEffort) throw new Exception($"Element {id} is in a group and cannot be rotated as an individual element.");
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
                                    warnings.Add($"Element {id} was pinned; unpinned for rotate.");
                                }
                                catch
                                {
                                    if (opts.failOnPinned)
                                    {
                                        skipped.Add(new { id, reason = "Pinned" });
                                        if (!bestEffort) throw new Exception($"Element {id} is pinned.");
                                        continue;
                                    }
                                }
                            }
                            else if (opts.failOnPinned)
                            {
                                skipped.Add(new { id, reason = "Pinned" });
                                if (!bestEffort) throw new Exception($"Element {id} is pinned.");
                                continue;
                            }
                        }

                        var before = SnapshotLocation(e);
                        try
                        {
                            ElementTransformUtils.RotateElement(doc, eid, axisLine, angleRadians);
                        }
                        catch (Exception ex)
                        {
                            skipped.Add(new { id, reason = ex.Message });
                            if (!bestEffort) throw new Exception($"Rotate failed for element {id}: {ex.Message}", ex);
                            continue;
                        }
                        finally
                        {
                            if (!p.dryRun && wasPinned && unpinned)
                            {
                                try { e.Pinned = true; }
                                catch { warnings.Add($"Element {id} was pinned before rotate but could not be re-pinned."); }
                            }
                        }

                        var after = SnapshotLocation(e);
                        rotatedIds.Add(id);
                        snapshots.Add(new { id, before, after });

                        TryAddJoinWarning(doc, e, warnings);
                    }

                    if (p.dryRun)
                    {
                        t.RollBack();
                        return Task.FromResult<object>(new
                        {
                            status = "Dry Run",
                            rotatedIds,
                            skipped,
                            warnings,
                            snapshots,
                            rolledBack = true
                        });
                    }

                    if (!bestEffort && skipped.Count > 0)
                    {
                        t.RollBack();
                        return Task.FromResult<object>(new
                        {
                            status = "Failed",
                            rotatedIds,
                            skipped,
                            warnings,
                            snapshots,
                            rolledBack = true,
                            error = "allOrNothing: rotate rolled back due to failures."
                        });
                    }

                    t.Commit();
                    return Task.FromResult<object>(new
                    {
                        status = "Rotated",
                        rotatedIds,
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
                rotatedIds,
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

