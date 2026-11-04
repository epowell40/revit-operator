// Test-only Revit API surface for executing the actual linked production helper.
namespace Autodesk.Revit.DB
{
    public enum FailureSeverity { None, Warning, Error, DocumentCorruption }
    public enum FailureProcessingResult { Continue, ProceedWithCommit, ProceedWithRollBack }
    public interface IFailuresPreprocessor { FailureProcessingResult PreprocessFailures(FailuresAccessor accessor); }
    public sealed class ElementId(long value) { public long Value { get; } = value; }
    public sealed class FailureDefinitionId(Guid guid) { public Guid Guid { get; } = guid; }
    public sealed class FailureMessageAccessor(FailureSeverity severity, string description, long[]? ids = null, Guid? definition = null)
    {
        public bool ThrowOnSeverity, ThrowOnDescription, ThrowOnIds, ThrowOnDefinition;
        public FailureSeverity GetSeverity() => ThrowOnSeverity ? throw new InvalidOperationException("severity unavailable") : severity;
        public string GetDescriptionText() => ThrowOnDescription ? throw new InvalidOperationException("description unavailable") : description;
        public ICollection<ElementId> GetFailingElementIds() => ThrowOnIds ? throw new InvalidOperationException("ids unavailable") : (ids ?? []).Select(id => new ElementId(id)).ToArray();
        public FailureDefinitionId? GetFailureDefinitionId() => ThrowOnDefinition ? throw new InvalidOperationException("definition unavailable") : definition.HasValue ? new FailureDefinitionId(definition.Value) : null;
    }
    public sealed class FailuresAccessor(params FailureMessageAccessor?[] failures)
    {
        public bool ThrowOnRead;
        public IList<FailureMessageAccessor?> GetFailureMessages() => ThrowOnRead ? throw new InvalidOperationException("failure inventory unavailable") : failures;
    }
    public sealed class FailureHandlingOptions
    {
        public bool ClearAfterRollback { get; private set; }
        public IFailuresPreprocessor? Preprocessor { get; private set; }
        public void SetClearAfterRollback(bool value) => ClearAfterRollback = value;
        public void SetFailuresPreprocessor(IFailuresPreprocessor value) => Preprocessor = value;
    }
    public sealed class Transaction { public FailureHandlingOptions GetFailureHandlingOptions() => new(); }
}
namespace RevitBridge.Common
{
    internal static class ElementIdCompat { internal static long GetValue(Autodesk.Revit.DB.ElementId id) => id.Value; }
}
