using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;

namespace RevitBridge.Logic.Handlers
{
    internal sealed class StoredViewFrame
    {
        public string frameId { get; set; } = "";
        public long viewId { get; set; }
        public string viewType { get; set; } = "";
        public string viewName { get; set; } = "";
        public string path { get; set; } = "";
        public int widthPx { get; set; }
        public int heightPx { get; set; }
        public XYZ topLeft { get; set; } = XYZ.Zero;
        public XYZ topRight { get; set; } = XYZ.Zero;
        public XYZ bottomLeft { get; set; } = XYZ.Zero;
        public DateTime createdUtc { get; set; }
    }

    internal static class FrameStore
    {
        private static readonly object Sync = new object();
        private static readonly Dictionary<string, StoredViewFrame> Frames = new Dictionary<string, StoredViewFrame>(StringComparer.OrdinalIgnoreCase);
        private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(10);

        public static StoredViewFrame Put(StoredViewFrame frame)
        {
            lock (Sync)
            {
                CleanupNoLock(DateTime.UtcNow);
                Frames[frame.frameId] = frame;
                return frame;
            }
        }

        public static bool TryGet(string frameId, out StoredViewFrame? frame)
        {
            var now = DateTime.UtcNow;
            lock (Sync)
            {
                CleanupNoLock(now);
                if (Frames.TryGetValue(frameId, out var f))
                {
                    frame = f;
                    return true;
                }
            }
            frame = null;
            return false;
        }

        private static void CleanupNoLock(DateTime nowUtc)
        {
            if (Frames.Count == 0) return;
            var toRemove = new List<string>();
            foreach (var kvp in Frames)
            {
                if (nowUtc - kvp.Value.createdUtc > Ttl)
                    toRemove.Add(kvp.Key);
            }
            foreach (var key in toRemove) Frames.Remove(key);
        }
    }
}
