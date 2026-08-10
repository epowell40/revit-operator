using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;

namespace RevitOperator.DynamicRevitSdk;

/// <summary>
/// Identity and hard bounds for the additive, read-only observation contract. This contract
/// does not grant execution authority and is not part of the production tool projection.
/// </summary>
public static class DynamicObservationContractV1
{
    public const string SelectorSchema = "dynamic-revit-observation-selector/v1";
    public const string EnvelopeSchema = "dynamic-revit-observation-envelope/v1";
    public const string CursorSchema = "dynamic-revit-observation-cursor/v1";
    public const string ManifestSchema = "dynamic-revit-observation-contract-manifest/v1";
    public const string CanonicalVersion = "dynamic-revit-observation-canonical/v3";
    public const int MaximumRequestBytes = 64 * 1024;
    public const int MaximumPageSize = 256;
    public const int MaximumObservedElements = 4096;
    public const int MaximumElementSelectors = 256;
    public const int MaximumCategorySelectors = 64;
    public const int MaximumOwnerViewSelectors = 64;
    public const int MaximumParameterSelectors = 64;
    public const int MaximumParametersPerElement = MaximumParameterSelectors * 2;

    private static readonly Type[] WireTypes =
    {
        typeof(DynamicObservationSelectorV1), typeof(DynamicObservationEnvelopeV1),
        typeof(DynamicObservedElementV1), typeof(DynamicStableReferenceV1),
        typeof(DynamicPointV1), typeof(DynamicCurveLocationV1), typeof(DynamicBoxV1),
        typeof(DynamicTransformV1), typeof(DynamicParameterValueV1)
    };

    public static string ContractSurfaceHash => DynamicWire.Sha256(string.Join("\n", WireTypes
        .OrderBy(type => type.FullName, StringComparer.Ordinal).Select(Surface)));

    public static string ManifestHash => DynamicWire.Sha256(DynamicCanonical.Join(
        ManifestSchema, SelectorSchema, EnvelopeSchema, CursorSchema, CanonicalVersion,
        MaximumRequestBytes.ToString(CultureInfo.InvariantCulture),
        MaximumPageSize.ToString(CultureInfo.InvariantCulture),
        MaximumObservedElements.ToString(CultureInfo.InvariantCulture),
        MaximumElementSelectors.ToString(CultureInfo.InvariantCulture),
        MaximumCategorySelectors.ToString(CultureInfo.InvariantCulture),
        MaximumOwnerViewSelectors.ToString(CultureInfo.InvariantCulture),
        MaximumParameterSelectors.ToString(CultureInfo.InvariantCulture),
        MaximumParametersPerElement.ToString(CultureInfo.InvariantCulture), ContractSurfaceHash,
        "read-only", "strict-fields", "deterministic-paging", "typed-parameter-values",
        "role-independent-revit-element-unique-id-refs", "built-in-category-refs", "workset-id-refs"));

    private static string Surface(Type type) => type.FullName + "\n" + string.Join("\n", type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
        .Where(property => property.GetMethod != null).OrderBy(property => property.Name, StringComparer.Ordinal)
        .Select(property => property.Name + ":" + TypeName(property.PropertyType)));

    private static string TypeName(Type type)
    {
        var nullable = Nullable.GetUnderlyingType(type);
        if (nullable != null) return TypeName(nullable) + "?";
        if (type.IsArray) return TypeName(type.GetElementType()!) + "[]";
        if (!type.IsGenericType) return type.FullName ?? type.Name;
        var name = type.GetGenericTypeDefinition().FullName ?? type.Name;
        var tick = name.IndexOf('`');
        if (tick >= 0) name = name.Substring(0, tick);
        return name + "<" + string.Join(",", type.GetGenericArguments().Select(TypeName)) + ">";
    }
}

public sealed class DynamicObservationSelectorV1
{
    public string Schema { get; set; } = DynamicObservationContractV1.SelectorSchema;
    public string[] ElementUniqueIds { get; set; } = Array.Empty<string>();
    public string[] CategoryStableIds { get; set; } = Array.Empty<string>();
    public long[] OwnerViewElementIds { get; set; } = Array.Empty<long>();
    public long? VisibleInViewElementId { get; set; }
    public string[] ParameterNames { get; set; } = Array.Empty<string>();
    public bool IncludeTypeParameters { get; set; }
    public int PageSize { get; set; } = 128;
    public string? Cursor { get; set; }
}

public sealed class DynamicObservationEnvelopeV1
{
    public string Schema { get; set; } = DynamicObservationContractV1.EnvelopeSchema;
    public string ContractManifestHash { get; set; } = DynamicObservationContractV1.ManifestHash;
    public string DocumentFingerprint { get; set; } = "";
    public string DocumentSessionId { get; set; } = "";
    public string RevisionHash { get; set; } = "";
    public string ScopeHash { get; set; } = "";
    public int PageOffset { get; set; }
    public int PageSize { get; set; }
    public int TotalCount { get; set; }
    public IReadOnlyList<DynamicObservedElementV1> Elements { get; set; } = Array.Empty<DynamicObservedElementV1>();
    public string? NextCursor { get; set; }
    public string EnvelopeHash { get; set; } = "";
}

/// <summary>A stable reference. StableId is authoritative; display name and numeric id are descriptive.</summary>
public sealed class DynamicStableReferenceV1
{
    public string Kind { get; set; } = "";
    public string StableId { get; set; } = "";
    public string? UniqueId { get; set; }
    public long? ElementId { get; set; }
    public string? Name { get; set; }
}

public sealed class DynamicPointV1
{
    public double X { get; set; }
    public double Y { get; set; }
    public double Z { get; set; }
}

public sealed class DynamicCurveLocationV1
{
    public string CurveKind { get; set; } = "";
    public DynamicPointV1 Start { get; set; } = new();
    public DynamicPointV1 End { get; set; } = new();
}

public sealed class DynamicTransformV1
{
    public DynamicPointV1 Origin { get; set; } = new();
    public DynamicPointV1 BasisX { get; set; } = new();
    public DynamicPointV1 BasisY { get; set; } = new();
    public DynamicPointV1 BasisZ { get; set; } = new();
}

public sealed class DynamicBoxV1
{
    public DynamicPointV1 Min { get; set; } = new();
    public DynamicPointV1 Max { get; set; } = new();
    public DynamicTransformV1? Transform { get; set; }
}

public sealed class DynamicParameterValueV1
{
    public string Identity { get; set; } = "";
    public string Name { get; set; } = "";
    public string StorageKind { get; set; } = "none";
    public bool HasValue { get; set; }
    public string? RawString { get; set; }
    public long? RawInteger { get; set; }
    public double? RawDouble { get; set; }
    public long? RawElementId { get; set; }
    public string? FormattedValue { get; set; }
    public string? SpecTypeId { get; set; }
    public string? UnitTypeId { get; set; }
    public string Scope { get; set; } = "instance";
    public bool Writable { get; set; }
}

public sealed class DynamicObservedElementV1
{
    public DynamicStableReferenceV1 Element { get; set; } = new();
    public DynamicStableReferenceV1? Category { get; set; }
    public DynamicStableReferenceV1? Family { get; set; }
    public DynamicStableReferenceV1? Type { get; set; }
    public DynamicStableReferenceV1? Host { get; set; }
    public DynamicStableReferenceV1? OwnerView { get; set; }
    public DynamicStableReferenceV1? Level { get; set; }
    public DynamicStableReferenceV1? Workset { get; set; }
    public DynamicStableReferenceV1? CreatedPhase { get; set; }
    public DynamicStableReferenceV1? DemolishedPhase { get; set; }
    public DynamicPointV1? PointLocation { get; set; }
    public double? PointRotationRadians { get; set; }
    public DynamicCurveLocationV1? CurveLocation { get; set; }
    public DynamicBoxV1? BoundingBox { get; set; }
    public DynamicTransformV1? Transform { get; set; }
    public bool IsPinned { get; set; }
    public bool IsGrouped { get; set; }
    public string CoreStateHash { get; set; } = "";
    public IReadOnlyList<DynamicParameterValueV1> Parameters { get; set; } = Array.Empty<DynamicParameterValueV1>();
}

/// <summary>Validation, canonical hashing, and deterministic bounded paging for read-only observations.</summary>
public static class DynamicObservationPolicyV1
{
    private const int MaximumIdentifierLength = 256;
    private const int MaximumNameLength = 256;
    private const double MaximumCoordinateMagnitude = 1_000_000_000d;

    public static void ValidateSelector(DynamicObservationSelectorV1 selector)
    {
        if (selector == null || selector.Schema != DynamicObservationContractV1.SelectorSchema)
            throw new ArgumentException("Dynamic observation selector schema is invalid.");
        RequireDistinctStrings(selector.ElementUniqueIds, DynamicObservationContractV1.MaximumElementSelectors, MaximumIdentifierLength, "element selectors");
        RequireDistinctStrings(selector.CategoryStableIds, DynamicObservationContractV1.MaximumCategorySelectors, MaximumIdentifierLength, "category selectors");
        RequireDistinctLongs(selector.OwnerViewElementIds, DynamicObservationContractV1.MaximumOwnerViewSelectors, "owner-view selectors");
        if (selector.VisibleInViewElementId is < 0) throw new ArgumentException("Dynamic observation visible-view selector is invalid.");
        RequireDistinctStrings(selector.ParameterNames, DynamicObservationContractV1.MaximumParameterSelectors, MaximumNameLength, "parameter selectors");
        if (selector.PageSize < 1 || selector.PageSize > DynamicObservationContractV1.MaximumPageSize)
            throw new ArgumentException("Dynamic observation page size is outside the bounded contract.");
        if (selector.Cursor != null && (selector.Cursor.Length > 160 || !TryReadCursor(selector.Cursor, out _, out _)))
            throw new ArgumentException("Dynamic observation cursor is malformed.");
    }

    public static string ScopeHash(DynamicObservationSelectorV1 selector)
    {
        ValidateSelector(selector);
        return DynamicWire.Sha256(Canonical.Join(DynamicObservationContractV1.SelectorSchema,
            Canonical.Set(selector.ElementUniqueIds), Canonical.Set(selector.CategoryStableIds),
            Canonical.Set(selector.OwnerViewElementIds.Select(value => value.ToString(CultureInfo.InvariantCulture))),
            selector.VisibleInViewElementId?.ToString(CultureInfo.InvariantCulture),
            Canonical.Set(selector.ParameterNames), selector.IncludeTypeParameters ? "1" : "0",
            selector.PageSize.ToString(CultureInfo.InvariantCulture)));
    }

    public static DynamicObservationEnvelopeV1 BuildPage(
        DynamicObservationSelectorV1 selector,
        string documentFingerprint,
        string documentSessionId,
        IEnumerable<DynamicObservedElementV1> observedElements)
    {
        ValidateSelector(selector);
        RequireHash(documentFingerprint, "document fingerprint");
        RequireText(documentSessionId, MaximumIdentifierLength, "document session");
        if (observedElements == null) throw new ArgumentNullException(nameof(observedElements));
        var all = observedElements.Take(DynamicObservationContractV1.MaximumObservedElements + 1).ToArray();
        if (all.Length > DynamicObservationContractV1.MaximumObservedElements)
            throw new ArgumentException("Dynamic observation source exceeds the bounded element count.");
        foreach (var element in all) ValidateElement(element);
        var duplicateIds = all.GroupBy(element => element.Element.StableId, StringComparer.Ordinal).Where(group => group.Count() != 1).Select(group => group.Key).ToArray();
        if (duplicateIds.Length != 0) throw new ArgumentException("Dynamic observation element identities must be unique.");

        var elementIds = new HashSet<string>(selector.ElementUniqueIds, StringComparer.Ordinal);
        var categoryIds = new HashSet<string>(selector.CategoryStableIds, StringComparer.Ordinal);
        var ownerViewIds = new HashSet<long>(selector.OwnerViewElementIds);
        var selected = all.Where(element =>
                (elementIds.Count == 0 || element.Element.UniqueId != null && elementIds.Contains(element.Element.UniqueId)) &&
                (categoryIds.Count == 0 || element.Category != null && categoryIds.Contains(element.Category.StableId)) &&
                (ownerViewIds.Count == 0 || element.OwnerView?.ElementId is long id && ownerViewIds.Contains(id)))
            .OrderBy(element => element.Element.StableId, StringComparer.Ordinal).ToArray();
        var scopeHash = ScopeHash(selector);
        var revisionHash = RevisionHash(documentFingerprint, documentSessionId, selected);
        var offset = 0;
        if (selector.Cursor != null)
        {
            if (!TryReadCursor(selector.Cursor, out offset, out var cursorHash) ||
                !FixedEquals(cursorHash, CursorProof(scopeHash, revisionHash, offset)))
                throw new ArgumentException("Dynamic observation cursor does not match the current scope and revision.");
        }
        if (offset < 0 || offset > selected.Length || offset != 0 && offset % selector.PageSize != 0)
            throw new ArgumentException("Dynamic observation cursor offset is outside the current result set.");
        var page = selected.Skip(offset).Take(selector.PageSize).ToArray();
        var nextOffset = offset + page.Length;
        var next = nextOffset < selected.Length ? CreateCursor(scopeHash, revisionHash, nextOffset) : null;
        var envelope = new DynamicObservationEnvelopeV1
        {
            DocumentFingerprint = documentFingerprint,
            DocumentSessionId = documentSessionId,
            RevisionHash = revisionHash,
            ScopeHash = scopeHash,
            PageOffset = offset,
            PageSize = selector.PageSize,
            TotalCount = selected.Length,
            Elements = page,
            NextCursor = next
        };
        envelope.EnvelopeHash = EnvelopeHash(envelope);
        ValidateEnvelope(envelope);
        return envelope;
    }

    public static string RevisionHash(string documentFingerprint, string documentSessionId, IEnumerable<DynamicObservedElementV1> elements)
    {
        RequireHash(documentFingerprint, "document fingerprint");
        RequireText(documentSessionId, MaximumIdentifierLength, "document session");
        var array = (elements ?? throw new ArgumentNullException(nameof(elements))).OrderBy(value => value.Element.StableId, StringComparer.Ordinal).ToArray();
        if (array.Length > DynamicObservationContractV1.MaximumObservedElements) throw new ArgumentException("Dynamic observation revision is unbounded.");
        foreach (var element in array) ValidateElement(element);
        return DynamicWire.Sha256(Canonical.Join(DynamicObservationContractV1.CanonicalVersion,
            "revision", documentFingerprint, documentSessionId, Canonical.Join(array.Select(ElementCanonical).ToArray())));
    }

    public static string EnvelopeHash(DynamicObservationEnvelopeV1 envelope)
    {
        if (envelope == null) throw new ArgumentNullException(nameof(envelope));
        return DynamicWire.Sha256(Canonical.Join(DynamicObservationContractV1.CanonicalVersion, "envelope",
            envelope.Schema, envelope.ContractManifestHash, envelope.DocumentFingerprint, envelope.DocumentSessionId,
            envelope.RevisionHash, envelope.ScopeHash, envelope.PageOffset.ToString(CultureInfo.InvariantCulture),
            envelope.PageSize.ToString(CultureInfo.InvariantCulture), envelope.TotalCount.ToString(CultureInfo.InvariantCulture),
            Canonical.Join((envelope.Elements ?? Array.Empty<DynamicObservedElementV1>()).Select(ElementCanonical).ToArray()), envelope.NextCursor));
    }

    public static void ValidateEnvelope(DynamicObservationEnvelopeV1 envelope)
    {
        if (envelope == null || envelope.Schema != DynamicObservationContractV1.EnvelopeSchema ||
            !FixedEquals(envelope.ContractManifestHash, DynamicObservationContractV1.ManifestHash))
            throw new ArgumentException("Dynamic observation envelope contract identity is invalid.");
        RequireHash(envelope.DocumentFingerprint, "document fingerprint");
        RequireText(envelope.DocumentSessionId, MaximumIdentifierLength, "document session");
        RequireHash(envelope.RevisionHash, "revision");
        RequireHash(envelope.ScopeHash, "scope");
        if (envelope.PageSize < 1 || envelope.PageSize > DynamicObservationContractV1.MaximumPageSize ||
            envelope.PageOffset < 0 || envelope.TotalCount < 0 || envelope.TotalCount > DynamicObservationContractV1.MaximumObservedElements ||
            envelope.PageOffset > envelope.TotalCount || envelope.Elements == null || envelope.Elements.Count > envelope.PageSize ||
            envelope.PageOffset + envelope.Elements.Count > envelope.TotalCount)
            throw new ArgumentException("Dynamic observation envelope paging is invalid.");
        foreach (var element in envelope.Elements) ValidateElement(element);
        if (envelope.Elements.Select(value => value.Element.StableId).Distinct(StringComparer.Ordinal).Count() != envelope.Elements.Count)
            throw new ArgumentException("Dynamic observation page contains duplicate elements.");
        if (envelope.NextCursor != null && (!TryReadCursor(envelope.NextCursor, out var offset, out var proof) ||
            offset != envelope.PageOffset + envelope.Elements.Count || offset >= envelope.TotalCount ||
            !FixedEquals(proof, CursorProof(envelope.ScopeHash, envelope.RevisionHash, offset))))
            throw new ArgumentException("Dynamic observation next cursor is invalid.");
        if (!FixedEquals(envelope.EnvelopeHash, EnvelopeHash(envelope)))
            throw new ArgumentException("Dynamic observation envelope hash is invalid.");
    }

    public static string ElementCanonical(DynamicObservedElementV1 element)
    {
        ValidateElement(element);
        var parameters = (element.Parameters ?? Array.Empty<DynamicParameterValueV1>())
            .OrderBy(value => value.Scope, StringComparer.Ordinal).ThenBy(value => value.Identity, StringComparer.Ordinal).Select(ParameterCanonical).ToArray();
        return Canonical.Join(ReferenceCanonical(element.Element), ReferenceCanonical(element.Category), ReferenceCanonical(element.Family),
            ReferenceCanonical(element.Type), ReferenceCanonical(element.Host), ReferenceCanonical(element.OwnerView), ReferenceCanonical(element.Level),
            ReferenceCanonical(element.Workset), ReferenceCanonical(element.CreatedPhase), ReferenceCanonical(element.DemolishedPhase),
            PointCanonical(element.PointLocation), DoubleCanonical(element.PointRotationRadians), CurveCanonical(element.CurveLocation),
            BoxCanonical(element.BoundingBox), TransformCanonical(element.Transform), element.IsPinned ? "1" : "0", element.IsGrouped ? "1" : "0",
            element.CoreStateHash, Canonical.Join(parameters));
    }

    public static void ValidateElement(DynamicObservedElementV1 element)
    {
        if (element == null) throw new ArgumentException("Dynamic observed element is missing.");
        ValidateReference(element.Element, "element", true);
        ValidateReference(element.Category, "category", false);
        ValidateReference(element.Family, "family", false);
        ValidateReference(element.Type, "type", false);
        ValidateReference(element.Host, "host", false);
        ValidateReference(element.OwnerView, "owner_view", false);
        ValidateReference(element.Level, "level", false);
        ValidateReference(element.Workset, "workset", false);
        ValidateReference(element.CreatedPhase, "phase", false);
        ValidateReference(element.DemolishedPhase, "phase", false);
        RequireHash(element.CoreStateHash, "core state hash");
        ValidatePoint(element.PointLocation);
        if (element.PointRotationRadians.HasValue && !Finite(element.PointRotationRadians.Value)) throw new ArgumentException("Dynamic point rotation must be finite.");
        if (element.CurveLocation != null)
        {
            RequireText(element.CurveLocation.CurveKind, 64, "curve kind");
            ValidatePoint(element.CurveLocation.Start, true); ValidatePoint(element.CurveLocation.End, true);
        }
        if (element.PointLocation != null && element.CurveLocation != null) throw new ArgumentException("Dynamic element location must be either point or curve.");
        ValidateBox(element.BoundingBox); ValidateTransform(element.Transform);
        if (element.Parameters == null || element.Parameters.Count > DynamicObservationContractV1.MaximumParametersPerElement)
            throw new ArgumentException("Dynamic observed parameters are outside the bounded contract.");
        foreach (var parameter in element.Parameters) ValidateParameter(parameter);
        if (element.Parameters.GroupBy(value => value.Scope + "\n" + value.Identity, StringComparer.Ordinal).Any(group => group.Count() != 1))
            throw new ArgumentException("Dynamic observed parameter identities must be unique within their scope.");
    }

    private static string CreateCursor(string scopeHash, string revisionHash, int offset)
        => DynamicObservationContractV1.CursorSchema + ":" + offset.ToString(CultureInfo.InvariantCulture) + ":" + CursorProof(scopeHash, revisionHash, offset);

    private static string CursorProof(string scopeHash, string revisionHash, int offset)
        => DynamicWire.Sha256(Canonical.Join(DynamicObservationContractV1.CursorSchema, scopeHash, revisionHash, offset.ToString(CultureInfo.InvariantCulture)));

    private static bool TryReadCursor(string cursor, out int offset, out string proof)
    {
        offset = -1; proof = "";
        var prefix = DynamicObservationContractV1.CursorSchema + ":";
        if (cursor == null || !cursor.StartsWith(prefix, StringComparison.Ordinal)) return false;
        var separator = cursor.IndexOf(':', prefix.Length);
        if (separator < 0 || !int.TryParse(cursor.Substring(prefix.Length, separator - prefix.Length), NumberStyles.None, CultureInfo.InvariantCulture, out offset)) return false;
        proof = cursor.Substring(separator + 1);
        return offset >= 0 && Hash(proof);
    }

    private static void ValidateReference(DynamicStableReferenceV1? value, string expectedKind, bool required)
    {
        if (value == null) { if (required) throw new ArgumentException("Dynamic stable reference is required."); return; }
        if (value.Kind != expectedKind || !Text(value.StableId, MaximumIdentifierLength) ||
            value.UniqueId != null && !Text(value.UniqueId, MaximumIdentifierLength) ||
            value.Name != null && !OptionalText(value.Name, MaximumNameLength) ||
            expectedKind != "category" && value.ElementId.HasValue && value.ElementId.Value < -1)
            throw new ArgumentException("Dynamic " + expectedKind + " reference is invalid.");
        if (expectedKind == "category")
        {
            if (!value.ElementId.HasValue || value.UniqueId != null ||
                !value.StableId.StartsWith("category:builtin:", StringComparison.Ordinal) && !value.StableId.StartsWith("category:element:", StringComparison.Ordinal))
                throw new ArgumentException("Dynamic category reference requires a built-in or document category identity.");
        }
        else if (expectedKind == "workset")
        {
            if (!value.ElementId.HasValue || value.ElementId.Value < 0 || value.UniqueId != null ||
                value.StableId != "workset:" + value.ElementId.Value.ToString(CultureInfo.InvariantCulture))
                throw new ArgumentException("Dynamic workset reference requires a stable workset identity.");
        }
        else if (value.UniqueId == null || !value.ElementId.HasValue || value.StableId != "revit-element:" + value.UniqueId)
        {
            throw new ArgumentException("Dynamic Revit element reference requires role-independent unique and numeric identities.");
        }
    }

    private static void ValidateParameter(DynamicParameterValueV1 parameter)
    {
        if (parameter == null || !Text(parameter.Identity, MaximumIdentifierLength) || !Text(parameter.Name, MaximumNameLength) ||
            parameter.Scope != "instance" && parameter.Scope != "type" ||
            parameter.FormattedValue != null && !OptionalText(parameter.FormattedValue, 1024) ||
            parameter.SpecTypeId != null && !Text(parameter.SpecTypeId, MaximumIdentifierLength) ||
            parameter.UnitTypeId != null && !Text(parameter.UnitTypeId, MaximumIdentifierLength))
            throw new ArgumentException("Dynamic parameter metadata is invalid.");
        var kinds = new[] { "none", "string", "integer", "double", "element_id" };
        if (!kinds.Contains(parameter.StorageKind, StringComparer.Ordinal)) throw new ArgumentException("Dynamic parameter storage kind is invalid.");
        if (parameter.RawString != null && parameter.RawString.Length > 4096) throw new ArgumentException("Dynamic parameter string is unbounded.");
        if (parameter.RawDouble.HasValue && !Finite(parameter.RawDouble.Value)) throw new ArgumentException("Dynamic parameter double is not finite.");
        if (!parameter.HasValue && (parameter.RawString != null || parameter.RawInteger.HasValue || parameter.RawDouble.HasValue || parameter.RawElementId.HasValue))
            throw new ArgumentException("Dynamic empty parameter may not carry a raw value.");
        if (parameter.HasValue)
        {
            var valid = parameter.StorageKind == "string" && parameter.RawString != null && !parameter.RawInteger.HasValue && !parameter.RawDouble.HasValue && !parameter.RawElementId.HasValue ||
                        parameter.StorageKind == "integer" && parameter.RawInteger.HasValue && parameter.RawString == null && !parameter.RawDouble.HasValue && !parameter.RawElementId.HasValue ||
                        parameter.StorageKind == "double" && parameter.RawDouble.HasValue && parameter.RawString == null && !parameter.RawInteger.HasValue && !parameter.RawElementId.HasValue ||
                        parameter.StorageKind == "element_id" && parameter.RawElementId.HasValue && parameter.RawString == null && !parameter.RawInteger.HasValue && !parameter.RawDouble.HasValue;
            if (!valid) throw new ArgumentException("Dynamic parameter raw value does not match its storage kind.");
        }
    }

    private static string ParameterCanonical(DynamicParameterValueV1 value) => Canonical.Join(value.Identity, value.Name, value.StorageKind,
        value.HasValue ? "1" : "0", value.RawString, value.RawInteger?.ToString(CultureInfo.InvariantCulture), DoubleCanonical(value.RawDouble),
        value.RawElementId?.ToString(CultureInfo.InvariantCulture), value.FormattedValue, value.SpecTypeId, value.UnitTypeId, value.Scope, value.Writable ? "1" : "0");

    private static string ReferenceCanonical(DynamicStableReferenceV1? value) => value == null ? Canonical.Join((string?)null) : Canonical.Join(
        value.Kind, value.StableId, value.UniqueId, value.ElementId?.ToString(CultureInfo.InvariantCulture), value.Name);

    private static string PointCanonical(DynamicPointV1? value) => value == null ? Canonical.Join((string?)null) : Canonical.Join(
        DoubleCanonical(value.X), DoubleCanonical(value.Y), DoubleCanonical(value.Z));

    private static string CurveCanonical(DynamicCurveLocationV1? value) => value == null ? Canonical.Join((string?)null) : Canonical.Join(
        value.CurveKind, PointCanonical(value.Start), PointCanonical(value.End));

    private static string TransformCanonical(DynamicTransformV1? value) => value == null ? Canonical.Join((string?)null) : Canonical.Join(
        PointCanonical(value.Origin), PointCanonical(value.BasisX), PointCanonical(value.BasisY), PointCanonical(value.BasisZ));

    private static string BoxCanonical(DynamicBoxV1? value) => value == null ? Canonical.Join((string?)null) : Canonical.Join(
        PointCanonical(value.Min), PointCanonical(value.Max), TransformCanonical(value.Transform));

    // Observation DTOs cross the Revit net48 -> supervisor/worker net8 JSON boundary. Raw
    // IEEE-754 bits are not a stable wire canonical there: the two System.Text.Json runtime
    // implementations can choose different, equally valid round-trip decimal spellings and
    // recover adjacent binary values. Thirteen significant digits retain substantially more
    // precision than Revit needs while making the signed observation identity transport-stable.
    private static string? DoubleCanonical(double? value)
    {
        if (!value.HasValue) return null;
        var text = value.Value.ToString("G13", CultureInfo.InvariantCulture);
        if (text == "-0") return "0";
        var exponentIndex = text.IndexOfAny(new[] { 'e', 'E' });
        if (exponentIndex < 0) return text;
        var exponent = int.Parse(text.Substring(exponentIndex + 1), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        return text.Substring(0, exponentIndex) + "e" + exponent.ToString(CultureInfo.InvariantCulture);
    }

    private static void ValidatePoint(DynamicPointV1? point, bool required = false)
    {
        if (point == null) { if (required) throw new ArgumentException("Dynamic point is required."); return; }
        if (!Finite(point.X) || !Finite(point.Y) || !Finite(point.Z) || Math.Abs(point.X) > MaximumCoordinateMagnitude || Math.Abs(point.Y) > MaximumCoordinateMagnitude || Math.Abs(point.Z) > MaximumCoordinateMagnitude)
            throw new ArgumentException("Dynamic point is invalid.");
    }

    private static void ValidateBox(DynamicBoxV1? box)
    {
        if (box == null) return;
        ValidatePoint(box.Min, true); ValidatePoint(box.Max, true); ValidateTransform(box.Transform);
        if (box.Min.X > box.Max.X || box.Min.Y > box.Max.Y || box.Min.Z > box.Max.Z) throw new ArgumentException("Dynamic bounding box is invalid.");
    }

    private static void ValidateTransform(DynamicTransformV1? value)
    {
        if (value == null) return;
        ValidatePoint(value.Origin, true); ValidatePoint(value.BasisX, true); ValidatePoint(value.BasisY, true); ValidatePoint(value.BasisZ, true);
    }

    private static void RequireDistinctStrings(IEnumerable<string>? values, int maximumCount, int maximumLength, string label)
    {
        if (values == null) throw new ArgumentException("Dynamic " + label + " are missing.");
        var array = values.ToArray();
        if (array.Length > maximumCount || array.Any(value => !Text(value, maximumLength)) || array.Distinct(StringComparer.Ordinal).Count() != array.Length)
            throw new ArgumentException("Dynamic " + label + " are invalid.");
    }

    private static void RequireDistinctLongs(IEnumerable<long>? values, int maximumCount, string label)
    {
        if (values == null) throw new ArgumentException("Dynamic " + label + " are missing.");
        var array = values.ToArray();
        if (array.Length > maximumCount || array.Any(value => value < 0) || array.Distinct().Count() != array.Length)
            throw new ArgumentException("Dynamic " + label + " are invalid.");
    }

    private static void RequireHash(string? value, string label) { if (!Hash(value)) throw new ArgumentException("Dynamic observation " + label + " is invalid."); }
    private static bool Hash(string? value) => value != null && value.Length == 71 && value.StartsWith("sha256:", StringComparison.Ordinal) && value.Substring(7).All(character => character >= '0' && character <= '9' || character >= 'a' && character <= 'f');
    private static void RequireText(string? value, int maximumLength, string label) { if (!Text(value, maximumLength)) throw new ArgumentException("Dynamic observation " + label + " is invalid."); }
    private static bool Text(string? value, int maximumLength) => !string.IsNullOrWhiteSpace(value) && value!.Length <= maximumLength && value.All(character => character >= 0x20 && character != 0x7f && character != '\r' && character != '\n');
    private static bool OptionalText(string value, int maximumLength) => value.Length <= maximumLength && value.All(character => character >= 0x20 && character != 0x7f && character != '\r' && character != '\n');
    private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    private static bool FixedEquals(string? left, string? right) => string.Equals(left, right, StringComparison.Ordinal);

    private static class Canonical
    {
        internal static string Join(params string?[] values)
        {
            var builder = new StringBuilder();
            foreach (var value in values)
            {
                if (value == null) builder.Append("-\n");
                else builder.Append('+').Append(Convert.ToBase64String(Encoding.UTF8.GetBytes(value))).Append('\n');
            }
            return builder.ToString();
        }

        internal static string Set(IEnumerable<string>? values) => Join((values ?? Array.Empty<string>()).OrderBy(value => value, StringComparer.Ordinal).ToArray());
    }
}
