using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace RevitOperator.DynamicRevitSdk;

/// <summary>Versioned identities for the additive, unexposed core-operation host contract.</summary>
public static class DynamicCoreOperationsV1
{
    public const string ManifestSchema = "dynamic-revit-core-operation-manifest/v1";
    public const string BindingSchema = "dynamic-revit-core-operation-manifest-binding/v1";
    public const string ApplyAuthorizationSchema = "dynamic-revit-core-operation-apply-authorization/v1";
    public const string EffectSchema = "dynamic-revit-core-operation-effect/v1";
    public const string PreviewSchema = "dynamic-revit-core-operation-preview/v1";
    public const string ApplyReceiptSchema = "dynamic-revit-core-operation-apply-receipt/v1";
    public const string CanonicalVersion = "dynamic-revit-core-operation-canonical/v1";
    public const int MaximumOperations = 256;
    public const int MaximumAttributes = 16;
}

public sealed class DynamicCoreOperationDescriptorV1
{
    public string Kind { get; set; } = "";
    public string PrimitiveVersion { get; set; } = "";
    public string Domain { get; set; } = "";
    public string EffectClass { get; set; } = "modify";
    public bool ImplementedByV1Host { get; set; }
    public bool PreviewSupported { get; set; }
    public bool ApplySupported { get; set; }
    public IReadOnlyList<string> RequiredAttributes { get; set; } = Array.Empty<string>();
    public IReadOnlyList<string> AllowedAttributes { get; set; } = Array.Empty<string>();
}

public static class DynamicCoreOperationManifestV1
{
    private static readonly Type[] ContractTypes =
    {
        typeof(DynamicCoreOperationDescriptorV1), typeof(DynamicCoreOperationManifestBindingV1),
        typeof(DynamicCoreOperationAdmissionContextV1), typeof(DynamicCoreOperationEffectV1),
        typeof(DynamicCoreOperationApplyAuthorizationV1), typeof(DynamicCoreOperationReadbackV1),
        typeof(DynamicCoreOperationPreviewV1), typeof(DynamicCoreOperationApplyReceiptV1)
    };
    private static readonly DynamicCoreOperationDescriptorV1[] Descriptors =
    {
        D("set_parameter", "set_parameter/v1", "parameters", "modify", true, true,
            new[] { "expected_parameter_state_hash", "expected_storage_kind", "expected_target_state_hash", "parameter_identity", "parameter_scope", "raw_value", "value_kind", "value_semantics" },
            new[] { "expected_parameter_state_hash", "expected_storage_kind", "expected_target_state_hash", "parameter_identity", "parameter_scope", "raw_value", "spec_type_id", "unit_type_id", "value_kind", "value_semantics" }),
        D("rotate_element", "rotate_element/v1", "elements", "modify", true, true,
            new[] { "angle_radians", "axis_direction", "axis_origin_feet", "expected_target_state_hash" }),
        D("change_type", "change_type/v1", "elements", "modify", true, true,
            new[] { "expected_category_stable_id", "expected_connector_signature", "expected_replacement_family_stable_id", "expected_replacement_type_state_hash", "expected_source_family_stable_id", "expected_target_state_hash", "replacement_type_unique_id" }),
        D("delete_element", "delete_element/v1", "elements", "delete", true, false,
            new[] { "expected_target_state_hash" })
    };

    public static IReadOnlyList<DynamicCoreOperationDescriptorV1> All => Descriptors;
    public static DynamicCoreOperationDescriptorV1? Find(string kind) => Descriptors.FirstOrDefault(value => value.Kind == kind);
    public static string ContractSurfaceHash => DynamicWire.Sha256(string.Join("\n", ContractTypes.OrderBy(type => type.FullName, StringComparer.Ordinal).Select(Surface)));
    public static string ManifestHash => DynamicWire.Sha256(DynamicCanonical.Join(DynamicCoreOperationsV1.ManifestSchema, ContractSurfaceHash,
        string.Join("\n", Descriptors.OrderBy(value => value.Kind, StringComparer.Ordinal).Select(Canonical))));

    private static DynamicCoreOperationDescriptorV1 D(string kind, string version, string domain, string effectClass, bool preview, bool apply, string[] required, string[]? allowed = null)
        => new()
        {
            Kind = kind, PrimitiveVersion = version, Domain = domain, EffectClass = effectClass,
            ImplementedByV1Host = true, PreviewSupported = preview, ApplySupported = apply,
            RequiredAttributes = required.OrderBy(value => value, StringComparer.Ordinal).ToArray(),
            AllowedAttributes = (allowed ?? required).OrderBy(value => value, StringComparer.Ordinal).ToArray()
        };

    private static string Canonical(DynamicCoreOperationDescriptorV1 value) => DynamicCanonical.Join(value.Kind, value.PrimitiveVersion,
        value.Domain, value.EffectClass, value.ImplementedByV1Host ? "1" : "0", value.PreviewSupported ? "1" : "0", value.ApplySupported ? "1" : "0",
        DynamicCanonical.Set(value.RequiredAttributes), DynamicCanonical.Set(value.AllowedAttributes));

    private static string Surface(Type type) => type.FullName + "\n" + string.Join("\n", type.GetProperties()
        .Where(property => property.GetMethod != null && property.GetMethod.IsPublic && !property.GetMethod.IsStatic)
        .OrderBy(property => property.Name, StringComparer.Ordinal).Select(property => property.Name + ":" + TypeName(property.PropertyType)));
    private static string TypeName(Type type)
    {
        if (type.IsArray) return TypeName(type.GetElementType()!) + "[]";
        if (type.IsGenericType)
        {
            var name = type.GetGenericTypeDefinition().FullName ?? type.Name;
            var tick = name.IndexOf('`'); if (tick >= 0) name = name.Substring(0, tick);
            return name + "<" + string.Join(",", type.GetGenericArguments().Select(TypeName)) + ">";
        }
        return type.FullName ?? type.Name;
    }
}

/// <summary>Typed builder. There is intentionally no generic untyped attribute adapter.</summary>
public sealed class DynamicCoreOperationGraphBuilderV1
{
    private readonly string _inputHash;
    private readonly string _documentFingerprint;
    private readonly long _documentRevision;
    private readonly int _budget;
    private readonly List<DynamicOperationNodeV1> _nodes = new();
    private string? _prior;

    public DynamicCoreOperationGraphBuilderV1(string inputHash, string documentFingerprint, long documentRevision, int operationBudget)
    {
        RequireHash(inputHash, nameof(inputHash)); RequireHash(documentFingerprint, nameof(documentFingerprint));
        if (documentRevision < 0) throw new ArgumentOutOfRangeException(nameof(documentRevision));
        if (operationBudget < 1 || operationBudget > DynamicCoreOperationsV1.MaximumOperations) throw new ArgumentOutOfRangeException(nameof(operationBudget));
        _inputHash = inputHash; _documentFingerprint = documentFingerprint; _documentRevision = documentRevision; _budget = operationBudget;
    }

    public string SetString(string targetUniqueId, string parameterIdentity, string scope, string value, string expectedTargetStateHash, string expectedParameterStateHash)
        => SetParameter(targetUniqueId, parameterIdentity, scope, "string", value ?? throw new ArgumentNullException(nameof(value)), "raw", "string", null, null, expectedTargetStateHash, expectedParameterStateHash);

    public string SetInteger(string targetUniqueId, string parameterIdentity, string scope, int value, string expectedTargetStateHash, string expectedParameterStateHash)
        => SetParameter(targetUniqueId, parameterIdentity, scope, "integer", value.ToString(CultureInfo.InvariantCulture), "raw", "integer", null, null, expectedTargetStateHash, expectedParameterStateHash);

    public string SetDoubleInternal(string targetUniqueId, string parameterIdentity, string scope, double internalValue, string specTypeId, string unitTypeId, string expectedTargetStateHash, string expectedParameterStateHash)
    {
        if (!Finite(internalValue)) throw new ArgumentException("A typed Revit double must be finite.", nameof(internalValue));
        return SetParameter(targetUniqueId, parameterIdentity, scope, "double", internalValue.ToString("R", CultureInfo.InvariantCulture), "internal_revit_units", "double",
            Required(specTypeId, 256), Required(unitTypeId, 256), expectedTargetStateHash, expectedParameterStateHash);
    }

    public string SetElementId(string targetUniqueId, string parameterIdentity, string scope, long elementId, string expectedTargetStateHash, string expectedParameterStateHash)
    {
        if (elementId < -1) throw new ArgumentOutOfRangeException(nameof(elementId));
        return SetParameter(targetUniqueId, parameterIdentity, scope, "element_id", elementId.ToString(CultureInfo.InvariantCulture), "raw", "element_id", null, null, expectedTargetStateHash, expectedParameterStateHash);
    }

    public string RotateElement(string targetUniqueId, DynamicPointV1 axisOriginFeet, DynamicPointV1 axisDirection, double angleRadians, string expectedTargetStateHash)
    {
        ValidatePoint(axisOriginFeet, true); ValidatePoint(axisDirection, false);
        var magnitude = Math.Sqrt(axisDirection.X * axisDirection.X + axisDirection.Y * axisDirection.Y + axisDirection.Z * axisDirection.Z);
        if (magnitude < 1e-12 || !Finite(angleRadians) || Math.Abs(angleRadians) > Math.PI * 2d) throw new ArgumentException("Rotation axis or angle is invalid.");
        var normalized = new DynamicPointV1 { X = axisDirection.X / magnitude, Y = axisDirection.Y / magnitude, Z = axisDirection.Z / magnitude };
        return Add("rotate_element", targetUniqueId, new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["axis_origin_feet"] = Point(axisOriginFeet), ["axis_direction"] = Point(normalized),
            ["angle_radians"] = angleRadians.ToString("R", CultureInfo.InvariantCulture), ["expected_target_state_hash"] = Hash(expectedTargetStateHash)
        });
    }

    public string ChangeType(string targetUniqueId, string replacementTypeUniqueId, string expectedCategoryStableId,
        string expectedSourceFamilyStableId, string expectedReplacementFamilyStableId, string expectedConnectorSignature,
        string expectedTargetStateHash, string expectedReplacementTypeStateHash)
        => Add("change_type", targetUniqueId, new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["replacement_type_unique_id"] = Required(replacementTypeUniqueId, 256),
            ["expected_category_stable_id"] = Required(expectedCategoryStableId, 256),
            ["expected_source_family_stable_id"] = Required(expectedSourceFamilyStableId, 256),
            ["expected_replacement_family_stable_id"] = Required(expectedReplacementFamilyStableId, 256),
            ["expected_connector_signature"] = Hash(expectedConnectorSignature),
            ["expected_target_state_hash"] = Hash(expectedTargetStateHash),
            ["expected_replacement_type_state_hash"] = Hash(expectedReplacementTypeStateHash)
        });

    public string DeleteElementDryRun(string targetUniqueId, string expectedTargetStateHash)
        => Add("delete_element", targetUniqueId, new Dictionary<string, string>(StringComparer.Ordinal) { ["expected_target_state_hash"] = Hash(expectedTargetStateHash) });

    public DynamicOperationGraphV1 Build()
    {
        if (_nodes.Count == 0) throw new InvalidOperationException("A core-operation graph requires at least one operation.");
        var graph = new DynamicOperationGraphV1
        {
            InputHash = _inputHash, DocumentFingerprint = _documentFingerprint, DocumentRevision = _documentRevision,
            Nodes = _nodes.Select(Clone).ToArray()
        };
        graph.GraphHash = DynamicOperationGraphV1Admission.GraphHash(graph);
        return graph;
    }

    private string SetParameter(string targetUniqueId, string parameterIdentity, string scope, string valueKind, string rawValue,
        string semantics, string storage, string? spec, string? unit, string expectedTargetStateHash, string expectedParameterStateHash)
    {
        if (scope != "instance" && scope != "type") throw new ArgumentException("Parameter scope must be instance or type.", nameof(scope));
        if (rawValue.Length > 4096) throw new ArgumentException("Typed parameter raw value exceeds the bound.", nameof(rawValue));
        var attributes = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["parameter_identity"] = Required(parameterIdentity, 256), ["parameter_scope"] = scope, ["value_kind"] = valueKind,
            ["raw_value"] = rawValue, ["value_semantics"] = semantics, ["expected_storage_kind"] = storage,
            ["expected_target_state_hash"] = Hash(expectedTargetStateHash), ["expected_parameter_state_hash"] = Hash(expectedParameterStateHash)
        };
        if (spec != null) attributes["spec_type_id"] = spec;
        if (unit != null) attributes["unit_type_id"] = unit;
        return Add("set_parameter", targetUniqueId, attributes);
    }

    private string Add(string kind, string targetUniqueId, IReadOnlyDictionary<string, string> attributes)
    {
        if (_nodes.Count >= _budget) throw new InvalidOperationException("Core-operation budget exceeded.");
        var node = new DynamicOperationNodeV1
        {
            Kind = kind, TargetUniqueIds = new[] { Required(targetUniqueId, 256) },
            DependsOn = _prior == null ? Array.Empty<string>() : new[] { _prior },
            Attributes = attributes.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal)
        };
        DynamicCoreOperationAdmissionV1.ValidateNodeShape(node, "preview");
        node.NodeId = DynamicOperationGraphV1Admission.NodeId(node);
        _nodes.Add(node); _prior = node.NodeId; return node.NodeId;
    }

    private static DynamicOperationNodeV1 Clone(DynamicOperationNodeV1 value) => new()
    {
        NodeId = value.NodeId, Kind = value.Kind, TargetUniqueIds = value.TargetUniqueIds.ToArray(), DependsOn = value.DependsOn.ToArray(),
        Attributes = value.Attributes.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal)
    };
    private static string Point(DynamicPointV1 value) => value.X.ToString("R", CultureInfo.InvariantCulture) + "," + value.Y.ToString("R", CultureInfo.InvariantCulture) + "," + value.Z.ToString("R", CultureInfo.InvariantCulture);
    private static void ValidatePoint(DynamicPointV1 value, bool coordinate) { if (value == null || !Finite(value.X) || !Finite(value.Y) || !Finite(value.Z) || coordinate && new[] { value.X, value.Y, value.Z }.Any(component => Math.Abs(component) > 1e9)) throw new ArgumentException("Core-operation point is invalid."); }
    private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    private static string Required(string value, int length) => string.IsNullOrWhiteSpace(value) || value.Length > length ? throw new ArgumentException("A bounded core-operation identity is required.") : value;
    private static string Hash(string value) { RequireHash(value, nameof(value)); return value; }
    private static void RequireHash(string value, string name) { if (!DynamicCanonical.Hash(value)) throw new ArgumentException("A core-operation SHA-256 identity is required.", name); }
}

public sealed class DynamicCoreOperationManifestBindingV1
{
    public string Schema { get; set; } = DynamicCoreOperationsV1.BindingSchema;
    public string BindingId { get; set; } = "";
    public string CoreManifestHash { get; set; } = "";
    public string PrimitiveManifestHash { get; set; } = "";
    public string GraphHash { get; set; } = "";
    public string DocumentFingerprint { get; set; } = "";
    public long DocumentRevision { get; set; }
    public string HostAdapterManifestHash { get; set; } = "";
    public string NonceHash { get; set; } = "";
    public long IssuedUnixSeconds { get; set; }
    public long ExpiresUnixSeconds { get; set; }
    public string Signature { get; set; } = "";
}

public sealed class DynamicCoreOperationAdmissionContextV1
{
    public string HostAdapterManifestHash { get; set; } = "";
    public IReadOnlyDictionary<string, string> TargetCategoryStableIds { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
    public IReadOnlyDictionary<string, string> TargetStateHashes { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
    public string ViewScopeHash { get; set; } = "";
    public string LevelScopeHash { get; set; } = "";
    public string WorksetScopeHash { get; set; } = "";
    public string PhaseScopeHash { get; set; } = "";
    public string FileCapabilitySetHash { get; set; } = "";
    public int PlannedExecutionMilliseconds { get; set; }
    public int PlannedRegenerations { get; set; }
}

public static class DynamicCoreOperationManifestBindingPolicyV1
{
    public static DynamicCoreOperationManifestBindingV1 Issue(DynamicOperationGraphV1 graph, string hostAdapterManifestHash,
        long nowUnixSeconds, long expiresUnixSeconds, byte[] trustedKey, string bindingId, string nonceHash)
    {
        if (graph == null) throw new ArgumentNullException(nameof(graph));
        var value = new DynamicCoreOperationManifestBindingV1
        {
            BindingId = Required(bindingId), CoreManifestHash = DynamicCoreOperationManifestV1.ManifestHash,
            PrimitiveManifestHash = DynamicPrimitiveManifestV1.ManifestHash, GraphHash = graph.GraphHash,
            DocumentFingerprint = graph.DocumentFingerprint, DocumentRevision = graph.DocumentRevision,
            HostAdapterManifestHash = Hash(hostAdapterManifestHash), NonceHash = Hash(nonceHash),
            IssuedUnixSeconds = nowUnixSeconds, ExpiresUnixSeconds = expiresUnixSeconds
        };
        ValidateShape(value, nowUnixSeconds, allowCurrent: true);
        value.Signature = Sign(value, trustedKey); return value;
    }

    public static string Canonical(DynamicCoreOperationManifestBindingV1 value) => DynamicCanonical.Join(value.Schema, value.BindingId,
        value.CoreManifestHash, value.PrimitiveManifestHash, value.GraphHash, value.DocumentFingerprint,
        value.DocumentRevision.ToString(CultureInfo.InvariantCulture), value.HostAdapterManifestHash, value.NonceHash,
        value.IssuedUnixSeconds.ToString(CultureInfo.InvariantCulture), value.ExpiresUnixSeconds.ToString(CultureInfo.InvariantCulture));

    public static string BindingHash(DynamicCoreOperationManifestBindingV1 value) => DynamicWire.Sha256(Canonical(value) + "+" + (value.Signature ?? ""));

    public static string Sign(DynamicCoreOperationManifestBindingV1 value, byte[] trustedKey)
    {
        RequireKey(trustedKey); using var hmac = new HMACSHA256(trustedKey);
        return "hmac-sha256:" + BitConverter.ToString(hmac.ComputeHash(Encoding.UTF8.GetBytes(Canonical(value)))).Replace("-", "").ToLowerInvariant();
    }

    public static void Validate(DynamicCoreOperationManifestBindingV1 value, DynamicOperationGraphV1 graph,
        string expectedHostAdapterManifestHash, byte[] trustedKey, long nowUnixSeconds)
    {
        ValidateShape(value, nowUnixSeconds, allowCurrent: false); RequireKey(trustedKey);
        if (graph == null || value.CoreManifestHash != DynamicCoreOperationManifestV1.ManifestHash || value.PrimitiveManifestHash != DynamicPrimitiveManifestV1.ManifestHash ||
            value.GraphHash != graph.GraphHash || value.DocumentFingerprint != graph.DocumentFingerprint || value.DocumentRevision != graph.DocumentRevision ||
            value.HostAdapterManifestHash != expectedHostAdapterManifestHash || value.Signature != Sign(value, trustedKey))
            throw new InvalidOperationException("Core-operation manifest binding is invalid or does not match trusted graph/host state.");
    }

    private static void ValidateShape(DynamicCoreOperationManifestBindingV1 value, long now, bool allowCurrent)
    {
        if (value == null || value.Schema != DynamicCoreOperationsV1.BindingSchema || string.IsNullOrWhiteSpace(value.BindingId) || value.BindingId.Length > 160 ||
            !DynamicCanonical.Hash(value.CoreManifestHash) || !DynamicCanonical.Hash(value.PrimitiveManifestHash) || !DynamicCanonical.Hash(value.GraphHash) ||
            !DynamicCanonical.Hash(value.DocumentFingerprint) || value.DocumentRevision < 0 || !DynamicCanonical.Hash(value.HostAdapterManifestHash) ||
            !DynamicCanonical.Hash(value.NonceHash) || value.ExpiresUnixSeconds <= value.IssuedUnixSeconds || value.ExpiresUnixSeconds - value.IssuedUnixSeconds > 300 ||
            (!allowCurrent && (value.IssuedUnixSeconds > now + 5 || value.ExpiresUnixSeconds <= now)))
            throw new InvalidOperationException("Core-operation manifest binding shape or lifetime is invalid.");
    }
    private static string Required(string value) => string.IsNullOrWhiteSpace(value) || value.Length > 160 ? throw new ArgumentException("Binding id is required.") : value;
    private static string Hash(string value) => DynamicCanonical.Hash(value) ? value : throw new ArgumentException("A manifest-binding hash is invalid.");
    private static void RequireKey(byte[] key) { if (key == null || key.Length < 32) throw new ArgumentException("Core-operation signing key must be at least 256 bits."); }
}

public static class DynamicCoreOperationAdmissionV1
{
    public static void Validate(DynamicOperationGraphV1 graph, DynamicEffectBudgetV1 budget, DynamicCoreOperationAdmissionContextV1 context,
        DynamicCoreOperationManifestBindingV1 binding, byte[] trustedKey, long nowUnixSeconds, string phase, Func<string, bool>? tryConsumeBinding = null)
    {
        if (phase != "preview" && phase != "apply") throw new ArgumentException("Core-operation phase must be preview or apply.");
        if (graph == null || budget == null || context == null || graph.Schema != DynamicRevitProductionSchemas.OperationGraphV1 || graph.Nodes == null || graph.Nodes.Count < 1 || graph.Nodes.Count > DynamicCoreOperationsV1.MaximumOperations)
            throw new ArgumentException("Core-operation graph is invalid.");
        DynamicCoreOperationManifestBindingPolicyV1.Validate(binding, graph, context.HostAdapterManifestHash, trustedKey, nowUnixSeconds);
        if (tryConsumeBinding != null && !tryConsumeBinding(DynamicCoreOperationManifestBindingPolicyV1.BindingHash(binding))) throw new InvalidOperationException("Core-operation manifest binding was replayed.");
        DynamicCanonical.RequireHashes(graph.InputHash, graph.DocumentFingerprint, graph.GraphHash, context.HostAdapterManifestHash,
            context.ViewScopeHash, context.LevelScopeHash, context.WorksetScopeHash, context.PhaseScopeHash, context.FileCapabilitySetHash);
        if (graph.GraphHash != DynamicOperationGraphV1Admission.GraphHash(graph)) throw new ArgumentException("Core-operation graph hash is invalid.");
        budget.Validate();
        if (!budget.TargetDocumentFingerprints.Contains(graph.DocumentFingerprint, StringComparer.Ordinal) || graph.Nodes.Count > budget.MaximumOperationCount ||
            context.ViewScopeHash != budget.ViewScopeHash || context.LevelScopeHash != budget.LevelScopeHash || context.WorksetScopeHash != budget.WorksetScopeHash ||
            context.PhaseScopeHash != budget.PhaseScopeHash || context.FileCapabilitySetHash != budget.FileCapabilitySetHash ||
            context.PlannedExecutionMilliseconds < 0 || context.PlannedExecutionMilliseconds > budget.MaximumExecutionMilliseconds ||
            context.PlannedRegenerations < 0 || context.PlannedRegenerations > budget.MaximumRegenerations)
            throw new ArgumentException("Core-operation effect budget or trusted scopes do not match.");
        var domains = new HashSet<string>(budget.AllowedSdkDomains, StringComparer.Ordinal);
        var targets = new HashSet<string>(budget.ExplicitTargetUniqueIds, StringComparer.Ordinal);
        var categories = new HashSet<string>(budget.AllowedCategories, StringComparer.Ordinal);
        var nodeIds = new HashSet<string>(StringComparer.Ordinal); var modifies = 0; var deletes = 0;
        foreach (var node in graph.Nodes)
        {
            ValidateNodeShape(node, phase);
            if (node.NodeId != DynamicOperationGraphV1Admission.NodeId(node) || !nodeIds.Add(node.NodeId)) throw new ArgumentException("Core-operation node identity is invalid or duplicated.");
            if (node.DependsOn.Any(dependency => dependency == node.NodeId || !nodeIds.Contains(dependency)))
                throw new ArgumentException("Core-operation dependencies must reference distinct earlier nodes.");
            var descriptor = DynamicCoreOperationManifestV1.Find(node.Kind)!;
            var productionDescriptor = DynamicPrimitiveManifestV1.Find(node.Kind);
            if (!descriptor.ImplementedByV1Host || productionDescriptor == null || !productionDescriptor.ImplementedByV1Host || !domains.Contains(descriptor.Domain))
                throw new InvalidOperationException("Core-operation primitive is not implemented by the signed v1 host manifest.");
            var target = node.TargetUniqueIds[0];
            if (targets.Count > 0 && !targets.Contains(target)) throw new ArgumentException("Core-operation target is outside explicit scope.");
            if (!context.TargetCategoryStableIds.TryGetValue(target, out var category) || categories.Count == 0 || !categories.Contains(category)) throw new ArgumentException("Core-operation target category is outside trusted scope.");
            if (!context.TargetStateHashes.TryGetValue(target, out var stateHash) || node.Attributes["expected_target_state_hash"] != stateHash) throw new InvalidOperationException("Core-operation target state is stale.");
            if (descriptor.EffectClass == "delete") deletes++; else modifies++;
        }
        if (graph.Nodes.SelectMany(value => value.TargetUniqueIds).Distinct(StringComparer.Ordinal).Count() > budget.MaximumAffectedElements || modifies > budget.MaximumModifications || deletes > budget.MaximumDeletes)
            throw new ArgumentException("Core-operation graph exceeds modification/delete bounds.");
        if (graph.Nodes.Select(node => node.TargetUniqueIds[0]).Distinct(StringComparer.Ordinal).Count() != graph.Nodes.Count)
            throw new ArgumentException("Core-operation v1 requires one exact mutation per target; compose later work from readback state.");
    }

    public static void ValidateNodeShape(DynamicOperationNodeV1 node, string phase)
    {
        if (node == null || node.TargetUniqueIds == null || node.TargetUniqueIds.Count != 1 || string.IsNullOrWhiteSpace(node.TargetUniqueIds[0]) || node.TargetUniqueIds[0].Length > 256 ||
            node.DependsOn == null || node.DependsOn.Count > DynamicCoreOperationsV1.MaximumOperations || node.Attributes == null || node.Attributes.Count > DynamicCoreOperationsV1.MaximumAttributes)
            throw new ArgumentException("Core-operation node shape is invalid.");
        var descriptor = DynamicCoreOperationManifestV1.Find(node.Kind) ?? throw new ArgumentException("Unknown core-operation primitive.");
        if (!descriptor.ImplementedByV1Host || phase == "preview" && !descriptor.PreviewSupported || phase == "apply" && !descriptor.ApplySupported)
            throw new InvalidOperationException("Core-operation primitive is not supported in this phase.");
        var keys = node.Attributes.Keys.ToArray();
        if (keys.Distinct(StringComparer.Ordinal).Count() != keys.Length || keys.Any(key => !descriptor.AllowedAttributes.Contains(key, StringComparer.Ordinal)) ||
            descriptor.RequiredAttributes.Any(required => !node.Attributes.ContainsKey(required)) || node.Attributes.Any(pair => string.IsNullOrWhiteSpace(pair.Key) || pair.Key.Length > 128 || pair.Value == null || pair.Value.Length > 4096))
            throw new ArgumentException("Core-operation attributes contain missing, duplicate, unknown, or unbounded values.");
        if (!DynamicCanonical.Hash(node.Attributes["expected_target_state_hash"])) throw new ArgumentException("Core-operation target-state identity is invalid.");
        if (node.Kind == "set_parameter") ValidateSetParameter(node.Attributes);
        else if (node.Kind == "rotate_element") ValidateRotation(node.Attributes);
        else if (node.Kind == "change_type") ValidateChangeType(node.Attributes);
    }

    private static void ValidateSetParameter(IReadOnlyDictionary<string, string> attributes)
    {
        var kind = attributes["value_kind"]; var storage = attributes["expected_storage_kind"];
        if (kind != storage || !new[] { "string", "integer", "double", "element_id" }.Contains(kind, StringComparer.Ordinal) ||
            attributes["parameter_scope"] != "instance" && attributes["parameter_scope"] != "type" ||
            string.IsNullOrWhiteSpace(attributes["parameter_identity"]) || attributes["parameter_identity"].Length > 256 ||
            !DynamicCanonical.Hash(attributes["expected_parameter_state_hash"]))
            throw new ArgumentException("Typed set_parameter metadata is invalid.");
        var raw = attributes["raw_value"];
        if (kind == "string")
        {
            ExactKeys(attributes, "expected_parameter_state_hash", "expected_storage_kind", "expected_target_state_hash", "parameter_identity", "parameter_scope", "raw_value", "value_kind", "value_semantics");
            if (attributes["value_semantics"] != "raw") throw new ArgumentException("String parameter value must use raw semantics.");
        }
        else if (kind == "integer")
        {
            ExactKeys(attributes, "expected_parameter_state_hash", "expected_storage_kind", "expected_target_state_hash", "parameter_identity", "parameter_scope", "raw_value", "value_kind", "value_semantics");
            if (attributes["value_semantics"] != "raw" || !int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out _)) throw new ArgumentException("Integer parameter value is invalid.");
        }
        else if (kind == "element_id")
        {
            ExactKeys(attributes, "expected_parameter_state_hash", "expected_storage_kind", "expected_target_state_hash", "parameter_identity", "parameter_scope", "raw_value", "value_kind", "value_semantics");
            if (attributes["value_semantics"] != "raw" || !long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id) || id < -1) throw new ArgumentException("ElementId parameter value is invalid.");
        }
        else
        {
            ExactKeys(attributes, "expected_parameter_state_hash", "expected_storage_kind", "expected_target_state_hash", "parameter_identity", "parameter_scope", "raw_value", "spec_type_id", "unit_type_id", "value_kind", "value_semantics");
            if (attributes["value_semantics"] != "internal_revit_units" || !double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) || !Finite(value) ||
                string.IsNullOrWhiteSpace(attributes["spec_type_id"]) || string.IsNullOrWhiteSpace(attributes["unit_type_id"])) throw new ArgumentException("Double parameter internal-unit value is invalid.");
        }
    }

    private static void ValidateRotation(IReadOnlyDictionary<string, string> attributes)
    {
        ExactKeys(attributes, "angle_radians", "axis_direction", "axis_origin_feet", "expected_target_state_hash");
        var origin = Vector(attributes["axis_origin_feet"]); var direction = Vector(attributes["axis_direction"]);
        var magnitude = Math.Sqrt(direction.Sum(value => value * value));
        if (origin.Any(value => Math.Abs(value) > 1e9) || Math.Abs(magnitude - 1d) > 1e-9 ||
            !double.TryParse(attributes["angle_radians"], NumberStyles.Float, CultureInfo.InvariantCulture, out var angle) || !Finite(angle) || Math.Abs(angle) > Math.PI * 2d)
            throw new ArgumentException("rotate_element axis or radians are invalid.");
    }

    private static void ValidateChangeType(IReadOnlyDictionary<string, string> attributes)
    {
        ExactKeys(attributes, "expected_category_stable_id", "expected_connector_signature", "expected_replacement_family_stable_id", "expected_replacement_type_state_hash", "expected_source_family_stable_id", "expected_target_state_hash", "replacement_type_unique_id");
        foreach (var name in new[] { "expected_category_stable_id", "expected_replacement_family_stable_id", "expected_source_family_stable_id", "replacement_type_unique_id" })
            if (string.IsNullOrWhiteSpace(attributes[name]) || attributes[name].Length > 256) throw new ArgumentException("change_type identity is invalid.");
        if (!DynamicCanonical.Hash(attributes["expected_connector_signature"]) || !DynamicCanonical.Hash(attributes["expected_replacement_type_state_hash"])) throw new ArgumentException("change_type compatibility identity is invalid.");
    }

    private static double[] Vector(string value)
    {
        var values = value.Split(',');
        if (values.Length != 3 || values.Any(item => !double.TryParse(item, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) || !Finite(parsed))) throw new ArgumentException("Core-operation vector is invalid.");
        return values.Select(item => double.Parse(item, CultureInfo.InvariantCulture)).ToArray();
    }
    private static void ExactKeys(IReadOnlyDictionary<string, string> value, params string[] expected) { if (value.Count != expected.Length || value.Keys.Any(key => !expected.Contains(key, StringComparer.Ordinal))) throw new ArgumentException("Core-operation attribute set is not exact."); }
    private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
}

public sealed class DynamicCoreOperationEffectV1
{
    public string Schema { get; set; } = DynamicCoreOperationsV1.EffectSchema;
    public string NodeId { get; set; } = "";
    public string Kind { get; set; } = "";
    public long PrimaryTargetElementId { get; set; }
    public IReadOnlyList<long> AddedElementIds { get; set; } = Array.Empty<long>();
    public IReadOnlyList<long> ModifiedElementIds { get; set; } = Array.Empty<long>();
    public IReadOnlyList<long> DeletedElementIds { get; set; } = Array.Empty<long>();
    public IReadOnlyList<string> DeletedUniqueIds { get; set; } = Array.Empty<string>();
    public string EffectHash { get; set; } = "";
}

public static class DynamicCoreOperationEffectPolicyV1
{
    public static string CanonicalHash(DynamicCoreOperationEffectV1 value)
    {
        ValidateShape(value, requireHash: false);
        return DynamicWire.Sha256(DynamicCanonical.Join(value.Schema, value.NodeId, value.Kind, value.PrimaryTargetElementId.ToString(CultureInfo.InvariantCulture),
            LongSet(value.AddedElementIds), LongSet(value.ModifiedElementIds), LongSet(value.DeletedElementIds), DynamicCanonical.Set(value.DeletedUniqueIds)));
    }

    public static string EffectSetHash(IEnumerable<DynamicCoreOperationEffectV1> effects)
    {
        var values = (effects ?? throw new ArgumentNullException(nameof(effects))).ToArray();
        foreach (var value in values) ValidateShape(value, requireHash: true);
        return DynamicWire.Sha256(DynamicCanonical.Join(DynamicCoreOperationsV1.EffectSchema, DynamicCanonical.Set(values.Select(value => value.EffectHash))));
    }

    public static void ValidateAgainstGraph(IEnumerable<DynamicCoreOperationEffectV1> effects, DynamicOperationGraphV1 graph, DynamicEffectBudgetV1 budget)
    {
        var values = (effects ?? throw new ArgumentNullException(nameof(effects))).ToArray(); budget.Validate();
        if (graph == null || values.Length != graph.Nodes.Count || values.Select(value => value.NodeId).Distinct(StringComparer.Ordinal).Count() != values.Length) throw new ArgumentException("Core-operation effects do not cover the graph exactly.");
        foreach (var node in graph.Nodes)
        {
            var effect = values.SingleOrDefault(value => value.NodeId == node.NodeId) ?? throw new ArgumentException("Core-operation effect is missing.");
            ValidateShape(effect, requireHash: true);
            if (effect.Kind != node.Kind || effect.AddedElementIds.Count != 0) throw new ArgumentException("Core-operation effect kind or create set is invalid.");
            if (node.Kind == "delete_element")
            {
                if (!effect.DeletedElementIds.Contains(effect.PrimaryTargetElementId) || effect.DeletedElementIds.Count != effect.DeletedUniqueIds.Count) throw new ArgumentException("Delete preview must report the exact cascade identity set.");
            }
            else if (effect.DeletedElementIds.Count != 0 || !effect.ModifiedElementIds.Contains(effect.PrimaryTargetElementId)) throw new ArgumentException("Modifying core-operation effect is invalid.");
        }
        var affected = values.SelectMany(value => value.AddedElementIds.Concat(value.ModifiedElementIds).Concat(value.DeletedElementIds)).Distinct().Count();
        if (affected > budget.MaximumAffectedElements)
            throw new ArgumentException("Observed core-operation blast radius exceeds its exact effect budget.");
    }

    private static void ValidateShape(DynamicCoreOperationEffectV1 value, bool requireHash)
    {
        if (value == null || value.Schema != DynamicCoreOperationsV1.EffectSchema || !DynamicCanonical.Hash(value.NodeId) || DynamicCoreOperationManifestV1.Find(value.Kind) == null || value.PrimaryTargetElementId < 0 ||
            value.AddedElementIds == null || value.ModifiedElementIds == null || value.DeletedElementIds == null || value.DeletedUniqueIds == null ||
            new[] { value.AddedElementIds, value.ModifiedElementIds, value.DeletedElementIds }.Any(items => items.Count > 50000 || items.Any(id => id < 0) || items.Distinct().Count() != items.Count) ||
            value.DeletedUniqueIds.Count > 50000 || value.DeletedUniqueIds.Any(id => string.IsNullOrWhiteSpace(id) || id.Length > 256) || value.DeletedUniqueIds.Distinct(StringComparer.Ordinal).Count() != value.DeletedUniqueIds.Count ||
            requireHash && value.EffectHash != CanonicalHash(value)) throw new ArgumentException("Core-operation effect shape or hash is invalid.");
    }
    private static string LongSet(IEnumerable<long> values) => DynamicCanonical.Set(values.OrderBy(value => value).Select(value => value.ToString(CultureInfo.InvariantCulture)));
}

public static class DynamicCoreOperationStateV1
{
    public static string ParameterStateHash(DynamicParameterValueV1 value)
    {
        if (value == null || string.IsNullOrWhiteSpace(value.Identity) || value.Identity.Length > 256 ||
            !new[] { "string", "integer", "double", "element_id" }.Contains(value.StorageKind, StringComparer.Ordinal) ||
            value.Scope != "instance" && value.Scope != "type")
            throw new ArgumentException("Typed parameter state is invalid.");
        var raw = value.StorageKind == "string" ? value.RawString ?? "" : value.StorageKind == "integer" ? Nullable(value.RawInteger) :
            value.StorageKind == "double" ? NullableDouble(value.RawDouble) : Nullable(value.RawElementId);
        return DynamicWire.Sha256(DynamicCanonical.Join("dynamic-revit-parameter-state/v1", value.Identity, value.Name ?? "", value.StorageKind,
            value.HasValue ? "1" : "0", raw, value.FormattedValue ?? "", value.SpecTypeId ?? "", value.UnitTypeId ?? "",
            value.Scope, value.Writable ? "1" : "0"));
    }

    private static string Nullable(long? value) => value.HasValue ? value.Value.ToString(CultureInfo.InvariantCulture) : "null";
    private static string NullableDouble(double? value)
    {
        if (!value.HasValue) return "null";
        if (double.IsNaN(value.Value) || double.IsInfinity(value.Value)) throw new ArgumentException("Typed parameter state contains a non-finite double.");
        return value.Value.ToString("R", CultureInfo.InvariantCulture);
    }
}

public sealed class DynamicCoreOperationApplyAuthorizationV1
{
    public string Schema { get; set; } = DynamicCoreOperationsV1.ApplyAuthorizationSchema;
    public string AuthorizationId { get; set; } = "";
    public string BindingHash { get; set; } = "";
    public string CoreManifestHash { get; set; } = "";
    public string PrimitiveManifestHash { get; set; } = "";
    public string GraphHash { get; set; } = "";
    public string EffectSetHash { get; set; } = "";
    public string DocumentFingerprint { get; set; } = "";
    public long DocumentRevision { get; set; }
    public long ExpiresUnixSeconds { get; set; }
    public string Signature { get; set; } = "";
}

public static class DynamicCoreOperationApplyAuthorizationPolicyV1
{
    public static DynamicCoreOperationApplyAuthorizationV1 Issue(DynamicOperationGraphV1 graph, DynamicCoreOperationManifestBindingV1 binding,
        string effectSetHash, long expiresUnixSeconds, byte[] trustedKey, string authorizationId)
    {
        if (graph == null || binding == null || graph.Nodes.Any(node => !(DynamicCoreOperationManifestV1.Find(node.Kind)?.ApplySupported ?? false)))
            throw new InvalidOperationException("Dry-run-only core operations cannot receive apply authorization.");
        if (!DynamicCanonical.Hash(effectSetHash) || string.IsNullOrWhiteSpace(authorizationId) || authorizationId.Length > 160) throw new ArgumentException("Core-operation apply authorization identity is invalid.");
        var value = new DynamicCoreOperationApplyAuthorizationV1
        {
            AuthorizationId = authorizationId, BindingHash = DynamicCoreOperationManifestBindingPolicyV1.BindingHash(binding),
            CoreManifestHash = DynamicCoreOperationManifestV1.ManifestHash, PrimitiveManifestHash = DynamicPrimitiveManifestV1.ManifestHash,
            GraphHash = graph.GraphHash, EffectSetHash = effectSetHash, DocumentFingerprint = graph.DocumentFingerprint,
            DocumentRevision = graph.DocumentRevision, ExpiresUnixSeconds = expiresUnixSeconds
        };
        value.Signature = Sign(value, trustedKey); return value;
    }

    public static void Validate(DynamicCoreOperationApplyAuthorizationV1 value, DynamicOperationGraphV1 graph,
        DynamicCoreOperationManifestBindingV1 binding, string expectedEffectSetHash, byte[] trustedKey, long nowUnixSeconds)
    {
        if (value == null || graph == null || binding == null || value.Schema != DynamicCoreOperationsV1.ApplyAuthorizationSchema ||
            string.IsNullOrWhiteSpace(value.AuthorizationId) || value.ExpiresUnixSeconds <= nowUnixSeconds || value.ExpiresUnixSeconds > nowUnixSeconds + 300 ||
            value.BindingHash != DynamicCoreOperationManifestBindingPolicyV1.BindingHash(binding) || value.CoreManifestHash != DynamicCoreOperationManifestV1.ManifestHash ||
            value.PrimitiveManifestHash != DynamicPrimitiveManifestV1.ManifestHash || value.GraphHash != graph.GraphHash || value.EffectSetHash != expectedEffectSetHash ||
            value.DocumentFingerprint != graph.DocumentFingerprint || value.DocumentRevision != graph.DocumentRevision ||
            graph.Nodes.Any(node => !(DynamicCoreOperationManifestV1.Find(node.Kind)?.ApplySupported ?? false)) || value.Signature != Sign(value, trustedKey))
            throw new InvalidOperationException("Core-operation apply authorization is invalid, stale, substituted, or includes dry-run-only work.");
    }

    public static string Sign(DynamicCoreOperationApplyAuthorizationV1 value, byte[] trustedKey)
    {
        if (trustedKey == null || trustedKey.Length < 32) throw new ArgumentException("Core-operation signing key must be at least 256 bits.");
        using var hmac = new HMACSHA256(trustedKey);
        return "hmac-sha256:" + BitConverter.ToString(hmac.ComputeHash(Encoding.UTF8.GetBytes(Canonical(value)))).Replace("-", "").ToLowerInvariant();
    }
    private static string Canonical(DynamicCoreOperationApplyAuthorizationV1 value) => DynamicCanonical.Join(value.Schema, value.AuthorizationId,
        value.BindingHash, value.CoreManifestHash, value.PrimitiveManifestHash, value.GraphHash, value.EffectSetHash, value.DocumentFingerprint,
        value.DocumentRevision.ToString(CultureInfo.InvariantCulture), value.ExpiresUnixSeconds.ToString(CultureInfo.InvariantCulture));
}

public sealed class DynamicCoreOperationReadbackV1
{
    public string NodeId { get; set; } = "";
    public string Kind { get; set; } = "";
    public string TargetUniqueId { get; set; } = "";
    public string BeforeStateHash { get; set; } = "";
    public string AfterStateHash { get; set; } = "";
    public IReadOnlyDictionary<string, string> Values { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
}

public sealed class DynamicCoreOperationPreviewV1
{
    public string Schema { get; set; } = DynamicCoreOperationsV1.PreviewSchema;
    public string CoreManifestHash { get; set; } = DynamicCoreOperationManifestV1.ManifestHash;
    public string GraphHash { get; set; } = "";
    public IReadOnlyList<DynamicCoreOperationEffectV1> Effects { get; set; } = Array.Empty<DynamicCoreOperationEffectV1>();
    public string EffectSetHash { get; set; } = "";
    public IReadOnlyList<DynamicCoreOperationReadbackV1> Readbacks { get; set; } = Array.Empty<DynamicCoreOperationReadbackV1>();
    public bool RollbackTruth { get; set; }
    public string PreviewHash { get; set; } = "";
}

public sealed class DynamicCoreOperationApplyReceiptV1
{
    public string Schema { get; set; } = DynamicCoreOperationsV1.ApplyReceiptSchema;
    public string Outcome { get; set; } = "";
    public string GraphHash { get; set; } = "";
    public string EffectSetHash { get; set; } = "";
    public IReadOnlyList<DynamicCoreOperationReadbackV1> Readbacks { get; set; } = Array.Empty<DynamicCoreOperationReadbackV1>();
    public string ReceiptHash { get; set; } = "";
}

public static class DynamicCoreOperationReceiptPolicyV1
{
    public static string PreviewHash(DynamicCoreOperationPreviewV1 value)
    {
        if (value == null || value.Schema != DynamicCoreOperationsV1.PreviewSchema || value.CoreManifestHash != DynamicCoreOperationManifestV1.ManifestHash || !DynamicCanonical.Hash(value.GraphHash) ||
            value.Effects == null || value.Readbacks == null || value.EffectSetHash != DynamicCoreOperationEffectPolicyV1.EffectSetHash(value.Effects) ||
            value.Readbacks.Count != value.Effects.Count || value.Effects.Any(effect => !value.Readbacks.Any(readback => readback.NodeId == effect.NodeId && readback.Kind == effect.Kind)))
            throw new ArgumentException("Core-operation preview shape is invalid.");
        return DynamicWire.Sha256(DynamicCanonical.Join(value.Schema, value.CoreManifestHash, value.GraphHash, value.EffectSetHash,
            ReadbackSetHash(value.Readbacks), value.RollbackTruth ? "1" : "0"));
    }

    public static void ValidateRollback(DynamicCoreOperationPreviewV1 value)
    {
        if (!value.RollbackTruth || value.PreviewHash != PreviewHash(value)) throw new InvalidOperationException("Core-operation preview is not exact rollback-verified evidence.");
    }

    public static string ReceiptHash(DynamicCoreOperationApplyReceiptV1 value)
    {
        if (value == null || value.Schema != DynamicCoreOperationsV1.ApplyReceiptSchema || value.Outcome != "committed_verified" || !DynamicCanonical.Hash(value.GraphHash) || !DynamicCanonical.Hash(value.EffectSetHash) || value.Readbacks == null)
            throw new ArgumentException("Core-operation apply receipt is invalid.");
        return DynamicWire.Sha256(DynamicCanonical.Join(value.Schema, value.Outcome, value.GraphHash, value.EffectSetHash, ReadbackSetHash(value.Readbacks)));
    }

    public static string ReadbackSetHash(IEnumerable<DynamicCoreOperationReadbackV1> readbacks)
    {
        var values = (readbacks ?? throw new ArgumentNullException(nameof(readbacks))).ToArray();
        if (values.Length > DynamicCoreOperationsV1.MaximumOperations || values.Select(value => value.NodeId).Distinct(StringComparer.Ordinal).Count() != values.Length)
            throw new ArgumentException("Core-operation readbacks are unbounded or duplicated.");
        return DynamicWire.Sha256(DynamicCanonical.Join("dynamic-revit-core-operation-readback-set/v1", DynamicCanonical.Set(values.Select(ReadbackHash))));
    }

    public static string ReadbackHash(DynamicCoreOperationReadbackV1 value)
    {
        if (value == null || !DynamicCanonical.Hash(value.NodeId) || DynamicCoreOperationManifestV1.Find(value.Kind) == null || string.IsNullOrWhiteSpace(value.TargetUniqueId) || value.TargetUniqueId.Length > 256 ||
            !DynamicCanonical.Hash(value.BeforeStateHash) || !DynamicCanonical.Hash(value.AfterStateHash) || value.Values == null || value.Values.Count > 32 || value.Values.Any(pair => string.IsNullOrWhiteSpace(pair.Key) || pair.Key.Length > 128 || pair.Value == null || pair.Value.Length > 4096))
            throw new ArgumentException("Core-operation readback is invalid.");
        return DynamicWire.Sha256(DynamicCanonical.Join(value.NodeId, value.Kind, value.TargetUniqueId, value.BeforeStateHash, value.AfterStateHash, DynamicCanonical.Map(value.Values)));
    }
}
