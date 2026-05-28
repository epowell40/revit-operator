using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class AlignElementsHandler : IRequestHandler
    {
        public sealed class FaceSpec
        {
            public string kind { get; set; } = "face"; // v1 only supports "face"
            public string side { get; set; } = "left"; // left|right|top|bottom
        }

        public sealed class Options
        {
            public bool failOnPinned { get; set; } = true;
            public double minAbsNormalDot { get; set; } = 0.90; // face normal alignment to axis
            public double zeroToleranceFt { get; set; } = 1.0 / 192.0; // ~1/16"
            public bool exportPreviewImage { get; set; } = false;
            public int previewImageSize { get; set; } = 2200;
        }

        public sealed class Params
        {
            public long sourceElementId { get; set; }
            public FaceSpec source { get; set; } = new FaceSpec();
            public long targetElementId { get; set; }
            public FaceSpec target { get; set; } = new FaceSpec();

            public string axis { get; set; } = "viewX"; // viewX|viewY
            public long? viewId { get; set; } // optional, defaults to active view

            public bool dryRun { get; set; } = true;
            public string behavior { get; set; } = "allOrNothing"; // allOrNothing|bestEffort (v1: single element, mostly informational)
            public Options? options { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? throw new ArgumentException("Invalid JSON payload.");
            if (p.sourceElementId <= 0) throw new ArgumentException("sourceElementId is required.");
            if (p.targetElementId <= 0) throw new ArgumentException("targetElementId is required.");
            if (p.source == null) throw new ArgumentException("source is required.");
            if (p.target == null) throw new ArgumentException("target is required.");
            if (!string.Equals(p.source.kind, "face", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("source.kind must be 'face'.");
            if (!string.Equals(p.target.kind, "face", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("target.kind must be 'face'.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var view = ResolveView(doc, uidoc.ActiveView, p.viewId);
            if (view == null) throw new InvalidOperationException("View not found.");

            var opts = p.options ?? new Options();
            var axis = FaceAlignmentUtil.ResolveAxis(view, p.axis);

            var sourceId = RevitBridge.Common.ElementIdCompat.Create(p.sourceElementId);
            var targetId = RevitBridge.Common.ElementIdCompat.Create(p.targetElementId);

            var warnings = new List<string>();

            // Resolve faces and compute initial gap.
            if (!FaceAlignmentUtil.TryResolvePlanarFace(doc, sourceId, view, axis, p.axis, p.source?.side ?? "left", opts.minAbsNormalDot, out var srcFace, out var srcErr))
                throw new ArgumentException(srcErr ?? "Failed to resolve source face.");
            if (!FaceAlignmentUtil.TryResolvePlanarFace(doc, targetId, view, axis, p.axis, p.target?.side ?? "right", opts.minAbsNormalDot, out var tgtFace, out var tgtErr))
                throw new ArgumentException(tgtErr ?? "Failed to resolve target face.");

            var gapBefore = tgtFace!.PlaneCoordOnAxis - srcFace!.PlaneCoordOnAxis;
            var vector = axis.Multiply(gapBefore);

            var sourceEl = doc.GetElement(sourceId);
            var targetEl = doc.GetElement(targetId);
            if (sourceEl == null) throw new ArgumentException($"Source element {p.sourceElementId} not found.");
            if (targetEl == null) throw new ArgumentException($"Target element {p.targetElementId} not found.");

            if (opts.failOnPinned && TryIsPinned(sourceEl, out var pinned) && pinned)
                throw new InvalidOperationException($"Source element {p.sourceElementId} is pinned.");

            object snapshotBefore = SnapshotLocation(sourceEl);

            string? previewPath = null;
            int? previewWidth = null;
            int? previewHeight = null;

            double gapAfter = gapBefore;
            object snapshotAfter = snapshotBefore;
            var failures = new List<CapturedFailure>();
            string? transactionStatus = null;

            if (p.dryRun)
            {
                using (var tg = new TransactionGroup(doc, "Align Elements (Dry Run)"))
                {
                    tg.Start();

                    using (var t = new Transaction(doc, "Align Elements (Move)"))
                    {
                        t.Start();
                        t.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(t, failures, rollbackOnErrors: true, deleteWarnings: false));
                        ElementTransformUtils.MoveElement(doc, sourceId, vector);
                        var st = t.Commit();
                        transactionStatus = st.ToString();
                    }

                    snapshotAfter = SnapshotLocation(sourceEl);

                    // Re-resolve face after move for validation.
                    if (FaceAlignmentUtil.TryResolvePlanarFace(doc, sourceId, view, axis, p.axis, p.source?.side ?? "left", opts.minAbsNormalDot, out var srcAfter, out _))
                        gapAfter = tgtFace.PlaneCoordOnAxis - srcAfter!.PlaneCoordOnAxis;

                    if (opts.exportPreviewImage)
                    {
                        (previewPath, previewWidth, previewHeight) = ExportPreview(doc, view, sourceId, srcFace.LabelPoint, targetId, tgtFace.LabelPoint, opts.previewImageSize);
                    }

                    tg.RollBack();
                }

                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    axis = p.axis,
                    vectorXyz = new[] { vector.X, vector.Y, vector.Z },
                    gapBeforeFt = gapBefore,
                    gapAfterFt = gapAfter,
                    withinTolerance = Math.Abs(gapAfter) <= opts.zeroToleranceFt,
                    rolledBack = true,
                    transactionStatus,
                    failures,
                    source = new
                    {
                        elementId = p.sourceElementId,
                        face = new
                        {
                            kind = "planar_face",
                            side = p.source.side,
                            planeCoordOnAxis = srcFace.PlaneCoordOnAxis,
                            axisAlignmentAbs = srcFace.AxisAlignmentAbs,
                            labelPointXyz = new[] { srcFace.LabelPoint.X, srcFace.LabelPoint.Y, srcFace.LabelPoint.Z }
                        },
                        snapshotBefore,
                        snapshotAfter
                    },
                    target = new
                    {
                        elementId = p.targetElementId,
                        face = new
                        {
                            kind = "planar_face",
                            side = p.target.side,
                            planeCoordOnAxis = tgtFace.PlaneCoordOnAxis,
                            axisAlignmentAbs = tgtFace.AxisAlignmentAbs,
                            labelPointXyz = new[] { tgtFace.LabelPoint.X, tgtFace.LabelPoint.Y, tgtFace.LabelPoint.Z }
                        }
                    },
                    preview = previewPath != null ? new { path = previewPath, widthPx = previewWidth, heightPx = previewHeight } : null,
                    warnings
                });
            }

            using (var t = new Transaction(doc, "Align Elements"))
            {
                t.Start();
                t.SetFailureHandlingOptions(FailureHandlingUtil.ConfigureFailureCapture(t, failures, rollbackOnErrors: true, deleteWarnings: false));
                ElementTransformUtils.MoveElement(doc, sourceId, vector);
                var st = t.Commit();
                transactionStatus = st.ToString();
            }

            snapshotAfter = SnapshotLocation(sourceEl);

            if (FaceAlignmentUtil.TryResolvePlanarFace(doc, sourceId, view, axis, p.axis, p.source?.side ?? "left", opts.minAbsNormalDot, out var srcAfter2, out _))
                gapAfter = tgtFace.PlaneCoordOnAxis - srcAfter2!.PlaneCoordOnAxis;

            if (opts.exportPreviewImage)
            {
                (previewPath, previewWidth, previewHeight) = ExportPreview(doc, view, sourceId, srcFace.LabelPoint, targetId, tgtFace.LabelPoint, opts.previewImageSize);
            }

            return Task.FromResult<object>(new
            {
                status = (string.Equals(transactionStatus, "RolledBack", StringComparison.OrdinalIgnoreCase) || FailureHandlingUtil.HasErrors(failures)) ? "Rolled Back" : "Aligned",
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                axis = p.axis,
                vectorXyz = new[] { vector.X, vector.Y, vector.Z },
                gapBeforeFt = gapBefore,
                gapAfterFt = gapAfter,
                withinTolerance = Math.Abs(gapAfter) <= opts.zeroToleranceFt,
                rolledBack = string.Equals(transactionStatus, "RolledBack", StringComparison.OrdinalIgnoreCase) || FailureHandlingUtil.HasErrors(failures),
                transactionStatus,
                failures,
                source = new
                {
                    elementId = p.sourceElementId,
                    face = new
                    {
                        kind = "planar_face",
                        side = p.source.side,
                        planeCoordOnAxis = srcFace.PlaneCoordOnAxis,
                        axisAlignmentAbs = srcFace.AxisAlignmentAbs,
                        labelPointXyz = new[] { srcFace.LabelPoint.X, srcFace.LabelPoint.Y, srcFace.LabelPoint.Z }
                    },
                    snapshotBefore,
                    snapshotAfter
                },
                target = new
                {
                    elementId = p.targetElementId,
                    face = new
                    {
                        kind = "planar_face",
                        side = p.target.side,
                        planeCoordOnAxis = tgtFace.PlaneCoordOnAxis,
                        axisAlignmentAbs = tgtFace.AxisAlignmentAbs,
                        labelPointXyz = new[] { tgtFace.LabelPoint.X, tgtFace.LabelPoint.Y, tgtFace.LabelPoint.Z }
                    }
                },
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
                // fall back
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

        private static (string path, int widthPx, int heightPx) ExportPreview(Document doc, View view, ElementId sourceId, XYZ sourceLabelPoint, ElementId targetId, XYZ targetLabelPoint, int imageSize)
        {
            var folder = SelectionUtil.EnsureDefaultSelectionCaptureFolder("");
            var exportId = Guid.NewGuid().ToString("N");
            var stem = $"Revit_{RevitBridge.Common.ElementIdCompat.GetValue(view.Id)}_{exportId}_align_preview";

            var ogsSource = new OverrideGraphicSettings();
            ogsSource.SetProjectionLineWeight(6);
            ogsSource.SetProjectionLineColor(new Color(255, 0, 0));

            var ogsTarget = new OverrideGraphicSettings();
            ogsTarget.SetProjectionLineWeight(6);
            ogsTarget.SetProjectionLineColor(new Color(0, 160, 255));

            string path;
            using (var tg = new TransactionGroup(doc, "Align Preview"))
            {
                tg.Start();

                using (var t = new Transaction(doc, "Preview Overrides"))
                {
                    t.Start();
                    try { view.SetElementOverrides(sourceId, ogsSource); } catch { }
                    try { view.SetElementOverrides(targetId, ogsTarget); } catch { }

                    TryCreateTextLabel(doc, view, sourceLabelPoint, "source face");
                    TryCreateTextLabel(doc, view, targetLabelPoint, "target face");

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
