using System;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitOperator.SafeReadHost.Kernel;

namespace RevitOperator.SafeReadHost
{
    internal sealed class CertifiedSheetsCountExternalEventHandler : IExternalEventHandler
    {
        private readonly CertifiedExternalWorkSlot _workSlot;
        private readonly DocumentSessionTracker _documentTracker;

        public CertifiedSheetsCountExternalEventHandler(
            CertifiedExternalWorkSlot workSlot,
            DocumentSessionTracker documentTracker)
        {
            _workSlot = workSlot ?? throw new ArgumentNullException(nameof(workSlot));
            _documentTracker = documentTracker ?? throw new ArgumentNullException(nameof(documentTracker));
        }

        public void Execute(UIApplication application)
        {
            CertifiedExternalWorkItem? workItem = _workSlot.Take();
            if (workItem == null)
                return;
            try
            {
                if (workItem.Phase == CertifiedExternalWorkPhase.CaptureBinding)
                {
                    FailureCode capture = RevitDocumentAccess.VerifyFull(
                        application,
                        _documentTracker,
                        workItem.ExpectedBinding);
                    workItem.Complete(capture == FailureCode.None
                        ? CertifiedExternalWorkResult.Captured(workItem.ExpectedBinding)
                        : CertifiedExternalWorkResult.Failure(capture));
                    return;
                }

                if (workItem.Phase == CertifiedExternalWorkPhase.CountSheets)
                {
                    if (workItem.AuthorizationExpiresAtUtc <= DateTimeOffset.UtcNow)
                    {
                        workItem.Complete(CertifiedExternalWorkResult.Failure(FailureCode.AuthorizationUnavailable));
                        return;
                    }
                    workItem.Complete(CountSheets(application, workItem.ExpectedBinding));
                    return;
                }

                workItem.Complete(CertifiedExternalWorkResult.Failure(FailureCode.InternalFailure));
            }
            catch
            {
                workItem.Complete(CertifiedExternalWorkResult.Failure(FailureCode.RevitUnavailable));
            }
        }

        public string GetName()
        {
            return "Revit Operator Certified Safe Read Sheets Count";
        }

        private CertifiedExternalWorkResult CountSheets(UIApplication application, DocumentBinding expected)
        {
            FailureCode before = RevitDocumentAccess.VerifyFull(application, _documentTracker, expected);
            if (before != FailureCode.None)
                return CertifiedExternalWorkResult.Failure(before);

            UIDocument? active = application.ActiveUIDocument;
            Document? document = active == null ? null : active.Document;
            if (document == null || !object.ReferenceEquals(document, expected.RuntimeIdentity))
                return CertifiedExternalWorkResult.Failure(FailureCode.DocumentChanged);

            int count = 0;
            FilteredElementCollector collector = new FilteredElementCollector(document);
            collector.OfClass(typeof(ViewSheet));
            using (FilteredElementIterator iterator = collector.GetElementIterator())
            {
                while (iterator.MoveNext())
                {
                    FailureCode inside = RevitDocumentAccess.VerifyFull(
                        application,
                        _documentTracker,
                        expected);
                    if (inside != FailureCode.None)
                        return CertifiedExternalWorkResult.Failure(inside);

                    Element? element = iterator.Current as Element;
                    ViewSheet? sheet = element as ViewSheet;
                    if (sheet == null || sheet.IsPlaceholder)
                        continue;
                    count++;
                    if (count > SafeReadContract.MaximumSheetCount)
                        return CertifiedExternalWorkResult.Failure(FailureCode.CountLimitExceeded);
                }
            }

            FailureCode after = RevitDocumentAccess.VerifyFull(application, _documentTracker, expected);
            if (after != FailureCode.None)
                return CertifiedExternalWorkResult.Failure(after);
            return CertifiedExternalWorkResult.Counted(expected, count);
        }
    }
}
