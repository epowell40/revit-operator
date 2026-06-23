using System.Threading.Tasks;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class LinkedRoomBoundariesHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.LinkedRoomBoundariesHandler().Handle(app, jsonData);
    }
}
