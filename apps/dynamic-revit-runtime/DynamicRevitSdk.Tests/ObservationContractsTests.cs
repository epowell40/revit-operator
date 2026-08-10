using System.Text.Json;
using RevitBridge.Logic.Handlers.DynamicRuntime;
using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class ObservationContractsTests
{
    private const string DocumentFingerprint = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string SessionId = "session-0441";
    private static readonly JsonSerializerOptions CamelJson = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    [Fact]
    public void Canonical_hashes_match_exact_golden_vectors()
    {
        var selector = Selector(pageSize: 2);
        var envelope = DynamicObservationPolicyV1.BuildPage(selector, DocumentFingerprint, SessionId,
            new[] { Element("z-element", 30, 12.5), Element("a-element", 10, 4.25), Element("m-element", 20, 8.75) });

        Assert.Equal("sha256:50e3d2505fc8dcd680e929714487e4c91eb59be47d2a32124372db35ecd15c5c", DynamicObservationContractV1.ManifestHash);
        Assert.Equal("sha256:5250896bc15318bdf5e586517643ad3ec315c2c3a4c550f1f1f12b2807c2ef36", envelope.ScopeHash);
        Assert.Equal("sha256:abbaa8e713b0277cc4639b1fb8be62366ebaed29c5b47094add433e6fd25320a", envelope.RevisionHash);
        Assert.Equal("sha256:21a5c4b95591e5672cb66158ec04e28bb2f768385743feb79a0d6c2841aa5e04", envelope.EnvelopeHash);
        Assert.Equal(new[] { "revit-element:a-element", "revit-element:m-element" }, envelope.Elements.Select(value => value.Element.StableId));
        Assert.NotNull(envelope.NextCursor);
    }

    [Theory]
    [InlineData(64.50565087321395, 64.50565087321394)]
    [InlineData(-7.83333333333325, -7.833333333333249)]
    [InlineData(0.0001234567890123456, 0.0001234567890123457)]
    [InlineData(123456789.01234567, 123456789.01234566)]
    public void Observation_canonical_is_stable_across_net48_json_transport_precision(double hostValue, double transportedValue)
    {
        var host = Element("transport-element", 42, hostValue);
        var transported = Element("transport-element", 42, transportedValue);
        transported.CoreStateHash = host.CoreStateHash;

        Assert.NotEqual(BitConverter.DoubleToInt64Bits(hostValue), BitConverter.DoubleToInt64Bits(transportedValue));
        Assert.Equal(DynamicObservationPolicyV1.ElementCanonical(host), DynamicObservationPolicyV1.ElementCanonical(transported));
    }

    [Fact]
    public void Checked_in_source_manifest_is_bound_to_the_contract_identity()
    {
        var path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "manifests", "dynamic-revit-observations-core.v1.json"));
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        Assert.Equal(DynamicObservationContractV1.ManifestSchema, document.RootElement.GetProperty("schema").GetString());
        Assert.Equal(DynamicObservationContractV1.ManifestHash, document.RootElement.GetProperty("contractManifestHash").GetString());
        Assert.True(document.RootElement.GetProperty("readOnly").GetBoolean());
        Assert.True(document.RootElement.GetProperty("activeViewCandidateHydration").GetBoolean());
        Assert.True(document.RootElement.GetProperty("hostExactCoreStateHash").GetBoolean());
        var expectedSdkIdentity = DynamicWire.Sha256(DynamicRevitSdkVersion.Value + "\n" + DynamicRevitSdkVersion.GraphSchema +
            "\nDynamicTaskInput\nDynamicElementDto\nMoveElement\nSetParameter\nBoundedStructuredReport\nDynamicWorkerAdmission\nCanonicalInputHashV1\nNoSystemTextJsonDependencyV1\nAuthenticatedLauncherSessionV1\n" + DynamicObservationContractV1.ManifestHash + "\n" + DynamicBuildingSystemsObservationContractV1.ManifestHash + "\n" + DynamicCoreOperationManifestV1.ManifestHash + "\n" + DynamicResultReferenceManifestV1.ManifestHash + "\n" + DynamicAnnotationOperationManifestV1.ManifestHash + "\n" + DynamicMepMutationManifestV1.ManifestHash);
        Assert.Equal(expectedSdkIdentity, DynamicRevitSdkVersion.ManifestHash);
    }

    [Fact]
    public void Paging_is_deterministic_bounded_and_revision_bound()
    {
        var elements = new[] { Element("z-element", 30, 12.5), Element("a-element", 10, 4.25), Element("m-element", 20, 8.75) };
        var first = DynamicObservationPolicyV1.BuildPage(Selector(2), DocumentFingerprint, SessionId, elements);
        var repeated = DynamicObservationPolicyV1.BuildPage(Selector(2), DocumentFingerprint, SessionId, elements.Reverse());
        Assert.Equal(first.EnvelopeHash, repeated.EnvelopeHash);
        Assert.Equal(first.NextCursor, repeated.NextCursor);

        var nextSelector = Selector(2); nextSelector.Cursor = first.NextCursor;
        var second = DynamicObservationPolicyV1.BuildPage(nextSelector, DocumentFingerprint, SessionId, elements);
        Assert.Equal(2, second.PageOffset);
        Assert.Single(second.Elements);
        Assert.Equal("revit-element:z-element", second.Elements[0].Element.StableId);
        Assert.Null(second.NextCursor);

        var mutated = elements.Select(value => value.Element.UniqueId == "m-element" ? Element("m-element", 20, 9.0) : value).ToArray();
        Assert.Throws<ArgumentException>(() => DynamicObservationPolicyV1.BuildPage(nextSelector, DocumentFingerprint, SessionId, mutated));
    }

    [Fact]
    public void Selector_scope_is_order_independent_but_bound_to_page_and_flags()
    {
        var left = Selector(64);
        left.ElementUniqueIds = new[] { "b", "a" };
        left.ParameterNames = new[] { "Comments", "Mark" };
        var right = Selector(64);
        right.ElementUniqueIds = new[] { "a", "b" };
        right.ParameterNames = new[] { "Mark", "Comments" };
        Assert.Equal(DynamicObservationPolicyV1.ScopeHash(left), DynamicObservationPolicyV1.ScopeHash(right));

        right.IncludeTypeParameters = true;
        Assert.NotEqual(DynamicObservationPolicyV1.ScopeHash(left), DynamicObservationPolicyV1.ScopeHash(right));
        right.IncludeTypeParameters = false; right.PageSize = 63;
        Assert.NotEqual(DynamicObservationPolicyV1.ScopeHash(left), DynamicObservationPolicyV1.ScopeHash(right));
        right.PageSize = 64; right.VisibleInViewElementId = 200;
        Assert.NotEqual(DynamicObservationPolicyV1.ScopeHash(left), DynamicObservationPolicyV1.ScopeHash(right));
    }

    [Theory]
    [InlineData("{\"schema\":\"dynamic-revit-observation-selector/v1\",\"extra\":true}")]
    [InlineData("{\"Schema\":\"dynamic-revit-observation-selector/v1\"}")]
    [InlineData("{\"schema\":\"dynamic-revit-observation-selector/v1\",\"schema\":\"dynamic-revit-observation-selector/v1\"}")]
    [InlineData("{\"schema\":\"dynamic-revit-observation-selector/v1\",\"pageSize\":257}")]
    [InlineData("{\"schema\":\"dynamic-revit-observation-selector/v1\",\"elementUniqueIds\":[\"same\",\"same\"]}")]
    [InlineData("{\"schema\":\"dynamic-revit-observation-selector/v1\",\"ownerViewElementIds\":[-1]}")]
    public void Strict_selector_wire_rejects_unknown_duplicate_case_mismatch_and_bounds(string json)
    {
        Assert.ThrowsAny<Exception>(() => DynamicObservationSelectorWireV1.Parse(json));
    }

    [Fact]
    public void Strict_wire_accepts_exact_selector_and_rejects_oversize_input()
    {
        var parsed = DynamicObservationSelectorWireV1.Parse("{\"schema\":\"dynamic-revit-observation-selector/v1\",\"parameterNames\":[\"Mark\"],\"includeTypeParameters\":true,\"pageSize\":16}");
        Assert.Equal(16, parsed.PageSize);
        Assert.True(parsed.IncludeTypeParameters);
        Assert.Equal(new[] { "Mark" }, parsed.ParameterNames);

        var oversize = "{\"schema\":\"dynamic-revit-observation-selector/v1\",\"cursor\":\"" + new string('x', DynamicObservationContractV1.MaximumRequestBytes) + "\"}";
        Assert.Throws<ArgumentException>(() => DynamicObservationSelectorWireV1.Parse(oversize));
    }

    [Fact]
    public void Envelope_wire_rejects_extra_nested_fields_and_tampered_hash()
    {
        var envelope = DynamicObservationPolicyV1.BuildPage(Selector(2), DocumentFingerprint, SessionId, new[] { Element("a", 1, 1.0) });
        var json = JsonSerializer.Serialize(envelope, CamelJson);
        Assert.Equal(envelope.EnvelopeHash, DynamicObservationSelectorWireV1.ParseEnvelope(json).EnvelopeHash);

        var extra = json.Substring(0, json.Length - 1) + ",\"authority\":true}";
        Assert.ThrowsAny<Exception>(() => DynamicObservationSelectorWireV1.ParseEnvelope(extra));
        var nestedExtra = json.Replace("\"kind\":\"element\"", "\"kind\":\"element\",\"authority\":true", StringComparison.Ordinal);
        Assert.ThrowsAny<Exception>(() => DynamicObservationSelectorWireV1.ParseEnvelope(nestedExtra));
        var nestedDuplicate = json.Replace("\"kind\":\"element\"", "\"kind\":\"element\",\"kind\":\"element\"", StringComparison.Ordinal);
        Assert.ThrowsAny<Exception>(() => DynamicObservationSelectorWireV1.ParseEnvelope(nestedDuplicate));
        envelope.TotalCount++;
        Assert.Throws<ArgumentException>(() => DynamicObservationPolicyV1.ValidateEnvelope(envelope));
    }

    [Fact]
    public void Typed_parameter_shape_and_finite_geometry_are_strict()
    {
        var element = Element("typed", 1, 3.5);
        element.Parameters = new[]
        {
            new DynamicParameterValueV1 { Identity = "parameter:builtin:-1001203", Name = "Mark", StorageKind = "string", HasValue = true, RawString = "A-1", FormattedValue = "A-1", Scope = "instance", Writable = true },
            new DynamicParameterValueV1 { Identity = "parameter:builtin:-1001301", Name = "Length", StorageKind = "double", HasValue = true, RawDouble = 3.5, FormattedValue = "3' 6\"", SpecTypeId = "autodesk.spec.aec:length-2.0.0", UnitTypeId = "autodesk.unit.unit:feet-1.0.1", Scope = "type" }
        };
        DynamicObservationPolicyV1.ValidateElement(element);

        element.Parameters = new[] { new DynamicParameterValueV1 { Identity = "bad", Name = "Bad", StorageKind = "double", HasValue = true, RawString = "3.5", Scope = "instance" } };
        Assert.Throws<ArgumentException>(() => DynamicObservationPolicyV1.ValidateElement(element));
        element.Parameters = Array.Empty<DynamicParameterValueV1>(); element.PointLocation = new DynamicPointV1 { X = double.NaN };
        Assert.Throws<ArgumentException>(() => DynamicObservationPolicyV1.ValidateElement(element));
    }

    [Fact]
    public void Source_and_selector_bounds_fail_closed()
    {
        var selector = Selector(32);
        selector.ParameterNames = Enumerable.Range(0, DynamicObservationContractV1.MaximumParameterSelectors + 1).Select(index => "p" + index).ToArray();
        Assert.Throws<ArgumentException>(() => DynamicObservationPolicyV1.ValidateSelector(selector));

        var unbounded = Enumerable.Range(0, DynamicObservationContractV1.MaximumObservedElements + 1).Select(index => Element("e" + index, index, index)).ToArray();
        Assert.Throws<ArgumentException>(() => DynamicObservationPolicyV1.BuildPage(Selector(32), DocumentFingerprint, SessionId, unbounded));
    }

    private static DynamicObservationSelectorV1 Selector(int pageSize) => new()
    {
        CategoryStableIds = new[] { "category:builtin:OST_Walls" },
        ParameterNames = new[] { "Mark" },
        IncludeTypeParameters = false,
        PageSize = pageSize
    };

    private static DynamicObservedElementV1 Element(string uniqueId, long id, double x) => new()
    {
        Element = new DynamicStableReferenceV1 { Kind = "element", StableId = "revit-element:" + uniqueId, UniqueId = uniqueId, ElementId = id, Name = "Element " + id },
        Category = new DynamicStableReferenceV1 { Kind = "category", StableId = "category:builtin:OST_Walls", ElementId = -2000011, Name = "Walls" },
        Family = new DynamicStableReferenceV1 { Kind = "family", StableId = "revit-element:fam-1", UniqueId = "fam-1", ElementId = 100, Name = "Basic Wall" },
        Type = new DynamicStableReferenceV1 { Kind = "type", StableId = "revit-element:type-1", UniqueId = "type-1", ElementId = 101, Name = "Generic - 8\"" },
        OwnerView = new DynamicStableReferenceV1 { Kind = "owner_view", StableId = "revit-element:view-1", UniqueId = "view-1", ElementId = 200, Name = "Level 1" },
        Level = new DynamicStableReferenceV1 { Kind = "level", StableId = "revit-element:level-1", UniqueId = "level-1", ElementId = 300, Name = "Level 1" },
        Workset = new DynamicStableReferenceV1 { Kind = "workset", StableId = "workset:1", ElementId = 1, Name = "Workset1" },
        CreatedPhase = new DynamicStableReferenceV1 { Kind = "phase", StableId = "revit-element:phase-1", UniqueId = "phase-1", ElementId = 400, Name = "New Construction" },
        PointLocation = new DynamicPointV1 { X = x, Y = 2, Z = 0 },
        PointRotationRadians = 0,
        BoundingBox = new DynamicBoxV1
        {
            Min = new DynamicPointV1 { X = x - 0.5, Y = 1.5, Z = 0 },
            Max = new DynamicPointV1 { X = x + 0.5, Y = 2.5, Z = 8 },
            Transform = IdentityTransform()
        },
        Transform = IdentityTransform(),
        CoreStateHash = DynamicWire.Sha256("core-state-" + uniqueId + "-" + x.ToString(System.Globalization.CultureInfo.InvariantCulture)),
        Parameters = new[] { new DynamicParameterValueV1 { Identity = "parameter:builtin:-1001203", Name = "Mark", StorageKind = "string", HasValue = true, RawString = "M-" + id, FormattedValue = "M-" + id, Scope = "instance", Writable = true } }
    };

    private static DynamicTransformV1 IdentityTransform() => new()
    {
        Origin = new DynamicPointV1(), BasisX = new DynamicPointV1 { X = 1 }, BasisY = new DynamicPointV1 { Y = 1 }, BasisZ = new DynamicPointV1 { Z = 1 }
    };
}
