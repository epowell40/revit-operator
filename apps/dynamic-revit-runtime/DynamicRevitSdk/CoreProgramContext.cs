using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitOperator.DynamicRevitSdk;

public sealed class DynamicCoreProgramResultV1
{
    public string Schema { get; set; } = "dynamic-revit-core-program-result/v1";
    public DynamicOperationGraphV1 Graph { get; set; } = new();
    public IReadOnlyList<string> Logs { get; set; } = Array.Empty<string>();
    public IReadOnlyDictionary<string, string> Report { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
}

public interface IDynamicCoreRevitProgramV1
{
    DynamicCoreProgramResultV1 Execute(DynamicCoreProgramContextV1 context);
}

/// <summary>General core-operation worker context backed only by supervisor-verified rule and host-observed active-view facts.</summary>
public sealed class DynamicCoreProgramContextV1
{
    private readonly List<string> _logs = new();
    private readonly Dictionary<string, string> _report = new(StringComparer.Ordinal);
    private readonly DynamicObservedElementV1[] _candidates;

    public DynamicCoreProgramContextV1(DynamicTaskInput input, long documentRevision, DynamicVerifiedContextRuleV1 rule,
        IEnumerable<DynamicObservationEnvelopeV1> observationPages)
    {
        Input = input ?? throw new ArgumentNullException(nameof(input));
        Rule = Clone(rule ?? throw new ArgumentNullException(nameof(rule)));
        DynamicContextRulePolicyV1.ValidateBinding(Rule);
        if (Rule.ProjectFingerprint != input.Document.ProjectFingerprint || Rule.ActiveViewElementId != input.Document.ActiveViewId)
            throw new ArgumentException("Verified context rule does not bind the exact worker document and active view.");
        var pages = (observationPages ?? throw new ArgumentNullException(nameof(observationPages))).Take(DynamicObservationContractV1.MaximumObservedElements + 1).ToArray();
        if (pages.Length == 0 || pages.Length > DynamicObservationContractV1.MaximumObservedElements) throw new ArgumentException("Context candidate observation pages are missing or unbounded.");
        foreach (var page in pages) DynamicObservationPolicyV1.ValidateEnvelope(page);
        var first = pages[0]; var offset = 0;
        foreach (var page in pages)
        {
            if (page.DocumentFingerprint != Rule.ProjectFingerprint || page.DocumentSessionId != input.Document.SessionId ||
                page.ScopeHash != Rule.ObservationScopeHash || page.RevisionHash != Rule.ObservationRevisionHash || page.PageOffset != offset ||
                page.PageSize != first.PageSize || page.TotalCount != first.TotalCount) throw new ArgumentException("Context candidate pages are mixed, stale, incomplete, or foreign.");
            offset += page.Elements.Count;
        }
        if (offset != first.TotalCount || pages[pages.Length - 1].NextCursor != null) throw new ArgumentException("Context candidate page set is incomplete.");
        _candidates = pages.SelectMany(value => value.Elements).Select(Clone).ToArray();
        if (_candidates.Any(value => value.Category == null || !Rule.TargetCategoryStableIds.Contains(value.Category.StableId, StringComparer.Ordinal)))
            throw new ArgumentException("Context candidate hydration escaped the verified rule categories.");
        Plan = new DynamicCoreOperationGraphBuilderV1(DynamicWire.InputHash(input), input.Document.ProjectFingerprint, documentRevision,
            input.OperationBudget, Rule.RecordId, Rule.RecordHash, Rule.BindingHash);
    }

    public DynamicTaskInput Input { get; }
    public DynamicVerifiedContextRuleV1 Rule { get; }
    public IReadOnlyList<DynamicObservedElementV1> Candidates => Array.AsReadOnly(_candidates.Select(Clone).ToArray());
    public DynamicCoreOperationGraphBuilderV1 Plan { get; }

    public void Log(string message) { if (!string.IsNullOrWhiteSpace(message) && _logs.Count < 64) _logs.Add(message.Trim().Length > 512 ? message.Trim().Substring(0, 512) : message.Trim()); }
    public void Report(string key, string value)
    {
        if (!DynamicCanonical.Id(key, 128) || value == null || value.Length > 1024 || _report.Count >= 64 && !_report.ContainsKey(key)) throw new ArgumentException("Core structured report is invalid or unbounded.");
        _report[key] = value;
    }
    public DynamicCoreProgramResultV1 Complete() => new() { Graph = Plan.Build(), Logs = _logs.ToArray(), Report = new Dictionary<string, string>(_report, StringComparer.Ordinal) };

    private static DynamicVerifiedContextRuleV1 Clone(DynamicVerifiedContextRuleV1 value) => new()
    {
        Schema = value.Schema, RecordId = value.RecordId, RecordHash = value.RecordHash, CompanyId = value.CompanyId,
        ProjectFingerprint = value.ProjectFingerprint, UserId = value.UserId, ActiveViewElementId = value.ActiveViewElementId,
        TargetCategoryStableIds = value.TargetCategoryStableIds.ToArray(), Conditions = value.Conditions.Select(Clone).ToArray(), Action = Clone(value.Action),
        IssuedUnixSeconds = value.IssuedUnixSeconds, ExpiresUnixSeconds = value.ExpiresUnixSeconds, VerificationKeyHash = value.VerificationKeyHash,
        WorkerRuntimePackageHash = value.WorkerRuntimePackageHash, ObservationScopeHash = value.ObservationScopeHash,
        ObservationRevisionHash = value.ObservationRevisionHash, BindingHash = value.BindingHash
    };
    private static DynamicContextRuleConditionV1 Clone(DynamicContextRuleConditionV1 value) => new() { ParameterName = value.ParameterName, ParameterIdentity = value.ParameterIdentity, ParameterScope = value.ParameterScope, Operator = value.Operator, ValueKind = value.ValueKind, RawValue = value.RawValue };
    private static DynamicContextRuleActionV1 Clone(DynamicContextRuleActionV1 value) => new() { Kind = value.Kind, ParameterName = value.ParameterName, ParameterIdentity = value.ParameterIdentity, ParameterScope = value.ParameterScope, ValueKind = value.ValueKind, RawValue = value.RawValue, SpecTypeId = value.SpecTypeId, UnitTypeId = value.UnitTypeId };
    private static DynamicObservedElementV1 Clone(DynamicObservedElementV1 value) => new()
    {
        Element = value.Element, Category = value.Category, Family = value.Family, Type = value.Type, Host = value.Host, OwnerView = value.OwnerView,
        Level = value.Level, Workset = value.Workset, CreatedPhase = value.CreatedPhase, DemolishedPhase = value.DemolishedPhase,
        PointLocation = value.PointLocation, PointRotationRadians = value.PointRotationRadians, CurveLocation = value.CurveLocation,
        BoundingBox = value.BoundingBox, Transform = value.Transform, IsPinned = value.IsPinned, IsGrouped = value.IsGrouped,
        CoreStateHash = value.CoreStateHash, Parameters = value.Parameters.Select(parameter => new DynamicParameterValueV1
        {
            Identity = parameter.Identity, Name = parameter.Name, StorageKind = parameter.StorageKind, HasValue = parameter.HasValue,
            RawString = parameter.RawString, RawInteger = parameter.RawInteger, RawDouble = parameter.RawDouble, RawElementId = parameter.RawElementId,
            FormattedValue = parameter.FormattedValue, SpecTypeId = parameter.SpecTypeId, UnitTypeId = parameter.UnitTypeId, Scope = parameter.Scope, Writable = parameter.Writable
        }).ToArray()
    };
}
