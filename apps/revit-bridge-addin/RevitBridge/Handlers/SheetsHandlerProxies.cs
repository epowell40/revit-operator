using Autodesk.Revit.UI;
using RevitBridge.Common;
using System.Threading.Tasks;

namespace RevitBridge.Handlers
{
    public sealed class GetTitleblockInfoHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.GetTitleblockInfoHandler().Handle(app, jsonData);
    }

    public sealed class CaptureSheetRegionHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.CaptureSheetRegionHandler().Handle(app, jsonData);
    }

    public sealed class TitleblockLabelMapHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.TitleblockLabelMapHandler().Handle(app, jsonData);
    }

    public sealed class VerifyParameterOnSheetHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.VerifyParameterOnSheetHandler().Handle(app, jsonData);
    }

    public sealed class TitleblockFamilyUpdateTextHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.TitleblockFamilyUpdateTextHandler().Handle(app, jsonData);
    }

    public sealed class TitleblockDateCandidatesHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.TitleblockDateCandidatesHandler().Handle(app, jsonData);
    }

    public sealed class TitleblockSetDateSmartHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.TitleblockSetDateSmartHandler().Handle(app, jsonData);
    }
}
