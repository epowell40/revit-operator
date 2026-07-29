using System;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitOperator.SafeReadCertifiedExecution
{
    public static class RevitDocumentAccess
    {
        public static DocumentBinding? Observe(Document? document, DocumentSessionTracker tracker) => tracker.Observe(CreateFacts(document));
        public static CertifiedFailureCode Verify(UIApplication application, DocumentSessionTracker tracker, DocumentBinding expected)
        {
            DocumentBinding? tracked = tracker.Current;
            if (tracked == null || !ReferenceEquals(tracked.RuntimeIdentity, expected.RuntimeIdentity)) return CertifiedFailureCode.DocumentChanged;
            return DocumentBindingVerifier.Verify(expected, CaptureFacts(application), tracked.DocumentSessionId);
        }
        public static DocumentIdentityFacts? CaptureFacts(UIApplication application)
        { UIDocument? active = application.ActiveUIDocument; return CreateFacts(active == null ? null : active.Document); }
        public static DocumentIdentityFacts? CreateFacts(Document? document)
        {
            if (document == null) return null;
            try
            {
                string uniqueId = String.Empty;
                ProjectInfo? info = document.ProjectInformation;
                if (info != null && info.IsValidObject) uniqueId = info.UniqueId ?? String.Empty;
                return new DocumentIdentityFacts(document, ProjectFingerprint.Compute(document.Title, document.PathName, uniqueId), document.IsValidObject, document.IsModifiable, document.IsModified);
            }
            catch { return null; }
        }
    }

    public sealed class CertifiedSheetsCountExternalEventHandler : IExternalEventHandler
    {
        private const int MaximumSheetCount = 100000;
        private readonly CertifiedExternalWorkSlot _slot;
        private readonly DocumentSessionTracker _tracker;
        public CertifiedSheetsCountExternalEventHandler(CertifiedExternalWorkSlot slot, DocumentSessionTracker tracker) { _slot = slot; _tracker = tracker; }
        public void Execute(UIApplication application)
        {
            CertifiedExternalWorkItem? item = _slot.Take();
            if (item == null) return;
            try
            {
                if (item.Phase == CertifiedExecutionPhase.CaptureBinding)
                {
                    CertifiedFailureCode verified = RevitDocumentAccess.Verify(application, _tracker, item.ExpectedBinding);
                    item.Complete(verified == CertifiedFailureCode.None ? CertifiedExecutionResult.Captured(item.ExpectedBinding) : CertifiedExecutionResult.Failure(item.Phase, verified));
                    return;
                }
                if (item.Phase != CertifiedExecutionPhase.CountSheets || item.AuthorizationToken == null || !item.AuthorizationToken.TryConsume(DateTimeOffset.UtcNow))
                { item.Complete(CertifiedExecutionResult.Failure(item.Phase, CertifiedFailureCode.AuthorizationUnavailable)); return; }
                item.Complete(Count(application, item.ExpectedBinding));
            }
            catch { item.Complete(CertifiedExecutionResult.Failure(item.Phase, CertifiedFailureCode.RevitUnavailable)); }
            finally { _slot.Release(item); }
        }
        public string GetName() => "Revit Operator Certified Safe Read Sheets Count";
        private CertifiedExecutionResult Count(UIApplication application, DocumentBinding expected)
        {
            CertifiedFailureCode before = RevitDocumentAccess.Verify(application, _tracker, expected);
            if (before != CertifiedFailureCode.None) return CertifiedExecutionResult.Failure(CertifiedExecutionPhase.CountSheets, before);
            UIDocument? active = application.ActiveUIDocument; Document? document = active == null ? null : active.Document;
            if (document == null || !ReferenceEquals(document, expected.RuntimeIdentity)) return CertifiedExecutionResult.Failure(CertifiedExecutionPhase.CountSheets, CertifiedFailureCode.DocumentChanged);
            int count = 0;
            FilteredElementCollector collector = new FilteredElementCollector(document).OfClass(typeof(ViewSheet));
            using (FilteredElementIterator iterator = collector.GetElementIterator())
            {
                while (iterator.MoveNext())
                {
                    CertifiedFailureCode inside = RevitDocumentAccess.Verify(application, _tracker, expected);
                    if (inside != CertifiedFailureCode.None) return CertifiedExecutionResult.Failure(CertifiedExecutionPhase.CountSheets, inside);
                    ViewSheet? sheet = iterator.Current as ViewSheet;
                    if (sheet == null || sheet.IsPlaceholder) continue;
                    if (++count > MaximumSheetCount) return CertifiedExecutionResult.Failure(CertifiedExecutionPhase.CountSheets, CertifiedFailureCode.CountLimitExceeded);
                }
            }
            CertifiedFailureCode after = RevitDocumentAccess.Verify(application, _tracker, expected);
            return after == CertifiedFailureCode.None ? CertifiedExecutionResult.Counted(expected, count) : CertifiedExecutionResult.Failure(CertifiedExecutionPhase.CountSheets, after);
        }
    }
}
