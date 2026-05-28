using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.Drafting
{
    public sealed class CreateRevisionCloudHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long viewId { get; set; }
            public string? frameId { get; set; }
            public List<DraftPoint>? points { get; set; } // polyline/loop
            public long? revisionId { get; set; } // optional
            public bool? closed { get; set; } = true;
            public bool? tagCreatedCloud { get; set; }
            public bool? tagHasLeader { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            if (p.viewId <= 0) throw new InvalidOperationException("create-revision-cloud.viewId is required.");
            var view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId)) as View;
            if (view == null) throw new InvalidOperationException($"View {p.viewId} not found.");

            var pts = p.points ?? new List<DraftPoint>();
            if (pts.Count < 2) throw new InvalidOperationException("create-revision-cloud.points must have at least 2 points.");
            if (pts.Count > 5000) throw new InvalidOperationException("create-revision-cloud.points too large (max 5000).");

            var dryRun = p.dryRun ?? false;
            var tagCreatedCloud = p.tagCreatedCloud ?? false;
            var tagHasLeader = p.tagHasLeader ?? false;
            var frameId = (p.frameId ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(frameId))
            {
                if (!FrameStore.TryGet(frameId, out var frame) || frame == null)
                    throw new InvalidOperationException($"Frame not found (expired?): {frameId}");
                if (frame.viewId != p.viewId)
                    throw new InvalidOperationException($"Frame {frameId} belongs to viewId={frame.viewId}, but request.viewId={p.viewId}.");
            }

            using (var t = new Transaction(doc, dryRun ? "Create Revision Cloud (dry run)" : "Create Revision Cloud"))
            {
                t.Start();

                var revId = ResolveRevisionId(doc, p.revisionId);
                var curves = BuildCurves(pts, frameId, p.closed ?? true);

                // RevisionCloud.Create overloads vary by Revit version; try common signatures.
                var rcId = TryCreateRevisionCloud(doc, view, revId, curves);

                if (dryRun)
                {
                    t.RollBack();
                    return Task.FromResult<object>(new
                    {
                        status = "Dry Run",
                        dryRun = true,
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                        curves = curves.Count,
                        revisionCloud = new { revisionId = RevitBridge.Common.ElementIdCompat.GetValue(revId) },
                        tag = tagCreatedCloud ? new { requested = true, hasLeader = tagHasLeader } : null
                    });
                }

                long? tagId = null;
                string? tagMessage = null;
                if (tagCreatedCloud)
                {
                    var tag = TryCreateRevisionCloudTag(doc, view, rcId, tagHasLeader, out tagMessage);
                    if (tag != null) tagId = RevitBridge.Common.ElementIdCompat.GetValue(tag.Id);
                }

                t.Commit();
                return Task.FromResult<object>(new
                {
                    status = "Success",
                    dryRun = false,
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                    revisionCloudId = RevitBridge.Common.ElementIdCompat.GetValue(rcId),
                    curves = curves.Count,
                    tag = tagCreatedCloud
                        ? new { requested = true, hasLeader = tagHasLeader, tagId, message = tagMessage }
                        : null
                });
            }
        }

        private static ElementId ResolveRevisionId(Document doc, long? requested)
        {
            if (requested.HasValue && requested.Value > 0)
            {
                var r = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(requested.Value)) as Revision;
                if (r != null) return r.Id;
            }

            var any = new FilteredElementCollector(doc)
                .OfClass(typeof(Revision))
                .Cast<Revision>()
                .OrderByDescending(r => r.SequenceNumber)
                .FirstOrDefault();

            if (any == null) throw new InvalidOperationException("No revisions exist in this project. Create a Revision first, or pass revisionId.");
            return any.Id;
        }

        private static List<Curve> BuildCurves(List<DraftPoint> pts, string frameId, bool closed)
        {
            var xyz = pts.Select(p => p.Resolve(frameId)).ToList();
            if (closed && !xyz[0].IsAlmostEqualTo(xyz[xyz.Count - 1]))
                xyz.Add(xyz[0]);

            var curves = new List<Curve>();
            for (int i = 0; i < xyz.Count - 1; i++)
            {
                var a = xyz[i];
                var b = xyz[i + 1];
                if (a.IsAlmostEqualTo(b)) continue;
                curves.Add(Line.CreateBound(a, b));
            }
            if (curves.Count == 0) throw new InvalidOperationException("Revision cloud polyline produced no non-degenerate segments.");
            return curves;
        }

        private static ElementId TryCreateRevisionCloud(Document doc, View view, ElementId revisionId, IList<Curve> curves)
        {
            var t = typeof(RevisionCloud);

            // (Document, ElementId viewId, ElementId revisionId, IList<Curve>)
            var m = t.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)
                .FirstOrDefault(x =>
                {
                    if (x.Name != "Create") return false;
                    var ps = x.GetParameters();
                    return ps.Length == 4 &&
                           ps[0].ParameterType == typeof(Document) &&
                           ps[1].ParameterType == typeof(ElementId) &&
                           ps[2].ParameterType == typeof(ElementId) &&
                           typeof(IList<Curve>).IsAssignableFrom(ps[3].ParameterType);
                });
            if (m != null)
            {
                var rc = (RevisionCloud)m.Invoke(null, new object[] { doc, view.Id, revisionId, curves });
                return rc.Id;
            }

            throw new InvalidOperationException("RevisionCloud.Create overload not found for this Revit version.");
        }

        private static IndependentTag? TryCreateRevisionCloudTag(Document doc, View view, ElementId revisionCloudId, bool addLeader, out string? message)
        {
            message = null;
            var revisionCloud = doc.GetElement(revisionCloudId);
            if (revisionCloud == null)
            {
                message = "Revision cloud element not found for tagging.";
                return null;
            }

            var point = ResolveElementCenter(revisionCloud, view) + new XYZ(1, 1, 0);
            try
            {
                return IndependentTag.Create(
                    doc,
                    view.Id,
                    new Reference(revisionCloud),
                    addLeader,
                    TagMode.TM_ADDBY_CATEGORY,
                    TagOrientation.Horizontal,
                    point);
            }
            catch (Exception ex)
            {
                message = ex.Message;
                return null;
            }
        }

        private static XYZ ResolveElementCenter(Element element, View view)
        {
            if (element.Location is LocationPoint lp && lp.Point != null)
            {
                return lp.Point;
            }

            var bbox = element.get_BoundingBox(view);
            if (bbox != null)
            {
                return (bbox.Min + bbox.Max) * 0.5;
            }

            return XYZ.Zero;
        }
    }
}
