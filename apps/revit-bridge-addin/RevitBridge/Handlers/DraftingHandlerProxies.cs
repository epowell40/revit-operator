using System.Threading.Tasks;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class CreateDraftingViewHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.Drafting.CreateDraftingViewHandler().Handle(app, jsonData);
    }

    public sealed class DrawDetailCurvesHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.Drafting.DrawDetailCurvesHandler().Handle(app, jsonData);
    }

    public sealed class CreateFilledRegionHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.Drafting.CreateFilledRegionHandler().Handle(app, jsonData);
    }

    public sealed class CreateRevisionCloudHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.Drafting.CreateRevisionCloudHandler().Handle(app, jsonData);
    }
}

