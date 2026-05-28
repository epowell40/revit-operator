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
    public class AnalyzeDimensionsHandler : IRequestHandler
    {
        public class Params
        {
            public long? viewId { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            var collector = new FilteredElementCollector(doc);
            if (p.viewId.HasValue)
            {
                collector = collector.OfCategory(BuiltInCategory.OST_Dimensions).WhereElementIsNotElementType().WherePasses(new ElementOwnerViewFilter(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)));
            }
            else
            {
                collector = collector.OfCategory(BuiltInCategory.OST_Dimensions).WhereElementIsNotElementType();
            }

            var results = new List<object>();

            foreach (Dimension dim in collector)
            {
                try
                {
                    var refs = new List<object>();
                    foreach (Reference r in dim.References)
                    {
                        var refElem = doc.GetElement(r.ElementId);
                        if (refElem != null)
                        {
                            // Try to get the specific point being referenced
                            // The Reference object itself might not have a GlobalPoint if it's a surface,
                            // but for dimensions, we can infer the position from the dimension line or origin.
                            // However, strictly speaking, Reference.GlobalPoint is available in some contexts.
                            // A better approximation for "Where is this witness line?" is to project the Dimension's 
                            // Origin/Curve onto the referenced element, but simpler is to just check geometric properties if possible.
                            
                            // For this data capture, we'll try to get the GlobalPoint if available, 
                            // or leave it null.
                            XYZ refPoint = null;
                            try { refPoint = r.GlobalPoint; } catch {}

                            refs.Add(new
                            {
                                elementId = RevitBridge.Common.ElementIdCompat.GetValue(refElem.Id),
                                category = refElem.Category?.Name,
                                name = refElem.Name,
                                type = refElem.GetType().Name,
                                point = refPoint != null ? new { x = refPoint.X, y = refPoint.Y, z = refPoint.Z } : null
                            });
                        }
                    }

                    results.Add(new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(dim.Id),
                        value = dim.Value,
                        valueString = dim.ValueString,
                        references = refs,
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(dim.OwnerViewId),
                        segments = dim.Segments != null ? dim.Segments.Size : 0
                    });
                }
                catch
                {
                    // Ignore failing dims
                }
            }

            return Task.FromResult<object>(results);
        }
    }
}

