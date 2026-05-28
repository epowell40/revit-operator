using System.Threading.Tasks;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public class TraceConnectedNetworkHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.MEP.TraceConnectedNetworkHandler().Handle(app, jsonData);
    }

    public class FindElementsByParameterHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.MEP.FindElementsByParameterHandler().Handle(app, jsonData);
    }

    public class RoomMepIntersectHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.MEP.RoomMepIntersectHandler().Handle(app, jsonData);
    }

    public class SyncConnectedSizesHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.MEP.SyncConnectedSizesHandler().Handle(app, jsonData);
    }

    public class ResizeDuctRunHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.MEP.ResizeDuctRunHandler().Handle(app, jsonData);
    }

    public class ResizeDuctsByScopeHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.MEP.ResizeDuctsByScopeHandler().Handle(app, jsonData);
    }

    public class ResizeDuctsInRoomHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.MEP.ResizeDuctsInRoomHandler().Handle(app, jsonData);
    }

    public class DuctsBySpatialScopeHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.MEP.DuctsBySpatialScopeHandler().Handle(app, jsonData);
    }

    public class ResizeDuctworkByScopeHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.MEP.ResizeDuctworkByScopeHandler().Handle(app, jsonData);
    }

    public class GetConnectorsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.MEP.GetConnectorsHandler().Handle(app, jsonData);
    }

    public class RepairDuctContinuityByScopeHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.MEP.RepairDuctContinuityByScopeHandler().Handle(app, jsonData);
    }
}
