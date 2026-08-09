using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace RevitOperator.DynamicRevitSdk;

public static class DynamicResultReferenceContractV1
{
    public const string ManifestSchema = "dynamic-revit-result-reference-manifest/v1";
    public const string GraphSchema = "dynamic-revit-result-reference-graph/v1";
    public const string OutputFactSchema = "dynamic-revit-result-output-fact/v1";
    public const string ReceiptSchema = "dynamic-revit-result-reference-receipt/v1";
    public const string ProgramResultSchema = "dynamic-revit-result-reference-program-result/v1";
    public const string CanonicalVersion = "dynamic-revit-result-reference-canonical/v1";
    public const int MaximumNodes = 256;
    public const int MaximumOutputsPerNode = 16;
    public const int MaximumReferencesPerNode = 64;
    public const int MaximumAttributesPerNode = 64;
    public const int MaximumBuildingSystemsPages = DynamicBuildingSystemsObservationContractV1.MaximumObservedFacts;
    public const int MaximumTrustedExternalTargets = DynamicBuildingSystemsObservationContractV1.MaximumObservedFacts;
}

public static class DynamicResultReferenceManifestV1
{
    private static readonly Type[] Types =
    {
        typeof(DynamicResultReferenceGraphV1), typeof(DynamicResultReferenceNodeV1), typeof(DynamicExternalTargetReferenceV1),
        typeof(DynamicSymbolicResultReferenceV1), typeof(DynamicResultOutputDeclarationV1), typeof(DynamicResultOutputSpecV1),
        typeof(DynamicResultOperationHandleV1), typeof(DynamicTrustedElementFactV1), typeof(DynamicResolvedElementTargetV1),
        typeof(DynamicCreatedResultFactV1), typeof(DynamicResultReferenceReceiptV1), typeof(DynamicResultReferenceGraphBuilderV1),
        typeof(DynamicResultReferencePolicyV1), typeof(DynamicResultReferenceHostResolverV1), typeof(IDynamicResultReferenceTransactionalHostV1),
        typeof(DynamicResultReferencePreviewEngineV1), typeof(DynamicResultReferenceProgramResultV1),
        typeof(DynamicResultReferenceProgramContextV1), typeof(IDynamicResultReferenceRevitProgramV1)
    };
    private static readonly string SurfaceHashValue = DynamicWire.Sha256(string.Join("\n", Types.OrderBy(type => type.FullName, StringComparer.Ordinal).Select(Surface)));
    private static readonly string ManifestHashValue = DynamicWire.Sha256(DynamicCanonical.Join(DynamicResultReferenceContractV1.ManifestSchema,
        DynamicResultReferenceContractV1.GraphSchema, DynamicResultReferenceContractV1.OutputFactSchema,
        DynamicResultReferenceContractV1.ReceiptSchema, DynamicResultReferenceContractV1.ProgramResultSchema, DynamicResultReferenceContractV1.CanonicalVersion,
        DynamicResultReferenceContractV1.MaximumNodes.ToString(CultureInfo.InvariantCulture),
        DynamicResultReferenceContractV1.MaximumOutputsPerNode.ToString(CultureInfo.InvariantCulture),
        DynamicResultReferenceContractV1.MaximumReferencesPerNode.ToString(CultureInfo.InvariantCulture),
        DynamicResultReferenceContractV1.MaximumAttributesPerNode.ToString(CultureInfo.InvariantCulture),
        DynamicResultReferenceContractV1.MaximumBuildingSystemsPages.ToString(CultureInfo.InvariantCulture),
        DynamicResultReferenceContractV1.MaximumTrustedExternalTargets.ToString(CultureInfo.InvariantCulture), SurfaceHashValue));

    public static string ContractSurfaceHash => SurfaceHashValue;
    public static string ManifestHash => ManifestHashValue;

    private static string Surface(Type type)
    {
        var properties = type.GetProperties().Where(property => property.GetMethod?.IsPublic == true && !property.GetMethod.IsStatic)
            .Select(property => "property:" + property.Name + ":" + TypeName(property.PropertyType) + (property.SetMethod == null ? ":read-only" : ":read-write"));
        var methods = type.GetMethods(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.DeclaredOnly)
            .Where(method => !method.IsSpecialName).Select(method => "method:" + method.Name + ":" + TypeName(method.ReturnType) + "(" +
                string.Join(",", method.GetParameters().Select(parameter => TypeName(parameter.ParameterType))) + ")");
        var constructors = type.GetConstructors(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.DeclaredOnly)
            .Select(constructor => "constructor:(" + string.Join(",", constructor.GetParameters().Select(parameter => TypeName(parameter.ParameterType))) + ")");
        return type.FullName + "\n" + string.Join("\n", properties.Concat(methods).Concat(constructors).OrderBy(value => value, StringComparer.Ordinal));
    }

    private static string TypeName(Type type)
    {
        if (type.IsArray) return TypeName(type.GetElementType()!) + "[]";
        if (type.IsGenericType)
        {
            var name = type.GetGenericTypeDefinition().FullName ?? type.Name; var tick = name.IndexOf('`');
            if (tick >= 0) name = name.Substring(0, tick);
            return name + "<" + string.Join(",", type.GetGenericArguments().Select(TypeName)) + ">";
        }
        return type.FullName ?? type.Name;
    }
}

public sealed class DynamicResultReferenceGraphV1
{
    public string Schema { get; set; } = DynamicResultReferenceContractV1.GraphSchema;
    public string ContractManifestHash { get; set; } = DynamicResultReferenceManifestV1.ManifestHash;
    public string InputHash { get; set; } = "";
    public string DocumentFingerprint { get; set; } = "";
    public string DocumentSessionId { get; set; } = "";
    public long DocumentRevision { get; set; }
    public IReadOnlyList<DynamicResultReferenceNodeV1> Nodes { get; set; } = Array.Empty<DynamicResultReferenceNodeV1>();
    public string GraphHash { get; set; } = "";
}

public sealed class DynamicResultReferenceNodeV1
{
    public string NodeId { get; set; } = "";
    public string Kind { get; set; } = "";
    public IReadOnlyList<string> DependsOn { get; set; } = Array.Empty<string>();
    public IReadOnlyList<DynamicExternalTargetReferenceV1> ExternalTargets { get; set; } = Array.Empty<DynamicExternalTargetReferenceV1>();
    public IReadOnlyList<DynamicSymbolicResultReferenceV1> ResultReferences { get; set; } = Array.Empty<DynamicSymbolicResultReferenceV1>();
    public IReadOnlyList<DynamicResultOutputDeclarationV1> Outputs { get; set; } = Array.Empty<DynamicResultOutputDeclarationV1>();
    public IReadOnlyDictionary<string, string> Attributes { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
}

public sealed class DynamicExternalTargetReferenceV1
{
    public string TargetUniqueId { get; set; } = "";
    public long TargetElementId { get; set; }
    public string DocumentFingerprint { get; set; } = "";
    public string ExpectedCategoryStableId { get; set; } = "";
    public string ExpectedTypeUniqueId { get; set; } = "";
    public string ExpectedStateHash { get; set; } = "";
}

public sealed class DynamicSymbolicResultReferenceV1
{
    public string ResultId { get; set; } = "";
    public string OutputSlot { get; set; } = "";
    public string ExpectedDocumentFingerprint { get; set; } = "";
    public string ExpectedCategoryStableId { get; set; } = "";
    public string ExpectedTypeUniqueId { get; set; } = "";
}

public sealed class DynamicResultOutputDeclarationV1
{
    public string ResultId { get; set; } = "";
    public string OutputSlot { get; set; } = "";
    public string ExpectedDocumentFingerprint { get; set; } = "";
    public string ExpectedCategoryStableId { get; set; } = "";
    public string ExpectedTypeUniqueId { get; set; } = "";
}

public sealed class DynamicResultOutputSpecV1
{
    public string OutputSlot { get; set; } = "";
    public string ExpectedCategoryStableId { get; set; } = "";
    public string ExpectedTypeUniqueId { get; set; } = "";
}

public sealed class DynamicResultOperationHandleV1
{
    internal DynamicResultOperationHandleV1(string nodeId, IReadOnlyList<DynamicResultOutputDeclarationV1> outputs) { NodeId = nodeId; Outputs = outputs; }
    public string NodeId { get; }
    public IReadOnlyList<DynamicResultOutputDeclarationV1> Outputs { get; }
    public DynamicSymbolicResultReferenceV1 Reference(string outputSlot)
    {
        var output = Outputs.SingleOrDefault(value => value.OutputSlot == outputSlot) ?? throw new ArgumentException("Result output slot is not declared.", nameof(outputSlot));
        return new DynamicSymbolicResultReferenceV1
        {
            ResultId = output.ResultId, OutputSlot = output.OutputSlot, ExpectedDocumentFingerprint = output.ExpectedDocumentFingerprint,
            ExpectedCategoryStableId = output.ExpectedCategoryStableId, ExpectedTypeUniqueId = output.ExpectedTypeUniqueId
        };
    }
}

public sealed class DynamicTrustedElementFactV1
{
    public string UniqueId { get; set; } = "";
    public long ElementId { get; set; }
    public string DocumentFingerprint { get; set; } = "";
    public string CategoryStableId { get; set; } = "";
    public string TypeUniqueId { get; set; } = "";
    public string StateHash { get; set; } = "";
    public bool Exists { get; set; }
    public bool Verified { get; set; }
    public bool Visible { get; set; }
}

public sealed class DynamicResolvedElementTargetV1
{
    public string SourceKind { get; set; } = "";
    public string SourceIdentity { get; set; } = "";
    public string UniqueId { get; set; } = "";
    public long ElementId { get; set; }
    public string DocumentFingerprint { get; set; } = "";
    public string CategoryStableId { get; set; } = "";
    public string TypeUniqueId { get; set; } = "";
    public string StateHash { get; set; } = "";
}

public sealed class DynamicCreatedResultFactV1
{
    public string Schema { get; set; } = DynamicResultReferenceContractV1.OutputFactSchema;
    public string ProducerNodeId { get; set; } = "";
    public string ResultId { get; set; } = "";
    public string OutputSlot { get; set; } = "";
    public string CreatedUniqueId { get; set; } = "";
    public long CreatedElementId { get; set; }
    public string DocumentFingerprint { get; set; } = "";
    public string CategoryStableId { get; set; } = "";
    public string TypeUniqueId { get; set; } = "";
    public string StateHash { get; set; } = "";
    public string Status { get; set; } = "created_verified";
    public bool Verified { get; set; }
    public bool Visible { get; set; }
    public string OutputHash { get; set; } = "";
}

public sealed class DynamicResultReferenceReceiptV1
{
    public string Schema { get; set; } = DynamicResultReferenceContractV1.ReceiptSchema;
    public string ContractManifestHash { get; set; } = DynamicResultReferenceManifestV1.ManifestHash;
    public string GraphHash { get; set; } = "";
    public string DocumentFingerprint { get; set; } = "";
    public string DocumentSessionId { get; set; } = "";
    public long DocumentRevision { get; set; }
    public string Outcome { get; set; } = "";
    public bool RollbackVerified { get; set; }
    public bool PartialFailureRolledBack { get; set; }
    public string FailureNodeId { get; set; } = "";
    public IReadOnlyList<DynamicCreatedResultFactV1> Outputs { get; set; } = Array.Empty<DynamicCreatedResultFactV1>();
    public string ReceiptHash { get; set; } = "";
}

public sealed class DynamicResultReferenceProgramResultV1
{
    public string Schema { get; set; } = DynamicResultReferenceContractV1.ProgramResultSchema;
    public string ContractManifestHash { get; set; } = DynamicResultReferenceManifestV1.ManifestHash;
    public DynamicResultReferenceGraphV1 Graph { get; set; } = new();
    public IReadOnlyList<string> Logs { get; set; } = Array.Empty<string>();
    public IReadOnlyDictionary<string, string> Report { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
}

public interface IDynamicResultReferenceRevitProgramV1
{
    DynamicResultReferenceProgramResultV1 Execute(DynamicResultReferenceProgramContextV1 context);
}

public sealed partial class DynamicResultReferenceProgramContextV1
{
    private readonly List<string> _logs = new();
    private readonly Dictionary<string, string> _report = new(StringComparer.Ordinal);

    public DynamicResultReferenceProgramContextV1(DynamicTaskInput input, long documentRevision)
        : this(input, documentRevision, "", "", Array.Empty<DynamicBuildingSystemsEnvelopeV1>(), Array.Empty<DynamicTrustedElementFactV1>()) { }

    public DynamicTaskInput Input { get; }
    public IReadOnlyList<DynamicElementDto> Elements => Input.Elements;
    public DynamicResultReferenceGraphBuilderV1 Plan { get; }
    public void Log(string message)
    {
        if (string.IsNullOrWhiteSpace(message) || _logs.Count >= 64) return;
        var value = message.Trim(); _logs.Add(value.Length > 512 ? value.Substring(0, 512) : value);
    }
    public void Report(string key, string value)
    {
        if (_report.Count >= 64 || !DynamicCanonical.Id(key, 128) || value == null || value.Length > 1024) throw new ArgumentException("Result-reference structured report is invalid or unbounded.");
        _report[key] = value;
    }
    public DynamicResultReferenceProgramResultV1 Complete() => new()
    {
        Graph = Plan.Build(), Logs = _logs.ToArray(), Report = new Dictionary<string, string>(_report, StringComparer.Ordinal)
    };
}

public sealed class DynamicResultReferenceGraphBuilderV1
{
    private readonly string _inputHash; private readonly string _document; private readonly string _session; private readonly long _revision;
    private readonly List<DynamicResultReferenceNodeV1> _nodes = new();
    private readonly Dictionary<string, (string NodeId, DynamicResultOutputDeclarationV1 Output)> _outputs = new(StringComparer.Ordinal);

    public DynamicResultReferenceGraphBuilderV1(string inputHash, string documentFingerprint, string documentSessionId, long documentRevision)
    {
        RequireHash(inputHash); RequireHash(documentFingerprint); RequireId(documentSessionId, 256);
        if (documentRevision < 0) throw new ArgumentOutOfRangeException(nameof(documentRevision));
        _inputHash = inputHash; _document = documentFingerprint; _session = documentSessionId; _revision = documentRevision;
    }

    public DynamicResultOperationHandleV1 AddOperation(string kind, IEnumerable<DynamicExternalTargetReferenceV1>? externalTargets,
        IEnumerable<DynamicSymbolicResultReferenceV1>? resultReferences, IEnumerable<DynamicResultOutputSpecV1>? outputs,
        IReadOnlyDictionary<string, string>? attributes = null)
    {
        if (_nodes.Count >= DynamicResultReferenceContractV1.MaximumNodes) throw new InvalidOperationException("Result-reference operation bound exceeded.");
        RequireId(kind, 128);
        var references = (resultReferences ?? Array.Empty<DynamicSymbolicResultReferenceV1>()).Select(Clone).ToArray();
        var dependencies = new HashSet<string>(StringComparer.Ordinal);
        foreach (var reference in references)
        {
            var key = Key(reference.ResultId, reference.OutputSlot);
            if (!_outputs.TryGetValue(key, out var prior)) throw new InvalidOperationException("Result reference is unresolved or forward.");
            if (!ReferenceMatches(reference, prior.Output)) throw new InvalidOperationException("Result reference type, category, or document contract was substituted.");
            dependencies.Add(prior.NodeId);
        }
        var index = _nodes.Count;
        var declarations = (outputs ?? Array.Empty<DynamicResultOutputSpecV1>()).Select(spec => new DynamicResultOutputDeclarationV1
        {
            ResultId = DynamicWire.Sha256(DynamicCanonical.Join("dynamic-result-id/v1", _inputHash, _document, index.ToString(CultureInfo.InvariantCulture), spec.OutputSlot ?? "", kind)),
            OutputSlot = spec.OutputSlot ?? "", ExpectedDocumentFingerprint = _document,
            ExpectedCategoryStableId = spec.ExpectedCategoryStableId ?? "", ExpectedTypeUniqueId = spec.ExpectedTypeUniqueId ?? ""
        }).ToArray();
        var node = new DynamicResultReferenceNodeV1
        {
            Kind = kind, DependsOn = dependencies.OrderBy(value => value, StringComparer.Ordinal).ToArray(),
            ExternalTargets = (externalTargets ?? Array.Empty<DynamicExternalTargetReferenceV1>()).Select(Clone).ToArray(),
            ResultReferences = references, Outputs = declarations,
            Attributes = (attributes ?? new Dictionary<string, string>()).ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal)
        };
        node.NodeId = DynamicResultReferencePolicyV1.NodeId(node);
        DynamicResultReferencePolicyV1.ValidateNodeShape(node);
        foreach (var output in declarations)
        {
            var key = Key(output.ResultId, output.OutputSlot);
            if (_outputs.ContainsKey(key)) throw new InvalidOperationException("Duplicate symbolic result ID/output slot.");
            _outputs.Add(key, (node.NodeId, output));
        }
        _nodes.Add(node);
        return new DynamicResultOperationHandleV1(node.NodeId, declarations.Select(Clone).ToArray());
    }

    public DynamicResultReferenceGraphV1 Build()
    {
        if (_nodes.Count == 0) throw new InvalidOperationException("Result-reference graph is empty.");
        var graph = new DynamicResultReferenceGraphV1
        {
            InputHash = _inputHash, DocumentFingerprint = _document, DocumentSessionId = _session, DocumentRevision = _revision,
            Nodes = _nodes.Select(Clone).ToArray()
        };
        graph.GraphHash = DynamicResultReferencePolicyV1.GraphHash(graph); return graph;
    }

    private static string Key(string resultId, string slot) => resultId + "\n" + slot;
    private static bool ReferenceMatches(DynamicSymbolicResultReferenceV1 value, DynamicResultOutputDeclarationV1 output) =>
        value.ResultId == output.ResultId && value.OutputSlot == output.OutputSlot && value.ExpectedDocumentFingerprint == output.ExpectedDocumentFingerprint &&
        value.ExpectedCategoryStableId == output.ExpectedCategoryStableId && value.ExpectedTypeUniqueId == output.ExpectedTypeUniqueId;
    private static DynamicExternalTargetReferenceV1 Clone(DynamicExternalTargetReferenceV1 value) => new() { TargetUniqueId = value.TargetUniqueId, TargetElementId = value.TargetElementId, DocumentFingerprint = value.DocumentFingerprint, ExpectedCategoryStableId = value.ExpectedCategoryStableId, ExpectedTypeUniqueId = value.ExpectedTypeUniqueId, ExpectedStateHash = value.ExpectedStateHash };
    private static DynamicSymbolicResultReferenceV1 Clone(DynamicSymbolicResultReferenceV1 value) => new() { ResultId = value.ResultId, OutputSlot = value.OutputSlot, ExpectedDocumentFingerprint = value.ExpectedDocumentFingerprint, ExpectedCategoryStableId = value.ExpectedCategoryStableId, ExpectedTypeUniqueId = value.ExpectedTypeUniqueId };
    private static DynamicResultOutputDeclarationV1 Clone(DynamicResultOutputDeclarationV1 value) => new() { ResultId = value.ResultId, OutputSlot = value.OutputSlot, ExpectedDocumentFingerprint = value.ExpectedDocumentFingerprint, ExpectedCategoryStableId = value.ExpectedCategoryStableId, ExpectedTypeUniqueId = value.ExpectedTypeUniqueId };
    private static DynamicResultReferenceNodeV1 Clone(DynamicResultReferenceNodeV1 value) => new() { NodeId = value.NodeId, Kind = value.Kind, DependsOn = value.DependsOn.ToArray(), ExternalTargets = value.ExternalTargets.Select(Clone).ToArray(), ResultReferences = value.ResultReferences.Select(Clone).ToArray(), Outputs = value.Outputs.Select(Clone).ToArray(), Attributes = value.Attributes.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal) };
    private static void RequireHash(string value) { if (!DynamicCanonical.Hash(value)) throw new ArgumentException("A SHA-256 identity is required."); }
    private static void RequireId(string value, int maximum) { if (!DynamicCanonical.Id(value, maximum)) throw new ArgumentException("A bounded identity is required."); }
}

public static class DynamicResultReferencePolicyV1
{
    public static string NodeId(DynamicResultReferenceNodeV1 node) => DynamicWire.Sha256(DynamicCanonical.Join(node.Kind,
        DynamicCanonical.Set(node.DependsOn), string.Join("\n", node.ExternalTargets.Select(ExternalCanonical).OrderBy(value => value, StringComparer.Ordinal)),
        string.Join("\n", node.ResultReferences.Select(ReferenceCanonical).OrderBy(value => value, StringComparer.Ordinal)),
        string.Join("\n", node.Outputs.Select(OutputCanonical).OrderBy(value => value, StringComparer.Ordinal)), DynamicCanonical.Map(node.Attributes)));

    public static string GraphHash(DynamicResultReferenceGraphV1 graph) => DynamicWire.Sha256(DynamicCanonical.Join(graph.Schema,
        graph.ContractManifestHash, graph.InputHash, graph.DocumentFingerprint, graph.DocumentSessionId,
        graph.DocumentRevision.ToString(CultureInfo.InvariantCulture), string.Join("\n", graph.Nodes.Select(NodeId))));

    public static void ValidateWorkerOutput(DynamicResultReferenceGraphV1 graph, string inputHash, string documentFingerprint,
        string documentSessionId, long documentRevision)
    {
        if (graph == null || graph.Schema != DynamicResultReferenceContractV1.GraphSchema || graph.ContractManifestHash != DynamicResultReferenceManifestV1.ManifestHash ||
            graph.InputHash != inputHash || graph.DocumentFingerprint != documentFingerprint || graph.DocumentSessionId != documentSessionId ||
            graph.DocumentRevision != documentRevision || documentRevision < 0 || graph.Nodes == null || graph.Nodes.Count < 1 ||
            graph.Nodes.Count > DynamicResultReferenceContractV1.MaximumNodes)
            throw new ArgumentException("Result-reference worker graph envelope is invalid or substituted.");
        DynamicCanonical.RequireHashes(inputHash, documentFingerprint, graph.GraphHash);
        var seenNodes = new HashSet<string>(StringComparer.Ordinal);
        var outputs = new Dictionary<string, (string NodeId, DynamicResultOutputDeclarationV1 Output)>(StringComparer.Ordinal);
        var resultIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in graph.Nodes)
        {
            ValidateNodeShape(node);
            if (node.NodeId != NodeId(node) || !seenNodes.Add(node.NodeId) || node.DependsOn.Any(dependency => !seenNodes.Contains(dependency)))
                throw new ArgumentException("Result-reference worker node identity or dependency is invalid, forward, or cyclic.");
            var descriptor = DynamicPrimitiveManifestV1.Find(node.Kind) ?? throw new ArgumentException("Result-reference worker primitive is unknown.");
            if (descriptor.RequiredAttributes.Any(required => !node.Attributes.ContainsKey(required)) ||
                node.Attributes.Keys.Any(attribute => !descriptor.RequiredAttributes.Contains(attribute, StringComparer.Ordinal)))
                throw new ArgumentException("Result-reference worker primitive attributes are missing, unknown, or extra.");
            if ((descriptor.EffectClass == "create") != (node.Outputs.Count > 0)) throw new ArgumentException("Worker create primitives require outputs and only create primitives may declare them.");
            foreach (var external in node.ExternalTargets)
                if (external.DocumentFingerprint != documentFingerprint) throw new ArgumentException("Worker external target references another document.");
            foreach (var reference in node.ResultReferences)
            {
                if (!outputs.TryGetValue(Key(reference.ResultId, reference.OutputSlot), out var prior) || !ReferenceMatches(reference, prior.Output) ||
                    !node.DependsOn.Contains(prior.NodeId, StringComparer.Ordinal))
                    throw new ArgumentException("Worker symbolic result is unresolved, forward, or mismatched.");
            }
            foreach (var output in node.Outputs)
            {
                if (output.ExpectedDocumentFingerprint != documentFingerprint || !resultIds.Add(output.ResultId) ||
                    outputs.ContainsKey(Key(output.ResultId, output.OutputSlot)))
                    throw new ArgumentException("Worker symbolic output is foreign or duplicated.");
                outputs.Add(Key(output.ResultId, output.OutputSlot), (node.NodeId, output));
            }
        }
        if (graph.GraphHash != GraphHash(graph)) throw new ArgumentException("Result-reference worker graph hash is invalid.");
    }

    public static void Validate(DynamicResultReferenceGraphV1 graph, DynamicEffectBudgetV1 budget, IEnumerable<string> allowedKinds,
        IReadOnlyDictionary<string, DynamicTrustedElementFactV1> trustedExternalTargets)
    {
        if (graph == null || budget == null || allowedKinds == null || trustedExternalTargets == null || graph.Schema != DynamicResultReferenceContractV1.GraphSchema ||
            graph.ContractManifestHash != DynamicResultReferenceManifestV1.ManifestHash || graph.DocumentRevision < 0 || graph.Nodes == null ||
            graph.Nodes.Count < 1 || graph.Nodes.Count > DynamicResultReferenceContractV1.MaximumNodes || !DynamicCanonical.Id(graph.DocumentSessionId, 256))
            throw new ArgumentException("Result-reference graph envelope is invalid.");
        DynamicCanonical.RequireHashes(graph.InputHash, graph.DocumentFingerprint, graph.GraphHash);
        budget.Validate();
        if (!budget.TargetDocumentFingerprints.Contains(graph.DocumentFingerprint, StringComparer.Ordinal) || graph.Nodes.Count > budget.MaximumOperationCount)
            throw new ArgumentException("Result-reference graph exceeds its document or operation budget.");
        var kinds = new HashSet<string>(allowedKinds, StringComparer.Ordinal); var seenNodes = new HashSet<string>(StringComparer.Ordinal);
        var explicitTargets = budget.ExplicitTargetUniqueIds ?? Array.Empty<string>();
        var outputs = new Dictionary<string, (string NodeId, DynamicResultOutputDeclarationV1 Output)>(StringComparer.Ordinal);
        var resultIds = new HashSet<string>(StringComparer.Ordinal);
        var outputCount = 0; var createCount = 0; var modifyCount = 0; var deleteCount = 0;
        var affected = new HashSet<string>(StringComparer.Ordinal);
        var permittedExternalEffects = new HashSet<string>(budget.AllowedExternalEffectClasses ?? Array.Empty<string>(), StringComparer.Ordinal);
        foreach (var node in graph.Nodes)
        {
            ValidateNodeShape(node);
            if (node.NodeId != NodeId(node) || !seenNodes.Add(node.NodeId)) throw new ArgumentException("Result-reference node identity is invalid or duplicated.");
            if (node.DependsOn.Any(dependency => !seenNodes.Contains(dependency))) throw new ArgumentException("Result-reference dependency is missing, forward, or cyclic.");
            var descriptor = DynamicPrimitiveManifestV1.Find(node.Kind);
            if (descriptor == null || !kinds.Contains(node.Kind) || !(budget.AllowedSdkDomains ?? Array.Empty<string>()).Contains(descriptor.Domain, StringComparer.Ordinal))
                throw new ArgumentException("Result-reference primitive kind or domain is not authorized.");
            if (descriptor.RequiredAttributes.Any(required => !node.Attributes.ContainsKey(required)))
                throw new ArgumentException("Result-reference primitive is missing a required attribute.");
            if (node.Attributes.Keys.Any(attribute => !descriptor.RequiredAttributes.Contains(attribute, StringComparer.Ordinal)))
                throw new ArgumentException("Result-reference primitive contains an unknown or extra attribute.");
            if ((descriptor.EffectClass == "create") != (node.Outputs.Count > 0)) throw new ArgumentException("Create primitives require symbolic outputs and only create primitives may declare them.");
            if (descriptor.EffectClass == "create") createCount += node.Outputs.Count;
            else if (descriptor.EffectClass == "modify") modifyCount++;
            else if (descriptor.EffectClass == "delete") deleteCount++;
            else if (descriptor.EffectClass == "external")
            {
                if (!permittedExternalEffects.Contains(node.Kind)) throw new ArgumentException("Result-reference external effect is not authorized.");
            }
            else throw new ArgumentException("Result-reference primitive effect class is unsupported.");
            if ((descriptor.EffectClass == "modify" || descriptor.EffectClass == "delete") && node.ExternalTargets.Count + node.ResultReferences.Count < 1)
                throw new ArgumentException("Result-reference modifying and deleting primitives require an exact target reference.");
            foreach (var external in node.ExternalTargets)
            {
                if (!trustedExternalTargets.TryGetValue(external.TargetUniqueId, out var fact)) throw new InvalidOperationException("External target is unresolved.");
                ValidateExternalAgainstFact(external, fact, graph.DocumentFingerprint);
                if (explicitTargets.Count > 0 && !explicitTargets.Contains(external.TargetUniqueId, StringComparer.Ordinal))
                    throw new ArgumentException("External target is outside explicit scope.");
                if ((budget.AllowedCategories?.Count ?? 0) < 1 || !(budget.AllowedCategories ?? Array.Empty<string>()).Contains(fact.CategoryStableId, StringComparer.Ordinal))
                    throw new ArgumentException("External target category is outside scope.");
                if (descriptor.EffectClass != "create") affected.Add("external\n" + external.TargetUniqueId);
            }
            foreach (var reference in node.ResultReferences)
            {
                var key = Key(reference.ResultId, reference.OutputSlot);
                if (!outputs.TryGetValue(key, out var prior)) throw new InvalidOperationException("Symbolic result is unresolved or forward.");
                if (!ReferenceMatches(reference, prior.Output) || !node.DependsOn.Contains(prior.NodeId, StringComparer.Ordinal))
                    throw new InvalidOperationException("Symbolic result dependency, type, category, or document is invalid.");
                if (descriptor.EffectClass != "create") affected.Add("result\n" + key);
            }
            foreach (var output in node.Outputs)
            {
                var key = Key(output.ResultId, output.OutputSlot);
                if (outputs.ContainsKey(key) || !resultIds.Add(output.ResultId)) throw new ArgumentException("Duplicate symbolic result ID or output slot.");
                outputs.Add(key, (node.NodeId, output));
                if (output.ExpectedDocumentFingerprint != graph.DocumentFingerprint) throw new InvalidOperationException("Symbolic output targets another document.");
                if ((budget.AllowedCategories?.Count ?? 0) < 1 || !(budget.AllowedCategories ?? Array.Empty<string>()).Contains(output.ExpectedCategoryStableId, StringComparer.Ordinal))
                    throw new ArgumentException("Symbolic output category is outside scope.");
                affected.Add("output\n" + key);
                outputCount++;
            }
        }
        if (createCount > budget.MaximumCreates || modifyCount > budget.MaximumModifications || deleteCount > budget.MaximumDeletes ||
            affected.Count > budget.MaximumAffectedElements || outputCount > budget.MaximumOutputCount)
            throw new ArgumentException("Result-reference graph exceeds effect, affected-element, or output bounds.");
        if (graph.GraphHash != GraphHash(graph)) throw new ArgumentException("Result-reference graph hash is invalid.");
    }

    public static void ValidateNodeShape(DynamicResultReferenceNodeV1 node)
    {
        if (node == null || !DynamicCanonical.Id(node.Kind, 128) || node.DependsOn == null || node.ExternalTargets == null || node.ResultReferences == null || node.Outputs == null || node.Attributes == null ||
            node.DependsOn.Count > DynamicResultReferenceContractV1.MaximumNodes || node.ResultReferences.Count > DynamicResultReferenceContractV1.MaximumReferencesPerNode ||
            node.ExternalTargets.Count > DynamicResultReferenceContractV1.MaximumReferencesPerNode || node.Outputs.Count > DynamicResultReferenceContractV1.MaximumOutputsPerNode ||
            node.Attributes.Count > DynamicResultReferenceContractV1.MaximumAttributesPerNode || node.Attributes.Any(pair => !DynamicCanonical.Id(pair.Key, 128) || pair.Value == null || pair.Value.Length > 8192))
            throw new ArgumentException("Result-reference node is invalid or unbounded.");
        RequireDistinct(node.DependsOn, "dependency");
        foreach (var value in node.ExternalTargets) ValidateExternalShape(value);
        foreach (var value in node.ResultReferences) ValidateReferenceShape(value);
        foreach (var value in node.Outputs) ValidateOutputShape(value);
        if (node.ExternalTargets.Select(value => value.TargetUniqueId).Distinct(StringComparer.Ordinal).Count() != node.ExternalTargets.Count ||
            node.ResultReferences.Select(value => Key(value.ResultId, value.OutputSlot)).Distinct(StringComparer.Ordinal).Count() != node.ResultReferences.Count ||
            node.Outputs.Select(value => value.ResultId).Distinct(StringComparer.Ordinal).Count() != node.Outputs.Count ||
            node.Outputs.Select(value => value.OutputSlot).Distinct(StringComparer.Ordinal).Count() != node.Outputs.Count)
            throw new ArgumentException("Result-reference node contains duplicate targets, references, or outputs.");
    }

    public static string OutputHash(DynamicCreatedResultFactV1 value)
    {
        ValidateCreatedFactShape(value, requireHash: false);
        return DynamicWire.Sha256(DynamicCanonical.Join(value.Schema, value.ProducerNodeId, value.ResultId, value.OutputSlot,
            value.CreatedUniqueId, value.CreatedElementId.ToString(CultureInfo.InvariantCulture), value.DocumentFingerprint,
            value.CategoryStableId, value.TypeUniqueId, value.StateHash, value.Status, value.Verified ? "1" : "0", value.Visible ? "1" : "0"));
    }

    public static string ReceiptHash(DynamicResultReferenceReceiptV1 value)
    {
        if (value == null || value.Schema != DynamicResultReferenceContractV1.ReceiptSchema || value.ContractManifestHash != DynamicResultReferenceManifestV1.ManifestHash ||
            !DynamicCanonical.Hash(value.GraphHash) || !DynamicCanonical.Hash(value.DocumentFingerprint) || !DynamicCanonical.Id(value.DocumentSessionId, 256) || value.DocumentRevision < 0 ||
            !new[] { "preview_rolled_back_verified", "failed_rolled_back" }.Contains(value.Outcome, StringComparer.Ordinal) || !value.RollbackVerified || value.Outputs == null ||
            value.Outputs.Count > DynamicResultReferenceContractV1.MaximumNodes * DynamicResultReferenceContractV1.MaximumOutputsPerNode)
            throw new ArgumentException("Result-reference receipt is invalid.");
        if (value.Outcome == "failed_rolled_back" && (!value.PartialFailureRolledBack || !DynamicCanonical.Hash(value.FailureNodeId)))
            throw new ArgumentException("Partial failure receipt lacks exact rollback identity.");
        if (value.Outcome == "preview_rolled_back_verified" && (value.PartialFailureRolledBack || value.FailureNodeId.Length != 0))
            throw new ArgumentException("Successful rollback receipt contains contradictory failure state.");
        foreach (var output in value.Outputs)
        {
            ValidateCreatedFactShape(output, requireHash: true);
            if (output.Status != "rolled_back_verified" || output.Visible)
                throw new ArgumentException("Rollback receipt exposes a live or non-rolled-back symbolic output.");
        }
        if (value.Outputs.Select(output => Key(output.ResultId, output.OutputSlot)).Distinct(StringComparer.Ordinal).Count() != value.Outputs.Count ||
            value.Outputs.Select(output => output.CreatedUniqueId).Distinct(StringComparer.Ordinal).Count() != value.Outputs.Count ||
            value.Outputs.Select(output => output.CreatedElementId).Distinct().Count() != value.Outputs.Count)
            throw new ArgumentException("Rollback receipt contains duplicate symbolic or Revit output identities.");
        return DynamicWire.Sha256(DynamicCanonical.Join(value.Schema, value.ContractManifestHash, value.GraphHash, value.DocumentFingerprint,
            value.DocumentSessionId, value.DocumentRevision.ToString(CultureInfo.InvariantCulture), value.Outcome,
            value.RollbackVerified ? "1" : "0", value.PartialFailureRolledBack ? "1" : "0", value.FailureNodeId,
            string.Join("\n", value.Outputs.Select(output => output.OutputHash).OrderBy(hash => hash, StringComparer.Ordinal))));
    }

    internal static void ValidateCreatedFactShape(DynamicCreatedResultFactV1 value, bool requireHash)
    {
        if (value == null || value.Schema != DynamicResultReferenceContractV1.OutputFactSchema || !DynamicCanonical.Hash(value.ProducerNodeId) || !DynamicCanonical.Hash(value.ResultId) ||
            !DynamicCanonical.Id(value.OutputSlot, 128) || !DynamicCanonical.Id(value.CreatedUniqueId, 256) || value.CreatedElementId < 0 || !DynamicCanonical.Hash(value.DocumentFingerprint) ||
            !DynamicCanonical.Id(value.CategoryStableId, 256) || !DynamicCanonical.Id(value.TypeUniqueId, 256) || !DynamicCanonical.Hash(value.StateHash) ||
            !new[] { "created_verified", "rolled_back_verified" }.Contains(value.Status, StringComparer.Ordinal) || !value.Verified ||
            value.Status == "created_verified" && !value.Visible || requireHash && value.OutputHash != OutputHash(value))
            throw new ArgumentException("Created symbolic output fact is invalid, hidden, unverified, failed, skipped, or stale.");
    }

    internal static void ValidateExternalAgainstFact(DynamicExternalTargetReferenceV1 expected, DynamicTrustedElementFactV1 fact, string document)
    {
        if (fact == null || !fact.Exists || !fact.Verified || !fact.Visible || fact.UniqueId != expected.TargetUniqueId || fact.ElementId != expected.TargetElementId ||
            fact.DocumentFingerprint != document || fact.DocumentFingerprint != expected.DocumentFingerprint || fact.CategoryStableId != expected.ExpectedCategoryStableId ||
            fact.TypeUniqueId != expected.ExpectedTypeUniqueId || fact.StateHash != expected.ExpectedStateHash)
            throw new InvalidOperationException("External target is stale, hidden, unverified, missing, or mismatched.");
    }

    private static void ValidateExternalShape(DynamicExternalTargetReferenceV1 value)
    {
        if (value == null || !DynamicCanonical.Id(value.TargetUniqueId, 256) || value.TargetElementId < 0 || !DynamicCanonical.Hash(value.DocumentFingerprint) ||
            !DynamicCanonical.Id(value.ExpectedCategoryStableId, 256) || !DynamicCanonical.Id(value.ExpectedTypeUniqueId, 256) || !DynamicCanonical.Hash(value.ExpectedStateHash))
            throw new ArgumentException("External target reference shape is invalid.");
    }
    private static void ValidateReferenceShape(DynamicSymbolicResultReferenceV1 value) { if (value == null || !DynamicCanonical.Hash(value.ResultId) || !DynamicCanonical.Id(value.OutputSlot, 128) || !DynamicCanonical.Hash(value.ExpectedDocumentFingerprint) || !DynamicCanonical.Id(value.ExpectedCategoryStableId, 256) || !DynamicCanonical.Id(value.ExpectedTypeUniqueId, 256)) throw new ArgumentException("Symbolic result reference shape is invalid."); }
    private static void ValidateOutputShape(DynamicResultOutputDeclarationV1 value) { if (value == null || !DynamicCanonical.Hash(value.ResultId) || !DynamicCanonical.Id(value.OutputSlot, 128) || !DynamicCanonical.Hash(value.ExpectedDocumentFingerprint) || !DynamicCanonical.Id(value.ExpectedCategoryStableId, 256) || !DynamicCanonical.Id(value.ExpectedTypeUniqueId, 256)) throw new ArgumentException("Symbolic output declaration shape is invalid."); }
    private static string ExternalCanonical(DynamicExternalTargetReferenceV1 value) => DynamicCanonical.Join(value.TargetUniqueId, value.TargetElementId.ToString(CultureInfo.InvariantCulture), value.DocumentFingerprint, value.ExpectedCategoryStableId, value.ExpectedTypeUniqueId, value.ExpectedStateHash);
    private static string ReferenceCanonical(DynamicSymbolicResultReferenceV1 value) => DynamicCanonical.Join(value.ResultId, value.OutputSlot, value.ExpectedDocumentFingerprint, value.ExpectedCategoryStableId, value.ExpectedTypeUniqueId);
    private static string OutputCanonical(DynamicResultOutputDeclarationV1 value) => DynamicCanonical.Join(value.ResultId, value.OutputSlot, value.ExpectedDocumentFingerprint, value.ExpectedCategoryStableId, value.ExpectedTypeUniqueId);
    private static bool ReferenceMatches(DynamicSymbolicResultReferenceV1 value, DynamicResultOutputDeclarationV1 output) => ReferenceCanonical(value) == OutputCanonical(output);
    internal static string Key(string resultId, string slot) => resultId + "\n" + slot;
    private static void RequireDistinct(IEnumerable<string> values, string name) { var array = values.ToArray(); if (array.Any(value => !DynamicCanonical.Hash(value)) || array.Distinct(StringComparer.Ordinal).Count() != array.Length) throw new ArgumentException("Result-reference " + name + " identities are invalid or duplicated."); }
}

public sealed class DynamicResultReferenceHostResolverV1
{
    private readonly DynamicResultReferenceGraphV1 _graph;
    private readonly Dictionary<string, DynamicCreatedResultFactV1> _created = new(StringComparer.Ordinal);
    private readonly HashSet<string> _executed = new(StringComparer.Ordinal);
    private bool _closed;

    public DynamicResultReferenceHostResolverV1(DynamicResultReferenceGraphV1 graph)
    {
        _graph = graph ?? throw new ArgumentNullException(nameof(graph));
        DynamicResultReferencePolicyV1.ValidateWorkerOutput(graph, graph.InputHash, graph.DocumentFingerprint, graph.DocumentSessionId, graph.DocumentRevision);
    }

    public IReadOnlyList<DynamicResolvedElementTargetV1> Resolve(DynamicResultReferenceNodeV1 node, Func<string, DynamicTrustedElementFactV1?> liveExternalTarget)
    {
        if (_closed || node == null || liveExternalTarget == null || node.NodeId != DynamicResultReferencePolicyV1.NodeId(node) ||
            !_graph.Nodes.Any(value => value.NodeId == node.NodeId) || _executed.Contains(node.NodeId))
            throw new InvalidOperationException("Result-reference resolver state is invalid.");
        if (node.DependsOn.Any(dependency => !_executed.Contains(dependency))) throw new InvalidOperationException("Result-reference dependency has not completed successfully.");
        var resolved = new List<DynamicResolvedElementTargetV1>();
        foreach (var external in node.ExternalTargets.OrderBy(value => value.TargetUniqueId, StringComparer.Ordinal))
        {
            var fact = liveExternalTarget(external.TargetUniqueId) ?? throw new InvalidOperationException("External target disappeared before execution.");
            DynamicResultReferencePolicyV1.ValidateExternalAgainstFact(external, fact, _graph.DocumentFingerprint);
            resolved.Add(Resolved("external", external.TargetUniqueId, fact.UniqueId, fact.ElementId, fact.DocumentFingerprint, fact.CategoryStableId, fact.TypeUniqueId, fact.StateHash));
        }
        foreach (var reference in node.ResultReferences.OrderBy(value => value.ResultId, StringComparer.Ordinal).ThenBy(value => value.OutputSlot, StringComparer.Ordinal))
        {
            if (!_created.TryGetValue(DynamicResultReferencePolicyV1.Key(reference.ResultId, reference.OutputSlot), out var fact))
                throw new InvalidOperationException("Symbolic output is unresolved, failed, skipped, or hidden.");
            DynamicResultReferencePolicyV1.ValidateCreatedFactShape(fact, requireHash: true);
            if (fact.Status != "created_verified" || !fact.Visible || fact.DocumentFingerprint != reference.ExpectedDocumentFingerprint ||
                fact.CategoryStableId != reference.ExpectedCategoryStableId || fact.TypeUniqueId != reference.ExpectedTypeUniqueId)
                throw new InvalidOperationException("Symbolic output is failed, skipped, hidden, unverified, or mismatched.");
            resolved.Add(Resolved("result", DynamicResultReferencePolicyV1.Key(reference.ResultId, reference.OutputSlot), fact.CreatedUniqueId,
                fact.CreatedElementId, fact.DocumentFingerprint, fact.CategoryStableId, fact.TypeUniqueId, fact.StateHash));
        }
        return resolved;
    }

    public void RegisterSuccessfulOutputs(DynamicResultReferenceNodeV1 node, IEnumerable<DynamicCreatedResultFactV1> outputs)
    {
        if (_closed || node == null || node.NodeId != DynamicResultReferencePolicyV1.NodeId(node) ||
            !_graph.Nodes.Any(value => value.NodeId == node.NodeId) || _executed.Contains(node.NodeId))
            throw new InvalidOperationException("Result-reference node cannot be foreign, substituted, or registered twice.");
        var values = (outputs ?? throw new ArgumentNullException(nameof(outputs))).ToArray();
        if (values.Length != node.Outputs.Count) throw new InvalidOperationException("Host output set does not exactly cover declared slots.");
        foreach (var declaration in node.Outputs)
        {
            var fact = values.SingleOrDefault(value => value.ResultId == declaration.ResultId && value.OutputSlot == declaration.OutputSlot)
                ?? throw new InvalidOperationException("Declared symbolic output is missing.");
            DynamicResultReferencePolicyV1.ValidateCreatedFactShape(fact, requireHash: true);
            if (fact.ProducerNodeId != node.NodeId || fact.Status != "created_verified" || fact.DocumentFingerprint != declaration.ExpectedDocumentFingerprint ||
                fact.CategoryStableId != declaration.ExpectedCategoryStableId || fact.TypeUniqueId != declaration.ExpectedTypeUniqueId)
                throw new InvalidOperationException("Host output producer, type, category, document, status, or visibility is invalid.");
            var key = DynamicResultReferencePolicyV1.Key(fact.ResultId, fact.OutputSlot);
            if (_created.ContainsKey(key)) throw new InvalidOperationException("Host returned a duplicate symbolic output.");
            _created.Add(key, Clone(fact));
        }
        _executed.Add(node.NodeId);
    }

    public IReadOnlyList<DynamicCreatedResultFactV1> SnapshotSuccessfulOutputs()
    {
        if (_closed) throw new InvalidOperationException("Result-reference resolver is already closed.");
        return _created.Values.OrderBy(value => value.ResultId, StringComparer.Ordinal).ThenBy(value => value.OutputSlot, StringComparer.Ordinal).Select(Clone).ToArray();
    }

    public void RefreshSuccessfulOutputs(IEnumerable<DynamicCreatedResultFactV1> outputs)
    {
        if (_closed) throw new InvalidOperationException("Result-reference resolver is already closed.");
        var values = (outputs ?? throw new ArgumentNullException(nameof(outputs))).ToArray();
        if (values.Length != _created.Count || values.Select(value => DynamicResultReferencePolicyV1.Key(value.ResultId, value.OutputSlot)).Distinct(StringComparer.Ordinal).Count() != values.Length)
            throw new InvalidOperationException("Refreshed symbolic outputs do not exactly cover the successful output set.");
        foreach (var pair in _created.ToArray())
        {
            var current = pair.Value;
            var refreshed = values.SingleOrDefault(value => DynamicResultReferencePolicyV1.Key(value.ResultId, value.OutputSlot) == pair.Key)
                ?? throw new InvalidOperationException("A successful symbolic output is missing from live refresh.");
            DynamicResultReferencePolicyV1.ValidateCreatedFactShape(refreshed, requireHash: true);
            if (refreshed.ProducerNodeId != current.ProducerNodeId || refreshed.ResultId != current.ResultId || refreshed.OutputSlot != current.OutputSlot ||
                refreshed.CreatedUniqueId != current.CreatedUniqueId || refreshed.CreatedElementId != current.CreatedElementId ||
                refreshed.DocumentFingerprint != current.DocumentFingerprint || refreshed.CategoryStableId != current.CategoryStableId ||
                refreshed.TypeUniqueId != current.TypeUniqueId || refreshed.Status != "created_verified" || !refreshed.Verified || !refreshed.Visible)
                throw new InvalidOperationException("Live symbolic output refresh changed stable identity, provenance, type, category, or verification state.");
            _created[pair.Key] = Clone(refreshed);
        }
    }

    public IReadOnlyList<DynamicCreatedResultFactV1> CloseAndSnapshot()
    {
        if (_closed) throw new InvalidOperationException("Result-reference resolver is already closed.");
        _closed = true; return _created.Values.OrderBy(value => value.ResultId, StringComparer.Ordinal).ThenBy(value => value.OutputSlot, StringComparer.Ordinal).Select(Clone).ToArray();
    }

    private static DynamicResolvedElementTargetV1 Resolved(string sourceKind, string sourceIdentity, string uniqueId, long elementId, string document, string category, string type, string state) => new() { SourceKind = sourceKind, SourceIdentity = sourceIdentity, UniqueId = uniqueId, ElementId = elementId, DocumentFingerprint = document, CategoryStableId = category, TypeUniqueId = type, StateHash = state };
    internal static DynamicCreatedResultFactV1 Clone(DynamicCreatedResultFactV1 value) => new() { ProducerNodeId = value.ProducerNodeId, ResultId = value.ResultId, OutputSlot = value.OutputSlot, CreatedUniqueId = value.CreatedUniqueId, CreatedElementId = value.CreatedElementId, DocumentFingerprint = value.DocumentFingerprint, CategoryStableId = value.CategoryStableId, TypeUniqueId = value.TypeUniqueId, StateHash = value.StateHash, Status = value.Status, Verified = value.Verified, Visible = value.Visible, OutputHash = value.OutputHash };
}

public interface IDynamicResultReferenceTransactionalHostV1
{
    void Begin(DynamicResultReferenceGraphV1 graph);
    IReadOnlyList<DynamicCreatedResultFactV1> ExecuteNode(DynamicResultReferenceNodeV1 node, IReadOnlyList<DynamicResolvedElementTargetV1> resolvedTargets);
    bool Rollback();
}

public static class DynamicResultReferencePreviewEngineV1
{
    public static DynamicResultReferenceReceiptV1 Execute(DynamicResultReferenceGraphV1 graph, DynamicEffectBudgetV1 budget,
        IEnumerable<string> allowedKinds, IReadOnlyDictionary<string, DynamicTrustedElementFactV1> admissionTargets,
        Func<string, DynamicTrustedElementFactV1?> liveExternalTarget, IDynamicResultReferenceTransactionalHostV1 host)
    {
        DynamicResultReferencePolicyV1.Validate(graph, budget, allowedKinds, admissionTargets);
        if (host == null || liveExternalTarget == null) throw new ArgumentNullException("A transactional host and live target authority are required.");
        var resolver = new DynamicResultReferenceHostResolverV1(graph); string failureNode = ""; Exception? failure = null;
        host.Begin(graph);
        try
        {
            foreach (var node in graph.Nodes)
            {
                failureNode = node.NodeId;
                var resolved = resolver.Resolve(node, liveExternalTarget);
                resolver.RegisterSuccessfulOutputs(node, host.ExecuteNode(node, resolved));
            }
        }
        catch (Exception ex) { failure = ex; }
        var rollback = host.Rollback();
        if (!rollback) throw new InvalidOperationException("Result-reference host failed to verify rollback.", failure);
        var outputs = resolver.CloseAndSnapshot().Select(value => { var copy = DynamicResultReferenceHostResolverV1.Clone(value); copy.Status = "rolled_back_verified"; copy.Visible = false; copy.OutputHash = DynamicResultReferencePolicyV1.OutputHash(copy); return copy; }).ToArray();
        var receipt = new DynamicResultReferenceReceiptV1
        {
            GraphHash = graph.GraphHash, DocumentFingerprint = graph.DocumentFingerprint, DocumentSessionId = graph.DocumentSessionId,
            DocumentRevision = graph.DocumentRevision, Outcome = failure == null ? "preview_rolled_back_verified" : "failed_rolled_back",
            RollbackVerified = true, PartialFailureRolledBack = failure != null, FailureNodeId = failure == null ? "" : failureNode, Outputs = outputs
        };
        receipt.ReceiptHash = DynamicResultReferencePolicyV1.ReceiptHash(receipt); return receipt;
    }
}
