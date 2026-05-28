using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class GetElementSummaryHandler : IRequestHandler
    {
        public class Params
        {
            // Back-compat: earlier clients used { ids: [...] }.
            public List<long> ids { get; set; }

            // Preferred: { elementIds: [...] } (matches other endpoints + Operator schema validator).
            public List<long> elementIds { get; set; }

            // Optional: evaluate bounding boxes in a specific view context (for sheet/view-space targeting).
            public long? viewId { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var ids = p?.elementIds ?? p?.ids;
            if (ids == null) throw new ArgumentException("Missing 'elementIds' (or legacy 'ids').");

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active document.");

            View viewForBbox = null;
            if (p?.viewId.HasValue == true && p.viewId.Value != 0)
            {
                viewForBbox = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
                if (viewForBbox == null) throw new InvalidOperationException($"View {p.viewId.Value} not found.");
            }

            var results = new List<object>(ids.Count);
            foreach (var id in ids)
            {
                var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (elem == null)
                {
                    results.Add(new { id, found = false, error = "Element not found" });
                    continue;
                }

                object bboxObj = null;
                try
                {
                    var bbox = elem.get_BoundingBox(viewForBbox);
                    if (bbox == null && viewForBbox != null)
                    {
                        // Fallback to model-space box when view-specific box is unavailable.
                        bbox = elem.get_BoundingBox(null);
                    }
                    if (bbox != null)
                    {
                        bboxObj = new
                        {
                            min = new { x = bbox.Min.X, y = bbox.Min.Y, z = bbox.Min.Z },
                            max = new { x = bbox.Max.X, y = bbox.Max.Y, z = bbox.Max.Z }
                        };
                    }
                }
                catch
                {
                    bboxObj = null;
                }

                object locationObj = null;
                try
                {
                    if (elem.Location is LocationPoint lp)
                    {
                        var pt = lp.Point;
                        locationObj = new { type = "point", x = pt.X, y = pt.Y, z = pt.Z };
                    }
                    else if (elem.Location is LocationCurve lc)
                    {
                        var curve = lc.Curve;
                        var p0 = curve.GetEndPoint(0);
                        var p1 = curve.GetEndPoint(1);
                        locationObj = new
                        {
                            type = "curve",
                            curveType = curve.GetType().Name,
                            p0 = new { x = p0.X, y = p0.Y, z = p0.Z },
                            p1 = new { x = p1.X, y = p1.Y, z = p1.Z }
                        };
                    }
                }
                catch
                {
                    locationObj = null;
                }

                results.Add(new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(elem.Id),
                    found = true,
                    category = elem.Category?.Name,
                    name = elem.Name,
                    boundingBox = bboxObj,
                    location = locationObj,
                    viewIdUsed = viewForBbox != null ? (long?)RevitBridge.Common.ElementIdCompat.GetValue(viewForBbox.Id) : null
                });
            }

            return Task.FromResult<object>(results);
        }
    }
}
