using System.Threading.Tasks;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public class CreateDuctHandler : IRequestHandler
    {
        // Keep a directly declared Params type for native tool-schema discovery.
        public class Params : RevitBridge.Logic.Handlers.CreateDuctHandler.Params { }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            return new RevitBridge.Logic.Handlers.CreateDuctHandler().Handle(app, jsonData);
        }
    }
}
