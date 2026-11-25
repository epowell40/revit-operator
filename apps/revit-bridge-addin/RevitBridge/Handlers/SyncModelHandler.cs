using System.Threading.Tasks;
using Autodesk.Revit.UI;
namespace RevitBridge.Handlers
{
    // One implementation shared by HTTP and native Operator dispatch.
    public class SyncModelHandler : IRequestHandler
    {
        public class Params : RevitBridge.Logic.Handlers.SyncModelHandler.Params { }
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.SyncModelHandler().Handle(app, jsonData);
    }
}
