using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public class QueryElementsHandler : IRequestHandler
    {
        public class Params
        {
            public string category { get; set; }
            public string[] categories { get; set; }
            public int? limit { get; set; } = 100;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            var collector = new FilteredElementCollector(doc)
                .WhereElementIsNotElementType();

            var cat = p?.category;
            if (string.IsNullOrWhiteSpace(cat) && p?.categories != null && p.categories.Length > 0) cat = p.categories[0];
            cat = (cat ?? "").Trim();

            if (!string.IsNullOrWhiteSpace(cat))
            {
                // Try to find built-in category
                if (Enum.TryParse<BuiltInCategory>(cat, true, out var bic))
                {
                    collector.OfCategory(bic);
                }
            }

            var elements = collector
                .ToElements()
                .Take(p.limit ?? 100)
                .Select(e => new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                    name = e.Name,
                    category = e.Category?.Name,
                    level = (e.LevelId != ElementId.InvalidElementId) ? (doc.GetElement(e.LevelId) as Level)?.Name : null,
                    location = e.get_BoundingBox(null) != null ? 
                        new { 
                            x = (e.get_BoundingBox(null).Min.X + e.get_BoundingBox(null).Max.X) / 2.0,
                            y = (e.get_BoundingBox(null).Min.Y + e.get_BoundingBox(null).Max.Y) / 2.0,
                            z = (e.get_BoundingBox(null).Min.Z + e.get_BoundingBox(null).Max.Z) / 2.0
                        } : null
                })
                .ToList();

            return Task.FromResult<object>(elements);
        }
    }
}
