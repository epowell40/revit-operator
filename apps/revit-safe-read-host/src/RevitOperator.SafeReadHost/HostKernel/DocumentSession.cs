using System;
using System.Security.Cryptography;
using System.Text;

namespace RevitOperator.SafeReadHost.HostKernel
{
    internal sealed class DocumentIdentityFacts
    {
        public DocumentIdentityFacts(object runtimeIdentity, string projectFingerprint, bool isValid, bool isModifiable, bool isModified)
        {
            RuntimeIdentity = runtimeIdentity;
            ProjectFingerprint = projectFingerprint;
            IsValid = isValid;
            IsModifiable = isModifiable;
            IsModified = isModified;
        }

        public object RuntimeIdentity { get; }
        public string ProjectFingerprint { get; }
        public bool IsValid { get; }
        public bool IsModifiable { get; }
        public bool IsModified { get; }
    }

    internal sealed class DocumentBinding
    {
        public DocumentBinding(object runtimeIdentity, string projectFingerprint, string documentSessionId, bool isModified)
        {
            RuntimeIdentity = runtimeIdentity;
            ProjectFingerprint = projectFingerprint;
            DocumentSessionId = documentSessionId;
            IsModified = isModified;
        }

        public object RuntimeIdentity { get; }
        public string ProjectFingerprint { get; }
        public string DocumentSessionId { get; }
        public bool IsModified { get; }
    }

    internal sealed class DocumentSessionTracker
    {
        private readonly object _sync = new object();
        private DocumentBinding? _current;

        public DocumentBinding? Current { get { lock (_sync) return _current; } }

        public DocumentBinding? Observe(DocumentIdentityFacts? facts)
        {
            lock (_sync)
            {
                if (facts == null || !facts.IsValid)
                {
                    _current = null;
                    return null;
                }
                if (_current == null || !ReferenceEquals(_current.RuntimeIdentity, facts.RuntimeIdentity) ||
                    !String.Equals(_current.ProjectFingerprint, facts.ProjectFingerprint, StringComparison.Ordinal))
                {
                    _current = new DocumentBinding(facts.RuntimeIdentity, facts.ProjectFingerprint, Guid.NewGuid().ToString("D"), facts.IsModified);
                }
                else if (_current.IsModified != facts.IsModified)
                {
                    _current = new DocumentBinding(_current.RuntimeIdentity, _current.ProjectFingerprint, _current.DocumentSessionId, facts.IsModified);
                }
                return _current;
            }
        }

        public void Clear() { lock (_sync) _current = null; }
        public void ClearIfCurrent(object runtimeIdentity) { lock (_sync) if (_current != null && ReferenceEquals(_current.RuntimeIdentity, runtimeIdentity)) _current = null; }
    }

    internal static class ProjectFingerprint
    {
        public static string Compute(string? title, string? path, string? uniqueId)
        {
            string input = (title ?? String.Empty).Normalize(NormalizationForm.FormC) + "\0" +
                           (path ?? String.Empty).Normalize(NormalizationForm.FormC) + "\0" +
                           (uniqueId ?? String.Empty).Normalize(NormalizationForm.FormC);
            using (SHA256 sha = SHA256.Create())
                return "sha256:" + Protocol.Hex(sha.ComputeHash(new UTF8Encoding(false).GetBytes(input)));
        }
    }

    internal static class DocumentBindingVerifier
    {
        public static CertifiedFailureCode Verify(DocumentBinding expected, DocumentIdentityFacts? actual, string? trackedSession)
        {
            if (actual == null || !actual.IsValid)
                return CertifiedFailureCode.NoActiveDocument;
            if (!ReferenceEquals(expected.RuntimeIdentity, actual.RuntimeIdentity) ||
                !String.Equals(expected.ProjectFingerprint, actual.ProjectFingerprint, StringComparison.Ordinal) ||
                !String.Equals(expected.DocumentSessionId, trackedSession, StringComparison.Ordinal) ||
                expected.IsModified != actual.IsModified)
                return CertifiedFailureCode.DocumentChanged;
            if (actual.IsModifiable)
                return CertifiedFailureCode.NotReadOnly;
            return CertifiedFailureCode.None;
        }
    }
}
