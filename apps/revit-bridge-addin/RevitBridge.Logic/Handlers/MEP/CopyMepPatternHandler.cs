using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    /// <summary>
    /// Copies an explicit connected MEP analog as one pattern so Revit can retain
    /// internal taps, hosted devices, family/type parameters, and system membership.
    /// Optional curve endpoint overrides fit copied straight curves to known anchors;
    /// optional external connections then join those copied curves to explicit existing
    /// elements. Dry-run executes the native operation and rolls the transaction back.
    /// </summary>
    public sealed class CopyMepPatternHandler : IRequestHandler
    {
        public sealed class CurveEndpointOverride
        {
            public long sourceElementId { get; set; }
            public double[]? startXyz { get; set; }
            public double[]? endXyz { get; set; }
        }

        public sealed class ExternalConnection
        {
            public long copiedSourceElementId { get; set; }
            public long existingElementId { get; set; }
        }

        public sealed class Params
        {
            public List<long>? sourceElementIds { get; set; }
            public double[]? translationXyz { get; set; }
            public List<CurveEndpointOverride>? curveEndpointOverrides { get; set; }
            public List<ExternalConnection>? externalConnections { get; set; }
            public double connectionToleranceFt { get; set; } = 0.125;
            public double connectionSizeToleranceFt { get; set; } = 0.01;
            public bool dryRun { get; set; } = true;
            public bool verify { get; set; } = true;
        }

        private sealed class SourcePair
        {
            public long A { get; set; }
            public long B { get; set; }
        }

        private sealed class ConnectorPair
        {
            public Connector Copied { get; set; } = null!;
            public Connector Existing { get; set; } = null!;
            public double DistanceFt { get; set; }
        }

        private static readonly HashSet<BuiltInCategory> AllowedCategories = new HashSet<BuiltInCategory>
        {
            BuiltInCategory.OST_DuctCurves,
            BuiltInCategory.OST_FlexDuctCurves,
            BuiltInCategory.OST_PipeCurves,
            BuiltInCategory.OST_FlexPipeCurves,
            BuiltInCategory.OST_DuctTerminal,
            BuiltInCategory.OST_MechanicalEquipment,
            BuiltInCategory.OST_PlumbingFixtures,
            BuiltInCategory.OST_DuctAccessory,
            BuiltInCategory.OST_PipeAccessory,
            BuiltInCategory.OST_DuctFitting,
            BuiltInCategory.OST_PipeFitting
        };

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
            var sourceIds = (p.sourceElementIds ?? new List<long>()).Where(id => id > 0).Distinct().ToList();
            if (sourceIds.Count == 0) throw new InvalidOperationException("sourceElementIds must contain at least one positive element id.");
            if (sourceIds.Count > 32) throw new InvalidOperationException("At most 32 source elements may be copied in one pattern.");
            var translation = Point(p.translationXyz, "translationXyz");
            if (translation.GetLength() > 10000.0) throw new InvalidOperationException("translationXyz exceeds the 10,000 foot safety limit.");
            if (p.connectionToleranceFt <= 0 || p.connectionToleranceFt > 2.0)
                throw new InvalidOperationException("connectionToleranceFt must be greater than 0 and no more than 2 feet.");
            if (p.connectionSizeToleranceFt < 0 || p.connectionSizeToleranceFt > 0.25)
                throw new InvalidOperationException("connectionSizeToleranceFt must be between 0 and 0.25 feet.");

            var sourceElements = sourceIds.Select(id => doc.GetElement(ElementIdCompat.Create(id))
                ?? throw new InvalidOperationException($"Source element {id} was not found.")).ToList();
            foreach (var source in sourceElements)
            {
                var category = source.Category?.BuiltInCategory;
                if (!category.HasValue || !AllowedCategories.Contains(category.Value))
                    throw new InvalidOperationException($"Source element {ElementIdCompat.GetValue(source.Id)} has unsupported category {source.Category?.Name ?? "<none>"}.");
                if (RepresentativePoint(source) == null)
                    throw new InvalidOperationException($"Source element {ElementIdCompat.GetValue(source.Id)} has no stable point or curve geometry for copy verification.");
            }

            ValidateOverrides(sourceIds, p.curveEndpointOverrides);
            ValidateExternalConnections(doc, sourceIds, p.externalConnections);
            var sourcePairs = CollectInternalPhysicalPairs(sourceElements);
            var provisionalCreatedIds = new List<long>();
            var mapping = new Dictionary<long, long>();
            var externalResults = new List<object>();
            var internalVerified = new List<object>();
            Transaction? tx = null;

            try
            {
                tx = new Transaction(doc, p.dryRun ? "Dry-run copy MEP pattern" : "Copy MEP pattern");
                tx.Start();
                var copiedIds = ElementTransformUtils.CopyElements(
                    doc,
                    sourceElements.Select(element => element.Id).ToList(),
                    doc,
                    Transform.CreateTranslation(translation),
                    new CopyPasteOptions());
                doc.Regenerate();
                provisionalCreatedIds = copiedIds.Select(ElementIdCompat.GetValue).ToList();
                if (provisionalCreatedIds.Count != sourceIds.Count)
                    throw new InvalidOperationException($"Native pattern copy created {provisionalCreatedIds.Count} elements for {sourceIds.Count} explicit sources; refusing unexpected dependent-copy drift.");

                var copiedElements = copiedIds.Select(id => doc.GetElement(id)
                    ?? throw new InvalidOperationException($"Copied element {ElementIdCompat.GetValue(id)} was not found after regeneration.")).ToList();
                mapping = MapCopiedElements(sourceElements, copiedElements, translation);
                ApplyCurveEndpointOverrides(doc, p.curveEndpointOverrides, mapping);
                doc.Regenerate();

                foreach (var connection in p.externalConnections ?? new List<ExternalConnection>())
                {
                    var copiedId = mapping[connection.copiedSourceElementId];
                    var copied = doc.GetElement(ElementIdCompat.Create(copiedId))
                        ?? throw new InvalidOperationException($"Mapped copied element {copiedId} was not found.");
                    var existing = doc.GetElement(ElementIdCompat.Create(connection.existingElementId))
                        ?? throw new InvalidOperationException($"External element {connection.existingElementId} was not found.");
                    // Revit can automatically join coincident pipe/duct endpoints while
                    // CopyElements regenerates the copied pattern. Treat that native join
                    // as satisfying the explicit request instead of requiring a second
                    // pair of open connectors that no longer exists.
                    if (ArePhysicallyConnected(doc, copiedId, connection.existingElementId))
                    {
                        externalResults.Add(new
                        {
                            copiedSourceElementId = connection.copiedSourceElementId,
                            copiedElementId = copiedId,
                            existingElementId = connection.existingElementId,
                            distanceFt = 0.0,
                            alreadyConnected = true
                        });
                        continue;
                    }
                    var pair = FindExternalConnectorPair(copied, existing, p.connectionToleranceFt, p.connectionSizeToleranceFt)
                        ?? throw new InvalidOperationException($"No compatible open connector pair was found between copied source {connection.copiedSourceElementId} and existing element {connection.existingElementId} within {p.connectionToleranceFt:0.###} ft and {p.connectionSizeToleranceFt:0.###} ft size tolerance.");
                    pair.Copied.ConnectTo(pair.Existing);
                    externalResults.Add(new
                    {
                        copiedSourceElementId = connection.copiedSourceElementId,
                        copiedElementId = copiedId,
                        existingElementId = connection.existingElementId,
                        distanceFt = pair.DistanceFt,
                        alreadyConnected = false
                    });
                }
                doc.Regenerate();

                if (p.verify)
                {
                    foreach (var pair in sourcePairs)
                    {
                        var copiedA = mapping[pair.A];
                        var copiedB = mapping[pair.B];
                        if (!ArePhysicallyConnected(doc, copiedA, copiedB))
                            throw new InvalidOperationException($"Copied pattern did not preserve source physical connection {pair.A}<->{pair.B} as {copiedA}<->{copiedB}.");
                        internalVerified.Add(new { sourceA = pair.A, sourceB = pair.B, copiedA, copiedB });
                    }
                    foreach (var connection in p.externalConnections ?? new List<ExternalConnection>())
                    {
                        if (!ArePhysicallyConnected(doc, mapping[connection.copiedSourceElementId], connection.existingElementId))
                            throw new InvalidOperationException($"External connection verification failed for copied source {connection.copiedSourceElementId} and existing element {connection.existingElementId}.");
                    }
                }

                var responseMapping = mapping.OrderBy(entry => entry.Key).Select(entry => new
                {
                    sourceElementId = entry.Key,
                    copiedElementId = entry.Value
                }).ToList();
                if (p.dryRun) tx.RollBack(); else tx.Commit();
                return Task.FromResult<object>(new
                {
                    status = p.dryRun ? "Ready" : "Applied",
                    dryRun = p.dryRun,
                    nativePreflightSucceeded = true,
                    transactionRolledBack = p.dryRun,
                    sourceElementIds = sourceIds,
                    translation = Vector(translation),
                    plannedCreatedCount = sourceIds.Count,
                    createdElementIds = p.dryRun ? new List<long>() : provisionalCreatedIds,
                    sourceToCopied = p.dryRun ? new List<object>() : responseMapping.Cast<object>().ToList(),
                    internalPhysicalConnectionCount = sourcePairs.Count,
                    internalConnectionsVerified = internalVerified,
                    externalConnections = externalResults
                });
            }
            catch (Exception ex)
            {
                try
                {
                    if (tx != null && tx.GetStatus() == TransactionStatus.Started) tx.RollBack();
                }
                catch { }
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    dryRun = p.dryRun,
                    nativePreflightSucceeded = false,
                    transactionRolledBack = true,
                    sourceElementIds = sourceIds,
                    translation = Vector(translation),
                    plannedCreatedCount = sourceIds.Count,
                    error = ex.Message
                });
            }
        }

        private static void ValidateOverrides(List<long> sourceIds, List<CurveEndpointOverride>? overrides)
        {
            var seen = new HashSet<long>();
            foreach (var item in overrides ?? new List<CurveEndpointOverride>())
            {
                if (!sourceIds.Contains(item.sourceElementId)) throw new InvalidOperationException($"Curve endpoint override source {item.sourceElementId} is not in sourceElementIds.");
                if (!seen.Add(item.sourceElementId)) throw new InvalidOperationException($"Curve endpoint override source {item.sourceElementId} is duplicated.");
                Point(item.startXyz, $"curveEndpointOverrides[{item.sourceElementId}].startXyz");
                Point(item.endXyz, $"curveEndpointOverrides[{item.sourceElementId}].endXyz");
            }
        }

        private static void ValidateExternalConnections(Document doc, List<long> sourceIds, List<ExternalConnection>? connections)
        {
            if ((connections?.Count ?? 0) > 16) throw new InvalidOperationException("At most 16 external connections may be requested.");
            var seenExisting = new HashSet<long>();
            foreach (var item in connections ?? new List<ExternalConnection>())
            {
                if (!sourceIds.Contains(item.copiedSourceElementId))
                    throw new InvalidOperationException($"External connection source {item.copiedSourceElementId} is not in sourceElementIds.");
                if (item.existingElementId <= 0 || sourceIds.Contains(item.existingElementId))
                    throw new InvalidOperationException($"External connection target {item.existingElementId} must be a positive element outside the copied source set.");
                if (!seenExisting.Add(item.existingElementId))
                    throw new InvalidOperationException($"External connection target {item.existingElementId} is duplicated.");
                if (doc.GetElement(ElementIdCompat.Create(item.existingElementId)) == null)
                    throw new InvalidOperationException($"External connection target {item.existingElementId} was not found.");
            }
        }

        private static Dictionary<long, long> MapCopiedElements(List<Element> sources, List<Element> copied, XYZ translation)
        {
            var unmatched = new List<Element>(copied);
            var result = new Dictionary<long, long>();
            foreach (var source in sources)
            {
                var sourcePoint = RepresentativePoint(source)!;
                var expected = sourcePoint + translation;
                var sourceCategory = source.Category?.BuiltInCategory;
                var sourceTypeId = ElementIdCompat.GetValue(source.GetTypeId());
                var best = unmatched
                    .Where(candidate => candidate.Category?.BuiltInCategory == sourceCategory && ElementIdCompat.GetValue(candidate.GetTypeId()) == sourceTypeId)
                    .Select(candidate => new { candidate, point = RepresentativePoint(candidate) })
                    .Where(row => row.point != null)
                    .OrderBy(row => row.point!.DistanceTo(expected))
                    .FirstOrDefault();
                if (best == null) throw new InvalidOperationException($"Could not map copied element for source {ElementIdCompat.GetValue(source.Id)} by category, type, and translated geometry.");
                result[ElementIdCompat.GetValue(source.Id)] = ElementIdCompat.GetValue(best.candidate.Id);
                unmatched.Remove(best.candidate);
            }
            if (unmatched.Count > 0) throw new InvalidOperationException("Copied pattern contains unmapped elements.");
            return result;
        }

        private static void ApplyCurveEndpointOverrides(Document doc, List<CurveEndpointOverride>? overrides, Dictionary<long, long> mapping)
        {
            foreach (var item in overrides ?? new List<CurveEndpointOverride>())
            {
                var copied = doc.GetElement(ElementIdCompat.Create(mapping[item.sourceElementId]))
                    ?? throw new InvalidOperationException($"Mapped copied curve for source {item.sourceElementId} was not found.");
                if (!(copied.Location is LocationCurve location) || !(location.Curve is Line))
                    throw new InvalidOperationException($"Curve endpoint override source {item.sourceElementId} must map to a straight Revit curve.");
                var start = Point(item.startXyz, $"curveEndpointOverrides[{item.sourceElementId}].startXyz");
                var end = Point(item.endXyz, $"curveEndpointOverrides[{item.sourceElementId}].endXyz");
                if (start.DistanceTo(end) < 0.01) throw new InvalidOperationException($"Curve endpoint override source {item.sourceElementId} is shorter than 0.01 ft.");
                location.Curve = Line.CreateBound(start, end);
            }
        }

        private static List<SourcePair> CollectInternalPhysicalPairs(List<Element> elements)
        {
            var sourceSet = new HashSet<long>(elements.Select(element => ElementIdCompat.GetValue(element.Id)));
            var keys = new HashSet<string>(StringComparer.Ordinal);
            var result = new List<SourcePair>();
            foreach (var element in elements)
            {
                var a = ElementIdCompat.GetValue(element.Id);
                foreach (var connector in MepRoutingUtil.GetConnectors(element))
                {
                    ConnectorSet? refs = null;
                    try { refs = connector.AllRefs; } catch { }
                    if (refs == null) continue;
                    foreach (Connector reference in refs)
                    {
                        if (reference == null || reference.ConnectorType == ConnectorType.Logical || reference.Owner == null) continue;
                        var b = ElementIdCompat.GetValue(reference.Owner.Id);
                        if (!sourceSet.Contains(b) || a == b) continue;
                        var low = Math.Min(a, b);
                        var high = Math.Max(a, b);
                        if (keys.Add($"{low}:{high}")) result.Add(new SourcePair { A = low, B = high });
                    }
                }
            }
            return result.OrderBy(pair => pair.A).ThenBy(pair => pair.B).ToList();
        }

        private static ConnectorPair? FindExternalConnectorPair(Element copied, Element existing, double toleranceFt, double sizeToleranceFt)
        {
            var candidates = new List<ConnectorPair>();
            foreach (var a in OpenPhysicalConnectors(copied))
            foreach (var b in OpenPhysicalConnectors(existing))
            {
                if (!Compatible(a, b, sizeToleranceFt)) continue;
                var distance = a.Origin.DistanceTo(b.Origin);
                if (distance <= toleranceFt) candidates.Add(new ConnectorPair { Copied = a, Existing = b, DistanceFt = distance });
            }
            return candidates.OrderBy(pair => pair.DistanceFt).FirstOrDefault();
        }

        private static bool Compatible(Connector a, Connector b, double sizeToleranceFt)
        {
            if (a.Domain != b.Domain || a.Shape != b.Shape) return false;
            try
            {
                if (a.Shape == ConnectorProfileType.Round)
                    return Math.Abs(a.Radius - b.Radius) <= sizeToleranceFt * 0.5;
                if (a.Shape == ConnectorProfileType.Rectangular || a.Shape == ConnectorProfileType.Oval)
                {
                    var aSize = new[] { a.Width, a.Height }.OrderBy(value => value).ToArray();
                    var bSize = new[] { b.Width, b.Height }.OrderBy(value => value).ToArray();
                    return Math.Abs(aSize[0] - bSize[0]) <= sizeToleranceFt && Math.Abs(aSize[1] - bSize[1]) <= sizeToleranceFt;
                }
            }
            catch
            {
                return false;
            }
            return true;
        }

        private static List<Connector> OpenPhysicalConnectors(Element element)
        {
            return MepRoutingUtil.GetConnectors(element)
                .Where(connector => connector.ConnectorType != ConnectorType.Logical && !HasPhysicalReference(connector))
                .ToList();
        }

        private static bool HasPhysicalReference(Connector connector)
        {
            ConnectorSet? refs = null;
            try { refs = connector.AllRefs; } catch { }
            if (refs == null) return false;
            foreach (Connector reference in refs)
            {
                if (reference == null || reference.ConnectorType == ConnectorType.Logical || reference.Owner == null) continue;
                if (reference.Owner is MEPSystem) continue;
                if (ElementIdCompat.GetValue(reference.Owner.Id) == ElementIdCompat.GetValue(connector.Owner.Id)) continue;
                return true;
            }
            return false;
        }

        private static bool ArePhysicallyConnected(Document doc, long aId, long bId)
        {
            var a = doc.GetElement(ElementIdCompat.Create(aId));
            if (a == null) return false;
            foreach (var connector in MepRoutingUtil.GetConnectors(a))
            {
                ConnectorSet? refs = null;
                try { refs = connector.AllRefs; } catch { }
                if (refs == null) continue;
                foreach (Connector reference in refs)
                {
                    if (reference == null || reference.ConnectorType == ConnectorType.Logical || reference.Owner == null) continue;
                    if (ElementIdCompat.GetValue(reference.Owner.Id) == bId) return true;
                }
            }
            return false;
        }

        private static XYZ? RepresentativePoint(Element element)
        {
            if (element.Location is LocationPoint point) return point.Point;
            if (element.Location is LocationCurve curve)
            {
                try { return curve.Curve.Evaluate(0.5, true); } catch { }
            }
            try
            {
                var box = element.get_BoundingBox(null);
                if (box != null) return (box.Min + box.Max) * 0.5;
            }
            catch { }
            return null;
        }

        private static XYZ Point(double[]? values, string label)
        {
            if (values == null || values.Length != 3 || values.Any(value => double.IsNaN(value) || double.IsInfinity(value)))
                throw new InvalidOperationException($"{label} must contain exactly three finite numbers.");
            return new XYZ(values[0], values[1], values[2]);
        }

        private static object Vector(XYZ point) => new { x = point.X, y = point.Y, z = point.Z };
    }
}
