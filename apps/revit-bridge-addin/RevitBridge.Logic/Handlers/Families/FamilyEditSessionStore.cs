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

        public static Session Create(Document projectDoc, Document familyDoc, Family family, long titleblockTypeId)
        {
            lock (_lock)
            {
                CleanupLocked();
                if (_sessions.Count >= MaxSessions)
                {
                    // Close the oldest session to make space.
                    string? oldestId = null;
                    DateTime oldest = DateTime.MaxValue;
                    foreach (var kv in _sessions)
                    {
                        if (kv.Value.LastAccessUtc < oldest)
                        {
                            oldest = kv.Value.LastAccessUtc;
                            oldestId = kv.Key;
                        }
                    }
                    if (!string.IsNullOrWhiteSpace(oldestId))
                    {
                        TryCloseLocked(oldestId!);
                    }
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
                try { s.FamilyDoc?.Close(false); } catch { }
            }
            catch
            {
                // ignore
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
            // TTL: 30 minutes idle.
            var now = DateTime.UtcNow;
            var expired = new List<string>();
            foreach (var kv in _sessions)
            {
                var s = kv.Value;
                if (s == null) { expired.Add(kv.Key); continue; }
                if ((now - s.LastAccessUtc).TotalMinutes > 30) expired.Add(kv.Key);
            }
            foreach (var id in expired)
            {
                TryCloseLocked(id);
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
