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
    public class QueryElementsHandler : IRequestHandler
    {
        public class Params
        {
            public string category { get; set; }
            public long? viewId { get; set; }
            public int? limit { get; set; } = 100;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            FilteredElementCollector collector;
            if (p.viewId.HasValue)
            {
                collector = new FilteredElementCollector(doc, RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value));
            }
            else
            {
                collector = new FilteredElementCollector(doc);
            }
            
            collector.WhereElementIsNotElementType();

            if (!string.IsNullOrEmpty(p.category))
            {
                if (Enum.TryParse<BuiltInCategory>(p.category, true, out var bic))
                {
                    collector.OfCategory(bic);
                }
            }

            var results = new List<object>();
            var elements = collector.ToElements();
            int limit = p.limit ?? 100;
            int count = 0;

            foreach (var e in elements)
            {
                if (count >= limit) break;
                try
                {
                    string levelName = null;
                    if (e.LevelId != ElementId.InvalidElementId)
                    {
                        var lvl = doc.GetElement(e.LevelId) as Level;
                        levelName = lvl?.Name;
                    }

                    object locationObj = null;
                    var bbox = e.get_BoundingBox(null);
                    if (bbox != null)
                    {
                        locationObj = new
                        {
                            x = (bbox.Min.X + bbox.Max.X) / 2.0,
                            y = (bbox.Min.Y + bbox.Max.Y) / 2.0,
                            z = (bbox.Min.Z + bbox.Max.Z) / 2.0
                        };
                    }

                    object geometry = null;
                    if (e is Grid grid)
                    {
                        var curve = grid.Curve;
                        geometry = new {
                            type = "Line",
                            p1 = new { x = curve.GetEndPoint(0).X, y = curve.GetEndPoint(0).Y, z = curve.GetEndPoint(0).Z },
                            p2 = new { x = curve.GetEndPoint(1).X, y = curve.GetEndPoint(1).Y, z = curve.GetEndPoint(1).Z }
                        };
                    }
                    else if (e is Wall wall)
                    {
                        if (wall.Location is LocationCurve lc)
                        {
                            geometry = new {
                                type = "Line",
                                p1 = new { x = lc.Curve.GetEndPoint(0).X, y = lc.Curve.GetEndPoint(0).Y, z = lc.Curve.GetEndPoint(0).Z },
                                p2 = new { x = lc.Curve.GetEndPoint(1).X, y = lc.Curve.GetEndPoint(1).Y, z = lc.Curve.GetEndPoint(1).Z }
                            };
                        }
                    }

                    results.Add(new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                        name = e.Name,
                        category = e.Category?.Name,
                        level = levelName,
                        location = locationObj,
                        geometry = geometry
                    });
                    count++;
                }
                catch
                {
                    // Skip problematic elements
                }
            }

            return Task.FromResult<object>(results);
        }
    }
}
