using System;

namespace RevitBridge.Common
{
    /// <summary>Keep auxiliary browser focus from swallowing a posted project-close command.</summary>
    public static class OperatorProjectCloseFocus
    {
        public static bool PrepareAndPost(string? activeViewType, Action restoreGraphicalView, Action postClose)
        {
            if (restoreGraphicalView == null) throw new ArgumentNullException(nameof(restoreGraphicalView));
            if (postClose == null) throw new ArgumentNullException(nameof(postClose));
            var restore = string.Equals(activeViewType, "ProjectBrowser", StringComparison.Ordinal)
                || string.Equals(activeViewType, "SystemBrowser", StringComparison.Ordinal);
            // A failed restoration must not arm a discard guard or post a close command.
            if (restore) restoreGraphicalView();
            postClose();
            return restore;
        }
    }
}
