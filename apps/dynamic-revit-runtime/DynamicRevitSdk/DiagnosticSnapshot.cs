using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("DynamicRevitWorker")]

namespace RevitOperator.DynamicRevitSdk;

// Worker-only copies of unverified program text. Capturing diagnostics never
// builds an operation graph or claims that a partial program completed.
internal sealed class DynamicProgramDiagnosticSnapshot
{
    internal DynamicProgramDiagnosticSnapshot(IReadOnlyList<string> logs, IReadOnlyDictionary<string, string> report)
    {
        Logs = logs.ToArray();
        Report = report.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
    }
    internal IReadOnlyList<string> Logs { get; }
    internal IReadOnlyDictionary<string, string> Report { get; }
}
