using Autodesk.Revit.DB;
using RevitBridge.Logic.Handlers.DynamicRuntime;
using Xunit;

namespace DynamicRevitSdk.Tests;

// Executes the linked production preprocessor against a minimal test-only API
// boundary. Installed Revit qualification separately proves native rollback/UI.
public sealed class DynamicFailureHandlingTests
{
    private static (FailureProcessingResult Result, List<DynamicCapturedFailure> Failures, FailureHandlingOptions Options)
        Run(FailuresAccessor accessor)
    {
        var failures = new List<DynamicCapturedFailure>();
        var options = DynamicFailureHandlingUtil.ConfigureFailureCapture(new Transaction(), failures);
        return (options.Preprocessor!.PreprocessFailures(accessor), failures, options);
    }

    [Fact]
    public void HostFaceWarningWithoutNativeErrorsCannotFallThroughToModalUi()
    {
        var id = Guid.Parse("c4e32a23-52e6-455b-949d-89e0c4eb78ab");
        const string message = "Instance origin does not lie on host face. Instance will lose association to host.";
        var result = Run(new FailuresAccessor(new FailureMessageAccessor(FailureSeverity.Warning, message, new long[] { 71, 72, 71 }, id)));
        Assert.Equal(FailureProcessingResult.ProceedWithRollBack, result.Result);
        Assert.True(result.Options.ClearAfterRollback);
        var failure = Assert.Single(result.Failures);
        Assert.Equal("warning", failure.severity);
        Assert.Equal(message, failure.message);
        Assert.Equal(new long[] { 71, 72 }, failure.elementIds);
        Assert.Equal(id.ToString(), failure.failureDefinitionId);
    }

    [Fact]
    public void NoFailuresPreserveNormalCommitProcessing()
    {
        var result = Run(new FailuresAccessor());
        Assert.Equal(FailureProcessingResult.Continue, result.Result);
        Assert.Empty(result.Failures);
    }

    [Theory]
    [InlineData(FailureSeverity.Warning, "warning")]
    [InlineData(FailureSeverity.Error, "error")]
    [InlineData(FailureSeverity.DocumentCorruption, "document_corruption")]
    [InlineData((FailureSeverity)99, "error")]
    public void CapturedFailuresRemainVisibleAndRequireRollback(FailureSeverity severity, string expected)
    {
        var result = Run(new FailuresAccessor(new FailureMessageAccessor(severity, "Native failure")));
        Assert.Equal(FailureProcessingResult.ProceedWithRollBack, result.Result);
        Assert.Equal(expected, Assert.Single(result.Failures).severity);
    }

    [Fact]
    public void FailureEnumerationErrorCannotMasqueradeAsNoFailures()
    {
        var result = Run(new FailuresAccessor { ThrowOnRead = true });
        Assert.Equal(FailureProcessingResult.ProceedWithRollBack, result.Result);
        Assert.Equal("error", Assert.Single(result.Failures).severity);
    }

    [Fact]
    public void NullFailureCannotMasqueradeAsNoFailures()
    {
        var result = Run(new FailuresAccessor(new FailureMessageAccessor?[] { null }));
        Assert.Equal(FailureProcessingResult.ProceedWithRollBack, result.Result);
        Assert.Equal("error", Assert.Single(result.Failures).severity);
    }

    [Fact]
    public void UnknownSeverityIsNotReportedAsAnObservedWarning()
    {
        var result = Run(new FailuresAccessor(new FailureMessageAccessor(FailureSeverity.Warning, "Unreadable severity") { ThrowOnSeverity = true }));
        Assert.Equal(FailureProcessingResult.ProceedWithRollBack, result.Result);
        Assert.Equal("error", Assert.Single(result.Failures).severity);
    }

    [Theory]
    [InlineData("description")]
    [InlineData("ids")]
    [InlineData("definition")]
    public void PartialDiagnosticReadFailureStillRollsBackWithoutInventingFields(string field)
    {
        var warning = new FailureMessageAccessor(FailureSeverity.Warning, "Native warning", new long[] { 71 });
        warning.ThrowOnDescription = field == "description";
        warning.ThrowOnIds = field == "ids";
        warning.ThrowOnDefinition = field == "definition";
        var result = Run(new FailuresAccessor(warning));
        Assert.Equal(FailureProcessingResult.ProceedWithRollBack, result.Result);
        var failure = Assert.Single(result.Failures);
        if (field == "description") Assert.Equal("", failure.message);
        if (field == "ids") Assert.Empty(failure.elementIds);
        if (field == "definition") Assert.Null(failure.failureDefinitionId);
    }

    [Fact]
    public void EveryWarningIsRetainedRatherThanSilentlyDeletedOrAccepted()
    {
        var result = Run(new FailuresAccessor(new FailureMessageAccessor(FailureSeverity.Warning, "First"),
            new FailureMessageAccessor(FailureSeverity.Warning, "Second")));
        Assert.Equal(FailureProcessingResult.ProceedWithRollBack, result.Result);
        Assert.Equal(new[] { "First", "Second" }, result.Failures.Select(f => f.message));
    }
}
