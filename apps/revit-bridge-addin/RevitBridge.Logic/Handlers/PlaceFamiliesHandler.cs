using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.DB.Structure;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    internal static class PlacementParameterValues
    {
        internal static double ParseDouble(string value, Func<string, double?> parseFormatted)
        {
            // Keep this handler's legacy numeric interpretation before consulting document display units.
            if (!double.TryParse(value, NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out var number))
            {
                var parsed = parseFormatted(value);
                if (!parsed.HasValue) throw new FormatException("Revit could not parse the value using this parameter's units.");
                number = parsed.Value;
            }
            if (double.IsNaN(number) || double.IsInfinity(number)) throw new FormatException("Value must be finite.");
            return number;
        }

        internal static bool MatchesDouble(double actual, double expected)
            => !double.IsNaN(actual) && !double.IsInfinity(actual)
                && !double.IsNaN(expected) && !double.IsInfinity(expected)
                && Math.Abs(actual - expected) < 1e-9;

        internal static bool ResultSucceeded(string status, int failedCount, int verificationFailedCount)
            => (status == "Placed" || status == "Planned") && failedCount == 0 && verificationFailedCount == 0;
    }

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
            public long? linkedHostElementId { get; set; }
            public Dictionary<string, string>? parameters { get; set; }
        }

        public class InstanceResult
        {
            public int index { get; set; }
            public string status { get; set; } = ""; // created | skipped | failed | planned
            public long? elementId { get; set; }
            public string? reason { get; set; }
            public string? coordinateMode { get; set; }
            public double? requestedLocationX { get; set; }
            public double? requestedLocationY { get; set; }
            public double? requestedLocationZ { get; set; }
            public double? absoluteModelCorrectionDistanceFt { get; set; }
            public bool? absoluteModelLocationVerified { get; set; }
            public long? worksetId { get; set; }
            public string? worksetName { get; set; }
            public bool? worksetVerified { get; set; }
            public long? familySymbolId { get; set; }
            public long? hostElementId { get; set; }
            public long? linkedHostElementId { get; set; }
            public bool? hostVerified { get; set; }
            public long? levelId { get; set; }
            public bool? levelVerified { get; set; }
            public string? levelIdBasis { get; set; }
            public string? placementBasis { get; set; }
            public long? supportPlaneElementId { get; set; }
            public double? rotationRadians { get; set; }
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
            public List<RequestedParameterEvidence> parameterResults { get; set; } = new List<RequestedParameterEvidence>();
            public bool? parameterVerificationSucceeded { get; set; }
        }

        public sealed class RequestedParameterEvidence
        {
            public string name { get; set; } = "";
            public string requested { get; set; } = "";
            public string? storageType { get; set; }
            public object? before { get; set; }
            public object? expectedInternalValue { get; set; }
            public object? actual { get; set; }
            public bool preCommitVerified { get; set; }
            public bool? postCommitVerified { get; set; }
            public string? error { get; set; }
        }

        private sealed class RequestedParameterExpectation
        {
            public long ParameterId { get; set; }
            public StorageType StorageType { get; set; }
            public object Value { get; set; } = null!;
            public RequestedParameterEvidence Evidence { get; set; } = null!;
        }

        private sealed class HostFacePlacement
        {
            public FamilyInstance Instance { get; set; } = null!;
            public XYZ ProjectedPoint { get; set; } = null!;
            public double ProjectionDistanceFt { get; set; }
        }

        private sealed class ResolvedHostFace
        {
            public Reference Reference { get; set; } = null!;
            public XYZ Point { get; set; } = null!;
            public XYZ Direction { get; set; } = null!;
            public double DistanceFt { get; set; }
        }

        public class PlacementResult
        {
            public OperatorNativeTransactionReceipt transaction { get; set; } = OperatorNativeTransactionReceipt.NotStarted();
            public string status { get; set; } = "Unknown";
            public int parameterVerificationFailedCount { get; set; }
            public bool success => PlacementParameterValues.ResultSucceeded(status, failedCount, parameterVerificationFailedCount);
            public string? familyPlacementType { get; set; }
            public bool requiresExplicitHost { get; set; }
            public bool unhostedWorkPlanePlacementAllowed { get; set; }
            public object? changeTracking { get; set; }
            public IReadOnlyList<OperatorCapturedNativeFailure> capturedFailures { get; set; } = Array.Empty<OperatorCapturedNativeFailure>();
            public bool failureRollbackRequested { get; set; }
            public List<long> supportPlaneElementIds { get; set; } = new List<long>();
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
            var parameterReadbackTargets = new List<(long id, InstanceResult result, List<RequestedParameterExpectation> expectations)>();

            var inventory = new OperatorNativeChangeInventory(doc);
            var failureGuard = new OperatorNativeFailureGuard();
            void Changed(object sender, DocumentChangedEventArgs args) => inventory.Observe(() => args.GetDocument(),
                () => args.GetAddedElementIds().Select(ElementIdCompat.GetValue),
                () => args.GetModifiedElementIds().Select(ElementIdCompat.GetValue),
                () => args.GetDeletedElementIds().Select(ElementIdCompat.GetValue));
            app.Application.DocumentChanged += Changed;
            try
            {
            using (Transaction t = new Transaction(doc, "Batch Place Families"))
            {
                t.Start();
                try
                {
                    NativeNonInteractiveFailureHandling.Configure(t, failureGuard);
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
                        result.selectedWorksetId = RevitBridge.Common.ElementIdCompat.GetValue(requestedWorkset.Id);
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
                    if (!string.IsNullOrWhiteSpace(p.levelName))
                    {
                        defaultLevel = levels.FirstOrDefault(l => l.Name.Equals(p.levelName.Trim(), StringComparison.OrdinalIgnoreCase))
                            ?? throw new Exception($"Level {p.levelName} not found.");
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

                    var plannedOrCreatedPoints = new List<(XYZ point, long? host, long? linked, long? level)>();

                    for (int i = 0; i < (p.instances?.Count ?? 0); i++)
                    {
                        var instData = p.instances[i];
                        var instResult = new InstanceResult { index = i };

                        var coordinates = new[] { instData.x, instData.y, instData.z };
                        AbsolutePlacementCorrection.Delta(coordinates, coordinates); // finite XYZ before native geometry
                        XYZ point = new XYZ(instData.x, instData.y, instData.z);
                        var instanceLevel = defaultLevel;
                        if (!string.IsNullOrWhiteSpace(instData.levelName))
                        {
                            if (!levelByName.TryGetValue(instData.levelName.Trim(), out instanceLevel))
                            {
                                throw new Exception($"Level {instData.levelName} not found.");
                            }
                        }

                        bool generatedWorkPlane = unhostedWorkPlanePlacementAllowed && !instData.hostElementId.HasValue;
                        if (generatedWorkPlane && p.instances.Count > 200)
                            throw new ArgumentException("Provisional work-plane placement is limited to 200 instances per request.");
                        instResult.coordinateMode = FamilyPlacementContract.ResolveCoordinateMode(instData.coordinateMode, generatedWorkPlane);
                        bool usesAbsoluteModelCoordinates = instResult.coordinateMode == "absolute_model";
                        instResult.requestedLocationX = point.X;
                        instResult.requestedLocationY = point.Y;
                        instResult.requestedLocationZ = point.Z;
                        XYZ idempotencyPoint = point;
                        XYZ levelPlacementPoint = point;
                        if (usesAbsoluteModelCoordinates && familyPlacementType != FamilyPlacementType.ViewBased)
                        {
                            // Revit's level-based overload interprets Z as an offset from the supplied level.
                            // Keep the external contract in absolute model coordinates and translate only for
                            // that overload. Hosted and level-free overloads continue to receive absolute XYZ.
                            levelPlacementPoint = new XYZ(point.X, point.Y, point.Z - instanceLevel!.Elevation);
                        }

                        using var instanceScope = new SubTransaction(doc);
                        instanceScope.Start();
                        ReferencePlane? generatedSupport = null;
                        var parameterExpectations = new List<RequestedParameterExpectation>();
                        try
                        {
                            if (instData.linkedHostElementId.HasValue && (!instData.hostElementId.HasValue || instData.linkedHostElementId.Value <= 0))
                                throw new Exception("linkedHostElementId requires a positive linked element ID and hostElementId identifying its RevitLinkInstance.");
                            if (requiresExplicitHost && !instData.hostElementId.HasValue)
                            {
                                throw new Exception(
                                    $"Family {symbol.FamilyName} / {symbol.Name} requires an explicit host " +
                                    $"({familyPlacementType}); provide hostElementId or use a hosted-placement workflow.");
                            }

                            Element? resolvedHost = null;
                            ResolvedHostFace? resolvedFace = null;
                            if (instData.hostElementId.HasValue)
                            {
                                resolvedHost = doc.GetElement(ToElementId(instData.hostElementId.Value));
                                if (resolvedHost == null || resolvedHost is ElementType)
                                    throw new Exception("The requested host is unavailable or is not a model instance.");
                                // Validate and project before deduplication. Existing instances cannot
                                // make an incomplete host selector valid or change the placement point.
                                LinkedHostPlacementPolicy.Validate(resolvedHost is RevitLinkInstance,
                                    familyPlacementType == FamilyPlacementType.WorkPlaneBased, instData.linkedHostElementId);
                                if (familyPlacementType == FamilyPlacementType.WorkPlaneBased)
                                {
                                    resolvedFace = ResolveClosestHostFace(resolvedHost, point, instData.linkedHostElementId);
                                    idempotencyPoint = resolvedFace.Point;
                                }
                            }

                            if (useIdempotency && toleranceFt > 0.0)
                            {
                                var sameHostExisting = existingPoints.Where(x =>
                                {
                                    var candidate = doc.GetElement(ToElementId(x.id)) as FamilyInstance;
                                    return candidate != null
                                        && (!instData.hostElementId.HasValue || MatchesExplicitHost(candidate, instData.hostElementId.Value, instData.linkedHostElementId))
                                        && (familyPlacementType != FamilyPlacementType.ViewBased || targetView != null && candidate.OwnerViewId == targetView.Id);
                                }).ToList();
                                var sameHostPlanned = plannedOrCreatedPoints
                                    .Where(x => x.host == instData.hostElementId && x.linked == instData.linkedHostElementId && x.level == (instanceLevel == null ? (long?)null : ElementIdCompat.GetValue(instanceLevel.Id)))
                                    .Select(x => x.point).ToList();
                                var match = FindEquivalent(sameHostExisting, sameHostPlanned, idempotencyPoint, toleranceFt);
                                if (match.found)
                                {
                                    if (match.existingElementId.HasValue)
                                    {
                                        var existing = (FamilyInstance)doc.GetElement(ToElementId(match.existingElementId.Value));
                                        if ((resolvedFace != null || generatedWorkPlane) && HostedPlacementUtil.ReadInstanceLevelId(existing) != ElementIdCompat.GetValue(instanceLevel!.Id))
                                            throw new Exception("The matching hosted instance does not retain the requested level; reconcile it before retrying placement.");
                                        parameterExpectations = ApplyRequestedParameters(doc, existing, instData.parameters, instResult, apply: false);
                                        VerifyRequestedParameters(existing, parameterExpectations, instResult, afterCommit: false);
                                        PopulateNativeReadback(doc, targetView, existing, instResult);
                                        instResult.hostElementId = instData.hostElementId;
                                        instResult.linkedHostElementId = instData.linkedHostElementId;
                                        instResult.hostVerified = instData.hostElementId.HasValue ? true : (bool?)null;
                                        instResult.levelId = HostedPlacementUtil.ReadInstanceLevelId(existing);
                                        instResult.levelVerified = resolvedFace != null || generatedWorkPlane ? true : (bool?)null;
                                        if (generatedWorkPlane)
                                        {
                                            var existingPoint = TryGetLocationPoint(existing);
                                            if (existingPoint == null || !AbsolutePlacementCorrection.Matches(coordinates, new[] { existingPoint.X, existingPoint.Y, existingPoint.Z }))
                                                throw new Exception("The matching provisional instance does not retain exact requested XYZ; reconcile it before retrying placement.");
                                            instResult.absoluteModelLocationVerified = true;
                                            instResult.placementBasis = "existing_instance_readback";
                                        }
                                    }
                                    if (!match.existingElementId.HasValue && instData.parameters?.Count > 0)
                                        throw new Exception("A same-request duplicate cannot establish requested parameter identity; reconcile the duplicate instance.");
                                    instResult.status = "skipped";
                                    instResult.elementId = match.existingElementId;
                                    instResult.reason = "idempotent: matching instance exists within tolerance";
                                    if (instanceScope.Commit() != TransactionStatus.Committed)
                                        throw new Exception("Idempotent placement scope did not settle.");
                                    if (!p.dryRun && match.existingElementId.HasValue && parameterExpectations.Count > 0)
                                        parameterReadbackTargets.Add((match.existingElementId.Value, instResult, parameterExpectations));
                                    result.skippedCount++;
                                    result.results.Add(instResult);
                                    continue;
                                }
                            }

                            FamilyInstance fi = null;
                            XYZ actualPlacementPoint = point;
                            if (instData.hostElementId.HasValue)
                            {
                                Element host = resolvedHost!;
                                if (host == null) throw new Exception($"Host element {instData.hostElementId.Value} not found.");
                                if (host is ElementType) throw new Exception($"Host element {instData.hostElementId.Value} is an element type; expected an instance element.");
                                LinkedHostPlacementPolicy.Validate(host is RevitLinkInstance,
                                    familyPlacementType == FamilyPlacementType.WorkPlaneBased, instData.linkedHostElementId);

                                try
                                {
                                    if (familyPlacementType == FamilyPlacementType.WorkPlaneBased)
                                    {
                                        var facePlacement = PlaceOnResolvedHostFace(doc, resolvedFace!, symbol);
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

                            if (fi == null && generatedWorkPlane)
                            {
                                generatedSupport = CreateHorizontalSupportPlane(doc, targetView, instanceLevel!, point);
                                resolvedFace = ResolveClosestHostFace(generatedSupport, point, null);
                                var placed = PlaceOnResolvedHostFace(doc, resolvedFace, symbol);
                                fi = placed.Instance;
                                actualPlacementPoint = placed.ProjectedPoint;
                                instResult.placementBasis = "generated_horizontal_reference_plane";
                                instResult.warnings.Add("Provisional generated support plane; no architectural ceiling hosting is claimed.");
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
                            if (resolvedFace != null && !HostedPlacementUtil.ApplyResolvedLevelToFaceHostedInstance(fi, instanceLevel!, instResult.warnings))
                            {
                                doc.Delete(fi.Id);
                                throw new Exception("Face-hosted placement did not retain the requested level; placement was discarded.");
                            }

                            if (requestedWorkset != null)
                            {
                                AssignAndVerifyWorkset(fi, requestedWorkset);
                                instResult.worksetId = RevitBridge.Common.ElementIdCompat.GetValue(requestedWorkset.Id);
                                instResult.worksetName = requestedWorkset.Name;
                                instResult.worksetVerified = true;
                            }

                            if (instData.hostElementId.HasValue && !MatchesExplicitHost(fi, instData.hostElementId.Value, instData.linkedHostElementId))
                            {
                                doc.Delete(fi.Id);
                                throw new Exception(
                                    $"Revit created {symbol.FamilyName} / {symbol.Name} without the requested host " +
                                    $"{instData.hostElementId.Value}; placement was discarded.");
                            }
                            if (instData.hostElementId.HasValue)
                            {
                                instResult.hostElementId = instData.hostElementId;
                                instResult.linkedHostElementId = instData.linkedHostElementId;
                                instResult.hostVerified = true;
                            }

                            if (usesAbsoluteModelCoordinates &&
                                !instData.hostElementId.HasValue && resolvedFace == null &&
                                familyPlacementType != FamilyPlacementType.ViewBased)
                            {
                                instResult.absoluteModelCorrectionDistanceFt =
                                    AlignAndVerifyAbsoluteModelLocation(doc, fi, point);
                                instResult.absoluteModelLocationVerified = true;
                                actualPlacementPoint = point;
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

                            parameterExpectations = ApplyRequestedParameters(doc, fi, instData.parameters, instResult, apply: true);

                            SetParameter(fi, "ROS_AutoGenerated", "1");
                            doc.Regenerate();
                            VerifyRequestedParameters(fi, parameterExpectations, instResult, afterCommit: false);
                            PopulateNativeReadback(doc, targetView, fi, instResult);
                            if (resolvedFace != null)
                            {
                                instResult.levelId = HostedPlacementUtil.ReadInstanceLevelId(fi);
                                instResult.levelVerified = instResult.levelId == ElementIdCompat.GetValue(instanceLevel!.Id);
                                if (instResult.levelVerified != true)
                                {
                                    doc.Delete(fi.Id);
                                    throw new Exception("Face-hosted placement lost the requested level after parameters and regeneration.");
                                }
                            }
                            if (resolvedFace != null)
                            {
                                var expectedHostId = generatedSupport == null ? instData.hostElementId!.Value : ElementIdCompat.GetValue(generatedSupport.Id);
                                if (!MatchesExplicitHost(fi, expectedHostId, instData.linkedHostElementId)
                                    || !instResult.locationX.HasValue || !instResult.locationY.HasValue || !instResult.locationZ.HasValue
                                    || !AbsolutePlacementCorrection.Matches(
                                        new[] { actualPlacementPoint.X, actualPlacementPoint.Y, actualPlacementPoint.Z },
                                        new[] { instResult.locationX.Value, instResult.locationY.Value, instResult.locationZ.Value }))
                                {
                                    doc.Delete(fi.Id);
                                    throw new Exception("Linked-face placement did not retain the exact host and projected model-space point after regeneration.");
                                }
                                instResult.absoluteModelLocationVerified = true;
                                if (generatedSupport != null)
                                {
                                    FamilyPlacementContract.VerifySupportedPlacement(coordinates,
                                        new[] { instResult.locationX!.Value, instResult.locationY!.Value, instResult.locationZ!.Value },
                                        ElementIdCompat.GetValue(instanceLevel!.Id), instResult.levelId, expectedHostId,
                                        MatchesExplicitHost(fi, expectedHostId, null) ? expectedHostId : (long?)null);
                                    instResult.hostVerified = true;
                                }
                            }
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
                            if (instanceScope.Commit() != TransactionStatus.Committed)
                                throw new Exception("Family instance scope did not commit.");
                            plannedOrCreatedPoints.Add((idempotencyPoint, instData.hostElementId, instData.linkedHostElementId, instanceLevel == null ? (long?)null : ElementIdCompat.GetValue(instanceLevel.Id)));

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
                                if (parameterExpectations.Count > 0)
                                    parameterReadbackTargets.Add((ElementIdCompat.GetValue(fi.Id), instResult, parameterExpectations));
                                if (generatedSupport != null)
                                {
                                    var supportId = ElementIdCompat.GetValue(generatedSupport.Id);
                                    result.supportPlaneElementIds.Add(supportId);
                                    instResult.supportPlaneElementId = supportId;
                                    instResult.hostElementId = supportId;
                                }
                            }

                            result.results.Add(instResult);
                        }
                        catch (Exception ex)
                        {
                            if (instanceScope.GetStatus() == TransactionStatus.Started)
                            {
                                if (instanceScope.RollBack() != TransactionStatus.RolledBack)
                                    throw new Exception("Failed instance rollback was not confirmed.", ex);
                            }
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
                        var observed = t.RollBack();
                        result.transaction = OperatorNativeTransactionReceipt.FromObservedStatus(observed.ToString(), result.elementIds);
                        if (observed != TransactionStatus.RolledBack) throw new Exception("Family preview rollback was not confirmed.");
                    }
                    else
                    {
                        result.status = result.failedCount > 0 ? "PlacedWithErrors" : "Placed";
                        var observed = t.Commit();
                        result.transaction = OperatorNativeTransactionReceipt.FromObservedStatus(observed.ToString(), result.elementIds);
                        if (observed != TransactionStatus.Committed) throw new Exception("Family placement commit was not confirmed.");
                        result.transaction = inventory.CommittedReceipt().WithNativeCreatedElements(result.elementIds.Concat(result.supportPlaneElementIds));
                        // A post-commit mismatch is a failed intent with known committed effects, never a rollback claim.
                        foreach (var target in parameterReadbackTargets)
                        {
                            try
                            {
                                var committedElement = doc.GetElement(ToElementId(target.id));
                                VerifyRequestedParameters(committedElement, target.expectations, target.result, afterCommit: true);
                            }
                            catch (Exception verificationError)
                            {
                                target.result.parameterVerificationSucceeded = false;
                                target.result.reason = verificationError.Message;
                                result.parameterVerificationFailedCount++;
                                result.status = "PlacedWithErrors";
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    result.status = "Failed";
                    result.error = ex.Message;
                    try { if (t.GetStatus() == TransactionStatus.Started) t.RollBack(); } catch { }
                    result.transaction = OperatorNativeTransactionReceipt.FromObservedStatus(t.GetStatus().ToString(), result.elementIds);
                    if (t.GetStatus() == TransactionStatus.Committed)
                        result.transaction = inventory.CommittedReceipt().WithNativeCreatedElements(result.elementIds.Concat(result.supportPlaneElementIds));
                    if (t.GetStatus() == TransactionStatus.RolledBack)
                    {
                        result.placedCount = 0;
                        result.elementIds.Clear();
                        result.supportPlaneElementIds.Clear();
                        foreach (var item in result.results.Where(item => item.status == "created"))
                        {
                            item.status = "rolled_back";
                            item.elementId = null;
                            if (item.supportPlaneElementId.HasValue) item.hostElementId = null;
                            item.supportPlaneElementId = null;
                        }
                    }
                }
            }

            }
            finally { app.Application.DocumentChanged -= Changed; }
            result.changeTracking = inventory.Diagnostics();
            result.capturedFailures = failureGuard.Failures;
            result.failureRollbackRequested = failureGuard.RollbackRequested;
            result.warnings.AddRange(failureGuard.Failures.Select(failure => failure.severity + ": " + failure.message));
            return Task.FromResult<object>(result);
        }

        private static ReferencePlane CreateHorizontalSupportPlane(Document doc, View? targetView, Level level, XYZ point)
        {
            // Keep support model-wide; never create it owned by a sheet/drafting view.
            var plan = targetView is ViewPlan supplied && !supplied.IsTemplate && supplied.GenLevel?.Id == level.Id
                ? supplied : new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>()
                    .FirstOrDefault(view => !view.IsTemplate && view.GenLevel?.Id == level.Id);
            if (plan == null) throw new Exception("Provisional work-plane placement requires an existing plan view on the requested level.");
            var support = doc.Create.NewReferencePlane(point - XYZ.BasisX, point + XYZ.BasisX, XYZ.BasisY, plan);
            if (support == null) throw new Exception("Revit did not create the provisional support plane.");
            doc.Regenerate();
            var actual = support.GetPlane();
            if (Math.Abs(Math.Abs(actual.Normal.Normalize().DotProduct(XYZ.BasisZ)) - 1.0) > 1e-7
                || Math.Abs((point - actual.Origin).DotProduct(actual.Normal.Normalize())) > 1e-7)
                throw new Exception("Native support plane is not horizontal at the requested model elevation.");
            support.Name = "Operator provisional support " + ElementIdCompat.GetValue(support.Id);
            return support;
        }

        private static void PopulateNativeReadback(
            Document doc,
            View? targetView,
            FamilyInstance instance,
            InstanceResult result)
        {
            result.familySymbolId = ElementIdCompat.GetValue(instance.GetTypeId());
            result.levelId = HostedPlacementUtil.ReadInstanceLevelId(instance);
            result.levelIdBasis = result.levelId.HasValue ? "native_effective_level" : null;
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
                    result.rotationRadians = locationPoint.Rotation;
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

        private static ResolvedHostFace ResolveClosestHostFace(
            Element host,
            XYZ requestedPoint,
            long? linkedHostElementId)
        {
            if (host is ReferencePlane referencePlane)
            {
                var planeNormal = referencePlane.Normal.Normalize();
                var signedDistance = (requestedPoint - referencePlane.BubbleEnd).DotProduct(planeNormal);
                return new ResolvedHostFace
                {
                    Reference = referencePlane.GetReference() ?? throw new Exception("Reference plane has no placement reference."),
                    Point = requestedPoint - planeNormal.Multiply(signedDistance),
                    Direction = TangentDirection(planeNormal),
                    DistanceFt = Math.Abs(signedDistance)
                };
            }

            var options = new Options
            {
                ComputeReferences = true,
                IncludeNonVisibleObjects = true,
                DetailLevel = ViewDetailLevel.Fine
            };
            var link = host as RevitLinkInstance;
            var transform = link?.GetTotalTransform() ?? Transform.Identity;
            var geometryHost = link == null ? host : link.GetLinkDocument()?.GetElement(ToElementId(linkedHostElementId!.Value));
            if (geometryHost == null || geometryHost is ElementType)
                throw new Exception("The requested linked host element is unavailable or is not a model instance.");
            var localPoint = transform.Inverse.OfPoint(requestedPoint);
            var candidates = new List<(Face face, IntersectionResult projection, double distance)>();
            CollectFaceCandidates(geometryHost.get_Geometry(options), localPoint, candidates);
            var selected = candidates
                .Where(candidate => candidate.face.Reference != null)
                .OrderBy(candidate => candidate.distance)
                .FirstOrDefault();
            if (selected.face == null || selected.projection == null || selected.face.Reference == null)
            {
                throw new Exception($"Host element {RevitBridge.Common.ElementIdCompat.GetValue(host.Id)} has no referenced face near the requested point.");
            }

            var normal = transform.OfVector(selected.face.ComputeNormal(selected.projection.UVPoint)).Normalize();
            var referenceDirection = TangentDirection(normal);
            var placementReference = link == null ? selected.face.Reference : selected.face.Reference.CreateLinkReference(link);
            var modelPoint = transform.OfPoint(selected.projection.XYZPoint);
            return new ResolvedHostFace
            {
                Reference = placementReference,
                Point = modelPoint,
                Direction = referenceDirection,
                DistanceFt = selected.distance
            };
        }

        private static HostFacePlacement PlaceOnResolvedHostFace(Document doc, ResolvedHostFace face, FamilySymbol symbol)
        {
            var instance = doc.Create.NewFamilyInstance(face.Reference, face.Point, face.Direction, symbol);
            if (instance == null) throw new Exception("Revit face-based placement returned no family instance.");
            return new HostFacePlacement { Instance = instance, ProjectedPoint = face.Point, ProjectionDistanceFt = face.DistanceFt };
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
                        if (projection != null && face.IsInside(projection.UVPoint))
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

        private static bool MatchesExplicitHost(FamilyInstance instance, long expectedHostElementId, long? expectedLinkedElementId)
        {
            if (expectedLinkedElementId.HasValue)
            {
                var linkedFace = instance.HostFace;
                return linkedFace != null && LinkedHostPlacementPolicy.Matches(expectedHostElementId, expectedLinkedElementId.Value,
                    RevitBridge.Common.ElementIdCompat.GetValue(linkedFace.ElementId), RevitBridge.Common.ElementIdCompat.GetValue(linkedFace.LinkedElementId));
            }
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

        private static double AlignAndVerifyAbsoluteModelLocation(
            Document doc,
            FamilyInstance instance,
            XYZ requestedPoint)
        {
            const double toleranceFt = 1e-7;
            doc.Regenerate();
            if (instance.Location is not LocationPoint beforeLocation)
            {
                throw new Exception(
                    $"absolute_model placement for element {ElementIdCompat.GetValue(instance.Id)} " +
                    "cannot be verified because Revit did not expose a LocationPoint.");
            }

            var correction = requestedPoint - beforeLocation.Point;
            var correctionDistance = correction.GetLength();
            if (correctionDistance > toleranceFt)
            {
                ElementTransformUtils.MoveElement(doc, instance.Id, correction);
                doc.Regenerate();
            }

            if (instance.Location is not LocationPoint afterLocation)
            {
                throw new Exception(
                    $"absolute_model placement for element {ElementIdCompat.GetValue(instance.Id)} " +
                    "lost its LocationPoint during verification.");
            }

            var residual = afterLocation.Point.DistanceTo(requestedPoint);
            if (residual > toleranceFt)
            {
                throw new Exception(
                    $"absolute_model placement for element {ElementIdCompat.GetValue(instance.Id)} " +
                    $"did not retain the requested point; residual is {residual:0.#########} ft.");
            }

            return correctionDistance;
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
                ? worksets.FirstOrDefault(workset => RevitBridge.Common.ElementIdCompat.GetValue(workset.Id) == requestedId!.Value)
                : null;
            var byName = cleanName.Length > 0
                ? worksets.FirstOrDefault(workset => string.Equals(workset.Name, cleanName, StringComparison.OrdinalIgnoreCase))
                : null;
            if (hasId && byId == null) throw new Exception($"Workset id {requestedId} was not found.");
            if (cleanName.Length > 0 && byName == null) throw new Exception($"Workset '{cleanName}' was not found.");
            if (byId != null && byName != null && RevitBridge.Common.ElementIdCompat.GetValue(byId.Id) != RevitBridge.Common.ElementIdCompat.GetValue(byName.Id))
                throw new Exception($"Requested workset id {requestedId} does not match workset name '{cleanName}'.");
            return byId ?? byName;
        }

        private static void AssignAndVerifyWorkset(Element element, Workset workset)
        {
            var parameter = element.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM);
            if (parameter == null || parameter.IsReadOnly)
                throw new Exception($"Element {ElementIdCompat.GetValue(element.Id)} cannot be assigned to workset '{workset.Name}'.");
            if (!parameter.Set(RevitBridge.Common.ElementIdCompat.GetValue(workset.Id)))
                throw new Exception($"Revit rejected workset '{workset.Name}' for element {ElementIdCompat.GetValue(element.Id)}.");
            if (RevitBridge.Common.ElementIdCompat.GetValue(element.WorksetId) != RevitBridge.Common.ElementIdCompat.GetValue(workset.Id))
                throw new Exception($"Workset verification failed for element {ElementIdCompat.GetValue(element.Id)}.");
        }

        private static List<RequestedParameterExpectation> ApplyRequestedParameters(
            Document doc, Element element, Dictionary<string, string>? requested, InstanceResult result, bool apply)
        {
            var expected = new List<RequestedParameterExpectation>();
            if (requested == null || requested.Count == 0) return expected;
            result.parameterVerificationSucceeded = false;
            foreach (var item in requested)
            {
                var evidence = new RequestedParameterEvidence { name = item.Key, requested = item.Value };
                result.parameterResults.Add(evidence);
                try
                {
                    var parameter = ResolveRequestedParameter(element, item.Key);
                    if (parameter.IsReadOnly) throw new Exception("Parameter is read-only.");
                    evidence.storageType = parameter.StorageType.ToString();
                    evidence.before = ParameterValueUtil.SnapshotForWire(parameter);
                    var value = ParseRequestedParameterValue(doc, parameter, item.Value);
                    evidence.expectedInternalValue = value;
                    var expectation = new RequestedParameterExpectation
                    {
                        ParameterId = ElementIdCompat.GetValue(parameter.Id),
                        StorageType = parameter.StorageType,
                        Value = value,
                        Evidence = evidence
                    };
                    expected.Add(expectation);
                    if (RequestedParameterMatches(parameter, expectation)) continue;
                    if (!apply) throw new Exception("The existing instance does not have the requested value; reconcile it before retrying placement.");
                    bool accepted;
                    switch (parameter.StorageType)
                    {
                        case StorageType.Double: accepted = parameter.Set((double)value); break;
                        case StorageType.Integer: accepted = parameter.Set((int)value); break;
                        case StorageType.String: accepted = parameter.Set((string)value); break;
                        case StorageType.ElementId: accepted = parameter.Set(ElementIdCompat.Create((long)value)); break;
                        default: throw new Exception("Unsupported parameter storage type.");
                    }
                    if (!accepted) throw new Exception("Revit rejected the requested value (Set returned false).");
                }
                catch (Exception error)
                {
                    evidence.error = error.Message;
                    throw new Exception($"Requested parameter '{item.Key}' failed: {error.Message}", error);
                }
            }
            return expected;
        }

        private static Parameter ResolveRequestedParameter(Element element, string name)
        {
            if (element == null) throw new Exception("Element could not be re-resolved.");
            var matches = element.GetParameters(name);
            if (matches == null || matches.Count == 0) throw new Exception("Requested parameter was not found.");
            if (matches.Count != 1) throw new Exception("Requested parameter name is ambiguous.");
            return matches[0];
        }

        private static object ParseRequestedParameterValue(Document doc, Parameter parameter, string value)
        {
            switch (parameter.StorageType)
            {
                case StorageType.String: return value;
                case StorageType.Integer:
                    if (int.TryParse(value, out var integer)) return integer;
                    throw new Exception("Invalid integer value.");
                case StorageType.ElementId:
                    // Preserve this handler's existing range and numeric interpretation.
                    if (long.TryParse(value, out var id) && id >= int.MinValue && id <= int.MaxValue) return id;
                    throw new Exception("Invalid element identifier.");
                case StorageType.Double:
                    return PlacementParameterValues.ParseDouble(value, formatted =>
                    {
                        var spec = parameter.Definition?.GetDataType();
                        return spec != null && UnitFormatUtils.TryParse(doc.GetUnits(), spec, formatted, out var parsed)
                            ? (double?)parsed : null;
                    });
                default: throw new Exception("Unsupported parameter storage type.");
            }
        }

        private static bool RequestedParameterMatches(Parameter parameter, RequestedParameterExpectation expected)
        {
            if (parameter.StorageType != expected.StorageType || ElementIdCompat.GetValue(parameter.Id) != expected.ParameterId)
                throw new Exception("Parameter identity or storage type changed.");
            switch (expected.StorageType)
            {
                case StorageType.String: return string.Equals(parameter.AsString() ?? "", (string)expected.Value, StringComparison.Ordinal);
                case StorageType.Integer: return parameter.AsInteger() == (int)expected.Value;
                case StorageType.ElementId: return ElementIdCompat.GetValue(parameter.AsElementId()) == (long)expected.Value;
                case StorageType.Double:
                    return PlacementParameterValues.MatchesDouble(parameter.AsDouble(), (double)expected.Value);
                default: throw new Exception("Unsupported parameter storage type.");
            }
        }

        private static void VerifyRequestedParameters(
            Element element, List<RequestedParameterExpectation> expected, InstanceResult result, bool afterCommit)
        {
            if (expected.Count == 0) return;
            result.parameterVerificationSucceeded = false;
            foreach (var item in expected)
            {
                try
                {
                    var parameter = ResolveRequestedParameter(element, item.Evidence.name);
                    item.Evidence.actual = ParameterValueUtil.SnapshotForWire(parameter);
                    if (!RequestedParameterMatches(parameter, item)) throw new Exception("Numeric/typed readback did not match the requested value.");
                    if (afterCommit) item.Evidence.postCommitVerified = true;
                    else item.Evidence.preCommitVerified = true;
                }
                catch (Exception error)
                {
                    if (afterCommit) item.Evidence.postCommitVerified = false;
                    item.Evidence.error = error.Message;
                    throw new Exception($"Requested parameter '{item.Evidence.name}' verification failed: {error.Message}", error);
                }
            }
            result.parameterVerificationSucceeded = true;
        }

        // Existing optional internal marker behavior is retained. User parameters use the verified path above.
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
