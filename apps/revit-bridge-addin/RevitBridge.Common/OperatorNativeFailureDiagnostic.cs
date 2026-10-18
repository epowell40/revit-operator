using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    /// <summary>Bounded diagnostic context only; never transaction or verification authority.</summary>
    public static class OperatorNativeFailureDiagnostic
    {
        public static object Capture(Exception error, string stage)
        {
            // No arguments, messages, file names, source lines or exception Data.
            var methods = (new StackTrace(error, false).GetFrames() ?? Array.Empty<StackFrame>())
                .Take(24).Select(frame => frame.GetMethod())
                .Where(method => method != null)
                .Select(method => (method!.DeclaringType?.FullName ?? "unknown") + "." + method.Name)
                .Select(method => method.Length <= 512 ? method : method.Substring(0, 512)).ToArray();
            return new Dictionary<string, object?> {
                ["schema"] = "operator.native_failure_diagnostic.v1",
                ["stage"] = Regex.IsMatch(stage ?? "", "\\A[a-z_]{1,80}\\z") ? stage : "unknown",
                ["exceptionType"] = error.GetType().FullName,
                ["hResult"] = error.HResult,
                ["stackMethods"] = methods,
                ["authority"] = "diagnostic_only"
            };
        }
    }
}
