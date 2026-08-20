using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitOperator.DynamicRevitSdk;

public static class DynamicExecutionProtocolV1
{
    public const string ManifestSchema = "dynamic-revit-execution-protocol-manifest/v1";
    public const string TraceSchema = "dynamic-revit-execution-trace/v1";
    public const string FactRequestSchema = "dynamic-revit-fact-request/v1";
    public const int MaximumSteps = 256;
    public const int MaximumAssertions = 256;
    public const int MaximumFactReferencesPerStep = 128;
    public const int MaximumNodesPerStep = 64;
    public const int MaximumFactRequestSelectors = 256;

    private static readonly string[] AssertionKinds =
        { "condition", "cardinality", "identity", "geometry", "topology", "state", "scope", "custom" };

    public static string ContractIdentity => DynamicWire.Sha256(DynamicCanonical.Join(
        "dynamic-revit-execution-protocol/v1", ManifestSchema, TraceSchema, FactRequestSchema,
        "bounded-needs-facts", "semantic-step-node-binding", "observation-provenance",
        "structured-assertions", "non-authorizing", "deterministic-replay-attestation"));

    public static string FactReferenceHash(DynamicProgramFactReferenceV1 value) => DynamicWire.Sha256(DynamicCanonical.Join(
        "dynamic-revit-fact-reference/v1", value.SnapshotHash, value.RevisionHash, value.ScopeHash,
        value.FactStableId, value.FieldPath));

    public static string FactRequestHash(DynamicProgramFactRequestV1 value) => DynamicWire.Sha256(DynamicCanonical.Join(
        FactRequestSchema, value.RequestId, value.Reason, DynamicBuildingSystemsObservationPolicyV1.ScopeHash(value.Selector),
        DynamicCanonical.Set(value.KnownScopeHashes), value.AuthorizationGranted ? "1" : "0"));

    public static string TraceHash(DynamicProgramExecutionTraceV1 value) => DynamicWire.Sha256(DynamicCanonical.Join(
        TraceSchema, value.ProtocolIdentity, value.Outcome, value.GraphHash, value.FactRequestHash,
        string.Join("\n", value.Steps.Select(StepCanonical)),
        string.Join("\n", value.Assertions.Select(AssertionCanonical)), value.AuthorizationGranted ? "1" : "0"));

    public static void ValidateFactRequest(DynamicProgramFactRequestV1 value)
    {
        if (value == null || value.Schema != FactRequestSchema || !DynamicCanonical.Id(value.RequestId, 128) ||
            string.IsNullOrWhiteSpace(value.Reason) || value.Reason.Length > 320 || value.AuthorizationGranted ||
            value.Selector == null || value.Selector.Cursor != null)
            throw new ArgumentException("Dynamic fact request is malformed, cursor-bearing, or authorizing.");
        DynamicBuildingSystemsObservationPolicyV1.ValidateSelector(value.Selector);
        if (value.Selector.ElementUniqueIds.Length + value.Selector.CategoryStableIds.Length + value.Selector.Kinds.Length + value.Selector.ParameterNames.Length > MaximumFactRequestSelectors)
            throw new ArgumentException("Dynamic fact request selector count exceeds its aggregate bound.");
        var known = value.KnownScopeHashes ?? Array.Empty<string>();
        if (known.Length > 16 || known.Any(hash => !DynamicCanonical.Hash(hash)) || known.Distinct(StringComparer.Ordinal).Count() != known.Length ||
            !known.SequenceEqual(known.OrderBy(hash => hash, StringComparer.Ordinal)))
            throw new ArgumentException("Dynamic fact request known scopes are invalid, duplicated, or non-canonical.");
        var requestedScope = DynamicBuildingSystemsObservationPolicyV1.ScopeHash(value.Selector);
        if (known.Contains(requestedScope, StringComparer.Ordinal))
            throw new ArgumentException("Dynamic fact request repeats an observation scope already supplied to the program.");
        if (value.RequestHash != FactRequestHash(value)) throw new ArgumentException("Dynamic fact request identity is invalid.");
    }

    public static void ValidateTrace(DynamicProgramExecutionTraceV1 value, DynamicResultReferenceGraphV1? graph,
        DynamicProgramFactRequestV1? factRequest)
    {
        if (value == null || value.Schema != TraceSchema || value.ProtocolIdentity != ContractIdentity || value.AuthorizationGranted ||
            value.Steps == null || value.Assertions == null || value.Steps.Count > MaximumSteps || value.Assertions.Count > MaximumAssertions)
            throw new ArgumentException("Dynamic execution trace envelope is malformed, unbounded, or authorizing.");
        var needsFacts = factRequest != null;
        if (value.Outcome != (needsFacts ? "needs_facts" : "completed") ||
            value.GraphHash != (needsFacts ? "" : graph?.GraphHash) ||
            value.FactRequestHash != (needsFacts ? factRequest!.RequestHash : ""))
            throw new ArgumentException("Dynamic execution trace outcome binding is invalid.");
        if (needsFacts) ValidateFactRequest(factRequest!);

        var stepIds = new HashSet<string>(StringComparer.Ordinal);
        var nodeIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var step in value.Steps)
        {
            if (!DynamicCanonical.Id(step.StepId, 128) || string.IsNullOrWhiteSpace(step.Purpose) || step.Purpose.Length > 320 ||
                step.DependsOn == null || step.NodeIds == null || step.FactReferences == null ||
                step.NodeIds.Count > MaximumNodesPerStep || step.FactReferences.Count > MaximumFactReferencesPerStep ||
                !stepIds.Add(step.StepId) || step.DependsOn.Any(dependency => !stepIds.Contains(dependency)) ||
                step.DependsOn.Distinct(StringComparer.Ordinal).Count() != step.DependsOn.Count)
                throw new ArgumentException("Dynamic execution step is malformed, duplicated, forward-dependent, or unbounded.");
            foreach (var nodeId in step.NodeIds)
                if (!DynamicCanonical.Hash(nodeId) || !nodeIds.Add(nodeId)) throw new ArgumentException("Dynamic execution trace binds a graph node zero or multiple times.");
            foreach (var fact in step.FactReferences) ValidateFactReference(fact);
        }
        if (!needsFacts && value.Steps.Count > 0)
        {
            var graphNodes = new HashSet<string>(graph!.Nodes.Select(node => node.NodeId), StringComparer.Ordinal);
            if (!nodeIds.SetEquals(graphNodes)) throw new ArgumentException("Dynamic execution trace does not bind every graph node exactly once.");
        }
        else if (needsFacts && nodeIds.Count != 0)
            throw new ArgumentException("A needs-facts trace cannot bind executable graph nodes.");

        var assertionIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var assertion in value.Assertions)
        {
            if (!DynamicCanonical.Id(assertion.AssertionId, 128) || !stepIds.Contains(assertion.StepId) ||
                !AssertionKinds.Contains(assertion.Kind, StringComparer.Ordinal) || !assertion.Passed ||
                string.IsNullOrWhiteSpace(assertion.Message) || assertion.Message.Length > 320 ||
                assertion.FactReferences == null || assertion.FactReferences.Count > MaximumFactReferencesPerStep ||
                !assertionIds.Add(assertion.AssertionId))
                throw new ArgumentException("Dynamic execution assertion is malformed, failed, unbound, duplicated, or unbounded.");
            foreach (var fact in assertion.FactReferences) ValidateFactReference(fact);
        }
        if (value.TraceHash != TraceHash(value)) throw new ArgumentException("Dynamic execution trace identity is invalid.");
    }

    public static void ValidateTraceFactReferences(DynamicProgramExecutionTraceV1 value,
        IEnumerable<DynamicBuildingSystemsEnvelopeV1> observationPages)
    {
        if (value == null) throw new ArgumentNullException(nameof(value));
        var pages = (observationPages ?? throw new ArgumentNullException(nameof(observationPages))).ToArray();
        foreach (var reference in value.Steps.SelectMany(step => step.FactReferences)
            .Concat(value.Assertions.SelectMany(assertion => assertion.FactReferences)))
        {
            ValidateFactReference(reference);
            var matches = pages.Count(page => page.SnapshotHash == reference.SnapshotHash &&
                page.RevisionHash == reference.RevisionHash && page.ScopeHash == reference.ScopeHash &&
                page.Facts.Any(fact => fact.Element.StableId == reference.FactStableId));
            if (matches != 1)
                throw new ArgumentException("Dynamic execution provenance does not bind exactly one supplied observation fact.");
        }
    }

    private static void ValidateFactReference(DynamicProgramFactReferenceV1 value)
    {
        if (value == null || !DynamicCanonical.Hash(value.SnapshotHash) || !DynamicCanonical.Hash(value.RevisionHash) ||
            !DynamicCanonical.Hash(value.ScopeHash) || !DynamicCanonical.Id(value.FactStableId, 256) ||
            !DynamicCanonical.Id(value.FieldPath, 256) || value.ReferenceHash != FactReferenceHash(value))
            throw new ArgumentException("Dynamic program fact reference is malformed or substituted.");
    }

    private static string StepCanonical(DynamicProgramStepV1 value) => DynamicCanonical.Join(value.StepId, value.Purpose,
        DynamicCanonical.Set(value.DependsOn), DynamicCanonical.Set(value.NodeIds),
        string.Join("\n", value.FactReferences.Select(FactReferenceHash).OrderBy(hash => hash, StringComparer.Ordinal)));

    private static string AssertionCanonical(DynamicProgramAssertionV1 value) => DynamicCanonical.Join(value.AssertionId,
        value.StepId, value.Kind, value.Passed ? "1" : "0", value.Message,
        string.Join("\n", value.FactReferences.Select(FactReferenceHash).OrderBy(hash => hash, StringComparer.Ordinal)));
}

public sealed class DynamicProgramFactReferenceV1
{
    public string SnapshotHash { get; set; } = "";
    public string RevisionHash { get; set; } = "";
    public string ScopeHash { get; set; } = "";
    public string FactStableId { get; set; } = "";
    public string FieldPath { get; set; } = "";
    public string ReferenceHash { get; set; } = "";
}

public sealed class DynamicProgramStepV1
{
    public string StepId { get; set; } = "";
    public string Purpose { get; set; } = "";
    public IReadOnlyList<string> DependsOn { get; set; } = Array.Empty<string>();
    public IReadOnlyList<string> NodeIds { get; set; } = Array.Empty<string>();
    public IReadOnlyList<DynamicProgramFactReferenceV1> FactReferences { get; set; } = Array.Empty<DynamicProgramFactReferenceV1>();
}

public sealed class DynamicProgramAssertionV1
{
    public string AssertionId { get; set; } = "";
    public string StepId { get; set; } = "";
    public string Kind { get; set; } = "condition";
    public bool Passed { get; set; }
    public string Message { get; set; } = "";
    public IReadOnlyList<DynamicProgramFactReferenceV1> FactReferences { get; set; } = Array.Empty<DynamicProgramFactReferenceV1>();
}

public sealed class DynamicProgramFactRequestV1
{
    public string Schema { get; set; } = DynamicExecutionProtocolV1.FactRequestSchema;
    public string RequestId { get; set; } = "";
    public string Reason { get; set; } = "";
    public DynamicBuildingSystemsSelectorV1 Selector { get; set; } = new();
    public string[] KnownScopeHashes { get; set; } = Array.Empty<string>();
    public bool AuthorizationGranted { get; set; }
    public string RequestHash { get; set; } = "";
}

public sealed class DynamicProgramExecutionTraceV1
{
    public string Schema { get; set; } = DynamicExecutionProtocolV1.TraceSchema;
    public string ProtocolIdentity { get; set; } = DynamicExecutionProtocolV1.ContractIdentity;
    public string Outcome { get; set; } = "completed";
    public string GraphHash { get; set; } = "";
    public string FactRequestHash { get; set; } = "";
    public IReadOnlyList<DynamicProgramStepV1> Steps { get; set; } = Array.Empty<DynamicProgramStepV1>();
    public IReadOnlyList<DynamicProgramAssertionV1> Assertions { get; set; } = Array.Empty<DynamicProgramAssertionV1>();
    public bool AuthorizationGranted { get; set; }
    public string TraceHash { get; set; } = "";
}

public sealed class DynamicProgramAssertionException : InvalidOperationException
{
    public DynamicProgramAssertionException(string assertionId, string stepId, string kind, string message)
        : base(message)
    {
        AssertionId = assertionId;
        StepId = stepId;
        Kind = kind;
    }

    public string AssertionId { get; }
    public string StepId { get; }
    public string Kind { get; }
}

public sealed partial class DynamicResultReferenceProgramContextV1
{
    private readonly List<DynamicProgramStepV1> _executionSteps = new();
    private readonly List<DynamicProgramAssertionV1> _executionAssertions = new();

    public DynamicProgramFactReferenceV1 Fact(DynamicBuildingSystemsFactV1 fact, string fieldPath)
    {
        if (fact == null) throw new ArgumentNullException(nameof(fact));
        return Fact(fact.Element.StableId, fieldPath);
    }

    public DynamicProgramFactReferenceV1 Fact(string factStableId, string fieldPath)
    {
        if (!DynamicCanonical.Id(factStableId, 256) || !DynamicCanonical.Id(fieldPath, 256))
            throw new ArgumentException("Dynamic fact identity or field path is invalid.");
        var pages = _buildingSystemsPages.Where(page => page.Facts.Any(fact => fact.Element.StableId == factStableId)).ToArray();
        if (pages.Length != 1) throw new ArgumentException("Dynamic fact reference is missing or ambiguous in the exact observation context.");
        var page = pages[0];
        var value = new DynamicProgramFactReferenceV1
        {
            SnapshotHash = page.SnapshotHash, RevisionHash = page.RevisionHash, ScopeHash = page.ScopeHash,
            FactStableId = factStableId, FieldPath = fieldPath
        };
        value.ReferenceHash = DynamicExecutionProtocolV1.FactReferenceHash(value);
        return value;
    }

    public void TraceStep(string stepId, string purpose, IEnumerable<DynamicResultOperationHandleV1>? operations = null,
        IEnumerable<DynamicProgramFactReferenceV1>? facts = null, IEnumerable<string>? dependsOn = null)
    {
        var value = new DynamicProgramStepV1
        {
            StepId = stepId, Purpose = purpose,
            DependsOn = (dependsOn ?? Array.Empty<string>()).ToArray(),
            NodeIds = (operations ?? Array.Empty<DynamicResultOperationHandleV1>()).Select(handle => handle.NodeId).ToArray(),
            FactReferences = (facts ?? Array.Empty<DynamicProgramFactReferenceV1>()).Select(Clone).ToArray()
        };
        var candidateSteps = _executionSteps.Concat(new[] { value }).ToArray();
        var candidate = BuildTrace("completed", "", "", candidateSteps, _executionAssertions);
        DynamicExecutionProtocolV1.ValidateTrace(candidate, GraphForTrace(candidateSteps.SelectMany(step => step.NodeIds).ToArray()), null);
        _executionSteps.Add(value);
    }

    public void Require(string assertionId, string stepId, bool condition, string message,
        string kind = "condition", IEnumerable<DynamicProgramFactReferenceV1>? facts = null)
    {
        if (!condition) throw new DynamicProgramAssertionException(assertionId, stepId, kind, message);
        _executionAssertions.Add(new DynamicProgramAssertionV1
        {
            AssertionId = assertionId, StepId = stepId, Kind = kind, Passed = true, Message = message,
            FactReferences = (facts ?? Array.Empty<DynamicProgramFactReferenceV1>()).Select(Clone).ToArray()
        });
    }

    public DynamicResultReferenceProgramResultV1 NeedFacts(string requestId, string reason, DynamicBuildingSystemsSelectorV1 selector)
    {
        var request = new DynamicProgramFactRequestV1
        {
            RequestId = requestId, Reason = reason, Selector = Clone(selector),
            KnownScopeHashes = _buildingSystemsPages.Select(page => page.ScopeHash).Distinct(StringComparer.Ordinal).OrderBy(hash => hash, StringComparer.Ordinal).ToArray()
        };
        request.RequestHash = DynamicExecutionProtocolV1.FactRequestHash(request);
        DynamicExecutionProtocolV1.ValidateFactRequest(request);
        var trace = BuildTrace("needs_facts", "", request.RequestHash, _executionSteps, _executionAssertions);
        DynamicExecutionProtocolV1.ValidateTrace(trace, null, request);
        DynamicExecutionProtocolV1.ValidateTraceFactReferences(trace, _buildingSystemsPages);
        return new DynamicResultReferenceProgramResultV1
        {
            Graph = new DynamicResultReferenceGraphV1(), FactRequest = request, ExecutionTrace = trace,
            Logs = _logs.ToArray(), Report = new Dictionary<string, string>(_report, StringComparer.Ordinal)
        };
    }

    internal DynamicProgramExecutionTraceV1 CompleteExecutionTrace(DynamicResultReferenceGraphV1 graph)
    {
        var trace = BuildTrace("completed", graph.GraphHash, "", _executionSteps, _executionAssertions);
        DynamicExecutionProtocolV1.ValidateTrace(trace, graph, null);
        DynamicExecutionProtocolV1.ValidateTraceFactReferences(trace, _buildingSystemsPages);
        return trace;
    }

    private static DynamicProgramExecutionTraceV1 BuildTrace(string outcome, string graphHash, string factRequestHash,
        IEnumerable<DynamicProgramStepV1> steps, IEnumerable<DynamicProgramAssertionV1> assertions)
    {
        var trace = new DynamicProgramExecutionTraceV1
        {
            Outcome = outcome, GraphHash = graphHash, FactRequestHash = factRequestHash,
            Steps = steps.Select(Clone).ToArray(), Assertions = assertions.Select(Clone).ToArray()
        };
        trace.TraceHash = DynamicExecutionProtocolV1.TraceHash(trace);
        return trace;
    }

    private static DynamicProgramFactReferenceV1 Clone(DynamicProgramFactReferenceV1 value) => new()
    {
        SnapshotHash = value.SnapshotHash, RevisionHash = value.RevisionHash, ScopeHash = value.ScopeHash,
        FactStableId = value.FactStableId, FieldPath = value.FieldPath, ReferenceHash = value.ReferenceHash
    };
    private static DynamicProgramStepV1 Clone(DynamicProgramStepV1 value) => new()
    {
        StepId = value.StepId, Purpose = value.Purpose, DependsOn = value.DependsOn.ToArray(), NodeIds = value.NodeIds.ToArray(),
        FactReferences = value.FactReferences.Select(Clone).ToArray()
    };
    private static DynamicProgramAssertionV1 Clone(DynamicProgramAssertionV1 value) => new()
    {
        AssertionId = value.AssertionId, StepId = value.StepId, Kind = value.Kind, Passed = value.Passed, Message = value.Message,
        FactReferences = value.FactReferences.Select(Clone).ToArray()
    };
    private static DynamicBuildingSystemsSelectorV1 Clone(DynamicBuildingSystemsSelectorV1 value) => new()
    {
        Schema = value.Schema, ElementUniqueIds = value.ElementUniqueIds.ToArray(), CategoryStableIds = value.CategoryStableIds.ToArray(),
        Kinds = value.Kinds.ToArray(), ParameterNames = value.ParameterNames.ToArray(), IncludeTypeParameters = value.IncludeTypeParameters,
        PageSize = value.PageSize, Cursor = value.Cursor
    };

    // TraceStep performs only incremental shape validation. CompleteExecutionTrace performs exact full-graph coverage validation.
    private static DynamicResultReferenceGraphV1 GraphForTrace(IReadOnlyList<string> nodeIds) => new()
    {
        InputHash = DynamicWire.Sha256("trace-shape"), DocumentFingerprint = DynamicWire.Sha256("trace-document"),
        DocumentSessionId = "trace-session", DocumentRevision = 0,
        Nodes = nodeIds.Select(id => new DynamicResultReferenceNodeV1 { NodeId = id }).ToArray(), GraphHash = ""
    };
}
