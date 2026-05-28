using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class RoomAlignWallToNearestColumnHandler : IRequestHandler
    {
        public sealed class Options
        {
            public bool failOnPinned { get; set; } = true;
            public double minAbsNormalDot { get; set; } = 0.90;
            public double zeroToleranceFt { get; set; } = 1.0 / 192.0; // ~1/16"
            public bool exportPreviewImage { get; set; } = false;
            public int previewImageSize { get; set; } = 2200;
        }

        public sealed class Params
        {
            public string roomNumber { get; set; } = "";
            public string wallSide { get; set; } = "left"; // left|right|top|bottom
            public double columnSearchRadiusFt { get; set; } = 30.0;
            public long? viewId { get; set; }
            public bool dryRun { get; set; } = true;
            public Options? options { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? throw new ArgumentException("Invalid JSON payload.");
            var roomNumber = (p.roomNumber ?? "").Trim();
            if (roomNumber.Length == 0) throw new ArgumentException("roomNumber is required.");

            var side = (p.wallSide ?? "left").Trim().ToLowerInvariant();
            if (side != "left" && side != "right" && side != "top" && side != "bottom")
                throw new ArgumentException("wallSide must be left|right|top|bottom.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var view = ResolveView(doc, uidoc.ActiveView, p.viewId);
            if (view == null) throw new InvalidOperationException("View not found.");

            var room = FindRoomByNumber(doc, roomNumber);
            if (room == null) throw new ArgumentException($"Room '{roomNumber}' not found.");

            var opts = p.options ?? new Options();

            var axisToken = (side == "left" || side == "right") ? "viewX" : "viewY";
            var axis = FaceAlignmentUtil.ResolveAxis(view, axisToken);

            var wallId = PickBoundaryWallId(doc, room, view, side);
            if (wallId == null) throw new InvalidOperationException($"Failed to deterministically select boundary wall for side '{side}' in room '{room.Number}'.");

            var wallEl = doc.GetElement(wallId);
            if (wallEl is not Wall) throw new InvalidOperationException($"Selected boundary element {RevitBridge.Common.ElementIdCompat.GetValue(wallId)} is not a Wall.");

            if (opts.failOnPinned && TryIsPinned(wallEl, out var pinned) && pinned)
                throw new InvalidOperationException($"Wall {RevitBridge.Common.ElementIdCompat.GetValue(wallId)} is pinned.");

            var roomCenter = GetRoomCenter(room, view);

            var columnCandidates = FindColumnsNear(doc, view, roomCenter, Math.Max(0.0, p.columnSearchRadiusFt), out var usedRadiusFallback);
            if (columnCandidates.Count == 0) throw new InvalidOperationException("No columns found in the view (columns may be hidden by view template/filters).");
            if (columnCandidates.Count > 40) columnCandidates = columnCandidates.Take(40).ToList();

            var targetSide = OppositeSide(side);

            // Choose the closest column in the intended direction (if possible), otherwise closest by absolute gap.
            var desiredSign = DesiredGapSign(side); // left/bottom => negative; right/top => positive
            var scored = new List<(ElementId colId, double gapFt, double absGapFt)>();

            if (!FaceAlignmentUtil.TryResolvePlanarFace(doc, wallId, view, axis, axisToken, side, opts.minAbsNormalDot, out var wallFaceForScoring, out var wallFaceErr))
                throw new InvalidOperationException(wallFaceErr ?? "Failed to resolve wall face for scoring.");

            foreach (var colId in columnCandidates)
            {
                if (!FaceAlignmentUtil.TryResolvePlanarFace(doc, colId, view, axis, axisToken, targetSide, opts.minAbsNormalDot, out var colFace, out _))
                    continue;

                var gap = colFace!.PlaneCoordOnAxis - wallFaceForScoring!.PlaneCoordOnAxis;
                scored.Add((colId, gap, Math.Abs(gap)));
            }

            if (scored.Count == 0) throw new InvalidOperationException("No valid column face candidates found for gap measurement (face alignment may be too strict for this view).");

            var directed = scored.Where(s => desiredSign == 0 ? true : Math.Sign(s.gapFt) == desiredSign).OrderBy(s => s.absGapFt).ToList();
            var best = (directed.Count > 0 ? directed[0] : scored.OrderBy(s => s.absGapFt).First());

            var warnings = new List<string>();
            if (usedRadiusFallback)
                warnings.Add("No columns found within the requested radius; fell back to the closest visible columns in the view.");
            if (directed.Count == 0)
                warnings.Add("No column found on the expected side direction; chose closest by absolute gap.");

            // Resolve faces for final computation/labels.
            if (!FaceAlignmentUtil.TryResolvePlanarFace(doc, wallId, view, axis, axisToken, side, opts.minAbsNormalDot, out var wallFaceFinal, out var wallErr))
                throw new InvalidOperationException(wallErr ?? "Failed to resolve wall face.");
            if (!FaceAlignmentUtil.TryResolvePlanarFace(doc, best.colId, view, axis, axisToken, targetSide, opts.minAbsNormalDot, out var colFaceFinal, out var colErr))
                throw new InvalidOperationException(colErr ?? "Failed to resolve column face.");

            var gapBefore = colFaceFinal!.PlaneCoordOnAxis - wallFaceFinal!.PlaneCoordOnAxis;
            var vector = axis.Multiply(gapBefore);

            object snapshotBefore = SnapshotLocation(wallEl);
            object snapshotAfter = snapshotBefore;
            double gapAfter = gapBefore;

            string? previewPath = null;
            int? previewWidth = null;
            int? previewHeight = null;

            var failures = new List<CapturedFailure>();
            string? transactionStatus = null;

            if (p.dryRun)
            {
                using (var tg = new TransactionGroup(doc, "Room Align Wall To Nearest Column (Dry Run)"))
                {
                    tg.Start();

                    using (var t = new Transaction(doc, "Align Wall"))
                    {
                        t.Start();
                        t.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(t, failures, rollbackOnErrors: true, deleteWarnings: false));
                        ElementTransformUtils.MoveElement(doc, wallId, vector);
                        var st = t.Commit();
                        transactionStatus = st.ToString();
                    }

                    snapshotAfter = SnapshotLocation(wallEl);
                    if (FaceAlignmentUtil.TryResolvePlanarFace(doc, wallId, view, axis, axisToken, side, opts.minAbsNormalDot, out var wallAfter, out _))
                        gapAfter = colFaceFinal.PlaneCoordOnAxis - wallAfter!.PlaneCoordOnAxis;

                    if (opts.exportPreviewImage)
                        (previewPath, previewWidth, previewHeight) = ExportPreview(doc, view, wallId, wallFaceFinal.LabelPoint, best.colId, colFaceFinal.LabelPoint, opts.previewImageSize);

                    tg.RollBack();
                }

                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    roomId = RevitBridge.Common.ElementIdCompat.GetValue(room.Id),
                    roomNumber = room.Number,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    wallSide = side,
                    axis = axisToken,
                    chosenWallId = RevitBridge.Common.ElementIdCompat.GetValue(wallId),
                    chosenColumnId = RevitBridge.Common.ElementIdCompat.GetValue(best.colId),
                    vectorXyz = new[] { vector.X, vector.Y, vector.Z },
                    gapBeforeFt = gapBefore,
                    gapAfterFt = gapAfter,
                    withinTolerance = Math.Abs(gapAfter) <= opts.zeroToleranceFt,
                    rolledBack = true,
                    transactionStatus,
                    failures,
                    snapshotBefore,
                    snapshotAfter,
                    preview = previewPath != null ? new { path = previewPath, widthPx = previewWidth, heightPx = previewHeight } : null,
                    warnings
                });
            }

            using (var t = new Transaction(doc, "Room Align Wall To Nearest Column"))
            {
                t.Start();
                t.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(t, failures, rollbackOnErrors: true, deleteWarnings: false));
                ElementTransformUtils.MoveElement(doc, wallId, vector);
                var st = t.Commit();
                transactionStatus = st.ToString();
            }

            snapshotAfter = SnapshotLocation(wallEl);
            if (FaceAlignmentUtil.TryResolvePlanarFace(doc, wallId, view, axis, axisToken, side, opts.minAbsNormalDot, out var wallAfter2, out _))
                gapAfter = colFaceFinal.PlaneCoordOnAxis - wallAfter2!.PlaneCoordOnAxis;

            if (opts.exportPreviewImage)
                (previewPath, previewWidth, previewHeight) = ExportPreview(doc, view, wallId, wallFaceFinal.LabelPoint, best.colId, colFaceFinal.LabelPoint, opts.previewImageSize);

            return Task.FromResult<object>(new
            {
                status = (string.Equals(transactionStatus, "RolledBack", StringComparison.OrdinalIgnoreCase) || FailureHandlingUtil.HasErrors(failures)) ? "Rolled Back" : "Aligned",
                roomId = RevitBridge.Common.ElementIdCompat.GetValue(room.Id),
                roomNumber = room.Number,
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                wallSide = side,
                axis = axisToken,
                chosenWallId = RevitBridge.Common.ElementIdCompat.GetValue(wallId),
                chosenColumnId = RevitBridge.Common.ElementIdCompat.GetValue(best.colId),
                vectorXyz = new[] { vector.X, vector.Y, vector.Z },
                gapBeforeFt = gapBefore,
                gapAfterFt = gapAfter,
                withinTolerance = Math.Abs(gapAfter) <= opts.zeroToleranceFt,
                rolledBack = string.Equals(transactionStatus, "RolledBack", StringComparison.OrdinalIgnoreCase) || FailureHandlingUtil.HasErrors(failures),
                transactionStatus,
                failures,
                snapshotBefore,
                snapshotAfter,
                preview = previewPath != null ? new { path = previewPath, widthPx = previewWidth, heightPx = previewHeight } : null,
                warnings
            });
        }

        private static View? ResolveView(Document doc, View? activeView, long? viewId)
        {
            if (viewId.HasValue && viewId.Value != 0)
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
            return activeView;
        }

        private static string NormalizeNumericRoomNumber(string s)
        {
            if (s == null) return "";
            var t = s.Trim();
            if (t.Length == 0) return "";
            for (int i = 0; i < t.Length; i++)
            {
                if (!char.IsDigit(t[i])) return t;
            }
            var trimmed = t.TrimStart('0');
            return trimmed.Length == 0 ? "0" : trimmed;
        }

        private static Room? FindRoomByNumber(Document doc, string roomNumber)
        {
            var q = (roomNumber ?? "").Trim();
            if (q.Length == 0) return null;
            var qNorm = NormalizeNumericRoomNumber(q);

            var collector = new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms);
            foreach (var room in collector.Cast<Room>())
            {
                var n = (room.Number ?? "").Trim();
                if (n.Equals(q, StringComparison.OrdinalIgnoreCase)) return room;
                var nNorm = NormalizeNumericRoomNumber(n);
                if (nNorm.Equals(qNorm, StringComparison.OrdinalIgnoreCase)) return room;
            }

            return null;
        }

        private static XYZ GetRoomCenter(Room room, View view)
        {
            try
            {
                if (room.Location is LocationPoint lp) return lp.Point;
            }
            catch { }

            try
            {
                // Prefer view-specific bbox (plan-view context) to avoid large Z offsets affecting proximity.
                var bb = room.get_BoundingBox(view) ?? room.get_BoundingBox(null);
                if (bb != null) return (bb.Min + bb.Max) * 0.5;
            }
            catch { }

            return XYZ.Zero;
        }

        private static int DesiredGapSign(string side)
        {
            var s = (side ?? "").Trim().ToLowerInvariant();
            if (s == "left" || s == "bottom") return -1;
            if (s == "right" || s == "top") return 1;
            return 0;
        }

        private static string OppositeSide(string side)
        {
            var s = (side ?? "").Trim().ToLowerInvariant();
            return s switch
            {
                "left" => "right",
                "right" => "left",
                "bottom" => "top",
                "top" => "bottom",
                _ => "right"
            };
        }

        private static ElementId? PickBoundaryWallId(Document doc, Room room, View view, string side)
        {
            var opts = new SpatialElementBoundaryOptions
            {
                SpatialElementBoundaryLocation = SpatialElementBoundaryLocation.Finish
            };

            var right = view.RightDirection.Normalize();
            var up = view.UpDirection.Normalize();

            var segmentsList = room.GetBoundarySegments(opts);
            if (segmentsList == null) return null;

            var segs = new List<(long hostId, double midX, double midY, double lenFt, double dirX, double dirY)>();
            foreach (var loop in segmentsList)
            {
                foreach (var s in loop)
                {
                    var curve = s.GetCurve();
                    var p0 = curve.GetEndPoint(0);
                    var p1 = curve.GetEndPoint(1);
                    var d = p1 - p0;
                    var len = d.GetLength();
                    var dir = len > 1e-9 ? d / len : XYZ.Zero;
                    var mid = (p0 + p1) * 0.5;

                    var hostId = RevitBridge.Common.ElementIdCompat.GetValue(s.ElementId);
                    if (hostId <= 0) continue;

                    segs.Add((hostId, mid.DotProduct(right), mid.DotProduct(up), curve.Length, dir.DotProduct(right), dir.DotProduct(up)));
                }
            }

            if (segs.Count == 0) return null;

            var minX = segs.Min(s => s.midX);
            var maxX = segs.Max(s => s.midX);
            var minY = segs.Min(s => s.midY);
            var maxY = segs.Max(s => s.midY);

            var tolX = Math.Max(0.25, 0.02 * Math.Max(1e-9, maxX - minX));
            var tolY = Math.Max(0.25, 0.02 * Math.Max(1e-9, maxY - minY));

            bool IsVertical((long hostId, double midX, double midY, double lenFt, double dirX, double dirY) s) => Math.Abs(s.dirY) >= Math.Abs(s.dirX);
            bool IsHorizontal((long hostId, double midX, double midY, double lenFt, double dirX, double dirY) s) => Math.Abs(s.dirX) > Math.Abs(s.dirY);

            IEnumerable<(long hostId, double midX, double midY, double lenFt, double dirX, double dirY)> candidates = side switch
            {
                "left" => segs.Where(IsVertical).Where(s => s.midX <= minX + tolX),
                "right" => segs.Where(IsVertical).Where(s => s.midX >= maxX - tolX),
                "bottom" => segs.Where(IsHorizontal).Where(s => s.midY <= minY + tolY),
                "top" => segs.Where(IsHorizontal).Where(s => s.midY >= maxY - tolY),
                _ => segs
            };

            var byWall = new Dictionary<long, double>();
            foreach (var c in candidates)
            {
                if (!byWall.TryGetValue(c.hostId, out var acc)) acc = 0.0;
                byWall[c.hostId] = acc + Math.Max(0.0, c.lenFt);
            }

            // Prefer actual Walls; pick the wall with the longest boundary coverage.
            ElementId? best = null;
            var bestLen = -1.0;
            foreach (var kv in byWall.OrderByDescending(kv => kv.Value))
            {
                var eid = RevitBridge.Common.ElementIdCompat.Create(kv.Key);
                var el = doc.GetElement(eid);
                if (el is not Wall) continue;
                if (kv.Value > bestLen)
                {
                    best = eid;
                    bestLen = kv.Value;
                }
            }

            return best;
        }

        private static List<ElementId> FindColumnsNear(Document doc, View view, XYZ center, double radiusFt, out bool usedFallback)
        {
            usedFallback = false;

            var right = view.RightDirection.Normalize();
            var up = view.UpDirection.Normalize();

            var cats = new List<ElementId>
            {
                RevitBridge.Common.ElementIdCompat.Create((long)BuiltInCategory.OST_StructuralColumns),
                RevitBridge.Common.ElementIdCompat.Create((long)BuiltInCategory.OST_Columns)
            };

            FilteredElementCollector collector;
            try
            {
                collector = new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType();
            }
            catch
            {
                collector = new FilteredElementCollector(doc).WhereElementIsNotElementType().WherePasses(new ElementOwnerViewFilter(view.Id));
            }

            collector = collector.WherePasses(new ElementMulticategoryFilter(cats));

            var scored = new List<(ElementId id, double dist2d)>(); // dist in view-plane feet
            foreach (var e in collector)
            {
                if (e == null) continue;
                var pt = GetElementPoint(e);
                if (pt == null) continue;

                var d = pt - center;
                var dx = d.DotProduct(right);
                var dy = d.DotProduct(up);
                var dist2d = Math.Sqrt(dx * dx + dy * dy);
                if (double.IsNaN(dist2d) || double.IsInfinity(dist2d)) continue;
                scored.Add((e.Id, dist2d));
            }

            if (scored.Count == 0) return new List<ElementId>();

            var ordered = scored.OrderBy(x => x.dist2d).ToList();

            if (radiusFt <= 0.0)
                return ordered.Select(x => x.id).Distinct().ToList();

            var within = ordered.Where(x => x.dist2d <= radiusFt).Select(x => x.id).Distinct().ToList();
            if (within.Count > 0) return within;

            // Fallback: if radius found nothing, pick the nearest few visible columns anyway (helps when room center/bbox Z offsets are large or radius was too small).
            usedFallback = true;
            return ordered.Take(60).Select(x => x.id).Distinct().ToList();
        }

        private static XYZ GetElementPoint(Element e)
        {
            try
            {
                if (e.Location is LocationPoint lp) return lp.Point;
            }
            catch { }

            try
            {
                var bb = e.get_BoundingBox(null);
                if (bb != null) return (bb.Min + bb.Max) * 0.5;
            }
            catch { }

            return null;
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
                    return new { kind = "LocationPoint", pointXyz = new[] { pt.X, pt.Y, pt.Z } };
                }

                if (e.Location is LocationCurve lc)
                {
                    var c = lc.Curve;
                    var p0 = c.GetEndPoint(0);
                    var p1 = c.GetEndPoint(1);
                    return new { kind = "LocationCurve", startXyz = new[] { p0.X, p0.Y, p0.Z }, endXyz = new[] { p1.X, p1.Y, p1.Z } };
                }
            }
            catch { }

            try
            {
                var bb = e.get_BoundingBox(null);
                if (bb != null)
                {
                    var c = (bb.Min + bb.Max) * 0.5;
                    return new { kind = "BboxCenter", centerXyz = new[] { c.X, c.Y, c.Z } };
                }
            }
            catch { }

            return new { kind = "Unknown" };
        }

        private static (string path, int widthPx, int heightPx) ExportPreview(Document doc, View view, ElementId wallId, XYZ wallLabelPoint, ElementId columnId, XYZ columnLabelPoint, int imageSize)
        {
            var folder = SelectionUtil.EnsureDefaultSelectionCaptureFolder("");
            var exportId = Guid.NewGuid().ToString("N");
            var stem = $"Revit_{RevitBridge.Common.ElementIdCompat.GetValue(view.Id)}_{exportId}_room_align_preview";

            var ogsWall = new OverrideGraphicSettings();
            ogsWall.SetProjectionLineWeight(6);
            ogsWall.SetProjectionLineColor(new Color(255, 0, 0));

            var ogsCol = new OverrideGraphicSettings();
            ogsCol.SetProjectionLineWeight(6);
            ogsCol.SetProjectionLineColor(new Color(0, 160, 255));

            string path;
            using (var tg = new TransactionGroup(doc, "Room Align Preview"))
            {
                tg.Start();

                using (var t = new Transaction(doc, "Preview Overrides"))
                {
                    t.Start();
                    try { view.SetElementOverrides(wallId, ogsWall); } catch { }
                    try { view.SetElementOverrides(columnId, ogsCol); } catch { }

                    TryCreateTextLabel(doc, view, wallLabelPoint, "wall face");
                    TryCreateTextLabel(doc, view, columnLabelPoint, "column face");

                    t.Commit();
                }

                path = SelectionUtil.ExportViewImage(doc, view, imageSize, folder, stem);
                tg.RollBack();
            }

            var (w, h) = SelectionUtil.ReadImageSize(path);
            return (path, w, h);
        }

        private static void TryCreateTextLabel(Document doc, View view, XYZ point, string text)
        {
            try
            {
                var typeId = new FilteredElementCollector(doc).OfClass(typeof(TextNoteType)).FirstElementId();
                if (typeId == ElementId.InvalidElementId) return;

                TextNote.Create(doc, view.Id, point, text, typeId);
            }
            catch
            {
                // ignore
            }
        }
    }
}
