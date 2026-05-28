using System;
using System.Linq;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public class ListViewsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var doc = app.ActiveUIDocument.Document;
            var views = new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .Where(v => !v.IsTemplate)
                .Select(v => new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(v.Id),
                    name = v.Name,
                    type = v.ViewType.ToString(),
                    isAssembly = v.IsAssemblyView
                })
                .ToList();

            return Task.FromResult<object>(views);
        }
    }
}