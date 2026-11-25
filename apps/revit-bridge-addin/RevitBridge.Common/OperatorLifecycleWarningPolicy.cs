using System;
using System.Collections.Generic;

namespace RevitBridge.Common
{
    public static class OperatorLifecycleWarningPolicy
    {
        // Equivalent to acknowledging a warning-only dialog for this invocation.
        // Never resolve errors, recommit, roll back, or override another processor.
        public static bool Acknowledge<T>(bool ownsCurrentInvocation, bool processingContinues,
            IReadOnlyList<T> messages, Func<T, bool> isWarning, Action<T> retain, Action<T> acknowledge)
        {
            if (!ownsCurrentInvocation || !processingContinues || messages.Count == 0) return false;
            bool warningsOnly = true;
            foreach (var message in messages) warningsOnly &= isWarning(message);
            // Retain the entire observation before dismissing any warning. A failed
            // observation leaves the dialog available for normal human handling.
            foreach (var message in messages) retain(message);
            if (!warningsOnly) return false;
            foreach (var message in messages) acknowledge(message);
            return true;
        }
    }
}
