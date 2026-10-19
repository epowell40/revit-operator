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
            => Task.FromResult(NativeMutationPreflightBoundary.Execute(enterNativeScope =>
                HandleCore(app, jsonData, enterNativeScope)));

        private object HandleCore(UIApplication app, string jsonData, Action enterNativeScope)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");

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

            var revId = ResolveRevisionId(doc, p.revisionId);
            var curves = BuildCurves(pts, frameId, p.closed ?? true);
            var failureGuard = new OperatorNativeFailureGuard();
            long cloudId = 0;
            long? tagId = null;
            string? tagMessage = null;
            enterNativeScope();
            var response = NativeSingleTransaction.Execute(app, doc,
                dryRun ? "Create Revision Cloud (dry run)" : "Create Revision Cloud", created =>
            {
                // Supported Revit versions take View, not ElementId. The former
                // reflection lookup could never find the actual 2024 API.
                var cloud = RevisionCloud.Create(doc, view, revId, curves);
                cloudId = ElementIdCompat.GetValue(cloud.Id);
                created.Add(cloudId);
                if (tagCreatedCloud)
                {
                    var tag = TryCreateRevisionCloudTag(doc, view, cloud.Id, tagHasLeader, out tagMessage);
                    if (tag != null)
                    {
                        tagId = ElementIdCompat.GetValue(tag.Id);
                        created.Add(tagId.Value);
                    }
                }
                return new Dictionary<string, object?>
                {
                    ["dryRun"] = dryRun,
                    ["previewExecuted"] = dryRun,
                    ["viewId"] = ElementIdCompat.GetValue(view.Id),
                    ["curves"] = curves.Count,
                    ["tag"] = tagCreatedCloud
                        ? new { requested = true, hasLeader = tagHasLeader, tagId, message = tagMessage }
                        : null
                };
            }, disposition: dryRun ? NativeTransactionDisposition.Rollback : NativeTransactionDisposition.Commit,
                configureTransaction: tx => NativeNonInteractiveFailureHandling.Configure(tx, failureGuard));
            OperatorNativeTransactionExecution.ReadCommitted(response, () =>
            {
                var cloud = doc.GetElement(ElementIdCompat.Create(cloudId)) as RevisionCloud
                    ?? throw new InvalidOperationException("Created revision cloud is missing after commit.");
                if (cloud.OwnerViewId != view.Id || cloud.RevisionId != revId)
                    throw new InvalidOperationException("Created cloud has a different owner view or revision.");
                if (tagId.HasValue && !(doc.GetElement(ElementIdCompat.Create(tagId.Value)) is IndependentTag))
                    throw new InvalidOperationException("Created revision cloud tag is missing after commit.");
                var sketch = cloud.GetSketchCurves();
                return new Dictionary<string, object?>
                {
                    ["revisionCloudId"] = cloudId,
                    ["revisionCloud"] = new
                    {
                        id = cloudId, uniqueId = cloud.UniqueId,
                        ownerViewId = ElementIdCompat.GetValue(cloud.OwnerViewId),
                        revisionId = ElementIdCompat.GetValue(cloud.RevisionId),
                        sketchCurveCount = sketch.Count,
                        sketchCurves = sketch.Select(c => new
                        {
                            kind = c.GetType().Name,
                            start = new[] { c.GetEndPoint(0).X, c.GetEndPoint(0).Y, c.GetEndPoint(0).Z },
                            end = new[] { c.GetEndPoint(1).X, c.GetEndPoint(1).Y, c.GetEndPoint(1).Z }
                        }).ToArray()
                    },
                    ["tagComplete"] = !tagCreatedCloud || tagId.HasValue
                };
            }, requestedChangesComplete: !tagCreatedCloud || tagId.HasValue);
            response["nativeFailures"] = failureGuard.Failures;
            response["status"] = OperatorNativeTransactionExecution.OutcomeStatus(response, "Success");
            if (Equals(response["status"], "Success") && tagCreatedCloud && !tagId.HasValue) response["status"] = "Partial";
            // Native receipt/readback describes this bounded effect, not the
            // requested diagram's visual or whole-task correctness.
            response.Remove("verified");
            response.Remove("ok");
            return response;
        }

        private static ElementId ResolveRevisionId(Document doc, long? requested)
        {
            if (requested.HasValue && requested.Value > 0)
            {
                var r = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(requested.Value)) as Revision;
                if (r == null) throw new InvalidOperationException($"Revision {requested.Value} not found.");
                if (r.Issued) throw new InvalidOperationException($"Revision {requested.Value} is issued and cannot receive a cloud.");
                return r.Id;
            }

            var any = new FilteredElementCollector(doc)
                .OfClass(typeof(Revision))
                .Cast<Revision>()
                .OrderByDescending(r => r.SequenceNumber)
                .FirstOrDefault();

            if (any == null) throw new InvalidOperationException("No revisions exist in this project. Create a Revision first, or pass revisionId.");
            if (any.Issued) throw new InvalidOperationException("The latest Revision is issued. Pass an unissued revisionId explicitly.");
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
