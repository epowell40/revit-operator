using System;

namespace Autodesk.Revit.DB
{
    public class ProjectInfo { public bool IsValidObject { get; set; } = true; public string UniqueId { get; set; } = String.Empty; }
    public class Document
    {
        public string Title { get; set; } = String.Empty;
        public string PathName { get; set; } = String.Empty;
        public bool IsValidObject { get; set; } = true;
        public bool IsModifiable { get; set; }
        public bool IsModified { get; set; }
        public ProjectInfo? ProjectInformation { get; set; } = new ProjectInfo();
    }
    public class View { public Document Document { get; set; } = new Document(); }
}

namespace Autodesk.Revit.DB.Events
{
    using Autodesk.Revit.DB;
    public class DocumentChangedEventArgs : EventArgs { public Document Document { get; set; } = new Document(); public Document GetDocument() => Document; }
    public class DocumentSavingEventArgs : EventArgs { public Document Document { get; set; } = new Document(); }
    public class DocumentSavedEventArgs : EventArgs { public Document Document { get; set; } = new Document(); }
    public class DocumentSavingAsEventArgs : EventArgs { public Document Document { get; set; } = new Document(); }
    public class DocumentSavedAsEventArgs : EventArgs { public Document Document { get; set; } = new Document(); }
    public class DocumentClosingEventArgs : EventArgs { public Document Document { get; set; } = new Document(); }
}

namespace Autodesk.Revit.ApplicationServices
{
    using Autodesk.Revit.DB.Events;
    public class ControlledApplication
    {
        public string VersionNumber { get; set; } = "2025";
        public event EventHandler<DocumentChangedEventArgs>? DocumentChanged;
        public event EventHandler<DocumentSavingEventArgs>? DocumentSaving;
        public event EventHandler<DocumentSavedEventArgs>? DocumentSaved;
        public event EventHandler<DocumentSavingAsEventArgs>? DocumentSavingAs;
        public event EventHandler<DocumentSavedAsEventArgs>? DocumentSavedAs;
        public event EventHandler<DocumentClosingEventArgs>? DocumentClosing;
    }
}

namespace Autodesk.Revit.UI.Events
{
    using Autodesk.Revit.DB;
    public class ViewActivatedEventArgs : EventArgs { public View? CurrentActiveView { get; set; } }
}

namespace Autodesk.Revit.UI
{
    using Autodesk.Revit.ApplicationServices;
    using Autodesk.Revit.DB;
    using Autodesk.Revit.UI.Events;
    public enum Result { Succeeded, Failed, Cancelled }
    public enum ExternalEventRequest { Accepted, Pending, Denied, TimedOut }
    public interface IExternalApplication { Result OnStartup(UIControlledApplication application); Result OnShutdown(UIControlledApplication application); }
    public interface IExternalEventHandler { void Execute(UIApplication application); string GetName(); }
    public sealed class ExternalEvent : IDisposable
    {
        public static ExternalEvent Create(IExternalEventHandler handler) => new ExternalEvent();
        public ExternalEventRequest NextResult { get; set; } = ExternalEventRequest.Accepted;
        public ExternalEventRequest Raise() => NextResult;
        public void Dispose() { }
    }
    public class UIDocument { public Document Document { get; set; } = new Document(); }
    public class UIApplication { public UIDocument? ActiveUIDocument { get; set; } }
    public class UIControlledApplication
    {
        public ControlledApplication ControlledApplication { get; set; } = new ControlledApplication();
        public event EventHandler<ViewActivatedEventArgs>? ViewActivated;
    }
}

namespace RevitOperator.SafeReadCertifiedExecution
{
    using Autodesk.Revit.DB;
    public sealed class CertifiedSheetCountResult
    {
        public bool Succeeded { get; set; }
        public int Count { get; set; }
        public int FailureCode { get; set; }
    }
    public static class CertifiedSheetCountKernel
    {
        public static Func<Document, CertifiedSheetCountResult>? ExecuteOverride { get; set; }
        public static CertifiedSheetCountResult Execute(Document document) => ExecuteOverride == null ? new CertifiedSheetCountResult { Succeeded = true } : ExecuteOverride(document);
    }
}
