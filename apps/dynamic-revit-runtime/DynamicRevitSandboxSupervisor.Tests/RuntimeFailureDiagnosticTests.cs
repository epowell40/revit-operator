using System.Text.Json;
using RevitOperator.DynamicRevitSdk;
using RevitOperator.DynamicRevitWorker;
using Xunit;

namespace RevitOperator.DynamicRevitSandboxSupervisor.Tests;

public sealed class RuntimeFailureDiagnosticTests
{
    private const string Source = """
using System;
using RevitOperator.DynamicRevitSdk;
public sealed class PartialReportProbe : IDynamicRevitProgram
{
    public DynamicProgramResult Execute(DynamicRevitContext context)
    {
        context.Log("Reviewed the supplied duct snapshot.");
        context.Report("Inspected", "20");
        context.Plan.SetParameter("fixture-duct", "Comments", "must never execute");
        throw new InvalidOperationException("Missing flow needed for the next calculation.");
    }
}
""";

    [Fact]
    public void FailedReplaysRetainDiagnosticTextAndSourceLineWithoutAnExecutableGraph()
    {
        var result = WorkerExecutor.Execute(new WorkerInput { Source = Source, Input = new DynamicTaskInput { OperationBudget = 1 } });
        AssertFailure(result);
        var error = Assert.Single(result.Diagnostics, value => value.Code == "PROGRAM_EXCEPTION");
        Assert.Equal(10, error.Line);
        Assert.DoesNotContain("C:\\", error.Message);
        var partials = result.Diagnostics.Where(value => value.Code == "PROGRAM_PARTIAL_OUTPUT").ToArray();
        Assert.Equal(2, partials.Length);
        for (var index = 0; index < partials.Length; index++)
        {
            Assert.Equal("info", partials[index].Severity);
            Assert.False(partials[index].Retryable);
            using var message = JsonDocument.Parse(partials[index].Message);
            var root = message.RootElement;
            Assert.Equal("diagnostic_only", root.GetProperty("authority").GetString());
            Assert.True(root.GetProperty("partial").GetBoolean());
            Assert.Equal(index, root.GetProperty("replayIndex").GetInt32());
            Assert.Equal("20", root.GetProperty("report").GetProperty("Inspected").GetString());
            Assert.Equal("Reviewed the supplied duct snapshot.", root.GetProperty("logs")[0].GetString());
        }
        Assert.Matches("^sha256:[a-f0-9]{64}$", result.DiagnosticBundleHash);
    }

    [Fact]
    public void CachedAssemblyRetainsGeneratedSourceLocationsAndDiagnosticIdentity()
    {
        var key = DynamicWire.Sha256("diagnostic-cache-fixture");
        var first = WorkerExecutor.Execute(new WorkerInput { Source = Source, CompilationCacheKey = key });
        AssertFailure(first);
        Assert.NotEmpty(first.CompiledAssemblyBase64!);
        var cached = WorkerExecutor.Execute(new WorkerInput { Source = Source, CompilationCacheKey = key, CachedAssemblyBase64 = first.CompiledAssemblyBase64 });
        AssertFailure(cached);
        Assert.True(cached.CompilationCacheHit);
        Assert.Equal(first.CompiledAssemblyHash, cached.CompiledAssemblyHash);
        Assert.Equal(first.DiagnosticBundleHash, cached.DiagnosticBundleHash);
        Assert.Equal(10, Assert.Single(cached.Diagnostics, value => value.Code == "PROGRAM_EXCEPTION").Line);
    }

    [Fact]
    public void OversizedPartialOutputRemainsBoundedValidJsonWithExplicitOmissionCounts()
    {
        var source = Source.Replace("context.Log(\"Reviewed the supplied duct snapshot.\");", "for (int i = 0; i < 100; i++) context.Log(new string('L', 512));")
            .Replace("context.Report(\"Inspected\", \"20\");", "for (int i = 0; i < 64; i++) context.Report(\"entry-\" + i, new string('R', 1024));");
        var result = WorkerExecutor.Execute(new WorkerInput { Source = source });
        AssertFailure(result);
        var partials = result.Diagnostics.Where(value => value.Code == "PROGRAM_PARTIAL_OUTPUT").ToArray();
        Assert.Equal(2, partials.Length);
        foreach (var diagnostic in partials)
        {
            Assert.InRange(diagnostic.Message.Length, 1, 1900);
            using var message = JsonDocument.Parse(diagnostic.Message);
            var root = message.RootElement;
            Assert.True(root.GetProperty("omittedLogs").GetInt32() > 0);
            Assert.True(root.GetProperty("omittedReportEntries").GetInt32() > 0);
            Assert.Equal(64, root.GetProperty("omittedLogs").GetInt32() + root.GetProperty("logs").GetArrayLength());
            Assert.Equal(64, root.GetProperty("omittedReportEntries").GetInt32() + root.GetProperty("report").EnumerateObject().Count());
        }
    }

    [Fact]
    public void ResultReferenceAssertionRetainsContextOutputWithoutCompletingItsPlan()
    {
        const string source = """
using RevitOperator.DynamicRevitSdk;
public sealed class AssertionProbe : IDynamicResultReferenceRevitProgramV1 {
    public DynamicResultReferenceProgramResultV1 Execute(DynamicResultReferenceProgramContextV1 context) {
        context.TraceStep("check-flow", "Check required flow.");
        context.Log("Flow check started.");
        context.Report("Stage", "flow-check");
        context.Require("flow-present", "check-flow", false, "Flow is missing.");
        return context.Complete();
    }
}
""";
        var result = WorkerExecutor.Execute(new WorkerInput { Source = source, ResultReferenceDocumentRevision = 1,
            Input = new DynamicTaskInput { Document = new DynamicDocumentDto { ProjectFingerprint = DynamicWire.Sha256("diagnostic-project"), SessionId = "diagnostic-session" } } });
        AssertFailure(result);
        var assertion = Assert.Single(result.Diagnostics, value => value.Code == "PROGRAM_ASSERTION_FAILED");
        Assert.Equal("check-flow", assertion.StepId);
        Assert.Equal("flow-present", assertion.AssertionId);
        Assert.Equal(7, assertion.Line);
        var partials = result.Diagnostics.Where(value => value.Code == "PROGRAM_PARTIAL_OUTPUT").ToArray();
        Assert.Equal(2, partials.Length);
        Assert.All(partials, value => Assert.Contains("flow-check", value.Message));
    }

    [Fact]
    public void ConstructorFailureHasSourceLocationButNoFabricatedPartialContext()
    {
        var source = Source.Replace("public sealed class PartialReportProbe : IDynamicRevitProgram\n{",
            "public sealed class PartialReportProbe : IDynamicRevitProgram\n{\n    public PartialReportProbe() { throw new InvalidOperationException(\"Constructor failed.\"); }");
        var result = WorkerExecutor.Execute(new WorkerInput { Source = source });
        AssertFailure(result);
        var error = Assert.Single(result.Diagnostics);
        Assert.Equal("PROGRAM_EXCEPTION", error.Code);
        Assert.Equal(5, error.Line);
        Assert.Contains("Constructor failed.", error.Message);
    }

    [Fact]
    public void GeneratedCodeCannotAccessTheWorkerOnlyDiagnosticSnapshot()
    {
        var source = Source.Replace("context.Log(\"Reviewed the supplied duct snapshot.\");", "context.CaptureDiagnostics();");
        var result = WorkerExecutor.Execute(new WorkerInput { Source = source });
        AssertFailure(result);
        Assert.Contains(result.Diagnostics, value => value.Code is "CS1061" or "CS0122");
        Assert.DoesNotContain(result.Diagnostics, value => value.Code == "PROGRAM_PARTIAL_OUTPUT");
    }

    [Fact]
    public void NullCharactersInProgramExceptionsCannotBreakTheDiagnosticTransportContract()
    {
        var source = Source.Replace("Missing flow needed for the next calculation.", "Missing flow\\0value.");
        var result = WorkerExecutor.Execute(new WorkerInput { Source = source });
        AssertFailure(result);
        var error = Assert.Single(result.Diagnostics, value => value.Code == "PROGRAM_EXCEPTION");
        Assert.False(error.Message.Contains('\0'));
        Assert.Contains("flow\\0value", error.Message);
    }

    private static void AssertFailure(WorkerOutput result)
    {
        Assert.False(result.Ok);
        Assert.Equal("failed", result.ExecutionStatus);
        Assert.False(result.DeterministicReplayVerified);
        Assert.Null(result.ExecutionIdentityHash);
        Assert.Null(result.Graph);
        Assert.Null(result.ResultReferenceProgramResult);
        Assert.Null(result.CoreProgramResult);
        Assert.Empty(result.Report);
        Assert.Empty(result.Logs);
    }
}
