using Autodesk.Revit.UI;
using RevitBridge.Common;
using System.Threading.Tasks;

namespace RevitBridge.Handlers
{
    public sealed class GetFamilyFilePathHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.GetFamilyFilePathHandler().Handle(app, jsonData);
    }

    public sealed class OpenFamilyDocHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.OpenFamilyDocHandler().Handle(app, jsonData);
    }

    public sealed class FindTextNotesHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.FindTextNotesHandler().Handle(app, jsonData);
    }

    public sealed class ReplaceTextNoteHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.ReplaceTextNoteHandler().Handle(app, jsonData);
    }

    public sealed class SaveFamilyDocHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.SaveFamilyDocHandler().Handle(app, jsonData);
    }

    public sealed class LoadFamilyDocHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.LoadFamilyDocHandler().Handle(app, jsonData);
    }

    public sealed class CloseDocHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.CloseDocHandler().Handle(app, jsonData);
    }

    public sealed class EditFamilyFromInstanceHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.EditFamilyFromInstanceHandler().Handle(app, jsonData);
    }

    public sealed class InspectFamilyContentHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.InspectFamilyContentHandler().Handle(app, jsonData);
    }

    public sealed class FindFamilyTextNotesHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.FindFamilyTextNotesHandler().Handle(app, jsonData);
    }

    public sealed class SetTextNoteTextHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.SetTextNoteTextHandler().Handle(app, jsonData);
    }

    public sealed class ReloadFamilyEditSessionHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => new RevitBridge.Logic.Handlers.ReloadFamilyEditSessionHandler().Handle(app, jsonData);
    }
}
