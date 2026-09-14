using System.Diagnostics;
using System.Text.Json;
using RevitOperator.DynamicRevitSdk;

namespace RevitOperator.DynamicRevitWorker;

internal sealed class GeneratedProgramFailure : Exception
{
    internal GeneratedProgramFailure(int replayIndex, DynamicProgramDiagnosticSnapshot snapshot, Exception cause)
        : base(cause.Message, cause) { ReplayIndex = replayIndex; Snapshot = snapshot; }
    internal int ReplayIndex { get; }
    internal DynamicProgramDiagnosticSnapshot Snapshot { get; }
}

internal static class GeneratedProgramDiagnostics
{
    internal static T Capture<T>(int replayIndex, Func<DynamicProgramDiagnosticSnapshot> snapshot, Func<T> execute)
    {
        try { return execute(); }
        catch (Exception error) { throw new GeneratedProgramFailure(replayIndex, snapshot(), error); }
    }

    internal static WorkerDiagnostic WithLocation(WorkerDiagnostic diagnostic, Exception error)
    {
        // Never serialize host stack traces or mapped arbitrary source paths.
        var frame = new StackTrace(error, true).GetFrames()?.FirstOrDefault(frame =>
            frame.GetMethod()?.DeclaringType?.Assembly.GetName().Name == "DynamicRevitProgram" &&
            frame.GetFileName() == "GeneratedProgram.cs" && frame.GetFileLineNumber() > 0);
        if (frame != null)
        {
            diagnostic.Line = frame.GetFileLineNumber();
            diagnostic.Column = frame.GetFileColumnNumber() > 0 ? frame.GetFileColumnNumber() : null;
        }
        return diagnostic;
    }

    internal static WorkerDiagnostic[] PartialOutput(Exception error) => Failures(error)
        .OrderBy(failure => failure.ReplayIndex).Take(2)
        .Where(failure => failure.Snapshot.Logs.Count > 0 || failure.Snapshot.Report.Count > 0)
        .Select(failure => new WorkerDiagnostic
        {
            Code = "PROGRAM_PARTIAL_OUTPUT", Phase = "execute", Severity = "info",
            RepairAction = "inspect_unverified_partial_output", Retryable = false,
            Message = PartialMessage(failure)
        }).ToArray();

    private static IEnumerable<GeneratedProgramFailure> Failures(Exception error)
    {
        if (error is GeneratedProgramFailure failure) yield return failure;
        else if (error is AggregateException aggregate)
        {
            foreach (var cause in aggregate.Flatten().InnerExceptions)
                foreach (var value in Failures(cause)) yield return value;
        }
        else if (error.InnerException != null)
            foreach (var value in Failures(error.InnerException)) yield return value;
    }

    private static string PartialMessage(GeneratedProgramFailure failure)
    {
        var logs = new List<string>();
        var report = new SortedDictionary<string, string>(StringComparer.Ordinal);
        string Serialize() => JsonSerializer.Serialize(new
        {
            authority = "diagnostic_only", partial = true, replayIndex = failure.ReplayIndex,
            logs, report, omittedLogs = failure.Snapshot.Logs.Count - logs.Count,
            omittedReportEntries = failure.Snapshot.Report.Count - report.Count
        }, Compiler.Json);
        // Reserve room inside the existing 2,048-character diagnostic contract.
        // Build valid JSON instead of truncating its serialization mid-string.
        foreach (var pair in failure.Snapshot.Report.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            report[pair.Key] = pair.Value;
            if (Serialize().Length > 1_900) report.Remove(pair.Key);
        }
        foreach (var log in failure.Snapshot.Logs)
        {
            logs.Add(log);
            if (Serialize().Length > 1_900) logs.RemoveAt(logs.Count - 1);
        }
        return Serialize();
    }
}
