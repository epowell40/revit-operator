using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;

namespace RevitOperator.DynamicRevitSdk;

/// <summary>Bounded, read-only building-systems observation contract. It grants no execution authority.</summary>
public static class DynamicBuildingSystemsObservationContractV1
{
    public const string ManifestSchema = "dynamic-revit-building-systems-observation-manifest/v1";
    public const string SelectorSchema = "dynamic-revit-building-systems-selector/v1";
    public const string EnvelopeSchema = "dynamic-revit-building-systems-envelope/v1";
    public const string CursorSchema = "dynamic-revit-building-systems-cursor/v1";
    public const string CanonicalVersion = "dynamic-revit-building-systems-canonical/v1";
    public const int MaximumRequestBytes = 64 * 1024;
    public const int MaximumPageSize = 128;
    public const int MaximumObservedFacts = 2048;
    public const int MaximumElementSelectors = 256;
    public const int MaximumCategorySelectors = 32;
    public const int MaximumKindSelectors = 5;
    public const int MaximumParameterSelectors = 32;
    public const int MaximumParametersPerFact = 64;
    public const int MaximumConnectorsPerFact = 64;
    public const int MaximumConnectionsPerConnector = 64;
    public const int MaximumSystemMembers = 2048;

    private static readonly Type[] WireTypes =
    {
        typeof(DynamicBuildingSystemsSelectorV1), typeof(DynamicBuildingSystemsEnvelopeV1),
        typeof(DynamicBuildingSystemsFactV1), typeof(DynamicBuildingConnectorV1),
        typeof(DynamicMepCurveFactV1), typeof(DynamicBuildingAssetFactV1), typeof(DynamicBuildingSystemFactV1)
    };

    public static string ContractSurfaceHash => DynamicWire.Sha256(string.Join("\n", WireTypes.OrderBy(type => type.FullName, StringComparer.Ordinal).Select(Surface)));
    public static string ManifestHash => DynamicWire.Sha256(DynamicCanonical.Join(ManifestSchema, SelectorSchema, EnvelopeSchema, CursorSchema,
        CanonicalVersion, MaximumRequestBytes.ToString(CultureInfo.InvariantCulture), MaximumPageSize.ToString(CultureInfo.InvariantCulture),
        MaximumObservedFacts.ToString(CultureInfo.InvariantCulture), MaximumElementSelectors.ToString(CultureInfo.InvariantCulture),
        MaximumCategorySelectors.ToString(CultureInfo.InvariantCulture), MaximumKindSelectors.ToString(CultureInfo.InvariantCulture),
        MaximumParameterSelectors.ToString(CultureInfo.InvariantCulture), MaximumParametersPerFact.ToString(CultureInfo.InvariantCulture),
        MaximumConnectorsPerFact.ToString(CultureInfo.InvariantCulture), MaximumConnectionsPerConnector.ToString(CultureInfo.InvariantCulture),
        MaximumSystemMembers.ToString(CultureInfo.InvariantCulture), ContractSurfaceHash, "read-only", "snapshot-bound", "development-laboratory-only", "no-revit-handles"));

    private static string Surface(Type type) => type.FullName + "\n" + string.Join("\n", type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
        .Where(property => property.GetMethod != null).OrderBy(property => property.Name, StringComparer.Ordinal)
        .Select(property => property.Name + ":" + TypeName(property.PropertyType)));
    private static string TypeName(Type type)
    {
        var nullable = Nullable.GetUnderlyingType(type); if (nullable != null) return TypeName(nullable) + "?";
        if (type.IsArray) return TypeName(type.GetElementType()!) + "[]";
        if (!type.IsGenericType) return type.FullName ?? type.Name;
        var name = type.GetGenericTypeDefinition().FullName ?? type.Name; var tick = name.IndexOf('`'); if (tick >= 0) name = name.Substring(0, tick);
        return name + "<" + string.Join(",", type.GetGenericArguments().Select(TypeName)) + ">";
    }
}

public sealed class DynamicBuildingSystemsSelectorV1
{
    public string Schema { get; set; } = DynamicBuildingSystemsObservationContractV1.SelectorSchema;
    public string[] ElementUniqueIds { get; set; } = Array.Empty<string>();
    public string[] CategoryStableIds { get; set; } = Array.Empty<string>();
    public string[] Kinds { get; set; } = Array.Empty<string>();
    public string[] ParameterNames { get; set; } = Array.Empty<string>();
    public bool IncludeTypeParameters { get; set; }
    public int PageSize { get; set; } = 64;
    public string? Cursor { get; set; }
}

public sealed class DynamicBuildingSystemsEnvelopeV1
{
    public string Schema { get; set; } = DynamicBuildingSystemsObservationContractV1.EnvelopeSchema;
    public string ContractManifestHash { get; set; } = DynamicBuildingSystemsObservationContractV1.ManifestHash;
    public string DocumentFingerprint { get; set; } = "";
    public string DocumentSessionId { get; set; } = "";
    public long DocumentRevision { get; set; }
    public string SnapshotHash { get; set; } = "";
    public string RevisionHash { get; set; } = "";
    public string ScopeHash { get; set; } = "";
    public int PageOffset { get; set; }
    public int PageSize { get; set; }
    public int TotalCount { get; set; }
    public IReadOnlyList<DynamicBuildingSystemsFactV1> Facts { get; set; } = Array.Empty<DynamicBuildingSystemsFactV1>();
    public string? NextCursor { get; set; }
    public string EnvelopeHash { get; set; } = "";
}

public sealed class DynamicBuildingSystemsFactV1
{
    public string Kind { get; set; } = "";
    public DynamicStableReferenceV1 Element { get; set; } = new();
    public DynamicStableReferenceV1? Category { get; set; }
    public DynamicStableReferenceV1? Family { get; set; }
    public DynamicStableReferenceV1? Type { get; set; }
    public DynamicStableReferenceV1? Host { get; set; }
    public DynamicStableReferenceV1? Level { get; set; }
    public DynamicStableReferenceV1? Workset { get; set; }
    public DynamicPointV1? Location { get; set; }
    public DynamicTransformV1? Orientation { get; set; }
    public DynamicMepCurveFactV1? Curve { get; set; }
    public DynamicBuildingAssetFactV1? Asset { get; set; }
    public DynamicBuildingSystemFactV1? System { get; set; }
    public IReadOnlyList<DynamicBuildingConnectorV1> Connectors { get; set; } = Array.Empty<DynamicBuildingConnectorV1>();
    public IReadOnlyList<DynamicParameterValueV1> Parameters { get; set; } = Array.Empty<DynamicParameterValueV1>();
}

public sealed class DynamicBuildingConnectorV1
{
    public string StableWithinSnapshotId { get; set; } = "";
    public DynamicPointV1 Origin { get; set; } = new();
    public DynamicPointV1 BasisX { get; set; } = new();
    public DynamicPointV1 BasisY { get; set; } = new();
    public DynamicPointV1 BasisZ { get; set; } = new();
    public string Domain { get; set; } = "";
    public string ConnectorType { get; set; } = "";
    public string Shape { get; set; } = "";
    public string FlowDirection { get; set; } = "";
    public string SystemClassification { get; set; } = "";
    public double? RadiusFeet { get; set; }
    public double? HeightFeet { get; set; }
    public double? WidthFeet { get; set; }
    public DynamicStableReferenceV1? System { get; set; }
    public IReadOnlyList<string> ConnectedCounterpartIds { get; set; } = Array.Empty<string>();
}

public sealed class DynamicMepCurveFactV1
{
    public DynamicPointV1 Start { get; set; } = new();
    public DynamicPointV1 End { get; set; } = new();
    public string CurveKind { get; set; } = "";
    public string Shape { get; set; } = "";
    public double? DiameterFeet { get; set; }
    public double? HeightFeet { get; set; }
    public double? WidthFeet { get; set; }
    public double? OffsetFeet { get; set; }
    public double? Slope { get; set; }
    public DynamicStableReferenceV1? Level { get; set; }
    public DynamicStableReferenceV1 Type { get; set; } = new();
    public IReadOnlyList<DynamicStableReferenceV1> Systems { get; set; } = Array.Empty<DynamicStableReferenceV1>();
}

public sealed class DynamicBuildingAssetFactV1
{
    public string AssetClass { get; set; } = "";
    public DynamicPointV1 Location { get; set; } = new();
    public DynamicTransformV1 Orientation { get; set; } = new();
    public DynamicStableReferenceV1 Family { get; set; } = new();
    public DynamicStableReferenceV1 Type { get; set; } = new();
    public DynamicStableReferenceV1? Host { get; set; }
    public DynamicStableReferenceV1? Level { get; set; }
    public DynamicStableReferenceV1? Workset { get; set; }
}

public sealed class DynamicBuildingSystemFactV1
{
    public string Domain { get; set; } = "";
    public string Classification { get; set; } = "";
    public DynamicStableReferenceV1 Type { get; set; } = new();
    public IReadOnlyList<DynamicStableReferenceV1> Members { get; set; } = Array.Empty<DynamicStableReferenceV1>();
}

public static class DynamicBuildingSystemsObservationPolicyV1
{
    private const int MaximumText = 512;
    private const double MaximumCoordinate = 1_000_000_000d;
    private static readonly string[] Kinds = { "mep_curve", "equipment", "device", "accessory", "system" };

    public static string ConnectorStableId(string snapshotHash, string ownerUniqueId, string connectorIdentity)
    {
        RequireHash(snapshotHash, "snapshot"); RequireText(ownerUniqueId, 256, "connector owner"); RequireText(connectorIdentity, 128, "connector identity");
        return "snapshot-connector:" + snapshotHash.Substring(7) + ":" +
            DynamicWire.Sha256(DynamicCanonical.Join("dynamic-revit-snapshot-connector/v1", snapshotHash, ownerUniqueId, connectorIdentity)).Substring(7);
    }

    public static void ValidateSelector(DynamicBuildingSystemsSelectorV1 value)
    {
        if (value == null || value.Schema != DynamicBuildingSystemsObservationContractV1.SelectorSchema) throw new ArgumentException("Building-systems selector schema is invalid.");
        Strings(value.ElementUniqueIds, DynamicBuildingSystemsObservationContractV1.MaximumElementSelectors, 256, "element selectors");
        Strings(value.CategoryStableIds, DynamicBuildingSystemsObservationContractV1.MaximumCategorySelectors, 256, "category selectors");
        Strings(value.Kinds, DynamicBuildingSystemsObservationContractV1.MaximumKindSelectors, 32, "kind selectors");
        if (value.Kinds.Any(item => !Kinds.Contains(item, StringComparer.Ordinal))) throw new ArgumentException("Building-systems kind selector is unknown.");
        Strings(value.ParameterNames, DynamicBuildingSystemsObservationContractV1.MaximumParameterSelectors, 256, "parameter selectors");
        if (value.PageSize < 1 || value.PageSize > DynamicBuildingSystemsObservationContractV1.MaximumPageSize) throw new ArgumentException("Building-systems page size is outside bounds.");
        if (value.Cursor != null && (value.Cursor.Length > 160 || !ReadCursor(value.Cursor, out _, out _))) throw new ArgumentException("Building-systems cursor is malformed.");
    }

    public static string ScopeHash(DynamicBuildingSystemsSelectorV1 value)
    {
        ValidateSelector(value);
        return DynamicWire.Sha256(DynamicCanonical.Join(DynamicBuildingSystemsObservationContractV1.SelectorSchema,
            DynamicCanonical.Set(value.ElementUniqueIds), DynamicCanonical.Set(value.CategoryStableIds), DynamicCanonical.Set(value.Kinds),
            DynamicCanonical.Set(value.ParameterNames), value.IncludeTypeParameters ? "1" : "0", value.PageSize.ToString(CultureInfo.InvariantCulture)));
    }

    public static DynamicBuildingSystemsEnvelopeV1 BuildPage(DynamicBuildingSystemsSelectorV1 selector, string documentFingerprint,
        string documentSessionId, long documentRevision, string snapshotHash, IEnumerable<DynamicBuildingSystemsFactV1> observedFacts)
    {
        ValidateSelector(selector); RequireHash(documentFingerprint, "document fingerprint"); RequireText(documentSessionId, 256, "document session");
        if (documentRevision < 0) throw new ArgumentException("Document revision is invalid."); RequireHash(snapshotHash, "snapshot");
        var all = (observedFacts ?? throw new ArgumentNullException(nameof(observedFacts))).Take(DynamicBuildingSystemsObservationContractV1.MaximumObservedFacts + 1).ToArray();
        if (all.Length > DynamicBuildingSystemsObservationContractV1.MaximumObservedFacts) throw new ArgumentException("Building-systems observation source exceeds bounds.");
        foreach (var fact in all) ValidateFact(fact, snapshotHash);
        if (all.Select(fact => fact.Element.StableId).Distinct(StringComparer.Ordinal).Count() != all.Length) throw new ArgumentException("Building-systems fact identities are duplicated.");
        var ids = new HashSet<string>(selector.ElementUniqueIds, StringComparer.Ordinal); var categories = new HashSet<string>(selector.CategoryStableIds, StringComparer.Ordinal); var kinds = new HashSet<string>(selector.Kinds, StringComparer.Ordinal);
        var selected = all.Where(fact => (ids.Count == 0 || fact.Element.UniqueId != null && ids.Contains(fact.Element.UniqueId)) &&
            (categories.Count == 0 || fact.Category != null && categories.Contains(fact.Category.StableId)) && (kinds.Count == 0 || kinds.Contains(fact.Kind)))
            .OrderBy(fact => fact.Element.StableId, StringComparer.Ordinal).ToArray();
        var scope = ScopeHash(selector); var revision = RevisionHash(documentFingerprint, documentSessionId, documentRevision, snapshotHash, selected); var offset = 0;
        if (selector.Cursor != null && (!ReadCursor(selector.Cursor, out offset, out var proof) || proof != CursorProof(scope, snapshotHash, revision, offset)))
            throw new ArgumentException("Building-systems cursor is stale or belongs to another scope/snapshot.");
        if (offset < 0 || offset > selected.Length || offset != 0 && offset % selector.PageSize != 0) throw new ArgumentException("Building-systems cursor offset is invalid.");
        var page = selected.Skip(offset).Take(selector.PageSize).ToArray(); var nextOffset = offset + page.Length;
        var envelope = new DynamicBuildingSystemsEnvelopeV1 { DocumentFingerprint = documentFingerprint, DocumentSessionId = documentSessionId,
            DocumentRevision = documentRevision, SnapshotHash = snapshotHash, RevisionHash = revision, ScopeHash = scope, PageOffset = offset,
            PageSize = selector.PageSize, TotalCount = selected.Length, Facts = page,
            NextCursor = nextOffset < selected.Length ? Cursor(scope, snapshotHash, revision, nextOffset) : null };
        envelope.EnvelopeHash = EnvelopeHash(envelope); ValidateEnvelope(envelope); return envelope;
    }

    public static string RevisionHash(string fingerprint, string session, long documentRevision, string snapshotHash, IEnumerable<DynamicBuildingSystemsFactV1> facts)
    {
        RequireHash(fingerprint, "document fingerprint"); RequireText(session, 256, "document session"); if (documentRevision < 0) throw new ArgumentException("Document revision is invalid."); RequireHash(snapshotHash, "snapshot");
        var values = (facts ?? throw new ArgumentNullException(nameof(facts))).OrderBy(value => value.Element.StableId, StringComparer.Ordinal).ToArray();
        if (values.Length > DynamicBuildingSystemsObservationContractV1.MaximumObservedFacts) throw new ArgumentException("Building-systems revision is unbounded.");
        foreach (var fact in values) ValidateFact(fact, snapshotHash);
        return DynamicWire.Sha256(DynamicCanonical.Join(DynamicBuildingSystemsObservationContractV1.CanonicalVersion, "revision", fingerprint, session,
            documentRevision.ToString(CultureInfo.InvariantCulture), snapshotHash, DynamicCanonical.Join(values.Select(FactCanonical).ToArray())));
    }

    public static void ValidateEnvelope(DynamicBuildingSystemsEnvelopeV1 value)
    {
        if (value == null || value.Schema != DynamicBuildingSystemsObservationContractV1.EnvelopeSchema || value.ContractManifestHash != DynamicBuildingSystemsObservationContractV1.ManifestHash)
            throw new ArgumentException("Building-systems envelope contract identity is invalid.");
        RequireHash(value.DocumentFingerprint, "document fingerprint"); RequireText(value.DocumentSessionId, 256, "document session"); if (value.DocumentRevision < 0) throw new ArgumentException("Document revision is invalid.");
        RequireHash(value.SnapshotHash, "snapshot"); RequireHash(value.RevisionHash, "revision"); RequireHash(value.ScopeHash, "scope");
        if (value.PageSize < 1 || value.PageSize > DynamicBuildingSystemsObservationContractV1.MaximumPageSize || value.PageOffset < 0 || value.TotalCount < 0 ||
            value.TotalCount > DynamicBuildingSystemsObservationContractV1.MaximumObservedFacts || value.PageOffset > value.TotalCount ||
            value.PageOffset != 0 && value.PageOffset % value.PageSize != 0 || value.Facts == null ||
            value.Facts.Count != Math.Min(value.PageSize, value.TotalCount - value.PageOffset))
            throw new ArgumentException("Building-systems envelope paging is invalid.");
        foreach (var fact in value.Facts) ValidateFact(fact, value.SnapshotHash);
        if (value.Facts.Select(fact => fact.Element.StableId).Distinct(StringComparer.Ordinal).Count() != value.Facts.Count) throw new ArgumentException("Building-systems page has duplicate facts.");
        if (!value.Facts.Select(fact => fact.Element.StableId).SequenceEqual(value.Facts.Select(fact => fact.Element.StableId).OrderBy(id => id, StringComparer.Ordinal)))
            throw new ArgumentException("Building-systems page order is non-canonical.");
        var expectedNext = value.PageOffset + value.Facts.Count < value.TotalCount;
        if (expectedNext != (value.NextCursor != null) || value.NextCursor != null &&
            (!ReadCursor(value.NextCursor, out var next, out var proof) || next != value.PageOffset + value.Facts.Count || proof != CursorProof(value.ScopeHash, value.SnapshotHash, value.RevisionHash, next)))
            throw new ArgumentException("Building-systems next cursor is invalid.");
        if (value.EnvelopeHash != EnvelopeHash(value)) throw new ArgumentException("Building-systems envelope hash is invalid.");
    }

    public static string EnvelopeHash(DynamicBuildingSystemsEnvelopeV1 value) => DynamicWire.Sha256(DynamicCanonical.Join(DynamicBuildingSystemsObservationContractV1.CanonicalVersion,
        "envelope", value.Schema, value.ContractManifestHash, value.DocumentFingerprint, value.DocumentSessionId, value.DocumentRevision.ToString(CultureInfo.InvariantCulture),
        value.SnapshotHash, value.RevisionHash, value.ScopeHash, value.PageOffset.ToString(CultureInfo.InvariantCulture), value.PageSize.ToString(CultureInfo.InvariantCulture),
        value.TotalCount.ToString(CultureInfo.InvariantCulture), DynamicCanonical.Join((value.Facts ?? Array.Empty<DynamicBuildingSystemsFactV1>()).Select(FactCanonical).ToArray()), value.NextCursor));

    public static void ValidateFact(DynamicBuildingSystemsFactV1 value, string snapshotHash)
    {
        if (value == null || !Kinds.Contains(value.Kind, StringComparer.Ordinal)) throw new ArgumentException("Building-systems fact kind is invalid.");
        Reference(value.Element, true, value.Kind == "system" ? "system" : "element"); Reference(value.Category, false, "category");
        Reference(value.Family, false, "family"); Reference(value.Type, false, "type"); Reference(value.Host, false, "host");
        Reference(value.Level, false, "level"); Reference(value.Workset, false, "workset");
        Point(value.Location); Transform(value.Orientation);
        if (value.Connectors == null || value.Connectors.Count > DynamicBuildingSystemsObservationContractV1.MaximumConnectorsPerFact) throw new ArgumentException("Building-systems connector set is unbounded.");
        foreach (var connector in value.Connectors) Connector(connector, snapshotHash);
        if (value.Connectors.Select(item => item.StableWithinSnapshotId).Distinct(StringComparer.Ordinal).Count() != value.Connectors.Count) throw new ArgumentException("Building-systems connector identities are duplicated.");
        if (value.Parameters == null || value.Parameters.Count > DynamicBuildingSystemsObservationContractV1.MaximumParametersPerFact) throw new ArgumentException("Building-systems parameter set is unbounded.");
        foreach (var parameter in value.Parameters) Parameter(parameter);
        if (value.Parameters.Select(parameter => parameter.Scope + "\n" + parameter.Identity).Distinct(StringComparer.Ordinal).Count() != value.Parameters.Count) throw new ArgumentException("Building-systems parameters are duplicated.");
        if (value.Kind == "mep_curve") { if (value.Curve == null || value.Asset != null || value.System != null) throw new ArgumentException("MEP curve fact shape is invalid."); Curve(value.Curve); }
        else if (value.Kind == "system") { if (value.System == null || value.Curve != null || value.Asset != null || value.Connectors.Count != 0) throw new ArgumentException("System fact shape is invalid."); System(value.System); }
        else { if (value.Asset == null || value.Curve != null || value.System != null) throw new ArgumentException("Building asset fact shape is invalid."); Asset(value.Asset, value.Kind); }
    }

    public static string FactCanonical(DynamicBuildingSystemsFactV1 value)
    {
        ValidateFact(value, ExtractSnapshot(value));
        return FactCanonicalUnchecked(value);
    }

    private static string ExtractSnapshot(DynamicBuildingSystemsFactV1 value)
    {
        var id = value.Connectors?.FirstOrDefault()?.StableWithinSnapshotId;
        return id == null || id.Length != 148 ? DynamicWire.Sha256("no-connectors/v1") : "sha256:" + id.Substring(19, 64);
    }

    private static string FactCanonicalUnchecked(DynamicBuildingSystemsFactV1 value) => DynamicCanonical.Join(value.Kind, Ref(value.Element), Ref(value.Category), Ref(value.Family), Ref(value.Type), Ref(value.Host), Ref(value.Level), Ref(value.Workset),
        Pt(value.Location), Tx(value.Orientation), CurveCanonical(value.Curve), AssetCanonical(value.Asset), SystemCanonical(value.System),
        DynamicCanonical.Join(value.Connectors.OrderBy(item => item.StableWithinSnapshotId, StringComparer.Ordinal).Select(ConnectorCanonical).ToArray()),
        DynamicCanonical.Join(value.Parameters.OrderBy(item => item.Scope, StringComparer.Ordinal).ThenBy(item => item.Identity, StringComparer.Ordinal).Select(ParameterCanonical).ToArray()));

    private static void Connector(DynamicBuildingConnectorV1 value, string snapshotHash)
    {
        var prefix = "snapshot-connector:" + snapshotHash.Substring(7) + ":";
        RequireHash(snapshotHash, "snapshot"); if (value == null || !value.StableWithinSnapshotId.StartsWith(prefix, StringComparison.Ordinal) || value.StableWithinSnapshotId.Length != 148 ||
            !DynamicCanonical.Hash("sha256:" + value.StableWithinSnapshotId.Substring(prefix.Length))) throw new ArgumentException("Connector snapshot identity is invalid.");
        Point(value.Origin, true); Point(value.BasisX, true); Point(value.BasisY, true); Point(value.BasisZ, true);
        if (!Orthonormal(value.BasisX, value.BasisY, value.BasisZ)) throw new ArgumentException("Connector frame is not right-handed orthonormal.");
        RequireText(value.Domain, 128, "connector domain"); RequireText(value.ConnectorType, 128, "connector type"); RequireText(value.Shape, 128, "connector shape"); RequireText(value.FlowDirection, 128, "connector flow"); RequireText(value.SystemClassification, 512, "system classification");
        foreach (var size in new[] { value.RadiusFeet, value.HeightFeet, value.WidthFeet }) if (size.HasValue && (!Finite(size.Value) || size.Value < 0 || size.Value > MaximumCoordinate)) throw new ArgumentException("Connector size is invalid.");
        Reference(value.System, false, "system"); Strings(value.ConnectedCounterpartIds, DynamicBuildingSystemsObservationContractV1.MaximumConnectionsPerConnector, 148, "connected counterparts");
        if (value.ConnectedCounterpartIds.Any(id => !id.StartsWith(prefix, StringComparison.Ordinal) || id.Length != 148 || !DynamicCanonical.Hash("sha256:" + id.Substring(prefix.Length)))) throw new ArgumentException("Connected counterpart identity is invalid.");
    }

    private static void Curve(DynamicMepCurveFactV1 value)
    {
        Point(value.Start, true); Point(value.End, true); RequireText(value.CurveKind, 64, "curve kind"); RequireText(value.Shape, 128, "curve shape");
        foreach (var number in new[] { value.DiameterFeet, value.HeightFeet, value.WidthFeet }) if (number.HasValue && (!Finite(number.Value) || number.Value < 0 || number.Value > MaximumCoordinate)) throw new ArgumentException("MEP curve size is invalid.");
        if (value.OffsetFeet.HasValue && (!Finite(value.OffsetFeet.Value) || Math.Abs(value.OffsetFeet.Value) > MaximumCoordinate) ||
            value.Slope.HasValue && (!Finite(value.Slope.Value) || Math.Abs(value.Slope.Value) > 1_000_000)) throw new ArgumentException("MEP curve offset or slope is invalid.");
        Reference(value.Level, false, "level"); Reference(value.Type, true, "type"); if (value.Systems == null || value.Systems.Count > 64) throw new ArgumentException("MEP curve system set is unbounded."); foreach (var system in value.Systems) Reference(system, true, "system");
        if (value.Systems.Select(Ref).Distinct(StringComparer.Ordinal).Count() != value.Systems.Count) throw new ArgumentException("MEP curve systems are duplicated.");
    }
    private static void Asset(DynamicBuildingAssetFactV1 value, string expected) { if (value == null || value.AssetClass != expected) throw new ArgumentException("Building asset classification is invalid."); Point(value.Location, true); Transform(value.Orientation, true); Reference(value.Family, true, "family"); Reference(value.Type, true, "type"); Reference(value.Host, false, "host"); Reference(value.Level, false, "level"); Reference(value.Workset, false, "workset"); }
    private static void System(DynamicBuildingSystemFactV1 value) { RequireText(value.Domain, 128, "system domain"); RequireText(value.Classification, 512, "system classification"); Reference(value.Type, true, "type"); if (value.Members == null || value.Members.Count > DynamicBuildingSystemsObservationContractV1.MaximumSystemMembers) throw new ArgumentException("System member set is unbounded."); foreach (var member in value.Members) Reference(member, true, "element"); if (value.Members.Select(Ref).Distinct(StringComparer.Ordinal).Count() != value.Members.Count) throw new ArgumentException("System members are duplicated."); }

    private static string CurveCanonical(DynamicMepCurveFactV1? value) => value == null ? "" : DynamicCanonical.Join(Pt(value.Start), Pt(value.End), value.CurveKind, value.Shape, Num(value.DiameterFeet), Num(value.HeightFeet), Num(value.WidthFeet), Num(value.OffsetFeet), Num(value.Slope), Ref(value.Level), Ref(value.Type), DynamicCanonical.Set(value.Systems.Select(Ref)));
    private static string AssetCanonical(DynamicBuildingAssetFactV1? value) => value == null ? "" : DynamicCanonical.Join(value.AssetClass, Pt(value.Location), Tx(value.Orientation), Ref(value.Family), Ref(value.Type), Ref(value.Host), Ref(value.Level), Ref(value.Workset));
    private static string SystemCanonical(DynamicBuildingSystemFactV1? value) => value == null ? "" : DynamicCanonical.Join(value.Domain, value.Classification, Ref(value.Type), DynamicCanonical.Set(value.Members.Select(Ref)));
    private static string ConnectorCanonical(DynamicBuildingConnectorV1 value) => DynamicCanonical.Join(value.StableWithinSnapshotId, Pt(value.Origin), Pt(value.BasisX), Pt(value.BasisY), Pt(value.BasisZ), value.Domain, value.ConnectorType, value.Shape, value.FlowDirection, value.SystemClassification, Num(value.RadiusFeet), Num(value.HeightFeet), Num(value.WidthFeet), Ref(value.System), DynamicCanonical.Set(value.ConnectedCounterpartIds));
    private static string ParameterCanonical(DynamicParameterValueV1 value) => DynamicCanonical.Join(value.Identity, value.Name, value.StorageKind, value.HasValue ? "1" : "0", value.RawString, value.RawInteger?.ToString(CultureInfo.InvariantCulture), Num(value.RawDouble), value.RawElementId?.ToString(CultureInfo.InvariantCulture), value.FormattedValue, value.SpecTypeId, value.UnitTypeId, value.Scope, value.Writable ? "1" : "0");
    private static void Parameter(DynamicParameterValueV1 value)
    {
        if (value == null) throw new ArgumentException("Parameter fact is missing."); RequireText(value.Identity, 256, "parameter identity"); RequireText(value.Name, 256, "parameter name");
        if (!new[] { "none", "string", "integer", "double", "element_id" }.Contains(value.StorageKind, StringComparer.Ordinal) || value.Scope != "instance" && value.Scope != "type" ||
            value.FormattedValue != null && value.FormattedValue.Length > 1024 || value.SpecTypeId != null && (string.IsNullOrWhiteSpace(value.SpecTypeId) || value.SpecTypeId.Length > 256) ||
            value.UnitTypeId != null && (string.IsNullOrWhiteSpace(value.UnitTypeId) || value.UnitTypeId.Length > 256) || value.RawString != null && value.RawString.Length > 4096 || value.RawDouble.HasValue && !Finite(value.RawDouble.Value))
            throw new ArgumentException("Parameter value is invalid or unbounded.");
        var carries = value.RawString != null || value.RawInteger.HasValue || value.RawDouble.HasValue || value.RawElementId.HasValue;
        if (!value.HasValue && carries) throw new ArgumentException("Empty parameter may not carry a raw value.");
        if (value.HasValue)
        {
            var exact = value.StorageKind == "string" && value.RawString != null && !value.RawInteger.HasValue && !value.RawDouble.HasValue && !value.RawElementId.HasValue ||
                value.StorageKind == "integer" && value.RawString == null && value.RawInteger.HasValue && !value.RawDouble.HasValue && !value.RawElementId.HasValue ||
                value.StorageKind == "double" && value.RawString == null && !value.RawInteger.HasValue && value.RawDouble.HasValue && !value.RawElementId.HasValue ||
                value.StorageKind == "element_id" && value.RawString == null && !value.RawInteger.HasValue && !value.RawDouble.HasValue && value.RawElementId.HasValue;
            if (!exact) throw new ArgumentException("Parameter raw value does not match its storage kind.");
        }
    }
    private static void Reference(DynamicStableReferenceV1? value, bool required, string expectedKind)
    {
        if (value == null) { if (required) throw new ArgumentException("Stable reference is required."); return; }
        if (value.Kind != expectedKind) throw new ArgumentException("Stable reference role is invalid."); RequireText(value.StableId, 512, "reference identity");
        if (value.UniqueId != null && (string.IsNullOrWhiteSpace(value.UniqueId) || value.UniqueId.Length > 256) || value.Name != null && value.Name.Length > 512) throw new ArgumentException("Stable reference metadata is invalid.");
        if (expectedKind == "category")
        {
            if (!value.ElementId.HasValue || value.UniqueId != null || !value.StableId.StartsWith("category:builtin:", StringComparison.Ordinal) && !value.StableId.StartsWith("category:element:", StringComparison.Ordinal))
                throw new ArgumentException("Category reference identity is invalid.");
        }
        else if (expectedKind == "workset")
        {
            if (!value.ElementId.HasValue || value.ElementId.Value < 0 || value.UniqueId != null || value.StableId != "workset:" + value.ElementId.Value.ToString(CultureInfo.InvariantCulture))
                throw new ArgumentException("Workset reference identity is invalid.");
        }
        else if (value.UniqueId == null || !value.ElementId.HasValue || value.ElementId.Value < -1 || value.StableId != "revit-element:" + value.UniqueId)
            throw new ArgumentException("Revit element reference identity is invalid.");
    }
    private static string Ref(DynamicStableReferenceV1? value) => value == null ? "" : DynamicCanonical.Join(value.Kind, value.StableId, value.UniqueId, value.ElementId?.ToString(CultureInfo.InvariantCulture), value.Name);
    private static void Point(DynamicPointV1? value, bool required = false) { if (value == null) { if (required) throw new ArgumentException("Point is required."); return; } if (!Finite(value.X) || !Finite(value.Y) || !Finite(value.Z) || new[] { value.X, value.Y, value.Z }.Any(number => Math.Abs(number) > MaximumCoordinate)) throw new ArgumentException("Point is invalid."); }
    private static string Pt(DynamicPointV1? value) => value == null ? "" : DynamicCanonical.Join(Num(value.X), Num(value.Y), Num(value.Z));
    private static void Transform(DynamicTransformV1? value, bool required = false) { if (value == null) { if (required) throw new ArgumentException("Orientation is required."); return; } Point(value.Origin, true); Point(value.BasisX, true); Point(value.BasisY, true); Point(value.BasisZ, true); if (!Orthonormal(value.BasisX, value.BasisY, value.BasisZ)) throw new ArgumentException("Orientation frame is not right-handed orthonormal."); }
    private static string Tx(DynamicTransformV1? value) => value == null ? "" : DynamicCanonical.Join(Pt(value.Origin), Pt(value.BasisX), Pt(value.BasisY), Pt(value.BasisZ));
    private static bool Orthonormal(DynamicPointV1 x, DynamicPointV1 y, DynamicPointV1 z) => Math.Abs(Dot(x, x) - 1) <= 1e-9 && Math.Abs(Dot(y, y) - 1) <= 1e-9 && Math.Abs(Dot(z, z) - 1) <= 1e-9 && Math.Abs(Dot(x, y)) <= 1e-9 && Math.Abs(Dot(x, z)) <= 1e-9 && Math.Abs(Dot(y, z)) <= 1e-9 && Math.Abs(x.Y * y.Z - x.Z * y.Y - z.X) <= 1e-9 && Math.Abs(x.Z * y.X - x.X * y.Z - z.Y) <= 1e-9 && Math.Abs(x.X * y.Y - x.Y * y.X - z.Z) <= 1e-9;
    private static double Dot(DynamicPointV1 left, DynamicPointV1 right) => left.X * right.X + left.Y * right.Y + left.Z * right.Z;
    private static string Num(double? value) => value.HasValue ? Num(value.Value) : "null";
    private static string Num(double value) { if (!Finite(value)) throw new ArgumentException("Canonical number is non-finite."); return value == 0 ? "0" : value.ToString("R", CultureInfo.InvariantCulture); }
    private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    private static void Strings(IEnumerable<string>? values, int maximum, int length, string label) { var array = values?.ToArray() ?? throw new ArgumentException(label + " are missing."); if (array.Length > maximum || array.Any(value => string.IsNullOrWhiteSpace(value) || value.Length > length) || array.Distinct(StringComparer.Ordinal).Count() != array.Length) throw new ArgumentException(label + " are invalid, duplicated, or unbounded."); }
    private static void RequireText(string? value, int maximum, string label) { if (value == null || string.IsNullOrWhiteSpace(value) || value.Length > maximum) throw new ArgumentException(label + " is invalid."); }
    private static void RequireHash(string? value, string label) { if (!DynamicCanonical.Hash(value ?? "")) throw new ArgumentException(label + " hash is invalid."); }
    private static string Cursor(string scope, string snapshot, string revision, int offset) => DynamicBuildingSystemsObservationContractV1.CursorSchema + ":" + offset.ToString(CultureInfo.InvariantCulture) + ":" + CursorProof(scope, snapshot, revision, offset);
    private static string CursorProof(string scope, string snapshot, string revision, int offset) => DynamicWire.Sha256(DynamicCanonical.Join(DynamicBuildingSystemsObservationContractV1.CursorSchema, scope, snapshot, revision, offset.ToString(CultureInfo.InvariantCulture)));
    private static bool ReadCursor(string value, out int offset, out string proof) { offset = 0; proof = ""; var prefix = DynamicBuildingSystemsObservationContractV1.CursorSchema + ":"; if (!value.StartsWith(prefix, StringComparison.Ordinal)) return false; var split = value.Substring(prefix.Length).Split(':'); if (split.Length != 3 || !int.TryParse(split[0], NumberStyles.None, CultureInfo.InvariantCulture, out offset)) return false; proof = "sha256:" + split[2]; return split[1] == "sha256" && DynamicCanonical.Hash(proof); }
}
