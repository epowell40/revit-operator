using System;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class MeasureGapHandler : IRequestHandler
    {
        public sealed class FaceSpec
        {
            public string kind { get; set; } = "face";
            public string side { get; set; } = "left";
        }

        public sealed class Options
        {
            public double minAbsNormalDot { get; set; } = 0.90;
            public double zeroToleranceFt { get; set; } = 1.0 / 192.0; // ~1/16"
        }

        public sealed class Params
        {
            public long sourceElementId { get; set; }
            public FaceSpec source { get; set; } = new FaceSpec();
            public long targetElementId { get; set; }
            public FaceSpec target { get; set; } = new FaceSpec();
            public string axis { get; set; } = "viewX";
            public long? viewId { get; set; }
            public Options? options { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? throw new ArgumentException("Invalid JSON payload.");
            if (p.sourceElementId <= 0) throw new ArgumentException("sourceElementId is required.");
            if (p.targetElementId <= 0) throw new ArgumentException("targetElementId is required.");
            if (p.source == null) throw new ArgumentException("source is required.");
            if (p.target == null) throw new ArgumentException("target is required.");
            if (!string.Equals(p.source.kind, "face", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("source.kind must be 'face'.");
            if (!string.Equals(p.target.kind, "face", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("target.kind must be 'face'.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var view = ResolveView(doc, uidoc.ActiveView, p.viewId);
            if (view == null) throw new InvalidOperationException("View not found.");

            var opts = p.options ?? new Options();
            var axis = FaceAlignmentUtil.ResolveAxis(view, p.axis);

            var sourceId = RevitBridge.Common.ElementIdCompat.Create(p.sourceElementId);
            var targetId = RevitBridge.Common.ElementIdCompat.Create(p.targetElementId);

            if (!FaceAlignmentUtil.TryResolvePlanarFace(doc, sourceId, view, axis, p.axis, p.source.side, opts.minAbsNormalDot, out var srcFace, out var srcErr))
                throw new ArgumentException(srcErr ?? "Failed to resolve source face.");
            if (!FaceAlignmentUtil.TryResolvePlanarFace(doc, targetId, view, axis, p.axis, p.target.side, opts.minAbsNormalDot, out var tgtFace, out var tgtErr))
                throw new ArgumentException(tgtErr ?? "Failed to resolve target face.");

            var gap = tgtFace!.PlaneCoordOnAxis - srcFace!.PlaneCoordOnAxis;

            return Task.FromResult<object>(new
            {
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                axis = p.axis,
                gapFt = gap,
                withinTolerance = Math.Abs(gap) <= opts.zeroToleranceFt,
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
                    }
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
                }
            });
        }

        private static View? ResolveView(Document doc, View? activeView, long? viewId)
        {
            if (viewId.HasValue && viewId.Value != 0)
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
            return activeView;
        }
    }
}
