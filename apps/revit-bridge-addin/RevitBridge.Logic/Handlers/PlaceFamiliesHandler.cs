using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class PlaceFamiliesHandler : IRequestHandler
    {
        public class PlacementRequest
        {
            public string? levelName { get; set; }
            public long? viewId { get; set; }
            public long? familySymbolId { get; set; }
            public string? familyName { get; set; }
            public string symbolName { get; set; } = "";
            public long? worksetId { get; set; }
            public string? worksetName { get; set; }
            public bool allowUnhostedWorkPlanePlacement { get; set; } = false;
            public List<InstanceData> instances { get; set; } = new List<InstanceData>();

            public bool dryRun { get; set; } = false;
            public IdempotencyOptions? idempotency { get; set; }
            public string? behavior { get; set; } // allOrNothing | bestEffort
        }

        public class IdempotencyOptions
        {
            public bool enabled { get; set; } = true;
            public double toleranceFt { get; set; } = 0.01;
        }

        public class InstanceData
        {
            public string? levelName { get; set; } // optional per-instance override
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
            public string? coordinateMode { get; set; } // legacy_level_offset | absolute_model
            public double? rotationDegrees { get; set; }
            public long? hostElementId { get; set; }
            public Dictionary<string, string>? parameters { get; set; }
        }

        public class InstanceResult
        {
            public int index { get; set; }
            public string status { get; set; } = ""; // created | skipped | failed | planned
            public long? elementId { get; set; }
            public string? reason { get; set; }
            public long? worksetId { get; set; }
            public string? worksetName { get; set; }
            public bool? worksetVerified { get; set; }
            public long? familySymbolId { get; set; }
            public long? ownerViewId { get; set; }
            public double? locationX { get; set; }
            public double? locationY { get; set; }
            public double? locationZ { get; set; }
            public bool? inTargetViewCollector { get; set; }
            public bool? viewSpecificBoundingBoxAvailable { get; set; }
            public double? bboxMinX { get; set; }
            public double? bboxMinY { get; set; }
            public double? bboxMinZ { get; set; }
            public double? bboxMaxX { get; set; }
            public double? bboxMaxY { get; set; }
            public double? bboxMaxZ { get; set; }
            public List<string> warnings { get; set; } = new List<string>();
        }

        private sealed class HostFacePlacement
        {
            public FamilyInstance Instance { get; set; } = null!;
            public XYZ ProjectedPoint { get; set; } = null!;
            public double ProjectionDistanceFt { get; set; }
        }

        public class PlacementResult
        {
            public string status { get; set; } = "Unknown";
            public string? familyPlacementType { get; set; }
            public bool requiresExplicitHost { get; set; }
            public bool unhostedWorkPlanePlacementAllowed { get; set; }
            public int placedCount { get; set; }
            public int skippedCount { get; set; }
            public int failedCount { get; set; }
            public long? selectedWorksetId { get; set; }
            public string? selectedWorksetName { get; set; }
            public List<long> elementIds { get; set; } = new List<long>();
            public List<InstanceResult> results { get; set; } = new List<InstanceResult>();
            public List<string> warnings { get; set; } = new List<string>();
            public string? error { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<PlacementRequest>(jsonData) ?? throw new Exception("Invalid request body.");
            var doc = app.ActiveUIDocument.Document;
            var result = new PlacementResult();

            using (Transaction t = new Transaction(doc, "Batch Place Families"))
            {
                t.Start();
                try
                {
                    bool bestEffort = string.Equals(p.behavior, "bestEffort", StringComparison.OrdinalIgnoreCase);
                    bool useIdempotency = p.idempotency?.enabled ?? false;
                    double toleranceFt = Math.Max(0.0, p.idempotency?.toleranceFt ?? 0.0);

                    var levels = new FilteredElementCollector(doc)
                        .OfClass(typeof(Level))
                        .Cast<Level>()
                        .ToList();

                    var requestedWorkset = ResolveRequestedWorkset(doc, p.worksetId, p.worksetName);
                    if (requestedWorkset != null)
                    {
                        result.selectedWorksetId = requestedWorkset.Id.IntegerValue;
                        result.selectedWorksetName = requestedWorkset.Name;
                    }

                    View? targetView = null;
                    Level? defaultLevel = null;
                    if (p.viewId.HasValue && p.viewId.Value > 0)
                    {
                        targetView = doc.GetElement(ElementIdCompat.Create(p.viewId.Value)) as View
                            ?? throw new Exception($"View {p.viewId.Value} not found.");
                        defaultLevel = targetView.GenLevel;
                    }
                    if (defaultLevel == null)
                    {
                        defaultLevel = levels
                            .FirstOrDefault(l => l.Name.Equals(p.levelName ?? "", StringComparison.OrdinalIgnoreCase));
                    }
                    var levelByName = levels
                        .GroupBy(l => l.Name ?? "", StringComparer.OrdinalIgnoreCase)
                        .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

                    FamilySymbol? symbol = null;
                    if (p.familySymbolId.HasValue && p.familySymbolId.Value > 0)
                    {
                        symbol = doc.GetElement(ElementIdCompat.Create(p.familySymbolId.Value)) as FamilySymbol;
                        if (symbol == null)
                            throw new Exception($"Family symbol {p.familySymbolId.Value} not found.");
                    }
                    else
                    {
                        symbol = new FilteredElementCollector(doc)
                            .OfClass(typeof(FamilySymbol))
                            .Cast<FamilySymbol>()
                            .FirstOrDefault(s =>
                                (string.IsNullOrEmpty(p.familyName) || s.FamilyName.Equals(p.familyName, StringComparison.OrdinalIgnoreCase)) &&
                                s.Name.Equals(p.symbolName, StringComparison.OrdinalIgnoreCase));
                    }

                    if (symbol == null) throw new Exception($"Symbol {p.symbolName} not found.");
                    if (!symbol.IsActive)
                    {
                        symbol.Activate();
                        doc.Regenerate();
                    }

                    var familyPlacementType = symbol.Family?.FamilyPlacementType ?? FamilyPlacementType.Invalid;
                    bool unhostedWorkPlanePlacementAllowed =
                        p.allowUnhostedWorkPlanePlacement && familyPlacementType == FamilyPlacementType.WorkPlaneBased;
                    bool requiresExplicitHost = RequiresExplicitHost(familyPlacementType) && !unhostedWorkPlanePlacementAllowed;
                    result.familyPlacementType = familyPlacementType.ToString();
                    result.requiresExplicitHost = requiresExplicitHost;
                    result.unhostedWorkPlanePlacementAllowed = unhostedWorkPlanePlacementAllowed;
                    if (familyPlacementType == FamilyPlacementType.ViewBased && targetView == null)
                        throw new Exception("View-based family placement requires viewId.");
                    if (familyPlacementType != FamilyPlacementType.ViewBased && defaultLevel == null)
                        throw new Exception($"Level {p.levelName} not found and the target view has no associated level.");

                    List<(long id, XYZ point)> existingPoints = new List<(long id, XYZ point)>();
                    if (useIdempotency && toleranceFt > 0.0)
                    {
                        existingPoints = new FilteredElementCollector(doc)
                            .OfClass(typeof(FamilyInstance))
                            .Cast<FamilyInstance>()
                            .Where(fi => fi.Symbol != null && fi.Symbol.Id == symbol.Id)
                            .Select(fi => (id: RevitBridge.Common.ElementIdCompat.GetValue(fi.Id), point: TryGetLocationPoint(fi)))
                            .Where(x => x.point != null)
                            .Select(x => (x.id, x.point!))
                            .ToList();
                    }

                    List<XYZ> plannedOrCreatedPoints = new List<XYZ>();

                    for (int i = 0; i < (p.instances?.Count ?? 0); i++)
                    {
                        var instData = p.instances[i];
                        var instResult = new InstanceResult { index = i };

                        XYZ point = new XYZ(instData.x, instData.y, instData.z);
                        var instanceLevel = defaultLevel;
                        if (!string.IsNullOrWhiteSpace(instData.levelName))
                        {
                            if (!levelByName.TryGetValue(instData.levelName.Trim(), out instanceLevel))
                            {
                                throw new Exception($"Level {instData.levelName} not found.");
                            }
                        }

                        bool usesAbsoluteModelCoordinates = string.Equals(
                            instData.coordinateMode,
                            "absolute_model",
                            StringComparison.OrdinalIgnoreCase);
                        XYZ idempotencyPoint = point;
                        XYZ levelPlacementPoint = point;
                        if (usesAbsoluteModelCoordinates && familyPlacementType != FamilyPlacementType.ViewBased)
                        {
                            // Revit's level-based overload interprets Z as an offset from the supplied level.
                            // Keep the external contract in absolute model coordinates and translate only for
                            // that overload. Hosted and level-free overloads continue to receive absolute XYZ.
                            levelPlacementPoint = new XYZ(point.X, point.Y, point.Z - instanceLevel!.Elevation);
                        }

                        try
                        {
                            if (requiresExplicitHost && !instData.hostElementId.HasValue)
                            {
                                throw new Exception(
                                    $"Family {symbol.FamilyName} / {symbol.Name} requires an explicit host " +
                                    $"({familyPlacementType}); provide hostElementId or use a hosted-placement workflow.");
                            }

                            if (useIdempotency && toleranceFt > 0.0)
                            {
                                var match = FindEquivalent(existingPoints, plannedOrCreatedPoints, idempotencyPoint, toleranceFt);
                                if (match.found)
                                {
                                    instResult.status = "skipped";
                                    instResult.elementId = match.existingElementId;
                                    instResult.reason = "idempotent: matching instance exists within tolerance";
                                    result.skippedCount++;
                                    result.results.Add(instResult);
                                    continue;
                                }
                            }

                            FamilyInstance fi = null;
                            XYZ actualPlacementPoint = point;
                            if (instData.hostElementId.HasValue)
                            {
                                Element host = doc.GetElement(ToElementId(instData.hostElementId.Value));
                                if (host == null) throw new Exception($"Host element {instData.hostElementId.Value} not found.");
                                if (host is ElementType) throw new Exception($"Host element {instData.hostElementId.Value} is an element type; expected an instance element.");

                                try
                                {
                                    if (familyPlacementType == FamilyPlacementType.WorkPlaneBased)
                                    {
                                        var facePlacement = PlaceOnClosestHostFace(doc, host, point, symbol);
                                        fi = facePlacement.Instance;
                                        actualPlacementPoint = facePlacement.ProjectedPoint;
                                        if (facePlacement.ProjectionDistanceFt > 0.5)
                                        {
                                            instResult.warnings.Add(
                                                $"Requested point was projected {facePlacement.ProjectionDistanceFt:0.###} ft to the closest referenced host face.");
                                        }
                                    }
                                    else
                                    {
                                        fi = doc.Create.NewFamilyInstance(point, symbol, host, instanceLevel, StructuralType.NonStructural);
                                    }
                                }
                                catch (Exception ex)
                                {
                                    if (requiresExplicitHost)
                                    {
                                        throw new Exception(
                                            $"Host placement failed for host-required family " +
                                            $"{symbol.FamilyName} / {symbol.Name} ({familyPlacementType}). {ex.Message}",
                                            ex);
                                    }

                                    instResult.warnings.Add($"Host placement failed; falling back to non-hosted/level-hosted. {ex.Message}");
                                }
                            }

                            if (fi == null)
                            {
                                try
                                {
                                    // The level-based overload treats Z as a level offset for ordinary
                                    // level-based families, but as an absolute model coordinate for the
                                    // explicitly allowed unhosted WorkPlaneBased case. Preserve the public
                                    // absolute_model contract in both native placement modes.
                                    var nativePlacementPoint = unhostedWorkPlanePlacementAllowed
                                        ? point
                                        : levelPlacementPoint;
                                    if (familyPlacementType == FamilyPlacementType.ViewBased)
                                    {
                                        fi = doc.Create.NewFamilyInstance(point, symbol, targetView!);
                                    }
                                    else
                                    {
                                        fi = doc.Create.NewFamilyInstance(nativePlacementPoint, symbol, instanceLevel!, StructuralType.NonStructural);
                                    }
                                }
                                catch
                                {
                                    if (familyPlacementType == FamilyPlacementType.ViewBased)
                                        throw;
                                    fi = doc.Create.NewFamilyInstance(point, symbol, StructuralType.NonStructural);
                                }
                            }

                            if (fi == null) throw new Exception("Failed to create family instance.");

                            if (requestedWorkset != null)
                            {
                                AssignAndVerifyWorkset(fi, requestedWorkset);
                                instResult.worksetId = requestedWorkset.Id.IntegerValue;
                                instResult.worksetName = requestedWorkset.Name;
                                instResult.worksetVerified = true;
                            }

                            if (instData.hostElementId.HasValue && !MatchesExplicitHost(fi, instData.hostElementId.Value))
                            {
                                doc.Delete(fi.Id);
                                throw new Exception(
                                    $"Revit created {symbol.FamilyName} / {symbol.Name} without the requested host " +
                                    $"{instData.hostElementId.Value}; placement was discarded.");
                            }

                            if (instData.rotationDegrees.HasValue && Math.Abs(instData.rotationDegrees.Value) > 1e-9)
                            {
                                // Some level-based families expose a LocationPoint at the family origin rather
                                // than at the requested model-space insertion point. Rotating about that value
                                // can orbit the new instance around the project origin. The placement workflow
                                // already tracks the authoritative insertion point (or projected host point), so
                                // keep rotation local to that point.
                                RotateAboutZ(doc, fi.Id, actualPlacementPoint, instData.rotationDegrees.Value);
                            }

                            if (instData.parameters != null)
                            {
                                foreach (var kvp in instData.parameters)
                                {
                                    SetParameter(fi, kvp.Key, kvp.Value);
                                }
                            }

                            SetParameter(fi, "ROS_AutoGenerated", "1");
                            doc.Regenerate();
                            PopulateNativeReadback(doc, targetView, fi, instResult);
                            if (familyPlacementType == FamilyPlacementType.ViewBased && targetView != null &&
                                (instResult.ownerViewId != ElementIdCompat.GetValue(targetView.Id) ||
                                 instResult.inTargetViewCollector != true ||
                                 instResult.viewSpecificBoundingBoxAvailable != true))
                            {
                                var failedId = ElementIdCompat.GetValue(fi.Id);
                                doc.Delete(fi.Id);
                                throw new Exception(
                                    $"View-based placement {failedId} did not retain owner view {ElementIdCompat.GetValue(targetView.Id)} " +
                                    "with collector and view-specific bounding-box proof; placement was discarded.");
                            }
                            plannedOrCreatedPoints.Add(idempotencyPoint);

                            if (p.dryRun)
                            {
                                instResult.status = "planned";
                                instResult.reason = "dryRun: rolled back";
                            }
                            else
                            {
                                instResult.status = "created";
                                instResult.elementId = RevitBridge.Common.ElementIdCompat.GetValue(fi.Id);
                                result.elementIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(fi.Id));
                                result.placedCount++;
                            }

                            result.results.Add(instResult);
                        }
                        catch (Exception ex)
                        {
                            instResult.status = "failed";
                            instResult.reason = ex.Message;
                            result.failedCount++;
                            result.results.Add(instResult);

                            if (!bestEffort)
                                throw new Exception($"Failed to place family instance at index {i}: {ex.Message}", ex);
                        }
                    }

                    if (p.dryRun)
                    {
                        result.status = result.failedCount > 0 ? "PlannedWithErrors" : "Planned";
                        t.RollBack();
                    }
                    else
                    {
                        result.status = result.failedCount > 0 ? "PlacedWithErrors" : "Placed";
                        t.Commit();
                    }
                }
                catch (Exception ex)
                {
                    result.status = "Failed";
                    result.error = ex.Message;
                    t.RollBack();
                }
            }

            return Task.FromResult<object>(result);
        }

        private static void PopulateNativeReadback(
            Document doc,
            View? targetView,
            FamilyInstance instance,
            InstanceResult result)
        {
            result.familySymbolId = ElementIdCompat.GetValue(instance.GetTypeId());
            try
            {
                var ownerViewId = instance.OwnerViewId;
                result.ownerViewId = ownerViewId == null || ownerViewId == ElementId.InvalidElementId
                    ? (long?)null
                    : ElementIdCompat.GetValue(ownerViewId);
            }
            catch
            {
                result.ownerViewId = null;
            }

            try
            {
                if (instance.Location is LocationPoint locationPoint)
                {
                    result.locationX = locationPoint.Point.X;
                    result.locationY = locationPoint.Point.Y;
                    result.locationZ = locationPoint.Point.Z;
                }
            }
            catch
            {
                // Keep location readback null when Revit does not expose it.
            }

            if (targetView == null) return;

            try
            {
                result.inTargetViewCollector = new FilteredElementCollector(doc, targetView.Id)
                    .WhereElementIsNotElementType()
                    .ToElementIds()
                    .Any(id => id == instance.Id);
            }
            catch
            {
                result.inTargetViewCollector = null;
            }

            try
            {
                var bbox = instance.get_BoundingBox(targetView);
                result.viewSpecificBoundingBoxAvailable = bbox != null;
                if (bbox != null)
                {
                    result.bboxMinX = bbox.Min.X;
                    result.bboxMinY = bbox.Min.Y;
                    result.bboxMinZ = bbox.Min.Z;
                    result.bboxMaxX = bbox.Max.X;
                    result.bboxMaxY = bbox.Max.Y;
                    result.bboxMaxZ = bbox.Max.Z;
                }
            }
            catch
            {
                result.viewSpecificBoundingBoxAvailable = false;
            }
        }

        private static bool RequiresExplicitHost(FamilyPlacementType familyPlacementType)
        {
            return familyPlacementType == FamilyPlacementType.OneLevelBasedHosted ||
                   familyPlacementType == FamilyPlacementType.WorkPlaneBased;
        }

        private static HostFacePlacement PlaceOnClosestHostFace(
            Document doc,
            Element host,
            XYZ requestedPoint,
            FamilySymbol symbol)
        {
            if (host is ReferencePlane referencePlane)
            {
                return PlaceOnReferencePlane(doc, referencePlane, requestedPoint, symbol);
            }

            var options = new Options
            {
                ComputeReferences = true,
                IncludeNonVisibleObjects = true,
                DetailLevel = ViewDetailLevel.Fine
            };
            var candidates = new List<(Face face, IntersectionResult projection, double distance)>();
            CollectFaceCandidates(host.get_Geometry(options), requestedPoint, candidates);
            var selected = candidates
                .Where(candidate => candidate.face.Reference != null)
                .OrderBy(candidate => candidate.distance)
                .FirstOrDefault();
            if (selected.face == null || selected.projection == null || selected.face.Reference == null)
            {
                throw new Exception($"Host element {RevitBridge.Common.ElementIdCompat.GetValue(host.Id)} has no referenced face near the requested point.");
            }

            var normal = selected.face.ComputeNormal(selected.projection.UVPoint).Normalize();
            var referenceDirection = TangentDirection(normal);
            var instance = doc.Create.NewFamilyInstance(
                selected.face.Reference,
                selected.projection.XYZPoint,
                referenceDirection,
                symbol);
            if (instance == null) throw new Exception("Revit face-based placement returned no family instance.");
            return new HostFacePlacement
            {
                Instance = instance,
                ProjectedPoint = selected.projection.XYZPoint,
                ProjectionDistanceFt = selected.distance
            };
        }

        private static HostFacePlacement PlaceOnReferencePlane(
            Document doc,
            ReferencePlane referencePlane,
            XYZ requestedPoint,
            FamilySymbol symbol)
        {
            var hostReference = referencePlane.GetReference();
            if (hostReference == null)
            {
                throw new Exception(
                    $"Reference plane {RevitBridge.Common.ElementIdCompat.GetValue(referencePlane.Id)} has no placement reference.");
            }

            var normal = referencePlane.Normal.Normalize();
            var origin = referencePlane.BubbleEnd;
            var signedDistance = (requestedPoint - origin).DotProduct(normal);
            var projectedPoint = requestedPoint - normal.Multiply(signedDistance);
            var referenceDirection = TangentDirection(normal);
            var instance = doc.Create.NewFamilyInstance(
                hostReference,
                projectedPoint,
                referenceDirection,
                symbol);
            if (instance == null) throw new Exception("Revit reference-plane placement returned no family instance.");

            return new HostFacePlacement
            {
                Instance = instance,
                ProjectedPoint = projectedPoint,
                ProjectionDistanceFt = Math.Abs(signedDistance)
            };
        }

        private static void CollectFaceCandidates(
            GeometryElement? geometry,
            XYZ requestedPoint,
            List<(Face face, IntersectionResult projection, double distance)> candidates)
        {
            if (geometry == null) return;
            foreach (var geometryObject in geometry)
            {
                if (geometryObject is Solid solid && solid.Volume > 1e-12)
                {
                    foreach (Face face in solid.Faces)
                    {
                        var projection = face.Project(requestedPoint);
                        if (projection != null)
                        {
                            candidates.Add((face, projection, projection.XYZPoint.DistanceTo(requestedPoint)));
                        }
                    }
                }
                else if (geometryObject is GeometryInstance instance)
                {
                    CollectFaceCandidates(instance.GetInstanceGeometry(), requestedPoint, candidates);
                }
            }
        }

        private static XYZ TangentDirection(XYZ normal)
        {
            var direction = XYZ.BasisZ - normal.Multiply(XYZ.BasisZ.DotProduct(normal));
            if (direction.GetLength() < 1e-9)
            {
                direction = XYZ.BasisX - normal.Multiply(XYZ.BasisX.DotProduct(normal));
            }
            if (direction.GetLength() < 1e-9)
            {
                direction = XYZ.BasisY - normal.Multiply(XYZ.BasisY.DotProduct(normal));
            }
            if (direction.GetLength() < 1e-9) throw new Exception("Unable to derive a tangent reference direction for the selected host face.");
            return direction.Normalize();
        }

        private static bool MatchesExplicitHost(FamilyInstance instance, long expectedHostElementId)
        {
            if (instance.Host != null
                && RevitBridge.Common.ElementIdCompat.GetValue(instance.Host.Id) == expectedHostElementId) return true;
            var hostFace = instance.HostFace;
            return hostFace != null
                && RevitBridge.Common.ElementIdCompat.GetValue(hostFace.ElementId) == expectedHostElementId;
        }

        private static (bool found, long? existingElementId) FindEquivalent(List<(long id, XYZ point)> existing, List<XYZ> plannedOrCreated, XYZ target, double toleranceFt)
        {
            foreach (var e in existing)
            {
                if (e.point.DistanceTo(target) <= toleranceFt) return (true, e.id);
            }
            foreach (var p in plannedOrCreated)
            {
                if (p.DistanceTo(target) <= toleranceFt) return (true, null);
            }
            return (false, null);
        }

        private static XYZ? TryGetLocationPoint(FamilyInstance fi)
        {
            if (fi.Location is LocationPoint lp) return lp.Point;
            return null;
        }

        private static void RotateAboutZ(Document doc, ElementId elementId, XYZ origin, double rotationDegrees)
        {
            double radians = rotationDegrees * (Math.PI / 180.0);
            Line axis = Line.CreateBound(origin, origin + XYZ.BasisZ);
            ElementTransformUtils.RotateElement(doc, elementId, axis, radians);
        }

        private static ElementId ToElementId(long id)
        {
            if (id < int.MinValue || id > int.MaxValue) throw new Exception($"ElementId {id} is outside 32-bit range.");
            return RevitBridge.Common.ElementIdCompat.Create((int)id);
        }

        private static Workset? ResolveRequestedWorkset(Document doc, long? requestedId, string? requestedName)
        {
            var hasId = requestedId.HasValue && requestedId.Value > 0;
            var cleanName = (requestedName ?? "").Trim();
            if (!hasId && cleanName.Length == 0) return null;
            if (!doc.IsWorkshared) throw new Exception("A workset was requested, but the active document is not workshared.");

            var worksets = new FilteredWorksetCollector(doc)
                .OfKind(WorksetKind.UserWorkset)
                .ToWorksets()
                .ToList();
            var byId = hasId
                ? worksets.FirstOrDefault(workset => workset.Id.IntegerValue == requestedId!.Value)
                : null;
            var byName = cleanName.Length > 0
                ? worksets.FirstOrDefault(workset => string.Equals(workset.Name, cleanName, StringComparison.OrdinalIgnoreCase))
                : null;
            if (hasId && byId == null) throw new Exception($"Workset id {requestedId} was not found.");
            if (cleanName.Length > 0 && byName == null) throw new Exception($"Workset '{cleanName}' was not found.");
            if (byId != null && byName != null && byId.Id.IntegerValue != byName.Id.IntegerValue)
                throw new Exception($"Requested workset id {requestedId} does not match workset name '{cleanName}'.");
            return byId ?? byName;
        }

        private static void AssignAndVerifyWorkset(Element element, Workset workset)
        {
            var parameter = element.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM);
            if (parameter == null || parameter.IsReadOnly)
                throw new Exception($"Element {ElementIdCompat.GetValue(element.Id)} cannot be assigned to workset '{workset.Name}'.");
            if (!parameter.Set(workset.Id.IntegerValue))
                throw new Exception($"Revit rejected workset '{workset.Name}' for element {ElementIdCompat.GetValue(element.Id)}.");
            if (element.WorksetId.IntegerValue != workset.Id.IntegerValue)
                throw new Exception($"Workset verification failed for element {ElementIdCompat.GetValue(element.Id)}.");
        }

        private void SetParameter(Element e, string name, string value)
        {
            Parameter param = e.LookupParameter(name);
            if (param == null) return;
            if (param.IsReadOnly) return;

            if (param.StorageType == StorageType.String)
            {
                param.Set(value);
            }
            else if (param.StorageType == StorageType.Double)
            {
                if (double.TryParse(value, NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out double d)) param.Set(d);
            }
            else if (param.StorageType == StorageType.Integer)
            {
                if (int.TryParse(value, out int i)) param.Set(i);
            }
            else if (param.StorageType == StorageType.ElementId)
            {
                if (long.TryParse(value, out long id) && id >= int.MinValue && id <= int.MaxValue)
                    param.Set(RevitBridge.Common.ElementIdCompat.Create((int)id));
            }
        }
    }
}

