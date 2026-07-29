using System;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitOperator.SafeReadHost.Kernel;

namespace RevitOperator.SafeReadHost
{
    internal static class RevitDocumentAccess
    {
        public static DocumentBinding? Observe(Document? document, DocumentSessionTracker tracker)
        {
            return tracker.Observe(CreateFacts(document));
        }

        public static FailureCode VerifyFull(
            UIApplication application,
            DocumentSessionTracker tracker,
            DocumentBinding expected)
        {
            DocumentIdentityFacts? facts = CaptureFacts(application);
            DocumentBinding? tracked = tracker.Current;
            string? sessionId = tracked == null ? null : tracked.DocumentSessionId;
            if (tracked == null || !object.ReferenceEquals(tracked.RuntimeIdentity, expected.RuntimeIdentity))
                return FailureCode.DocumentChanged;
            return DocumentBindingVerifier.Verify(expected, facts, sessionId);
        }

        public static DocumentIdentityFacts? CaptureFacts(UIApplication application)
        {
            UIDocument? active = application.ActiveUIDocument;
            return CreateFacts(active == null ? null : active.Document);
        }

        public static DocumentIdentityFacts? CreateFacts(Document? document)
        {
            if (document == null)
                return null;
            try
            {
                string projectUniqueId = string.Empty;
                ProjectInfo? projectInformation = document.ProjectInformation;
                if (projectInformation != null && projectInformation.IsValidObject)
                    projectUniqueId = projectInformation.UniqueId ?? string.Empty;
                string fingerprint = ProjectFingerprint.Compute(document.Title, document.PathName, projectUniqueId);
                return new DocumentIdentityFacts(
                    document,
                    fingerprint,
                    document.IsValidObject,
                    document.IsModifiable,
                    document.IsModified);
            }
            catch
            {
                return null;
            }
        }
    }
}
