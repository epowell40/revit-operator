using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;

namespace RevitOperator.SafeReadHost.Kernel
{
    internal sealed class DocumentIdentityFacts
    {
        public DocumentIdentityFacts(
            object runtimeIdentity,
            string projectFingerprint,
            bool isValid,
            bool isModifiable,
            bool isModified)
        {
            RuntimeIdentity = runtimeIdentity ?? throw new ArgumentNullException(nameof(runtimeIdentity));
            ProjectFingerprint = projectFingerprint ?? string.Empty;
            IsValid = isValid;
            IsModifiable = isModifiable;
            IsModified = isModified;
        }

        public object RuntimeIdentity { get; private set; }
        public string ProjectFingerprint { get; private set; }
        public bool IsValid { get; private set; }
        public bool IsModifiable { get; private set; }
        public bool IsModified { get; private set; }
    }

    internal sealed class DocumentBinding
    {
        public DocumentBinding(
            object runtimeIdentity,
            string projectFingerprint,
            string documentSessionId,
            bool isModified)
        {
            if (runtimeIdentity == null)
                throw new ArgumentNullException(nameof(runtimeIdentity));
            if (!ProtocolValidation.IsSha256(projectFingerprint))
                throw new ArgumentException("projectFingerprint is not SHA-256.", nameof(projectFingerprint));
            if (!ProtocolValidation.IsCanonicalGuid(documentSessionId))
                throw new ArgumentException("documentSessionId is not canonical.", nameof(documentSessionId));
            RuntimeIdentity = runtimeIdentity;
            ProjectFingerprint = projectFingerprint;
            DocumentSessionId = documentSessionId;
            IsModified = isModified;
        }

        public object RuntimeIdentity { get; private set; }
        public string ProjectFingerprint { get; private set; }
        public string DocumentSessionId { get; private set; }
        public bool IsModified { get; private set; }
    }

    internal sealed class DocumentSessionTracker
    {
        private readonly object _sync = new object();
        private readonly List<OpenDocumentSession> _openDocuments = new List<OpenDocumentSession>();
        private DocumentBinding? _current;

        public DocumentBinding? Observe(DocumentIdentityFacts? facts)
        {
            lock (_sync)
            {
                if (facts == null || !facts.IsValid || !ProtocolValidation.IsSha256(facts.ProjectFingerprint))
                {
                    _current = null;
                    return null;
                }

                OpenDocumentSession? openSession = Find(facts.RuntimeIdentity);
                if (openSession == null)
                {
                    openSession = new OpenDocumentSession(
                        facts.RuntimeIdentity,
                        facts.ProjectFingerprint,
                        Guid.NewGuid().ToString("D"));
                    _openDocuments.Add(openSession);
                }
                else if (!string.Equals(openSession.ProjectFingerprint, facts.ProjectFingerprint, StringComparison.Ordinal))
                {
                    openSession.ProjectFingerprint = facts.ProjectFingerprint;
                    openSession.DocumentSessionId = Guid.NewGuid().ToString("D");
                }
                _current = new DocumentBinding(
                    facts.RuntimeIdentity,
                    facts.ProjectFingerprint,
                    openSession.DocumentSessionId,
                    facts.IsModified);
                return _current;
            }
        }

        public void ClearIfCurrent(object? runtimeIdentity)
        {
            lock (_sync)
            {
                for (int index = _openDocuments.Count - 1; index >= 0; index--)
                {
                    if (object.ReferenceEquals(_openDocuments[index].RuntimeIdentity, runtimeIdentity))
                        _openDocuments.RemoveAt(index);
                }
                if (_current != null && object.ReferenceEquals(_current.RuntimeIdentity, runtimeIdentity))
                    _current = null;
            }
        }

        public void Clear()
        {
            lock (_sync)
            {
                _current = null;
                _openDocuments.Clear();
            }
        }

        public DocumentBinding? Current
        {
            get
            {
                lock (_sync)
                    return _current;
            }
        }

        private OpenDocumentSession? Find(object runtimeIdentity)
        {
            for (int index = 0; index < _openDocuments.Count; index++)
            {
                if (object.ReferenceEquals(_openDocuments[index].RuntimeIdentity, runtimeIdentity))
                    return _openDocuments[index];
            }
            return null;
        }

        private sealed class OpenDocumentSession
        {
            public OpenDocumentSession(object runtimeIdentity, string projectFingerprint, string documentSessionId)
            {
                RuntimeIdentity = runtimeIdentity;
                ProjectFingerprint = projectFingerprint;
                DocumentSessionId = documentSessionId;
            }

            public object RuntimeIdentity { get; private set; }
            public string ProjectFingerprint { get; set; }
            public string DocumentSessionId { get; set; }
        }
    }

    internal static class DocumentBindingVerifier
    {
        public static FailureCode Verify(DocumentBinding? expected, DocumentIdentityFacts? current, string? currentSessionId)
        {
            if (expected == null || current == null || !current.IsValid)
                return FailureCode.DocumentChanged;
            if (!object.ReferenceEquals(expected.RuntimeIdentity, current.RuntimeIdentity))
                return FailureCode.DocumentChanged;
            if (!string.Equals(expected.ProjectFingerprint, current.ProjectFingerprint, StringComparison.Ordinal))
                return FailureCode.DocumentChanged;
            if (!string.Equals(expected.DocumentSessionId, currentSessionId, StringComparison.Ordinal))
                return FailureCode.DocumentChanged;
            if (current.IsModifiable)
                return FailureCode.NotReadOnly;
            if (current.IsModified != expected.IsModified)
                return FailureCode.DocumentChanged;
            return FailureCode.None;
        }
    }

    internal static class ProjectFingerprint
    {
        public static string Compute(string? title, string? path, string? projectUniqueId)
        {
            string normalizedTitle = NormalizeText(title);
            string normalizedPath = NormalizePath(path);
            string normalizedUniqueId = NormalizeText(projectUniqueId);
            string canonical = LengthPrefix(normalizedTitle) + LengthPrefix(normalizedPath) + LengthPrefix(normalizedUniqueId);
            byte[] bytes = Encoding.UTF8.GetBytes(canonical);
            using (SHA256 algorithm = SHA256.Create())
            {
                byte[] digest = algorithm.ComputeHash(bytes);
                StringBuilder builder = new StringBuilder(64);
                for (int index = 0; index < digest.Length; index++)
                    builder.Append(digest[index].ToString("x2"));
                return "sha256:" + builder.ToString();
            }
        }

        private static string NormalizeText(string? value)
        {
            return (value ?? string.Empty).Trim().Normalize(NormalizationForm.FormC);
        }

        private static string NormalizePath(string? value)
        {
            return NormalizeText(value).Replace('/', '\\').ToUpperInvariant();
        }

        private static string LengthPrefix(string value)
        {
            return value.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + value + "|";
        }
    }
}
