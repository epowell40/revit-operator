using System.Threading.Tasks;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public class ListElementTypesHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.ListElementTypesHandler().Handle(app, jsonData);
    }

    public class ChangeElementTypeHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.ChangeElementTypeHandler().Handle(app, jsonData);
    }

    public class ResolveElementTypeHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.ResolveElementTypeHandler().Handle(app, jsonData);
    }

    public class ReplaceDoorHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.ReplaceDoorHandler().Handle(app, jsonData);
    }

    public class DuplicateElementTypeHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.DuplicateElementTypeHandler().Handle(app, jsonData);
    }

    public class SetTypeParametersHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.SetTypeParametersHandler().Handle(app, jsonData);
    }

    public class DuplicateTypeAndSwapInstanceHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) =>
            new RevitBridge.Logic.Handlers.DuplicateTypeAndSwapInstanceHandler().Handle(app, jsonData);
    }
}
