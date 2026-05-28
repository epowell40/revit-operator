using Autodesk.Revit.UI;
using RevitBridge.Common;
using System.Threading.Tasks;

namespace RevitBridge.Handlers
{
    public sealed class RegenerateHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.RegenerateHandler().Handle(app, jsonData);
    }
    public sealed class RevitStateSnapshotHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.RevitStateSnapshotHandler().Handle(app, jsonData);
    }
}