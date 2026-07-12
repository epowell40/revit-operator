using System.Threading.Tasks;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public class ExportViewFrameHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.ExportViewFrameHandler().Handle(app, jsonData);
    }

    public class ExportViewRegionHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.ExportViewRegionHandler().Handle(app, jsonData);
    }

    public class ExportVisibleElementsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.ExportVisibleElementsHandler().Handle(app, jsonData);
    }

    public class PickAtPixelHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.PickAtPixelHandler().Handle(app, jsonData);
    }

    public class SetSelectionHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.SetSelectionHandler().Handle(app, jsonData);
    }

    public class HighlightAndExportHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.HighlightAndExportHandler().Handle(app, jsonData);
    }

    public class ActivateViewHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.ActivateViewHandler().Handle(app, jsonData);
    }

    public class ResolveRoomPlanViewHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.ResolveRoomPlanViewHandler().Handle(app, jsonData);
    }

    public class PlanDwellingReceptaclesHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.PlanDwellingReceptaclesHandler().Handle(app, jsonData);
    }

    public class PlanRoomReceptaclesFromAnalogHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.PlanRoomReceptaclesFromAnalogHandler().Handle(app, jsonData);
    }

    public class ApplyRoomReceptaclesFromAnalogHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.ApplyRoomReceptaclesFromAnalogHandler().Handle(app, jsonData);
    }
}
