using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace RevitOperator.DynamicRevitSdk;

public static class DynamicMepMutationContractV1
{
    public const string ManifestSchema = "dynamic-revit-mep-mutation-manifest/v1";
    public const string PreviewSchema = "dynamic-revit-mep-mutation-preview/v1";
    public const string ApplyAuthorizationSchema = "dynamic-revit-mep-mutation-apply-authorization/v1";
    public const string ApplyReceiptSchema = "dynamic-revit-mep-mutation-apply-receipt/v1";
    public const string SemanticEffectSchema = "dynamic-revit-mep-semantic-effect/v1";
    public const string ObservedEffectSchema = "dynamic-revit-mep-observed-effect/v1";
    public const string SemanticOutputSchema = "dynamic-revit-mep-semantic-output/v1";
    public const string ReadbackSchema = "dynamic-result-reference-mutation-readback/v1";
    public const string CanonicalVersion = "dynamic-revit-mep-mutation-canonical/v1";
    public const bool ProductionExposed = false;
    public const int MaximumOperations = 64;
    public const int MaximumEffects = 64;
    public const int MaximumOutputs = 64;
}

public sealed class DynamicMepMutationDescriptorV1
{
    internal DynamicMepMutationDescriptorV1(string kind, string version, string effectClass, int externalMinimum, int externalMaximum,
        int resultMinimum, int resultMaximum, int outputCount, params string[] attributes)
    {
        Kind = kind; PrimitiveVersion = version; EffectClass = effectClass; ExternalTargetMinimum = externalMinimum;
        ExternalTargetMaximum = externalMaximum; ResultReferenceMinimum = resultMinimum; ResultReferenceMaximum = resultMaximum;
        OutputCount = outputCount; RequiredAttributes = Array.AsReadOnly(attributes.OrderBy(value => value, StringComparer.Ordinal).ToArray());
    }
    public string Kind { get; }
    public string PrimitiveVersion { get; }
    public string EffectClass { get; }
    public int ExternalTargetMinimum { get; }
    public int ExternalTargetMaximum { get; }
    public int ResultReferenceMinimum { get; }
    public int ResultReferenceMaximum { get; }
    public int OutputCount { get; }
    public IReadOnlyList<string> RequiredAttributes { get; }
}

public static class DynamicMepMutationManifestV1
{
    private static readonly Type[] ContractTypes =
    {
        typeof(DynamicMepMutationDescriptorV1), typeof(DynamicMepCurveSpecV1), typeof(DynamicMepCurveSizeV1), typeof(DynamicMepConnectorSelectorV1),
        typeof(DynamicMepSemanticEffectV1), typeof(DynamicMepObservedEffectV1), typeof(DynamicMepSemanticOutputV1),
        typeof(DynamicResultReferenceMutationReadbackV1),
        typeof(DynamicMepMutationPreviewV1), typeof(DynamicMepMutationApplyAuthorizationV1), typeof(DynamicMepMutationApplyReceiptV1),
        typeof(DynamicMepResultReferenceBuilderV1), typeof(DynamicMepMutationPolicyV1)
    };
    private static readonly DynamicMepMutationDescriptorV1[] Descriptors =
    {
        new("create_mep_curve", "create_mep_curve/v2", "create", 0, 0, 0, 0, 1, "curve", "size", "system_type", "type_identity"),
        new("set_mep_curve_size", "set_mep_curve_size/v1", "modify", 0, 1, 0, 1, 0, "size"),
        new("connect_mep", "connect_mep/v1", "modify", 0, 2, 0, 2, 0, "connector_a", "connector_b"),
        new("create_elbow_fitting", "create_elbow_fitting/v1", "create", 0, 2, 0, 2, 1, "connector_a", "connector_b", "expected_fitting_type"),
        new("create_transition_fitting", "create_transition_fitting/v1", "create", 0, 2, 0, 2, 1, "connector_a", "connector_b", "expected_fitting_type")
    };
    private static readonly IReadOnlyList<DynamicMepMutationDescriptorV1> ReadOnlyDescriptors = Array.AsReadOnly(Descriptors);
    private static readonly string SurfaceHashValue = DynamicWire.Sha256(string.Join("\n", ContractTypes.OrderBy(type => type.FullName, StringComparer.Ordinal).Select(Surface)));
    private static readonly string ManifestHashValue = DynamicWire.Sha256(DynamicCanonical.Join(DynamicMepMutationContractV1.ManifestSchema,
        DynamicMepMutationContractV1.CanonicalVersion, DynamicResultReferenceManifestV1.ManifestHash, DynamicPrimitiveManifestV1.ManifestHash,
        SurfaceHashValue, string.Join("\n", Descriptors.OrderBy(value => value.Kind, StringComparer.Ordinal).Select(Canonical))));

    public static IReadOnlyList<DynamicMepMutationDescriptorV1> All => ReadOnlyDescriptors;
    public static string ContractSurfaceHash => SurfaceHashValue;
    public static string ManifestHash => ManifestHashValue;
    public static DynamicMepMutationDescriptorV1? Find(string kind) => Descriptors.FirstOrDefault(value => value.Kind == kind);

    private static string Canonical(DynamicMepMutationDescriptorV1 value) => DynamicCanonical.Join(value.Kind, value.PrimitiveVersion,
        value.EffectClass, value.ExternalTargetMinimum.ToString(CultureInfo.InvariantCulture), value.ExternalTargetMaximum.ToString(CultureInfo.InvariantCulture),
        value.ResultReferenceMinimum.ToString(CultureInfo.InvariantCulture), value.ResultReferenceMaximum.ToString(CultureInfo.InvariantCulture),
        value.OutputCount.ToString(CultureInfo.InvariantCulture), DynamicCanonical.Set(value.RequiredAttributes));
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
        if (!type.IsGenericType) return type.FullName ?? type.Name;
        var name = type.GetGenericTypeDefinition().FullName ?? type.Name; var tick = name.IndexOf('`'); if (tick >= 0) name = name.Substring(0, tick);
        return name + "<" + string.Join(",", type.GetGenericArguments().Select(TypeName)) + ">";
    }
}

/// <summary>Exact internal-unit size for a newly created pipe or duct curve.</summary>
public sealed class DynamicMepCurveSizeV1
{
    public string Shape { get; set; } = "";
    public double? DiameterFeet { get; set; }
    public double? HeightFeet { get; set; }
    public double? WidthFeet { get; set; }

    public string Canonical()
    {
        Validate();
        return DynamicCanonical.Join("mep-curve-size/v1", Shape, Number(DiameterFeet), Number(HeightFeet), Number(WidthFeet));
    }

    public void Validate()
    {
        if (Shape == "Round")
        {
            RequireDimension(DiameterFeet, "diameter");
            if (HeightFeet != null || WidthFeet != null) throw new ArgumentException("Round MEP size may specify only diameter.");
            return;
        }
        if (Shape != "Rectangular" && Shape != "Oval") throw new ArgumentException("MEP curve size shape is invalid.");
        RequireDimension(HeightFeet, "height"); RequireDimension(WidthFeet, "width");
        if (DiameterFeet != null) throw new ArgumentException("Non-round MEP size may not specify diameter.");
    }

    public static DynamicMepCurveSizeV1 ParseCanonical(string value)
    {
        var parts = DynamicMepCurveSpecV1.Decode(value, 5, "MEP curve size");
        if (parts[0] != "mep-curve-size/v1") throw new ArgumentException("MEP curve size canonical version is invalid.");
        var result = new DynamicMepCurveSizeV1 { Shape = parts[1], DiameterFeet = Parse(parts[2]), HeightFeet = Parse(parts[3]), WidthFeet = Parse(parts[4]) };
        result.Validate();
        if (result.Canonical() != value) throw new ArgumentException("MEP curve size canonical bytes are not exact.");
        return result;
    }

    private static string Number(double? value) => value == null ? "none" : DynamicCoreOperationCanonicalNumberV1.Format(value.Value);
    private static double? Parse(string value) => value == "none" ? null : DynamicCoreOperationCanonicalNumberV1.ParseExact(value, "MEP curve size");
    private static void RequireDimension(double? value, string name)
    {
        if (value == null || double.IsNaN(value.Value) || double.IsInfinity(value.Value) || value.Value < 1d / 384d || value.Value > 1_000d)
            throw new ArgumentException("MEP curve " + name + " is outside the bounded internal-unit range.");
    }
}

public sealed class DynamicMepCurveSpecV1
{
    public string CurveKind { get; set; } = "";
    public DynamicPointV1 StartFeet { get; set; } = new();
    public DynamicPointV1 EndFeet { get; set; } = new();
    public string LevelUniqueId { get; set; } = "";
    public string Canonical()
    {
        Validate(); return DynamicCanonical.Join("mep-curve-spec/v1", CurveKind, Point(StartFeet), Point(EndFeet), LevelUniqueId);
    }
    public void Validate()
    {
        if ((CurveKind != "pipe" && CurveKind != "duct") || !DynamicCanonical.Id(LevelUniqueId, 256)) throw new ArgumentException("MEP curve kind or level is invalid.");
        ValidatePoint(StartFeet); ValidatePoint(EndFeet);
        var dx = EndFeet.X - StartFeet.X; var dy = EndFeet.Y - StartFeet.Y; var dz = EndFeet.Z - StartFeet.Z;
        var length = Math.Sqrt(dx * dx + dy * dy + dz * dz);
        if (length < 1d / 384d || length > 10_000d) throw new ArgumentException("MEP curve length is outside the bounded general-operation range.");
    }
    public static DynamicMepCurveSpecV1 ParseCanonical(string value)
    {
        var parts = Decode(value, 5, "MEP curve");
        if (parts[0] != "mep-curve-spec/v1") throw new ArgumentException("MEP curve canonical version is invalid.");
        var result = new DynamicMepCurveSpecV1 { CurveKind = parts[1], StartFeet = ParsePoint(parts[2]), EndFeet = ParsePoint(parts[3]), LevelUniqueId = parts[4] };
        result.Validate(); if (result.Canonical() != value) throw new ArgumentException("MEP curve canonical bytes are not exact."); return result;
    }
    internal static string Point(DynamicPointV1 value) => Number(value.X) + "," + Number(value.Y) + "," + Number(value.Z);
    internal static string Number(double value) => DynamicCoreOperationCanonicalNumberV1.Format(value);
    internal static DynamicPointV1 ParsePoint(string value)
    {
        var parts = value.Split(','); if (parts.Length != 3) throw new ArgumentException("MEP point is invalid.");
        return new DynamicPointV1 { X = DynamicCoreOperationCanonicalNumberV1.ParseExact(parts[0], "point"), Y = DynamicCoreOperationCanonicalNumberV1.ParseExact(parts[1], "point"), Z = DynamicCoreOperationCanonicalNumberV1.ParseExact(parts[2], "point") };
    }
    private static void ValidatePoint(DynamicPointV1 value)
    {
        if (value == null || new[] { value.X, value.Y, value.Z }.Any(component => double.IsNaN(component) || double.IsInfinity(component) || Math.Abs(component) > 1_000_000d))
            throw new ArgumentException("MEP curve point is invalid.");
    }
    internal static string[] Decode(string value, int count, string label)
    {
        if (string.IsNullOrEmpty(value)) throw new ArgumentException(label + " canonical bytes are empty.");
        var result = new List<string>(); var index = 0;
        while (index < value.Length)
        {
            var marker = value[index++]; if (marker != '+') throw new ArgumentException(label + " canonical marker is invalid.");
            var end = value.IndexOf('\n', index); if (end < 0) throw new ArgumentException(label + " canonical record is truncated.");
            try { result.Add(System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(value.Substring(index, end - index)))); }
            catch { throw new ArgumentException(label + " canonical field encoding is invalid."); }
            index = end + 1;
        }
        if (result.Count != count) throw new ArgumentException(label + " canonical field count is invalid."); return result.ToArray();
    }
}

public sealed class DynamicMepConnectorSelectorV1
{
    public string SourceIdentityHash { get; set; } = "";
    public string NativeConnectorId { get; set; } = "endpoint";
    public DynamicPointV1 ExpectedOriginFeet { get; set; } = new();
    public string ExpectedDomain { get; set; } = "";
    public string ExpectedShape { get; set; } = "";
    public string Canonical()
    {
        Validate(); return DynamicCanonical.Join("mep-connector-selector/v1", SourceIdentityHash, NativeConnectorId,
            DynamicMepCurveSpecV1.Point(ExpectedOriginFeet), ExpectedDomain, ExpectedShape);
    }
    public void Validate()
    {
        if (!DynamicCanonical.Hash(SourceIdentityHash) || !DynamicCanonical.Id(NativeConnectorId, 64) ||
            !new[] { "DomainHvac", "DomainPiping" }.Contains(ExpectedDomain, StringComparer.Ordinal) ||
            !new[] { "Round", "Rectangular", "Oval" }.Contains(ExpectedShape, StringComparer.Ordinal))
            throw new ArgumentException("MEP connector selector identity, domain, or shape is invalid.");
        DynamicMepCurveSpecV1.ParsePoint(DynamicMepCurveSpecV1.Point(ExpectedOriginFeet));
    }
    public static DynamicMepConnectorSelectorV1 ParseCanonical(string value)
    {
        var parts = DynamicMepCurveSpecV1.Decode(value, 6, "MEP connector selector");
        if (parts[0] != "mep-connector-selector/v1") throw new ArgumentException("MEP connector selector version is invalid.");
        var result = new DynamicMepConnectorSelectorV1 { SourceIdentityHash = parts[1], NativeConnectorId = parts[2], ExpectedOriginFeet = DynamicMepCurveSpecV1.ParsePoint(parts[3]), ExpectedDomain = parts[4], ExpectedShape = parts[5] };
        result.Validate(); if (result.Canonical() != value) throw new ArgumentException("MEP connector selector canonical bytes are not exact."); return result;
    }
}

public static class DynamicMepResultReferenceBuilderV1
{
    public static DynamicResultOperationHandleV1 CreateMepCurve(DynamicResultReferenceGraphBuilderV1 builder, DynamicMepCurveSpecV1 curve,
        DynamicMepCurveSizeV1 size, string systemTypeUniqueId, string curveTypeUniqueId, string expectedCategoryStableId)
    {
        if (builder == null) throw new ArgumentNullException(nameof(builder)); curve.Validate(); size.Validate(); RequireId(systemTypeUniqueId); RequireId(curveTypeUniqueId); RequireId(expectedCategoryStableId);
        if (curve.CurveKind == "pipe" && size.Shape != "Round") throw new ArgumentException("Pipe curves require an exact round size.");
        var expected = curve.CurveKind == "pipe" ? "category:builtin:OST_PipeCurves" : "category:builtin:OST_DuctCurves";
        if (expectedCategoryStableId != expected) throw new ArgumentException("MEP curve output category does not match its declared curve kind.");
        return builder.AddOperation("create_mep_curve", null, null,
            new[] { new DynamicResultOutputSpecV1 { OutputSlot = "curve", ExpectedCategoryStableId = expectedCategoryStableId, ExpectedTypeUniqueId = curveTypeUniqueId } },
            new Dictionary<string, string>(StringComparer.Ordinal) { ["curve"] = curve.Canonical(), ["size"] = size.Canonical(), ["system_type"] = systemTypeUniqueId, ["type_identity"] = curveTypeUniqueId });
    }

    public static DynamicResultOperationHandleV1 ConnectMep(DynamicResultReferenceGraphBuilderV1 builder,
        IEnumerable<DynamicExternalTargetReferenceV1>? externalTargets, IEnumerable<DynamicSymbolicResultReferenceV1>? resultReferences,
        DynamicMepConnectorSelectorV1 connectorA, DynamicMepConnectorSelectorV1 connectorB)
        => AddConnectorOperation(builder, "connect_mep", externalTargets, resultReferences, connectorA, connectorB, null, null, null);

    /// <summary>Set the exact connector dimensions of one existing or previously-created MEP curve.</summary>
    public static DynamicResultOperationHandleV1 SetMepCurveSize(DynamicResultReferenceGraphBuilderV1 builder,
        IEnumerable<DynamicExternalTargetReferenceV1>? externalTargets, IEnumerable<DynamicSymbolicResultReferenceV1>? resultReferences,
        DynamicMepCurveSizeV1 size)
    {
        if (builder == null) throw new ArgumentNullException(nameof(builder)); size.Validate();
        var external = (externalTargets ?? Array.Empty<DynamicExternalTargetReferenceV1>()).ToArray();
        var results = (resultReferences ?? Array.Empty<DynamicSymbolicResultReferenceV1>()).ToArray();
        if (external.Length + results.Length != 1) throw new ArgumentException("A general MEP size operation requires exactly one element target.");
        var categories = external.Select(value => value.ExpectedCategoryStableId).Concat(results.Select(value => value.ExpectedCategoryStableId)).ToArray();
        if (categories.Any(value => value != "category:builtin:OST_PipeCurves" && value != "category:builtin:OST_DuctCurves"))
            throw new ArgumentException("A general MEP size operation requires an exact pipe-curve or duct-curve target.");
        if (categories[0] == "category:builtin:OST_PipeCurves" && size.Shape != "Round")
            throw new ArgumentException("Pipe curves require an exact round size.");
        return builder.AddOperation("set_mep_curve_size", external, results, null,
            new Dictionary<string, string>(StringComparer.Ordinal) { ["size"] = size.Canonical() });
    }

    public static DynamicResultOperationHandleV1 CreateTransitionFitting(DynamicResultReferenceGraphBuilderV1 builder,
        IEnumerable<DynamicExternalTargetReferenceV1>? externalTargets, IEnumerable<DynamicSymbolicResultReferenceV1>? resultReferences,
        DynamicMepConnectorSelectorV1 connectorA, DynamicMepConnectorSelectorV1 connectorB, string expectedFittingTypeUniqueId,
        string expectedFittingCategoryStableId)
        => AddConnectorOperation(builder, "create_transition_fitting", externalTargets, resultReferences, connectorA, connectorB,
            Require(expectedFittingTypeUniqueId), Require(expectedFittingCategoryStableId),
            new[] { new DynamicResultOutputSpecV1 { OutputSlot = "fitting", ExpectedCategoryStableId = expectedFittingCategoryStableId, ExpectedTypeUniqueId = expectedFittingTypeUniqueId } });

    public static DynamicResultOperationHandleV1 CreateElbowFitting(DynamicResultReferenceGraphBuilderV1 builder,
        IEnumerable<DynamicExternalTargetReferenceV1>? externalTargets, IEnumerable<DynamicSymbolicResultReferenceV1>? resultReferences,
        DynamicMepConnectorSelectorV1 connectorA, DynamicMepConnectorSelectorV1 connectorB, string expectedFittingTypeUniqueId,
        string expectedFittingCategoryStableId)
        => AddConnectorOperation(builder, "create_elbow_fitting", externalTargets, resultReferences, connectorA, connectorB,
            Require(expectedFittingTypeUniqueId), Require(expectedFittingCategoryStableId),
            new[] { new DynamicResultOutputSpecV1 { OutputSlot = "fitting", ExpectedCategoryStableId = expectedFittingCategoryStableId, ExpectedTypeUniqueId = expectedFittingTypeUniqueId } });

    private static DynamicResultOperationHandleV1 AddConnectorOperation(DynamicResultReferenceGraphBuilderV1 builder, string kind,
        IEnumerable<DynamicExternalTargetReferenceV1>? externalTargets, IEnumerable<DynamicSymbolicResultReferenceV1>? resultReferences,
        DynamicMepConnectorSelectorV1 a, DynamicMepConnectorSelectorV1 b, string? fittingType, string? fittingCategory,
        IEnumerable<DynamicResultOutputSpecV1>? outputs)
    {
        if (builder == null) throw new ArgumentNullException(nameof(builder)); a.Validate(); b.Validate();
        var external = (externalTargets ?? Array.Empty<DynamicExternalTargetReferenceV1>()).ToArray();
        var results = (resultReferences ?? Array.Empty<DynamicSymbolicResultReferenceV1>()).ToArray();
        if (external.Length + results.Length != 2) throw new ArgumentException("A general MEP connector operation requires exactly two element targets.");
        var attributes = new Dictionary<string, string>(StringComparer.Ordinal) { ["connector_a"] = a.Canonical(), ["connector_b"] = b.Canonical() };
        if (fittingType != null) attributes["expected_fitting_type"] = fittingType;
        return builder.AddOperation(kind, external, results, outputs, attributes);
    }
    private static void RequireId(string value) { if (!DynamicCanonical.Id(value, 256)) throw new ArgumentException("A bounded MEP identity is required."); }
    private static string Require(string value) { RequireId(value); return value; }
}

public sealed class DynamicMepSemanticEffectV1
{
    public string Schema { get; set; } = DynamicMepMutationContractV1.SemanticEffectSchema;
    public string NodeId { get; set; } = "";
    public string Kind { get; set; } = "";
    public int AddedCount { get; set; }
    public int ModifiedCount { get; set; }
    public int DeletedCount { get; set; }
    public string AddedCategoryTypeSetHash { get; set; } = "";
    public string ModifiedSourceSetHash { get; set; } = "";
    public string TopologyHash { get; set; } = "";
    public string EffectHash { get; set; } = "";
}

public sealed class DynamicMepObservedEffectV1
{
    public string Schema { get; set; } = DynamicMepMutationContractV1.ObservedEffectSchema;
    public string NodeId { get; set; } = "";
    public string Kind { get; set; } = "";
    public IReadOnlyList<long> AddedElementIds { get; set; } = Array.Empty<long>();
    public IReadOnlyList<long> ModifiedElementIds { get; set; } = Array.Empty<long>();
    public IReadOnlyList<long> DeletedElementIds { get; set; } = Array.Empty<long>();
    public string SemanticEffectHash { get; set; } = "";
    public string EffectHash { get; set; } = "";
}

public sealed class DynamicMepSemanticOutputV1
{
    public string Schema { get; set; } = DynamicMepMutationContractV1.SemanticOutputSchema;
    public string ProducerNodeId { get; set; } = "";
    public string ResultId { get; set; } = "";
    public string OutputSlot { get; set; } = "";
    public string CategoryStableId { get; set; } = "";
    public string TypeUniqueId { get; set; } = "";
    public string MepStateHash { get; set; } = "";
    public string OutputHash { get; set; } = "";
}

/// <summary>Exact, ID-independent host readback for both zero-output edits and creations.</summary>
public sealed class DynamicResultReferenceMutationReadbackV1
{
    public string Schema { get; set; } = DynamicMepMutationContractV1.ReadbackSchema;
    public string NodeId { get; set; } = "";
    public string Kind { get; set; } = "";
    public string SubjectIdentity { get; set; } = "";
    public string BeforeStateHash { get; set; } = "";
    public string AfterStateHash { get; set; } = "";
    public IReadOnlyDictionary<string, string> ExactValues { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
    public string ReadbackHash { get; set; } = "";
}

public sealed class DynamicMepMutationPreviewV1
{
    public string Schema { get; set; } = DynamicMepMutationContractV1.PreviewSchema;
    public string ContractManifestHash { get; set; } = DynamicMepMutationManifestV1.ManifestHash;
    public string GraphHash { get; set; } = "";
    public string EffectBudgetHash { get; set; } = "";
    public string DocumentFingerprint { get; set; } = "";
    public string DocumentSessionId { get; set; } = "";
    public long DocumentRevision { get; set; }
    public IReadOnlyList<DynamicMepSemanticEffectV1> Effects { get; set; } = Array.Empty<DynamicMepSemanticEffectV1>();
    public IReadOnlyList<DynamicMepSemanticOutputV1> Outputs { get; set; } = Array.Empty<DynamicMepSemanticOutputV1>();
    public IReadOnlyList<DynamicResultReferenceMutationReadbackV1> Readbacks { get; set; } = Array.Empty<DynamicResultReferenceMutationReadbackV1>();
    public string SemanticEffectSetHash { get; set; } = "";
    public string SemanticOutputSetHash { get; set; } = "";
    public string ReadbackSetHash { get; set; } = "";
    public string TopologyHash { get; set; } = "";
    public bool RollbackVerified { get; set; }
    public string PreviewHash { get; set; } = "";
}

public sealed class DynamicMepMutationApplyAuthorizationV1
{
    public string Schema { get; set; } = DynamicMepMutationContractV1.ApplyAuthorizationSchema;
    public string AuthorizationId { get; set; } = "";
    public string ContractManifestHash { get; set; } = "";
    public string GraphHash { get; set; } = "";
    public string PreviewHash { get; set; } = "";
    public string EffectBudgetHash { get; set; } = "";
    public string SemanticEffectSetHash { get; set; } = "";
    public string SemanticOutputSetHash { get; set; } = "";
    public string ReadbackSetHash { get; set; } = "";
    public string TopologyHash { get; set; } = "";
    public string DocumentFingerprint { get; set; } = "";
    public string DocumentSessionId { get; set; } = "";
    public long DocumentRevision { get; set; }
    public long IssuedUnixSeconds { get; set; }
    public long ExpiresUnixSeconds { get; set; }
    public string Signature { get; set; } = "";
}

public sealed class DynamicMepMutationApplyReceiptV1
{
    public string Schema { get; set; } = DynamicMepMutationContractV1.ApplyReceiptSchema;
    public string ContractManifestHash { get; set; } = DynamicMepMutationManifestV1.ManifestHash;
    public string GraphHash { get; set; } = "";
    public string PreviewHash { get; set; } = "";
    public string AuthorizationHash { get; set; } = "";
    public string EffectBudgetHash { get; set; } = "";
    public string DocumentFingerprint { get; set; } = "";
    public string DocumentSessionId { get; set; } = "";
    public long DocumentRevisionBefore { get; set; }
    public long DocumentRevisionAfter { get; set; }
    public IReadOnlyList<DynamicMepObservedEffectV1> Effects { get; set; } = Array.Empty<DynamicMepObservedEffectV1>();
    public IReadOnlyList<DynamicCreatedResultFactV1> Outputs { get; set; } = Array.Empty<DynamicCreatedResultFactV1>();
    public string SemanticEffectSetHash { get; set; } = "";
    public string SemanticOutputSetHash { get; set; } = "";
    public string ReadbackSetHash { get; set; } = "";
    public IReadOnlyList<DynamicResultReferenceMutationReadbackV1> Readbacks { get; set; } = Array.Empty<DynamicResultReferenceMutationReadbackV1>();
    public string TopologyHash { get; set; } = "";
    public string Outcome { get; set; } = "committed_verified";
    public string ReceiptHash { get; set; } = "";
}

public static class DynamicMepMutationPolicyV1
{
    public static void ValidateGraphShape(DynamicResultReferenceGraphV1 graph)
    {
        if (graph == null || graph.Nodes == null || graph.Nodes.Count < 1 || graph.Nodes.Count > DynamicMepMutationContractV1.MaximumOperations)
            throw new ArgumentException("MEP result-reference graph is empty or unbounded.");
        foreach (var node in graph.Nodes)
        {
            var descriptor = DynamicMepMutationManifestV1.Find(node.Kind) ?? throw new ArgumentException("MEP result-reference primitive is not admitted.");
            DynamicResultReferencePolicyV1.ValidateNodeShape(node);
            if (node.ExternalTargets.Count < descriptor.ExternalTargetMinimum || node.ExternalTargets.Count > descriptor.ExternalTargetMaximum ||
                node.ResultReferences.Count < descriptor.ResultReferenceMinimum || node.ResultReferences.Count > descriptor.ResultReferenceMaximum ||
                node.ExternalTargets.Count + node.ResultReferences.Count != TargetCount(node.Kind) || node.Outputs.Count != descriptor.OutputCount ||
                !node.Attributes.Keys.OrderBy(value => value, StringComparer.Ordinal).SequenceEqual(descriptor.RequiredAttributes, StringComparer.Ordinal))
                throw new ArgumentException("MEP primitive target, output, or exact attribute shape is invalid.");
            if (node.Kind == "create_mep_curve")
            {
                var curve = DynamicMepCurveSpecV1.ParseCanonical(node.Attributes["curve"]);
                var size = DynamicMepCurveSizeV1.ParseCanonical(node.Attributes["size"]);
                if (!DynamicCanonical.Id(node.Attributes["system_type"], 256) || !DynamicCanonical.Id(node.Attributes["type_identity"], 256) ||
                    curve.CurveKind == "pipe" && size.Shape != "Round" ||
                    node.Outputs[0].ExpectedCategoryStableId != (curve.CurveKind == "pipe" ? "category:builtin:OST_PipeCurves" : "category:builtin:OST_DuctCurves") ||
                    node.Outputs[0].ExpectedTypeUniqueId != node.Attributes["type_identity"])
                    throw new ArgumentException("MEP curve semantic declaration is invalid.");
            }
            else if (node.Kind == "set_mep_curve_size")
            {
                var size = DynamicMepCurveSizeV1.ParseCanonical(node.Attributes["size"]);
                var categories = node.ExternalTargets.Select(value => value.ExpectedCategoryStableId)
                    .Concat(node.ResultReferences.Select(value => value.ExpectedCategoryStableId)).ToArray();
                if (categories.Length != 1 || categories[0] != "category:builtin:OST_PipeCurves" && categories[0] != "category:builtin:OST_DuctCurves" ||
                    categories[0] == "category:builtin:OST_PipeCurves" && size.Shape != "Round")
                    throw new ArgumentException("MEP curve size target category or shape is invalid.");
            }
            else
            {
                DynamicMepConnectorSelectorV1.ParseCanonical(node.Attributes["connector_a"]);
                DynamicMepConnectorSelectorV1.ParseCanonical(node.Attributes["connector_b"]);
                if ((node.Kind == "create_transition_fitting" || node.Kind == "create_elbow_fitting") &&
                    (!DynamicCanonical.Id(node.Attributes["expected_fitting_type"], 256) || node.Outputs[0].ExpectedTypeUniqueId != node.Attributes["expected_fitting_type"] ||
                     (node.Outputs[0].ExpectedCategoryStableId != "category:builtin:OST_DuctFitting" && node.Outputs[0].ExpectedCategoryStableId != "category:builtin:OST_PipeFitting")))
                    throw new ArgumentException("MEP fitting type or category declaration is invalid.");
            }
        }
    }
    private static int TargetCount(string kind) => kind == "create_mep_curve" ? 0 : kind == "set_mep_curve_size" ? 1 : 2;
    public static string SemanticEffectHash(DynamicMepSemanticEffectV1 value)
    {
        ValidateSemanticEffect(value, false);
        return DynamicWire.Sha256(DynamicCanonical.Join(value.Schema, value.NodeId, value.Kind,
            value.AddedCount.ToString(CultureInfo.InvariantCulture), value.ModifiedCount.ToString(CultureInfo.InvariantCulture),
            value.DeletedCount.ToString(CultureInfo.InvariantCulture), value.AddedCategoryTypeSetHash, value.ModifiedSourceSetHash, value.TopologyHash));
    }
    public static string ObservedEffectHash(DynamicMepObservedEffectV1 value)
    {
        ValidateObservedEffect(value, false);
        return DynamicWire.Sha256(DynamicCanonical.Join(value.Schema, value.NodeId, value.Kind,
            DynamicCanonical.Set(value.AddedElementIds.Select(Number)), DynamicCanonical.Set(value.ModifiedElementIds.Select(Number)),
            DynamicCanonical.Set(value.DeletedElementIds.Select(Number)), value.SemanticEffectHash));
    }
    public static string SemanticOutputHash(DynamicMepSemanticOutputV1 value)
    {
        ValidateSemanticOutput(value, false);
        return DynamicWire.Sha256(DynamicCanonical.Join(value.Schema, value.ProducerNodeId, value.ResultId, value.OutputSlot,
            value.CategoryStableId, value.TypeUniqueId, value.MepStateHash));
    }
    public static string SemanticEffectSetHash(IEnumerable<DynamicMepSemanticEffectV1> values)
    {
        var array = (values ?? throw new ArgumentNullException(nameof(values))).ToArray(); if (array.Length > DynamicMepMutationContractV1.MaximumEffects) throw new ArgumentException("MEP effect set is unbounded.");
        foreach (var value in array) ValidateSemanticEffect(value, true);
        return DynamicWire.Sha256(DynamicCanonical.Join(DynamicMepMutationContractV1.SemanticEffectSchema, DynamicCanonical.Set(array.Select(value => value.EffectHash))));
    }
    public static string SemanticOutputSetHash(IEnumerable<DynamicMepSemanticOutputV1> values)
    {
        var array = (values ?? throw new ArgumentNullException(nameof(values))).ToArray(); if (array.Length > DynamicMepMutationContractV1.MaximumOutputs) throw new ArgumentException("MEP output set is unbounded.");
        foreach (var value in array) ValidateSemanticOutput(value, true);
        return DynamicWire.Sha256(DynamicCanonical.Join(DynamicMepMutationContractV1.SemanticOutputSchema, DynamicCanonical.Set(array.Select(value => value.OutputHash))));
    }
    public static string ReadbackHash(DynamicResultReferenceMutationReadbackV1 value)
    {
        ValidateReadback(value, false);
        return DynamicWire.Sha256(DynamicCanonical.Join(value.Schema, value.NodeId, value.Kind, value.SubjectIdentity,
            value.BeforeStateHash, value.AfterStateHash, DynamicCanonical.Map(value.ExactValues)));
    }
    public static string ReadbackSetHash(IEnumerable<DynamicResultReferenceMutationReadbackV1> values)
    {
        var array = (values ?? throw new ArgumentNullException(nameof(values))).ToArray();
        if (array.Length > DynamicMepMutationContractV1.MaximumEffects) throw new ArgumentException("Mutation readback set is unbounded.");
        foreach (var value in array) ValidateReadback(value, true);
        return DynamicWire.Sha256(DynamicCanonical.Join(DynamicMepMutationContractV1.ReadbackSchema, DynamicCanonical.Set(array.Select(value => value.ReadbackHash))));
    }
    public static string PreviewHash(DynamicMepMutationPreviewV1 value)
    {
        ValidatePreview(value, false);
        return DynamicWire.Sha256(DynamicCanonical.Join(value.Schema, value.ContractManifestHash, value.GraphHash, value.EffectBudgetHash,
            value.DocumentFingerprint, value.DocumentSessionId, value.DocumentRevision.ToString(CultureInfo.InvariantCulture), value.SemanticEffectSetHash,
            value.SemanticOutputSetHash, value.ReadbackSetHash, value.TopologyHash, value.RollbackVerified ? "1" : "0"));
    }
    public static DynamicMepMutationApplyAuthorizationV1 IssueAuthorization(DynamicMepMutationPreviewV1 preview, DynamicEffectBudgetV1 budget,
        long issuedUnixSeconds, long expiresUnixSeconds, byte[] trustedKey, string authorizationId)
    {
        ValidatePreview(preview, true); budget.Validate();
        if (preview.EffectBudgetHash != budget.CanonicalHash() || issuedUnixSeconds < 0 || expiresUnixSeconds <= issuedUnixSeconds || expiresUnixSeconds - issuedUnixSeconds > 300 || !DynamicCanonical.Id(authorizationId, 160))
            throw new ArgumentException("MEP apply authorization request is invalid.");
        var value = new DynamicMepMutationApplyAuthorizationV1
        {
            AuthorizationId = authorizationId, ContractManifestHash = DynamicMepMutationManifestV1.ManifestHash, GraphHash = preview.GraphHash,
            PreviewHash = preview.PreviewHash, EffectBudgetHash = preview.EffectBudgetHash, SemanticEffectSetHash = preview.SemanticEffectSetHash,
            SemanticOutputSetHash = preview.SemanticOutputSetHash, ReadbackSetHash = preview.ReadbackSetHash, TopologyHash = preview.TopologyHash, DocumentFingerprint = preview.DocumentFingerprint,
            DocumentSessionId = preview.DocumentSessionId, DocumentRevision = preview.DocumentRevision,
            IssuedUnixSeconds = issuedUnixSeconds, ExpiresUnixSeconds = expiresUnixSeconds
        };
        value.Signature = Sign(value, trustedKey); return value;
    }
    public static string ValidateAndConsumeAuthorization(DynamicMepMutationApplyAuthorizationV1 value, DynamicMepMutationPreviewV1 preview,
        DynamicEffectBudgetV1 budget, long nowUnixSeconds, byte[] trustedKey, IDynamicCoreOperationApplyAuthorizationLedgerV1 ledger)
    {
        if (ledger == null) throw new ArgumentNullException(nameof(ledger)); ValidatePreview(preview, true); budget.Validate();
        if (value == null || value.Schema != DynamicMepMutationContractV1.ApplyAuthorizationSchema || value.ContractManifestHash != DynamicMepMutationManifestV1.ManifestHash ||
            value.GraphHash != preview.GraphHash || value.PreviewHash != preview.PreviewHash || value.EffectBudgetHash != budget.CanonicalHash() || value.EffectBudgetHash != preview.EffectBudgetHash ||
            value.SemanticEffectSetHash != preview.SemanticEffectSetHash || value.SemanticOutputSetHash != preview.SemanticOutputSetHash || value.ReadbackSetHash != preview.ReadbackSetHash || value.TopologyHash != preview.TopologyHash ||
            value.DocumentFingerprint != preview.DocumentFingerprint || value.DocumentSessionId != preview.DocumentSessionId || value.DocumentRevision != preview.DocumentRevision ||
            value.IssuedUnixSeconds < 0 || value.IssuedUnixSeconds > nowUnixSeconds + 5 || value.ExpiresUnixSeconds <= nowUnixSeconds || value.ExpiresUnixSeconds - value.IssuedUnixSeconds > 300 ||
            !DynamicCanonical.Id(value.AuthorizationId, 160) || !DynamicCanonical.FixedEquals(value.Signature, Sign(value, trustedKey)))
            throw new InvalidOperationException("MEP apply authorization is stale, substituted, expired, or unauthenticated.");
        var hash = AuthorizationHash(value); if (!ledger.TryConsume(hash)) throw new InvalidOperationException("MEP apply authorization was replayed."); return hash;
    }
    public static string AuthorizationHash(DynamicMepMutationApplyAuthorizationV1 value) => DynamicWire.Sha256(CanonicalAuthorization(value) + "+" + (value.Signature ?? ""));
    public static string ApplyReceiptHash(DynamicMepMutationApplyReceiptV1 value)
    {
        if (value == null || value.Schema != DynamicMepMutationContractV1.ApplyReceiptSchema || value.ContractManifestHash != DynamicMepMutationManifestV1.ManifestHash ||
            value.Outcome != "committed_verified" || value.DocumentRevisionAfter < value.DocumentRevisionBefore || !DynamicCanonical.Id(value.DocumentSessionId, 256) ||
            value.Effects == null || value.Outputs == null || value.Readbacks == null || value.Effects.Count > DynamicMepMutationContractV1.MaximumEffects ||
            value.Outputs.Count > DynamicMepMutationContractV1.MaximumOutputs || value.Readbacks.Count > DynamicMepMutationContractV1.MaximumEffects)
            throw new ArgumentException("MEP apply receipt envelope is invalid.");
        DynamicCanonical.RequireHashes(value.GraphHash, value.PreviewHash, value.AuthorizationHash, value.EffectBudgetHash, value.DocumentFingerprint,
            value.SemanticEffectSetHash, value.SemanticOutputSetHash, value.ReadbackSetHash, value.TopologyHash);
        foreach (var effect in value.Effects) ValidateObservedEffect(effect, true);
        foreach (var output in value.Outputs) DynamicResultReferencePolicyV1.ValidateCreatedFactShape(output, true);
        foreach (var readback in value.Readbacks) ValidateReadback(readback, true);
        if (value.ReadbackSetHash != ReadbackSetHash(value.Readbacks)) throw new ArgumentException("MEP apply readback set is invalid.");
        return DynamicWire.Sha256(DynamicCanonical.Join(value.Schema, value.ContractManifestHash, value.GraphHash, value.PreviewHash, value.AuthorizationHash,
            value.EffectBudgetHash, value.DocumentFingerprint, value.DocumentSessionId, value.DocumentRevisionBefore.ToString(CultureInfo.InvariantCulture),
            value.DocumentRevisionAfter.ToString(CultureInfo.InvariantCulture), DynamicCanonical.Set(value.Effects.Select(effect => effect.EffectHash)),
            DynamicCanonical.Set(value.Outputs.Select(output => output.OutputHash)), value.SemanticEffectSetHash, value.SemanticOutputSetHash,
            value.ReadbackSetHash, DynamicCanonical.Set(value.Readbacks.Select(readback => readback.ReadbackHash)), value.TopologyHash, value.Outcome));
    }
    public static void ValidatePreview(DynamicMepMutationPreviewV1 value, bool requireHash)
    {
        if (value == null || value.Schema != DynamicMepMutationContractV1.PreviewSchema || value.ContractManifestHash != DynamicMepMutationManifestV1.ManifestHash ||
            value.DocumentRevision < 0 || !DynamicCanonical.Id(value.DocumentSessionId, 256) || value.Effects == null || value.Outputs == null || value.Readbacks == null || !value.RollbackVerified)
            throw new ArgumentException("MEP preview receipt envelope or rollback truth is invalid.");
        DynamicCanonical.RequireHashes(value.GraphHash, value.EffectBudgetHash, value.DocumentFingerprint, value.SemanticEffectSetHash, value.SemanticOutputSetHash, value.ReadbackSetHash, value.TopologyHash);
        if (value.SemanticEffectSetHash != SemanticEffectSetHash(value.Effects) || value.SemanticOutputSetHash != SemanticOutputSetHash(value.Outputs) || value.ReadbackSetHash != ReadbackSetHash(value.Readbacks)) throw new ArgumentException("MEP preview semantic sets are invalid.");
        if (requireHash && value.PreviewHash != PreviewHash(value)) throw new InvalidOperationException("MEP preview hash is invalid.");
    }
    private static string Sign(DynamicMepMutationApplyAuthorizationV1 value, byte[] key) => DynamicCanonical.Hmac(CanonicalAuthorization(value), key);
    private static string CanonicalAuthorization(DynamicMepMutationApplyAuthorizationV1 value) => DynamicCanonical.Join(value.Schema, value.AuthorizationId,
        value.ContractManifestHash, value.GraphHash, value.PreviewHash, value.EffectBudgetHash, value.SemanticEffectSetHash, value.SemanticOutputSetHash, value.ReadbackSetHash,
        value.TopologyHash, value.DocumentFingerprint, value.DocumentSessionId, value.DocumentRevision.ToString(CultureInfo.InvariantCulture),
        value.IssuedUnixSeconds.ToString(CultureInfo.InvariantCulture), value.ExpiresUnixSeconds.ToString(CultureInfo.InvariantCulture));
    private static void ValidateSemanticEffect(DynamicMepSemanticEffectV1 value, bool requireHash)
    {
        if (value == null || value.Schema != DynamicMepMutationContractV1.SemanticEffectSchema || !DynamicCanonical.Hash(value.NodeId) || DynamicMepMutationManifestV1.Find(value.Kind) == null ||
            value.AddedCount < 0 || value.ModifiedCount < 0 || value.DeletedCount < 0 || value.AddedCount + value.ModifiedCount + value.DeletedCount > 50_000)
            throw new ArgumentException("MEP semantic effect is invalid.");
        DynamicCanonical.RequireHashes(value.AddedCategoryTypeSetHash, value.ModifiedSourceSetHash, value.TopologyHash);
        if (requireHash && value.EffectHash != SemanticEffectHash(value)) throw new ArgumentException("MEP semantic effect hash is invalid.");
    }
    private static void ValidateObservedEffect(DynamicMepObservedEffectV1 value, bool requireHash)
    {
        if (value == null || value.Schema != DynamicMepMutationContractV1.ObservedEffectSchema || !DynamicCanonical.Hash(value.NodeId) || DynamicMepMutationManifestV1.Find(value.Kind) == null ||
            value.AddedElementIds == null || value.ModifiedElementIds == null || value.DeletedElementIds == null) throw new ArgumentException("MEP observed effect is invalid.");
        ValidateIds(value.AddedElementIds); ValidateIds(value.ModifiedElementIds); ValidateIds(value.DeletedElementIds); DynamicCanonical.RequireHashes(value.SemanticEffectHash);
        if (requireHash && value.EffectHash != ObservedEffectHash(value)) throw new ArgumentException("MEP observed effect hash is invalid.");
    }
    private static void ValidateSemanticOutput(DynamicMepSemanticOutputV1 value, bool requireHash)
    {
        if (value == null || value.Schema != DynamicMepMutationContractV1.SemanticOutputSchema || !DynamicCanonical.Hash(value.ProducerNodeId) || !DynamicCanonical.Hash(value.ResultId) ||
            !DynamicCanonical.Id(value.OutputSlot, 128) || !DynamicCanonical.Id(value.CategoryStableId, 256) || !DynamicCanonical.Id(value.TypeUniqueId, 256) || !DynamicCanonical.Hash(value.MepStateHash))
            throw new ArgumentException("MEP semantic output is invalid.");
        if (requireHash && value.OutputHash != SemanticOutputHash(value)) throw new ArgumentException("MEP semantic output hash is invalid.");
    }
    private static void ValidateReadback(DynamicResultReferenceMutationReadbackV1 value, bool requireHash)
    {
        if (value == null || value.Schema != DynamicMepMutationContractV1.ReadbackSchema || !DynamicCanonical.Hash(value.NodeId) ||
            DynamicMepMutationManifestV1.Find(value.Kind) == null || !DynamicCanonical.Id(value.SubjectIdentity, 512) || value.ExactValues == null ||
            value.ExactValues.Count > 64 || value.ExactValues.Any(pair => !DynamicCanonical.Id(pair.Key, 128) || pair.Value == null || pair.Value.Length > 2048))
            throw new ArgumentException("Mutation readback is invalid.");
        DynamicCanonical.RequireHashes(value.BeforeStateHash, value.AfterStateHash);
        if (requireHash && value.ReadbackHash != ReadbackHash(value)) throw new ArgumentException("Mutation readback hash is invalid.");
    }
    private static void ValidateIds(IReadOnlyList<long> values)
    {
        if (values.Count > 50_000 || values.Any(value => value < 0) || values.Distinct().Count() != values.Count || !values.SequenceEqual(values.OrderBy(value => value)))
            throw new ArgumentException("MEP effect IDs must be bounded, unique, and ascending.");
    }
    private static string Number(long value) => value.ToString(CultureInfo.InvariantCulture);
}
