using System;
using System.Linq;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class ContextHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var uidoc = app.ActiveUIDocument;
            var doc = uidoc?.Document;
            var view = doc?.ActiveView;

            return Task.FromResult<object>(new
            {
                version = app.Application.VersionName,
                username = app.Application.Username,
                document = doc == null ? null : new
                {
                    title = doc.Title,
                    path = doc.PathName,
                    isWorkshared = doc.IsWorkshared,
                    activeView = view == null ? null : new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                        name = view.Name,
                        type = view.ViewType.ToString()
                    },
                    selection = uidoc?.Selection.GetElementIds().Select(id => RevitBridge.Common.ElementIdCompat.GetValue(id)).ToList()
                }
            });
        }
    }
}
