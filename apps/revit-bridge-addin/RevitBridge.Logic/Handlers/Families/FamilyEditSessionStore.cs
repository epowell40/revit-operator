using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;

namespace RevitBridge.Logic.Handlers
{
    internal static class FamilyEditSessionStore
    {
        internal sealed class Session
        {
            public string SessionId = "";
            public Document ProjectDoc = null!;
            public Document FamilyDoc = null!;
            public string FamilyName = "";
            public long FamilyId;
            public long TitleblockTypeId;
            public string? SourceFilePath;
            public DateTime CreatedUtc;
            public DateTime LastAccessUtc;
        }

        private static readonly object _lock = new object();
        private static readonly Dictionary<string, Session> _sessions = new Dictionary<string, Session>(StringComparer.OrdinalIgnoreCase);
        private const int MaxSessions = 3;

        public static void EnsureCapacity()
        {
            lock (_lock)
            {
                CleanupLocked();
                if (_sessions.Count >= MaxSessions)
                    throw new InvalidOperationException("Close an existing family edit session before opening another; retained edits were not discarded.");
            }
        }

        public static object OpenReceipt(Session session, string sourceKind, string sourceId)
        {
            lock (_lock)
            {
                var registered = _sessions.TryGetValue(session.SessionId, out var retained) && ReferenceEquals(retained, session);
                return RevitBridge.Common.OperatorFamilySessionReceipt.Opened(session.SessionId, sourceKind, sourceId,
                    session.ProjectDoc.IsValidObject && session.FamilyDoc.IsValidObject && session.FamilyDoc.IsFamilyDocument, registered);
            }
        }

        public static Session Create(Document projectDoc, Document familyDoc, Family family, long titleblockTypeId)
        {
            lock (_lock)
            {
                CleanupLocked();
                if (_sessions.Count >= MaxSessions)
                {
                    throw new InvalidOperationException("Close an existing family edit session before opening another; retained edits were not discarded.");
                }

                var id = Guid.NewGuid().ToString("N");
                var now = DateTime.UtcNow;
                var s = new Session
                {
                    SessionId = id,
                    ProjectDoc = projectDoc,
                    FamilyDoc = familyDoc,
                    FamilyName = family?.Name ?? "",
                    FamilyId = RevitBridge.Common.ElementIdCompat.GetValue(family?.Id),
                    TitleblockTypeId = titleblockTypeId,
                    SourceFilePath = SafePathName(familyDoc),
                    CreatedUtc = now,
                    LastAccessUtc = now
                };
                _sessions[id] = s;
                return s;
            }
        }

        public static Session CreateFromExternalFile(Document projectDoc, Document familyDoc)
        {
            var fam = familyDoc?.OwnerFamily;
            return Create(projectDoc, familyDoc, fam ?? throw new InvalidOperationException("Family document has no OwnerFamily."), titleblockTypeId: 0);
        }

        public static bool TryGet(string sessionId, out Session session, out string? error)
        {
            session = null!;
            error = null;
            if (string.IsNullOrWhiteSpace(sessionId))
            {
                error = "familyDocumentId is required.";
                return false;
            }

            lock (_lock)
            {
                CleanupLocked();
                if (!_sessions.TryGetValue(sessionId.Trim(), out var s) || s == null)
                {
                    error = "Family edit session not found (expired or closed).";
                    return false;
                }

                if (s.ProjectDoc == null || s.FamilyDoc == null)
                {
                    error = "Family edit session is invalid.";
                    return false;
                }

                s.LastAccessUtc = DateTime.UtcNow;
                session = s;
                return true;
            }
        }

        public static bool TryClose(string sessionId, out string? error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(sessionId))
            {
                error = "familyDocumentId is required.";
                return false;
            }

            lock (_lock)
            {
                CleanupLocked();
                return TryCloseLocked(sessionId.Trim(), out error);
            }
        }

        public static bool TryRemove(string sessionId, out string? error)
        {
            error = null;
            if (string.IsNullOrWhiteSpace(sessionId))
            {
                error = "familyDocumentId is required.";
                return false;
            }

            lock (_lock)
            {
                CleanupLocked();
                if (!_sessions.ContainsKey(sessionId.Trim()))
                {
                    error = "Family edit session not found.";
                    return false;
                }
                _sessions.Remove(sessionId.Trim());
                return true;
            }
        }

        private static bool TryCloseLocked(string sessionId, out string? error)
        {
            error = null;
            if (!_sessions.TryGetValue(sessionId, out var s) || s == null)
            {
                error = "Family edit session not found.";
                return false;
            }

            try
            {
                if (!s.FamilyDoc.Close(false) || s.FamilyDoc.IsValidObject)
                {
                    error = "Revit did not confirm family document closure; session retained.";
                    return false;
                }
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
            _sessions.Remove(sessionId);
            return true;
        }

        private static void TryCloseLocked(string sessionId)
        {
            try { TryCloseLocked(sessionId, out var _); } catch { }
        }

        private static void CleanupLocked()
        {
            // Session lookup/open must never discard another session's edits.
            // Remove only documents which Revit has already closed.
            var expired = new List<string>();
            foreach (var kv in _sessions)
            {
                var s = kv.Value;
                if (s == null) { expired.Add(kv.Key); continue; }
                if (s.FamilyDoc == null || !s.FamilyDoc.IsValidObject) expired.Add(kv.Key);
            }
            foreach (var id in expired)
            {
                _sessions.Remove(id);
            }
        }

        private static string? SafePathName(Document familyDoc)
        {
            try
            {
                var p = familyDoc?.PathName;
                return string.IsNullOrWhiteSpace(p) ? null : p;
            }
            catch { return null; }
        }
    }
}
