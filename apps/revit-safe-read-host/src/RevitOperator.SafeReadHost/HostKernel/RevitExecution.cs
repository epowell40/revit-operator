using System;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitOperator.SafeReadCertifiedExecution;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal static class RevitDocumentAccess
    {
        public static DocumentBinding? Observe(Document? document, DocumentSessionTracker tracker) => tracker.Observe(CreateFacts(document));

        public static CertifiedFailureCode Verify(UIApplication application, DocumentSessionTracker tracker, DocumentBinding expected)
        {
            DocumentBinding? tracked = tracker.Current;
            if (tracked == null || !ReferenceEquals(tracked.RuntimeIdentity, expected.RuntimeIdentity))
                return CertifiedFailureCode.DocumentChanged;
            return DocumentBindingVerifier.Verify(expected, CaptureFacts(application), tracked.DocumentSessionId);
        }

        public static DocumentIdentityFacts? CaptureFacts(UIApplication application)
        {
            UIDocument? active = application.ActiveUIDocument;
            return CreateFacts(active == null ? null : active.Document);
        }

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

    internal sealed class CertifiedSheetsCountExternalEventHandler : IExternalEventHandler
    {
        private readonly CertifiedExternalWorkSlot _slot;
        private readonly DocumentSessionTracker _tracker;

        public CertifiedSheetsCountExternalEventHandler(CertifiedExternalWorkSlot slot, DocumentSessionTracker tracker)
        {
            _slot = slot;
            _tracker = tracker;
        }

        public void Execute(UIApplication application)
        {
            CertifiedExternalWorkItem? item = _slot.Take();
            if (item == null) return;
            try
            {
                if (item.Phase == CertifiedExecutionPhase.CaptureBinding)
                {
                    CertifiedFailureCode verified = RevitDocumentAccess.Verify(application, _tracker, item.ExpectedBinding);
                    item.Complete(verified == CertifiedFailureCode.None
                        ? CertifiedExecutionResult.Captured(item.ExpectedBinding)
                        : CertifiedExecutionResult.Failure(item.Phase, verified, true));
                    return;
                }
                if (item.Phase != CertifiedExecutionPhase.CountSheets || item.AuthorizationToken == null ||
                    !item.AuthorizationToken.TryConsume(DateTimeOffset.UtcNow))
                {
                    item.Complete(CertifiedExecutionResult.Failure(item.Phase, CertifiedFailureCode.AuthorizationUnavailable, true));
                    return;
                }
                item.Complete(Count(application, item.ExpectedBinding));
            }
            catch
            {
                item.Complete(CertifiedExecutionResult.Failure(item.Phase, CertifiedFailureCode.RevitUnavailable, true));
            }
            finally
            {
                _slot.Release(item);
            }
        }

        public string GetName() => "Revit Operator Certified Safe Read Sheets Count";

        private CertifiedExecutionResult Count(UIApplication application, DocumentBinding expected)
        {
            CertifiedFailureCode before = RevitDocumentAccess.Verify(application, _tracker, expected);
            if (before != CertifiedFailureCode.None)
                return CertifiedExecutionResult.Failure(CertifiedExecutionPhase.CountSheets, before, true);
            UIDocument? active = application.ActiveUIDocument;
            Document? document = active == null ? null : active.Document;
            if (document == null || !ReferenceEquals(document, expected.RuntimeIdentity))
                return CertifiedExecutionResult.Failure(CertifiedExecutionPhase.CountSheets, CertifiedFailureCode.DocumentChanged, true);

            CertifiedSheetCountResult result = CertifiedSheetCountKernel.Execute(document);
            if (!result.Succeeded)
                return CertifiedExecutionResult.Failure(CertifiedExecutionPhase.CountSheets, MapFailure(result.FailureCode), true);

            CertifiedFailureCode after = RevitDocumentAccess.Verify(application, _tracker, expected);
            return after == CertifiedFailureCode.None
                ? CertifiedExecutionResult.Counted(expected, result.Count)
                : CertifiedExecutionResult.Failure(CertifiedExecutionPhase.CountSheets, after, true);
        }

        private static CertifiedFailureCode MapFailure(int code)
        {
            if (code == 1) return CertifiedFailureCode.NoActiveDocument;
            if (code == 2) return CertifiedFailureCode.NotReadOnly;
            if (code == 3) return CertifiedFailureCode.DocumentChanged;
            if (code == 4) return CertifiedFailureCode.CountLimitExceeded;
            return CertifiedFailureCode.InternalFailure;
        }
    }
}
