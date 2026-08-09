using System.Text.Json;
using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class BuildingSystemsObservationTests
{
    private static readonly string Fingerprint = H("document");
    private static readonly string Snapshot = H("snapshot");

    [Fact]
    public void ManifestAndSdkIdentityBindTheExactAdditiveSurface()
    {
        var path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "manifests", "dynamic-revit-building-systems-observations.v1.json"));
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        var root = document.RootElement;
        Assert.Equal(DynamicBuildingSystemsObservationContractV1.ManifestSchema, root.GetProperty("schema").GetString());
        Assert.Equal(DynamicBuildingSystemsObservationContractV1.ManifestHash, root.GetProperty("contractManifestHash").GetString());
        Assert.Equal(DynamicBuildingSystemsObservationContractV1.ContractSurfaceHash, root.GetProperty("contractSurfaceHash").GetString());
        Assert.False(root.GetProperty("productionExposed").GetBoolean());
        var expectedSdk = DynamicWire.Sha256(DynamicRevitSdkVersion.Value + "\n" + DynamicRevitSdkVersion.GraphSchema +
            "\nDynamicTaskInput\nDynamicElementDto\nMoveElement\nSetParameter\nBoundedStructuredReport\nDynamicWorkerAdmission\nCanonicalInputHashV1\nNoSystemTextJsonDependencyV1\nAuthenticatedLauncherSessionV1\n" +
            DynamicObservationContractV1.ManifestHash + "\n" + DynamicBuildingSystemsObservationContractV1.ManifestHash + "\n" + DynamicCoreOperationManifestV1.ManifestHash + "\n" + DynamicResultReferenceManifestV1.ManifestHash + "\n" + DynamicAnnotationOperationManifestV1.ManifestHash + "\n" + DynamicMepMutationManifestV1.ManifestHash);
        Assert.Equal(expectedSdk, DynamicRevitSdkVersion.ManifestHash);
    }

    [Fact]
    public void SnapshotPagingRejectsStaleScopeRevisionAndSnapshot()
    {
        var selector = Selector(1); var facts = new[] { CurveFact("a"), CurveFact("b") };
        var first = DynamicBuildingSystemsObservationPolicyV1.BuildPage(selector, Fingerprint, "session", 7, Snapshot, facts);
        Assert.NotNull(first.NextCursor); Assert.Single(first.Facts);

        var next = Selector(1); next.Cursor = first.NextCursor;
        var second = DynamicBuildingSystemsObservationPolicyV1.BuildPage(next, Fingerprint, "session", 7, Snapshot, facts.Reverse());
        Assert.Equal("b", second.Facts[0].Element.UniqueId);

        var changed = new[] { CurveFact("a"), CurveFact("b") }; changed[1].Curve!.WidthFeet = 9;
        Assert.Throws<ArgumentException>(() => DynamicBuildingSystemsObservationPolicyV1.BuildPage(next, Fingerprint, "session", 7, Snapshot, changed));
        var changedScope = Selector(1); changedScope.Cursor = first.NextCursor; changedScope.Kinds = new[] { "mep_curve" };
        Assert.Throws<ArgumentException>(() => DynamicBuildingSystemsObservationPolicyV1.BuildPage(changedScope, Fingerprint, "session", 7, Snapshot, facts));
        Assert.Throws<ArgumentException>(() => DynamicBuildingSystemsObservationPolicyV1.BuildPage(next, Fingerprint, "session", 8, H("other-snapshot"), facts));
    }

    [Fact]
    public void ConnectorIdentitiesBindSnapshotAndTopologyAndExposeNoRevitHandle()
    {
        var left = CurveFact("a"); var baseline = DynamicBuildingSystemsObservationPolicyV1.RevisionHash(Fingerprint, "session", 7, Snapshot, new[] { left });
        left.Connectors[0].ConnectedCounterpartIds = new[] { DynamicBuildingSystemsObservationPolicyV1.ConnectorStableId(Snapshot, "owner-c", "7") };
        var topologyChanged = DynamicBuildingSystemsObservationPolicyV1.RevisionHash(Fingerprint, "session", 7, Snapshot, new[] { left });
        Assert.NotEqual(baseline, topologyChanged);
        Assert.NotEqual(DynamicBuildingSystemsObservationPolicyV1.ConnectorStableId(Snapshot, "owner-a", "1"),
            DynamicBuildingSystemsObservationPolicyV1.ConnectorStableId(H("next-snapshot"), "owner-a", "1"));
        Assert.DoesNotContain(typeof(DynamicBuildingConnectorV1).GetProperties(), property => property.Name.Contains("Handle", StringComparison.OrdinalIgnoreCase) || property.Name == "ConnectorId");
    }

    [Fact]
    public void MalformedFramesFactsAndBoundsFailClosed()
    {
        var fact = CurveFact("a"); fact.Connectors[0].BasisY = Point(1, 0, 0);
        Assert.Throws<ArgumentException>(() => DynamicBuildingSystemsObservationPolicyV1.ValidateFact(fact, Snapshot));

        fact = CurveFact("a"); fact.Connectors[0].StableWithinSnapshotId = DynamicBuildingSystemsObservationPolicyV1.ConnectorStableId(H("wrong"), "owner-a", "1");
        Assert.Throws<ArgumentException>(() => DynamicBuildingSystemsObservationPolicyV1.ValidateFact(fact, Snapshot));

        fact = CurveFact("a"); fact.Asset = new DynamicBuildingAssetFactV1();
        Assert.Throws<ArgumentException>(() => DynamicBuildingSystemsObservationPolicyV1.ValidateFact(fact, Snapshot));

        var selector = Selector(DynamicBuildingSystemsObservationContractV1.MaximumPageSize + 1);
        Assert.Throws<ArgumentException>(() => DynamicBuildingSystemsObservationPolicyV1.ValidateSelector(selector));
        var unbounded = Enumerable.Range(0, DynamicBuildingSystemsObservationContractV1.MaximumObservedFacts + 1).Select(index => SystemFact("s" + index)).ToArray();
        Assert.Throws<ArgumentException>(() => DynamicBuildingSystemsObservationPolicyV1.BuildPage(Selector(64), Fingerprint, "session", 1, Snapshot, unbounded));
    }

    [Fact]
    public void EnvelopePagingAndCurveSystemSetsAreCanonical()
    {
        var facts = new[] { CurveFact("b"), CurveFact("a") };
        var page = DynamicBuildingSystemsObservationPolicyV1.BuildPage(Selector(1), Fingerprint, "session", 1, Snapshot, facts);

        page.NextCursor = null;
        page.EnvelopeHash = DynamicBuildingSystemsObservationPolicyV1.EnvelopeHash(page);
        Assert.Throws<ArgumentException>(() => DynamicBuildingSystemsObservationPolicyV1.ValidateEnvelope(page));

        page = DynamicBuildingSystemsObservationPolicyV1.BuildPage(Selector(2), Fingerprint, "session", 1, Snapshot, facts);
        page.Facts = page.Facts.Reverse().ToArray();
        page.EnvelopeHash = DynamicBuildingSystemsObservationPolicyV1.EnvelopeHash(page);
        Assert.Throws<ArgumentException>(() => DynamicBuildingSystemsObservationPolicyV1.ValidateEnvelope(page));

        var curve = CurveFact("curve");
        var system = Ref("system", "system");
        curve.Curve!.Systems = new[] { system, system };
        Assert.Throws<ArgumentException>(() => DynamicBuildingSystemsObservationPolicyV1.ValidateFact(curve, Snapshot));
    }

    [Fact]
    public void EquipmentCurveAndSystemShapesCarryRequiredRepresentativeFacts()
    {
        DynamicBuildingSystemsObservationPolicyV1.ValidateFact(CurveFact("curve"), Snapshot);
        DynamicBuildingSystemsObservationPolicyV1.ValidateFact(AssetFact("equipment"), Snapshot);
        DynamicBuildingSystemsObservationPolicyV1.ValidateFact(AssetFact("device"), Snapshot);
        DynamicBuildingSystemsObservationPolicyV1.ValidateFact(AssetFact("accessory"), Snapshot);
        DynamicBuildingSystemsObservationPolicyV1.ValidateFact(SystemFact("system"), Snapshot);
    }

    [Fact]
    public void RevitAdapterCanonicalizesReflectedConnectorFramesBeforeValidation()
    {
        var path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "revit-bridge-addin", "RevitBridge.Logic", "Handlers", "DynamicRuntime", "DynamicBuildingSystemsObservationAdapter.cs"));
        var source = File.ReadAllText(path);
        Assert.Contains("var frame = CanonicalFrame(coordinate);", source);
        Assert.Contains("transform.BasisX - z.Multiply(transform.BasisX.DotProduct(z))", source);
        Assert.Contains("var y = z.CrossProduct(x).Normalize();", source);
        Assert.Contains("name == \"OST_DuctTerminal\"", source);
    }

    [Fact]
    public void CanonicalNumbersBindExactIeeeBitsAcrossRuntimeTargets()
    {
        var fact = CurveFact("bits");
        fact.Curve!.End.X = BitConverter.Int64BitsToDouble(unchecked((long)0x3ff0000000000001));
        var first = DynamicBuildingSystemsObservationPolicyV1.RevisionHash(Fingerprint, "session", 9, Snapshot, new[] { fact });
        fact.Curve.End.X = 1d;
        var adjacent = DynamicBuildingSystemsObservationPolicyV1.RevisionHash(Fingerprint, "session", 9, Snapshot, new[] { fact });

        Assert.NotEqual(first, adjacent);
        Assert.Equal("dynamic-revit-building-systems-canonical/v2", DynamicBuildingSystemsObservationContractV1.CanonicalVersion);
        var source = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "DynamicRevitSdk", "BuildingSystemsObservationContracts.cs")));
        Assert.Contains("BitConverter.DoubleToInt64Bits", source);
        Assert.DoesNotContain("value.ToString(\"R\"", source);
    }

    private static DynamicBuildingSystemsSelectorV1 Selector(int page) => new() { PageSize = page };

    private static DynamicBuildingSystemsFactV1 CurveFact(string id)
    {
        var type = Ref("type-" + id, "type"); var connector = new DynamicBuildingConnectorV1
        {
            StableWithinSnapshotId = DynamicBuildingSystemsObservationPolicyV1.ConnectorStableId(Snapshot, "owner-" + id, "1"),
            Origin = Point(0, 0, 0), BasisX = Point(1, 0, 0), BasisY = Point(0, 1, 0), BasisZ = Point(0, 0, 1),
            Domain = "DomainHvac", ConnectorType = "End", Shape = "Rectangular", FlowDirection = "Out",
            SystemClassification = "DuctSystemType=SupplyAir", HeightFeet = 1, WidthFeet = 2,
            ConnectedCounterpartIds = new[] { DynamicBuildingSystemsObservationPolicyV1.ConnectorStableId(Snapshot, "owner-b", "2") }
        };
        return new DynamicBuildingSystemsFactV1
        {
            Kind = "mep_curve", Element = Ref(id, "element"), Type = type,
            Curve = new DynamicMepCurveFactV1 { Start = Point(0, 0, 0), End = Point(10, 0, 0), CurveKind = "Line", Shape = "Rectangular",
                HeightFeet = 1, WidthFeet = 2, OffsetFeet = 3, Slope = 0.01, Type = type }, Connectors = new[] { connector }
        };
    }

    private static DynamicBuildingSystemsFactV1 AssetFact(string kind)
    {
        var family = Ref("family", "family"); var type = Ref("type", "type"); var transform = new DynamicTransformV1
        { Origin = Point(1, 2, 3), BasisX = Point(1, 0, 0), BasisY = Point(0, 1, 0), BasisZ = Point(0, 0, 1) };
        return new DynamicBuildingSystemsFactV1 { Kind = kind, Element = Ref(kind, "element"), Family = family, Type = type,
            Location = transform.Origin, Orientation = transform, Asset = new DynamicBuildingAssetFactV1
            { AssetClass = kind, Location = transform.Origin, Orientation = transform, Family = family, Type = type } };
    }

    private static DynamicBuildingSystemsFactV1 SystemFact(string id)
    {
        var type = Ref("type-" + id, "type");
        return new DynamicBuildingSystemsFactV1 { Kind = "system", Element = Ref(id, "system"),
            System = new DynamicBuildingSystemFactV1 { Domain = "MechanicalSystem", Classification = "SystemType=SupplyAir", Type = type,
                Members = new[] { Ref("member-" + id, "element") } } };
    }

    private static DynamicStableReferenceV1 Ref(string id, string kind) => new() { Kind = kind, StableId = "revit-element:" + id, UniqueId = id, ElementId = 1 };
    private static DynamicPointV1 Point(double x, double y, double z) => new() { X = x, Y = y, Z = z };
    private static string H(string value) => DynamicWire.Sha256(value);
}
