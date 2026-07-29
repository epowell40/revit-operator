namespace Autodesk.Revit.UI
{
    public enum ExternalEventRequest
    {
        Accepted = 0,
        Pending = 1,
        Denied = 2,
        TimedOut = 3,
    }

    public interface IExternalEventHandler
    {
        void Execute(UIApplication application);
        string GetName();
    }

    public sealed class UIApplication
    {
        private readonly UIDocument _activeUiDocument;

        public UIApplication(UIDocument activeUiDocument)
        {
            _activeUiDocument = activeUiDocument;
        }

        public UIDocument ActiveUIDocument
        {
            get { return _activeUiDocument; }
        }
    }

    public sealed class UIDocument
    {
        private readonly Autodesk.Revit.DB.Document _document;

        public UIDocument(Autodesk.Revit.DB.Document document)
        {
            _document = document;
        }

        public Autodesk.Revit.DB.Document Document
        {
            get { return _document; }
        }
    }

    public sealed class ExternalEvent
    {
        private readonly IExternalEventHandler _handler;

        private ExternalEvent(IExternalEventHandler handler)
        {
            _handler = handler;
        }

        public static ExternalEvent Create(IExternalEventHandler handler)
        {
            return new ExternalEvent(handler);
        }

        public ExternalEventRequest Raise()
        {
            _handler.GetName();
            return ExternalEventRequest.Accepted;
        }
    }
}
