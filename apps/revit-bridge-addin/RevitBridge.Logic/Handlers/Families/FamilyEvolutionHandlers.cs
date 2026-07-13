using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Common.FamilyEvolution;
using RevitBridge.Logic.Handlers.Core;
using RevitBridge.Logic.Handlers.MEP;

namespace RevitBridge.Logic.Handlers
{
    public sealed class FamilyEvolutionClearanceSpec
    {
        public string side { get; set; } = "power_connection";
        public string offset { get; set; } = "36 in";
        public string lineStyleName { get; set; } = "Operator - Clearance Light Dashed";
        public string linePatternName { get; set; } = "Operator - Clearance Dash";
        public int lineWeight { get; set; } = 1;
        public int red { get; set; } = 160;
        public int green { get; set; } = 160;
        public int blue { get; set; } = 160;
    }

    public class FamilyEvolutionRequest
    {
        public long instanceId { get; set; }
        public string? expectedUniqueId { get; set; }
        public string? expectedMark { get; set; }
        public string? expectedFamilyName { get; set; }
        public string? expectedTypeName { get; set; }
        public string newFamilyName { get; set; } = "";
        public string newTypeName { get; set; } = "";
        public string widthParameterName { get; set; } = "Width";
        public string depthParameterName { get; set; } = "Length";
        public string width { get; set; } = "";
        public string depth { get; set; } = "";
        public FamilyEvolutionClearanceSpec? clearance { get; set; }
        public string? familySavePath { get; set; }
    }

    public sealed class PlanFamilyEvolutionHandler : IRequestHandler
    {
        public sealed class Params : FamilyEvolutionRequest { }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = FamilyEvolutionService.Deserialize<Params>(jsonData);
            var plan = FamilyEvolutionService.Prepare(app, request);
            return Task.FromResult<object>(FamilyEvolutionService.ToPlanReceipt(plan));
        }
    }

    public sealed class ApplyFamilyEvolutionHandler : IRequestHandler
    {
        public sealed class Params : FamilyEvolutionRequest
        {
            public string planHash { get; set; } = "";
            public string confirm { get; set; } = "";
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = FamilyEvolutionService.Deserialize<Params>(jsonData);
            var plan = FamilyEvolutionService.Prepare(app, request);
            if (!string.Equals((request.planHash ?? "").Trim(), plan.PlanHash, StringComparison.Ordinal))
                throw new OperatorToolUserErrorException(
                    "Family evolution plan is stale or does not match this request.",
                    "family_evolution_plan_hash_mismatch");

            var requiredConfirm = FamilyEvolutionService.RequiredConfirm(plan.InstanceId);
            if (!BulkConfirmUtil.EqualsNormalized(request.confirm, requiredConfirm))
                throw new OperatorToolUserErrorException(
                    "Family evolution requires typed confirmation.",
                    "family_evolution_confirm_required",
                    requiredConfirm: requiredConfirm,
                    confirmReceived: BulkConfirmUtil.Normalize(request.confirm));

            return Task.FromResult<object>(FamilyEvolutionService.Apply(app, plan, requiredConfirm));
        }
    }

    public sealed class ReadFamilyEvolutionHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long instanceId { get; set; }
            public string widthParameterName { get; set; } = "Width";
            public string depthParameterName { get; set; } = "Length";
            public string lineStyleName { get; set; } = "Operator - Clearance Light Dashed";
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = FamilyEvolutionService.Deserialize<Params>(jsonData);
            return Task.FromResult<object>(FamilyEvolutionService.Read(app, request));
        }
    }

    internal static class FamilyEvolutionService
    {
        internal sealed class PreparedPlan
        {
            public Document ProjectDoc = null!;
            public FamilyInstance Instance = null!;
            public FamilySymbol SourceSymbol = null!;
            public Family SourceFamily = null!;
            public long InstanceId;
            public long SourceFamilyId;
            public long SourceTypeId;
            public string InstanceUniqueId = "";
            public string Mark = "";
            public string SourceFamilyName = "";
            public string SourceTypeName = "";
            public string NewFamilyName = "";
            public string NewTypeName = "";
            public string WidthParameterName = "";
            public string DepthParameterName = "";
            public double SourceWidthFt;
            public double SourceDepthFt;
            public double TargetWidthFt;
            public double TargetDepthFt;
            public string TargetWidthDisplay = "";
            public string TargetDepthDisplay = "";
            public bool WidthIsInstance;
            public bool DepthIsInstance;
            public string WidthFormula = "";
            public string DepthFormula = "";
            public bool HasClearance;
            public string ClearanceRequestedSide = "";
            public string ClearanceResolvedSide = "";
            public double ClearanceOffsetFt;
            public string ClearanceOffsetDisplay = "";
            public string LineStyleName = "";
            public string LinePatternName = "";
            public int LineWeight;
            public int Red;
            public int Green;
            public int Blue;
            public double? ConnectorLocalX;
            public double? ConnectorLocalY;
            public List<ClearanceSegment> ClearanceSegments = new List<ClearanceSegment>();
            public string SavePath = "";
            public bool SavePathExists;
            public string PlanHash = "";
            public string FamilyContentFingerprint = "";
            public bool ProjectFamilyNameExists;
        }

        private sealed class FamilyLoadOptions : IFamilyLoadOptions
        {
            public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues)
            {
                overwriteParameterValues = false;
                return false;
            }

            public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues)
            {
                source = FamilySource.Family;
                overwriteParameterValues = false;
                return false;
            }
        }

        internal static T Deserialize<T>(string jsonData) where T : new()
        {
            if (string.IsNullOrWhiteSpace(jsonData)) return new T();
            return JsonSerializer.Deserialize<T>(jsonData) ?? new T();
        }

        internal static PreparedPlan Prepare(UIApplication app, FamilyEvolutionRequest request)
        {
            if (request.instanceId <= 0) throw new ArgumentException("instanceId is required.");
            var newFamilyName = RequiredName(request.newFamilyName, "newFamilyName");
            var newTypeName = RequiredName(request.newTypeName, "newTypeName");
            var widthParameterName = RequiredName(request.widthParameterName, "widthParameterName");
            var depthParameterName = RequiredName(request.depthParameterName, "depthParameterName");
            var expectedUniqueId = RequiredName(request.expectedUniqueId, "expectedUniqueId");
            var expectedFamilyName = RequiredName(request.expectedFamilyName, "expectedFamilyName");
            var expectedTypeName = RequiredName(request.expectedTypeName, "expectedTypeName");

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Open a project document before planning family evolution.");
            var instance = doc.GetElement(ElementIdCompat.Create(request.instanceId)) as FamilyInstance
                ?? throw new InvalidOperationException($"Element {request.instanceId} is not a FamilyInstance.");
            var symbol = doc.GetElement(instance.GetTypeId()) as FamilySymbol
                ?? throw new InvalidOperationException($"Element {request.instanceId} does not have a FamilySymbol type.");
            var family = symbol.Family ?? throw new InvalidOperationException("Selected FamilySymbol has no Family.");
            var mark = instance.LookupParameter("Mark")?.AsString() ?? "";

            MatchExpected("unique id", expectedUniqueId, instance.UniqueId ?? "");
            MatchExpected("Mark", request.expectedMark, mark);
            MatchExpected("family", expectedFamilyName, family.Name);
            MatchExpected("type", expectedTypeName, symbol.Name);
            if (string.Equals(newFamilyName, family.Name, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("newFamilyName must differ from the resolved source family so the source family is not overwritten.");

            if (!LengthTextUtil.TryParseLengthToFeet(doc, request.width, out var targetWidth, out var widthError))
                throw new ArgumentException("width is invalid: " + widthError);
            if (!LengthTextUtil.TryParseLengthToFeet(doc, request.depth, out var targetDepth, out var depthError))
                throw new ArgumentException("depth is invalid: " + depthError);
            if (targetWidth <= 0 || targetDepth <= 0) throw new ArgumentException("width and depth must be positive.");

            var plan = new PreparedPlan
            {
                ProjectDoc = doc,
                Instance = instance,
                SourceSymbol = symbol,
                SourceFamily = family,
                InstanceId = request.instanceId,
                SourceFamilyId = ElementIdCompat.GetValue(family.Id),
                SourceTypeId = ElementIdCompat.GetValue(symbol.Id),
                InstanceUniqueId = instance.UniqueId ?? "",
                Mark = mark,
                SourceFamilyName = family.Name ?? "",
                SourceTypeName = symbol.Name ?? "",
                NewFamilyName = newFamilyName,
                NewTypeName = newTypeName,
                WidthParameterName = widthParameterName,
                DepthParameterName = depthParameterName,
                TargetWidthFt = targetWidth,
                TargetDepthFt = targetDepth,
                TargetWidthDisplay = request.width ?? "",
                TargetDepthDisplay = request.depth ?? ""
            };

            plan.ProjectFamilyNameExists = new FilteredElementCollector(doc)
                .OfClass(typeof(Family))
                .Cast<Family>()
                .Any(candidate => string.Equals(candidate.Name, newFamilyName, StringComparison.OrdinalIgnoreCase));

            plan.SavePath = ResolveSavePath(request.familySavePath, newFamilyName);
            plan.SavePathExists = File.Exists(plan.SavePath);

            Document? familyDoc = null;
            try
            {
                familyDoc = doc.EditFamily(family);
                var manager = familyDoc.FamilyManager ?? throw new InvalidOperationException("Family document has no FamilyManager.");
                var sourceType = FindFamilyType(manager, symbol.Name)
                    ?? throw new InvalidOperationException($"Family type '{symbol.Name}' was not found in the family document.");
                var widthParameter = FindFamilyParameter(manager, widthParameterName)
                    ?? throw new InvalidOperationException($"Family parameter '{widthParameterName}' was not found.");
                var depthParameter = FindFamilyParameter(manager, depthParameterName)
                    ?? throw new InvalidOperationException($"Family parameter '{depthParameterName}' was not found.");

                plan.WidthIsInstance = widthParameter.IsInstance;
                plan.DepthIsInstance = depthParameter.IsInstance;
                plan.WidthFormula = GetFormula(widthParameter);
                plan.DepthFormula = GetFormula(depthParameter);
                if (plan.WidthIsInstance || plan.DepthIsInstance)
                    throw new InvalidOperationException("Width and depth family parameters must be type parameters.");
                if (plan.WidthFormula.Length > 0 || plan.DepthFormula.Length > 0)
                    throw new InvalidOperationException("Width and depth family parameters must not be formula-driven.");

                plan.SourceWidthFt = ReadFamilyLength(sourceType, widthParameter, widthParameterName);
                plan.SourceDepthFt = ReadFamilyLength(sourceType, depthParameter, depthParameterName);
                plan.FamilyContentFingerprint = ComputeFamilyContentFingerprint(familyDoc, manager);

                if (request.clearance != null)
                {
                    PrepareClearance(instance, request.clearance, plan);
                }
            }
            finally
            {
                if (familyDoc != null)
                {
                    try { familyDoc.Close(false); } catch { }
                }
            }

            plan.PlanHash = ComputeHash(plan);
            return plan;
        }

        private static void PrepareClearance(FamilyInstance instance, FamilyEvolutionClearanceSpec spec, PreparedPlan plan)
        {
            plan.HasClearance = true;
            plan.ClearanceRequestedSide = (spec.side ?? "").Trim().ToLowerInvariant().Replace('-', '_').Replace(' ', '_');
            if (!LengthTextUtil.TryParseLengthToFeet(plan.ProjectDoc, spec.offset, out var offsetFt, out var error) || offsetFt <= 0)
                throw new ArgumentException("clearance.offset is invalid: " + error);
            plan.ClearanceOffsetFt = offsetFt;
            plan.ClearanceOffsetDisplay = spec.offset ?? "";
            plan.LineStyleName = RequiredName(spec.lineStyleName, "clearance.lineStyleName");
            plan.LinePatternName = (spec.linePatternName ?? "").Trim();
            plan.LineWeight = spec.lineWeight;
            plan.Red = spec.red;
            plan.Green = spec.green;
            plan.Blue = spec.blue;
            if (plan.LineWeight < 1 || plan.LineWeight > 16) throw new ArgumentException("clearance.lineWeight must be between 1 and 16.");
            if (!ByteColor(plan.Red) || !ByteColor(plan.Green) || !ByteColor(plan.Blue))
                throw new ArgumentException("clearance color channels must be between 0 and 255.");

            if (plan.ClearanceRequestedSide == "power_connection")
            {
                var electrical = MepSystemUtil.GetConnectors(instance)
                    .Where(connector => connector != null && string.Equals(connector.Domain.ToString(), "DomainElectrical", StringComparison.OrdinalIgnoreCase))
                    .ToList();
                if (electrical.Count != 1)
                    throw new InvalidOperationException($"power_connection requires exactly one electrical connector; found {electrical.Count}.");
                var local = instance.GetTransform().Inverse.OfPoint(electrical[0].Origin);
                plan.ConnectorLocalX = local.X;
                plan.ConnectorLocalY = local.Y;
                plan.ClearanceResolvedSide = FamilyEvolutionPlan.ResolveConnectorSide(local.X, local.Y, plan.SourceWidthFt, plan.SourceDepthFt);
            }
            else
            {
                plan.ClearanceResolvedSide = FamilyEvolutionPlan.NormalizeSide(plan.ClearanceRequestedSide);
            }

            plan.ClearanceSegments = FamilyEvolutionPlan.BuildClearanceRectangle(
                plan.TargetWidthFt,
                plan.TargetDepthFt,
                plan.ClearanceOffsetFt,
                plan.ClearanceResolvedSide).ToList();
        }

        internal static object ToPlanReceipt(PreparedPlan plan)
        {
            return new
            {
                status = plan.SavePathExists || plan.ProjectFamilyNameExists ? "Blocked" : "Planned",
                blocker = plan.SavePathExists
                    ? "family_save_path_exists"
                    : plan.ProjectFamilyNameExists ? "project_family_name_exists" : null,
                planHash = plan.PlanHash,
                requiredConfirm = RequiredConfirm(plan.InstanceId),
                target = new
                {
                    instanceId = plan.InstanceId,
                    uniqueId = plan.InstanceUniqueId,
                    mark = plan.Mark,
                    familyId = plan.SourceFamilyId,
                    familyName = plan.SourceFamilyName,
                    typeId = plan.SourceTypeId,
                    typeName = plan.SourceTypeName
                },
                evolution = new
                {
                    newFamilyName = plan.NewFamilyName,
                    newTypeName = plan.NewTypeName,
                    familySavePath = plan.SavePath,
                    familySavePathExists = plan.SavePathExists,
                    width = ParameterReceipt(plan.WidthParameterName, plan.SourceWidthFt, plan.TargetWidthFt, plan.WidthFormula, plan.WidthIsInstance),
                    depth = ParameterReceipt(plan.DepthParameterName, plan.SourceDepthFt, plan.TargetDepthFt, plan.DepthFormula, plan.DepthIsInstance)
                },
                clearance = plan.HasClearance ? ClearanceReceipt(plan) : null,
                safety = new
                {
                    sourceFamilyWillBeOverwritten = false,
                    projectApplyUsesSingleTransaction = true,
                    projectRollbackReadbackVerified = false,
                    recoveryArtifactRetainedOnProjectFailure = true,
                    selectedInstanceOnly = true
                }
            };
        }

        internal static object Apply(UIApplication app, PreparedPlan plan, string requiredConfirm)
        {
            if (plan.SavePathExists)
                throw new OperatorToolUserErrorException("Family save path already exists; choose a new family name or familySavePath.", "family_save_path_exists");
            if (plan.ProjectFamilyNameExists)
                throw new OperatorToolUserErrorException("A project family already has the planned new family name.", "project_family_name_exists");

            var directory = Path.GetDirectoryName(plan.SavePath);
            if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);
            Document? familyDoc = null;
            var createdCurveIds = new List<long>();
            try
            {
                familyDoc = plan.ProjectDoc.EditFamily(plan.SourceFamily);
                var manager = familyDoc.FamilyManager ?? throw new InvalidOperationException("Family document has no FamilyManager.");
                var currentFingerprint = ComputeFamilyContentFingerprint(familyDoc, manager);
                if (!string.Equals(currentFingerprint, plan.FamilyContentFingerprint, StringComparison.Ordinal))
                    throw new InvalidOperationException("Source family content changed after planning; create a new family-evolution plan.");
                var sourceType = FindFamilyType(manager, plan.SourceTypeName)
                    ?? throw new InvalidOperationException("Source family type is no longer present.");
                if (FindFamilyType(manager, plan.NewTypeName) != null)
                    throw new InvalidOperationException($"Family type '{plan.NewTypeName}' already exists.");
                var widthParameter = FindFamilyParameter(manager, plan.WidthParameterName)
                    ?? throw new InvalidOperationException("Width family parameter is no longer present.");
                var depthParameter = FindFamilyParameter(manager, plan.DepthParameterName)
                    ?? throw new InvalidOperationException("Depth family parameter is no longer present.");

                using (var transaction = new Transaction(familyDoc, "Create selected equipment type and clearance"))
                {
                    transaction.Start();
                    WarningSuppressionUtil.SuppressWarnings(transaction);
                    manager.CurrentType = sourceType;
                    var newType = manager.NewType(plan.NewTypeName)
                        ?? throw new InvalidOperationException("FamilyManager.NewType did not return a family type.");
                    manager.Set(widthParameter, plan.TargetWidthFt);
                    manager.Set(depthParameter, plan.TargetDepthFt);
                    familyDoc.Regenerate();
                    VerifyFamilyLength(newType, widthParameter, plan.TargetWidthFt, plan.WidthParameterName);
                    VerifyFamilyLength(newType, depthParameter, plan.TargetDepthFt, plan.DepthParameterName);

                    if (plan.HasClearance)
                    {
                        var subcategory = EnsureClearanceSubcategory(familyDoc, plan);
                        var plane = Plane.CreateByNormalAndOrigin(XYZ.BasisZ, XYZ.Zero);
                        var sketchPlane = SketchPlane.Create(familyDoc, plane);
                        foreach (var segment in plan.ClearanceSegments)
                        {
                            var line = Line.CreateBound(new XYZ(segment.X1, segment.Y1, 0), new XYZ(segment.X2, segment.Y2, 0));
                            var curve = familyDoc.FamilyCreate.NewSymbolicCurve(line, sketchPlane);
                            curve.Subcategory = subcategory.GetGraphicsStyle(GraphicsStyleType.Projection);
                            createdCurveIds.Add(ElementIdCompat.GetValue(curve.Id));
                        }
                        familyDoc.Regenerate();
                        VerifyClearanceCurves(familyDoc, createdCurveIds, subcategory, plan);
                    }
                    transaction.Commit();
                }

                familyDoc.SaveAs(plan.SavePath, new SaveAsOptions { Compact = true, OverwriteExistingFile = false });
            }
            catch (Exception ex)
            {
                return new
                {
                    status = "Failed",
                    phase = "family_edit_or_save",
                    error = ex.Message,
                    planHash = plan.PlanHash,
                    projectChanged = false,
                    recoveryArtifact = File.Exists(plan.SavePath) ? plan.SavePath : null
                };
            }
            finally
            {
                if (familyDoc != null)
                {
                    try { familyDoc.Close(false); } catch { }
                }
            }

            Family? loadedFamily = null;
            FamilySymbol? loadedSymbol = null;
            long beforeTypeId = ElementIdCompat.GetValue(plan.Instance.GetTypeId());
            try
            {
                using (var transaction = new Transaction(plan.ProjectDoc, "Load selected equipment family and swap instance"))
                {
                    transaction.Start();
                    WarningSuppressionUtil.SuppressWarnings(transaction);
                    var loaded = plan.ProjectDoc.LoadFamily(plan.SavePath, new FamilyLoadOptions(), out loadedFamily);
                    if (!loaded || loadedFamily == null)
                        throw new InvalidOperationException("The cloned family was not loaded as a new family.");
                    if (!string.Equals(loadedFamily.Name, plan.NewFamilyName, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException($"Loaded family name '{loadedFamily.Name}' did not match planned name '{plan.NewFamilyName}'.");
                    loadedSymbol = loadedFamily.GetFamilySymbolIds()
                        .Select(id => plan.ProjectDoc.GetElement(id) as FamilySymbol)
                        .FirstOrDefault(symbol => symbol != null && string.Equals(symbol.Name, plan.NewTypeName, StringComparison.OrdinalIgnoreCase));
                    if (loadedSymbol == null) throw new InvalidOperationException("New family type was not found after loading.");
                    if (!loadedSymbol.IsActive) loadedSymbol.Activate();
                    plan.Instance.ChangeTypeId(loadedSymbol.Id);
                    plan.ProjectDoc.Regenerate();
                    if (ElementIdCompat.GetValue(plan.Instance.GetTypeId()) != ElementIdCompat.GetValue(loadedSymbol.Id))
                        throw new InvalidOperationException("Selected instance did not retain the new family type.");
                    VerifyProjectLength(loadedSymbol, plan.WidthParameterName, plan.TargetWidthFt);
                    VerifyProjectLength(loadedSymbol, plan.DepthParameterName, plan.TargetDepthFt);
                    transaction.Commit();
                }
                try { app.ActiveUIDocument.RefreshActiveView(); } catch { }
            }
            catch (Exception ex)
            {
                var afterTypeId = ElementIdCompat.GetValue(plan.Instance.GetTypeId());
                var loadedFamilyStillPresent = new FilteredElementCollector(plan.ProjectDoc)
                    .OfClass(typeof(Family))
                    .Cast<Family>()
                    .Any(candidate => string.Equals(candidate.Name, plan.NewFamilyName, StringComparison.OrdinalIgnoreCase));
                var rollbackVerified = afterTypeId == beforeTypeId && !loadedFamilyStillPresent;
                return new
                {
                    status = "Failed",
                    phase = "project_load_or_swap",
                    error = ex.Message,
                    planHash = plan.PlanHash,
                    projectChanged = rollbackVerified ? (bool?)false : null,
                    rollback = new { verified = rollbackVerified, beforeTypeId, afterTypeId, clonedFamilyAbsent = !loadedFamilyStillPresent },
                    recoveryArtifact = plan.SavePath,
                    recoveryAction = "Inspect or load the retained RFA manually; the project transaction was rolled back."
                };
            }

            return new
            {
                status = "Applied",
                planHash = plan.PlanHash,
                requiredConfirm,
                instanceId = plan.InstanceId,
                beforeTypeId,
                familyId = ElementIdCompat.GetValue(loadedFamily?.Id),
                familyName = loadedFamily?.Name,
                typeId = ElementIdCompat.GetValue(loadedSymbol?.Id),
                typeName = loadedSymbol?.Name,
                width = ParameterReceipt(plan.WidthParameterName, plan.SourceWidthFt, plan.TargetWidthFt, plan.WidthFormula, plan.WidthIsInstance),
                depth = ParameterReceipt(plan.DepthParameterName, plan.SourceDepthFt, plan.TargetDepthFt, plan.DepthFormula, plan.DepthIsInstance),
                clearance = plan.HasClearance ? ClearanceReceipt(plan) : null,
                createdFamilyCurveIds = createdCurveIds,
                familyArtifact = plan.SavePath,
                projectChanged = true,
                recovery = new { sourceFamilyId = plan.SourceFamilyId, sourceTypeId = plan.SourceTypeId, retainedArtifact = plan.SavePath }
            };
        }

        internal static object Read(UIApplication app, ReadFamilyEvolutionHandler.Params request)
        {
            if (request.instanceId <= 0) throw new ArgumentException("instanceId is required.");
            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;
            var instance = doc.GetElement(ElementIdCompat.Create(request.instanceId)) as FamilyInstance
                ?? throw new InvalidOperationException($"Element {request.instanceId} is not a FamilyInstance.");
            var symbol = doc.GetElement(instance.GetTypeId()) as FamilySymbol
                ?? throw new InvalidOperationException("Selected instance has no FamilySymbol.");
            var family = symbol.Family ?? throw new InvalidOperationException("Selected symbol has no Family.");
            var projectWidth = ReadProjectLength(symbol, request.widthParameterName);
            var projectDepth = ReadProjectLength(symbol, request.depthParameterName);
            var curves = new List<object>();
            long? linePatternId = null;
            string? linePatternName = null;
            int? lineWeight = null;
            int[]? lineColor = null;
            Document? familyDoc = null;
            try
            {
                familyDoc = doc.EditFamily(family);
                foreach (var curve in new FilteredElementCollector(familyDoc).OfClass(typeof(CurveElement)).Cast<CurveElement>())
                {
                    if (curve.CurveElementType != CurveElementType.SymbolicCurve) continue;
                    var graphicsStyle = curve.LineStyle as GraphicsStyle;
                    var subcategory = graphicsStyle?.GraphicsStyleCategory;
                    if (subcategory == null || !string.Equals(subcategory.Name, request.lineStyleName, StringComparison.OrdinalIgnoreCase)) continue;
                    if (!linePatternId.HasValue)
                    {
                        try
                        {
                            var patternId = subcategory.GetLinePatternId(GraphicsStyleType.Projection);
                            linePatternId = ElementIdCompat.GetValue(patternId);
                            linePatternName = (familyDoc.GetElement(patternId) as LinePatternElement)?.Name;
                        }
                        catch { }
                        try { lineWeight = subcategory.GetLineWeight(GraphicsStyleType.Projection); } catch { }
                        try
                        {
                            var color = subcategory.LineColor;
                            lineColor = new[] { (int)color.Red, (int)color.Green, (int)color.Blue };
                        }
                        catch { }
                    }
                    var geometry = curve.GeometryCurve;
                    var start = geometry?.GetEndPoint(0);
                    var end = geometry?.GetEndPoint(1);
                    curves.Add(new
                    {
                        id = ElementIdCompat.GetValue(curve.Id),
                        style = subcategory.Name,
                        start = start == null ? null : new[] { start.X, start.Y, start.Z },
                        end = end == null ? null : new[] { end.X, end.Y, end.Z }
                    });
                }
            }
            finally
            {
                if (familyDoc != null)
                {
                    try { familyDoc.Close(false); } catch { }
                }
            }

            return new
            {
                status = "Read",
                instanceId = request.instanceId,
                uniqueId = instance.UniqueId,
                mark = instance.LookupParameter("Mark")?.AsString(),
                familyId = ElementIdCompat.GetValue(family.Id),
                familyName = family.Name,
                typeId = ElementIdCompat.GetValue(symbol.Id),
                typeName = symbol.Name,
                width = new { parameterName = request.widthParameterName, internalFeet = projectWidth },
                depth = new { parameterName = request.depthParameterName, internalFeet = projectDepth },
                clearance = new
                {
                    lineStyleName = request.lineStyleName,
                    linePatternId,
                    linePatternName,
                    lineWeight,
                    color = lineColor,
                    symbolicCurveCount = curves.Count,
                    symbolicCurves = curves
                }
            };
        }

        internal static string RequiredConfirm(long instanceId) => $"APPLY FAMILY EVOLUTION {instanceId}";

        private static string ComputeHash(PreparedPlan plan)
        {
            var fields = new List<KeyValuePair<string, string>>
            {
                Field("instanceId", plan.InstanceId.ToString(CultureInfo.InvariantCulture)),
                Field("instanceUniqueId", plan.InstanceUniqueId),
                Field("sourceFamilyId", plan.SourceFamilyId.ToString(CultureInfo.InvariantCulture)),
                Field("sourceTypeId", plan.SourceTypeId.ToString(CultureInfo.InvariantCulture)),
                Field("sourceFamilyName", plan.SourceFamilyName),
                Field("sourceTypeName", plan.SourceTypeName),
                Field("familyContentFingerprint", plan.FamilyContentFingerprint),
                Field("mark", plan.Mark),
                Field("newFamilyName", plan.NewFamilyName),
                Field("newTypeName", plan.NewTypeName),
                Field("widthParameter", plan.WidthParameterName),
                Field("depthParameter", plan.DepthParameterName),
                Field("sourceWidthFt", FamilyEvolutionPlan.CanonicalNumber(plan.SourceWidthFt)),
                Field("sourceDepthFt", FamilyEvolutionPlan.CanonicalNumber(plan.SourceDepthFt)),
                Field("targetWidthFt", FamilyEvolutionPlan.CanonicalNumber(plan.TargetWidthFt)),
                Field("targetDepthFt", FamilyEvolutionPlan.CanonicalNumber(plan.TargetDepthFt)),
                Field("savePath", plan.SavePath),
                Field("projectFamilyNameExists", plan.ProjectFamilyNameExists ? "true" : "false"),
                Field("hasClearance", plan.HasClearance ? "true" : "false")
            };
            if (plan.HasClearance)
            {
                fields.Add(Field("clearanceRequestedSide", plan.ClearanceRequestedSide));
                fields.Add(Field("clearanceResolvedSide", plan.ClearanceResolvedSide));
                fields.Add(Field("clearanceOffsetFt", FamilyEvolutionPlan.CanonicalNumber(plan.ClearanceOffsetFt)));
                fields.Add(Field("lineStyleName", plan.LineStyleName));
                fields.Add(Field("linePatternName", plan.LinePatternName));
                fields.Add(Field("lineWeight", plan.LineWeight.ToString(CultureInfo.InvariantCulture)));
                fields.Add(Field("lineColor", $"{plan.Red},{plan.Green},{plan.Blue}"));
                fields.Add(Field("connectorLocalX", plan.ConnectorLocalX.HasValue ? FamilyEvolutionPlan.CanonicalNumber(plan.ConnectorLocalX.Value) : ""));
                fields.Add(Field("connectorLocalY", plan.ConnectorLocalY.HasValue ? FamilyEvolutionPlan.CanonicalNumber(plan.ConnectorLocalY.Value) : ""));
            }
            return FamilyEvolutionPlan.ComputePlanHash(fields);
        }

        private static string ComputeFamilyContentFingerprint(Document familyDoc, FamilyManager manager)
        {
            var fields = new List<KeyValuePair<string, string>>();
            foreach (var familyType in manager.Types.Cast<FamilyType>().OrderBy(type => type.Name, StringComparer.OrdinalIgnoreCase))
            {
                foreach (var parameter in manager.Parameters.Cast<FamilyParameter>()
                    .OrderBy(item => item.Definition?.Name ?? "", StringComparer.OrdinalIgnoreCase))
                {
                    var parameterName = parameter.Definition?.Name ?? "";
                    var value = "";
                    try
                    {
                        switch (parameter.StorageType)
                        {
                            case StorageType.Double:
                                value = familyType.AsDouble(parameter).HasValue
                                    ? FamilyEvolutionPlan.CanonicalNumber(familyType.AsDouble(parameter)!.Value)
                                    : "";
                                break;
                            case StorageType.Integer:
                                value = familyType.AsInteger(parameter)?.ToString(CultureInfo.InvariantCulture) ?? "";
                                break;
                            case StorageType.ElementId:
                                var id = familyType.AsElementId(parameter);
                                value = id == null ? "" : ElementIdCompat.GetValue(id).ToString(CultureInfo.InvariantCulture);
                                break;
                            case StorageType.String:
                                value = familyType.AsString(parameter) ?? "";
                                break;
                        }
                    }
                    catch { value = "<unreadable>"; }
                    fields.Add(Field(
                        $"type:{familyType.Name}:parameter:{parameterName}",
                        $"{parameter.StorageType}|instance={parameter.IsInstance}|formula={GetFormula(parameter)}|value={value}"));
                }
            }

            foreach (var element in new FilteredElementCollector(familyDoc)
                .WhereElementIsNotElementType()
                .OrderBy(element => ElementIdCompat.GetValue(element.Id)))
            {
                var id = ElementIdCompat.GetValue(element.Id);
                var category = element.Category?.Name ?? "";
                var name = "";
                try { name = element.Name ?? ""; } catch { }
                var detail = $"{element.GetType().FullName}|{category}|{name}";
                if (element is CurveElement curve)
                {
                    var geometry = curve.GeometryCurve;
                    if (geometry != null)
                    {
                        detail += "|curve=" + PointKey(geometry.GetEndPoint(0)) + ">" + PointKey(geometry.GetEndPoint(1));
                    }
                }
                else if (element is ReferencePlane referencePlane)
                {
                    detail += "|reference=" + PointKey(referencePlane.BubbleEnd) + ">" + PointKey(referencePlane.FreeEnd);
                }
                fields.Add(Field("element:" + id.ToString(CultureInfo.InvariantCulture), detail));
            }

            if (fields.Count == 0) fields.Add(Field("family", familyDoc.Title ?? ""));
            return FamilyEvolutionPlan.ComputePlanHash(fields);
        }

        private static void VerifyClearanceCurves(
            Document familyDoc,
            IReadOnlyCollection<long> createdCurveIds,
            Category subcategory,
            PreparedPlan plan)
        {
            if (createdCurveIds.Count != plan.ClearanceSegments.Count)
                throw new InvalidOperationException("Clearance curve count did not match the planned rectangle.");

            var actual = new List<ClearanceSegment>();
            foreach (var id in createdCurveIds)
            {
                var curve = familyDoc.GetElement(ElementIdCompat.Create(id)) as CurveElement
                    ?? throw new InvalidOperationException("A created clearance curve could not be read back.");
                if (curve.CurveElementType != CurveElementType.SymbolicCurve)
                    throw new InvalidOperationException("A created clearance curve was not symbolic.");
                var style = (curve.LineStyle as GraphicsStyle)?.GraphicsStyleCategory;
                if (style == null || !string.Equals(style.Name, plan.LineStyleName, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("A created clearance curve did not retain the planned line style.");
                var geometry = curve.GeometryCurve;
                if (geometry == null) throw new InvalidOperationException("A created clearance curve has no geometry.");
                var start = geometry.GetEndPoint(0);
                var end = geometry.GetEndPoint(1);
                actual.Add(new ClearanceSegment(start.X, start.Y, end.X, end.Y));
            }

            foreach (var expected in plan.ClearanceSegments)
            {
                var index = actual.FindIndex(candidate => SameSegment(candidate, expected));
                if (index < 0) throw new InvalidOperationException("Created clearance geometry did not match the planned rectangle.");
                actual.RemoveAt(index);
            }

            if (subcategory.GetLineWeight(GraphicsStyleType.Projection) != plan.LineWeight)
                throw new InvalidOperationException("Clearance line weight readback did not match the plan.");
            var color = subcategory.LineColor;
            if (color.Red != plan.Red || color.Green != plan.Green || color.Blue != plan.Blue)
                throw new InvalidOperationException("Clearance line color readback did not match the plan.");
            if (plan.LinePatternName.Length > 0)
            {
                var patternId = subcategory.GetLinePatternId(GraphicsStyleType.Projection);
                var patternName = (familyDoc.GetElement(patternId) as LinePatternElement)?.Name ?? "";
                if (!string.Equals(patternName, plan.LinePatternName, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Clearance line pattern readback did not match the plan.");
            }
        }

        private static bool SameSegment(ClearanceSegment left, ClearanceSegment right) =>
            SamePoint(left.X1, left.Y1, right.X1, right.Y1) && SamePoint(left.X2, left.Y2, right.X2, right.Y2) ||
            SamePoint(left.X1, left.Y1, right.X2, right.Y2) && SamePoint(left.X2, left.Y2, right.X1, right.Y1);

        private static bool SamePoint(double x1, double y1, double x2, double y2) =>
            Math.Abs(x1 - x2) <= 1e-7 && Math.Abs(y1 - y2) <= 1e-7;

        private static string PointKey(XYZ point) => string.Join(",", new[]
        {
            FamilyEvolutionPlan.CanonicalNumber(point.X),
            FamilyEvolutionPlan.CanonicalNumber(point.Y),
            FamilyEvolutionPlan.CanonicalNumber(point.Z)
        });

        private static Category EnsureClearanceSubcategory(Document familyDoc, PreparedPlan plan)
        {
            var parent = familyDoc.OwnerFamily?.FamilyCategory
                ?? throw new InvalidOperationException("Family category is unavailable.");
            Category? subcategory = null;
            foreach (Category candidate in parent.SubCategories)
            {
                if (candidate != null && string.Equals(candidate.Name, plan.LineStyleName, StringComparison.OrdinalIgnoreCase))
                {
                    subcategory = candidate;
                    break;
                }
            }
            if (subcategory == null)
                subcategory = familyDoc.Settings.Categories.NewSubcategory(parent, plan.LineStyleName);
            subcategory.SetLineWeight(plan.LineWeight, GraphicsStyleType.Projection);
            subcategory.LineColor = new Color((byte)plan.Red, (byte)plan.Green, (byte)plan.Blue);

            if (plan.LinePatternName.Length > 0)
            {
                var pattern = new FilteredElementCollector(familyDoc)
                    .OfClass(typeof(LinePatternElement))
                    .Cast<LinePatternElement>()
                    .FirstOrDefault(element => string.Equals(element.Name, plan.LinePatternName, StringComparison.OrdinalIgnoreCase));
                if (pattern == null)
                {
                    var definition = new LinePattern(plan.LinePatternName);
                    definition.SetSegments(new List<LinePatternSegment>
                    {
                        new LinePatternSegment(LinePatternSegmentType.Dash, 0.5),
                        new LinePatternSegment(LinePatternSegmentType.Space, 0.25)
                    });
                    pattern = LinePatternElement.Create(familyDoc, definition);
                }
                var method = subcategory.GetType().GetMethod(
                    "SetLinePatternId",
                    BindingFlags.Public | BindingFlags.Instance,
                    null,
                    new[] { typeof(ElementId), typeof(GraphicsStyleType) },
                    null);
                if (method == null)
                    throw new InvalidOperationException("This Revit version cannot assign the requested dashed line pattern.");
                method.Invoke(subcategory, new object[] { pattern.Id, GraphicsStyleType.Projection });
            }
            return subcategory;
        }

        private static FamilyType? FindFamilyType(FamilyManager manager, string name) =>
            manager.Types.Cast<FamilyType>().FirstOrDefault(type => string.Equals(type.Name, name, StringComparison.OrdinalIgnoreCase));

        private static FamilyParameter? FindFamilyParameter(FamilyManager manager, string name) =>
            manager.Parameters.Cast<FamilyParameter>().FirstOrDefault(parameter => string.Equals(parameter.Definition?.Name, name, StringComparison.OrdinalIgnoreCase));

        private static string GetFormula(FamilyParameter parameter)
        {
            try
            {
                var property = parameter.GetType().GetProperty("Formula", BindingFlags.Public | BindingFlags.Instance);
                return (property?.GetValue(parameter, null) as string ?? "").Trim();
            }
            catch { return ""; }
        }

        private static double ReadFamilyLength(FamilyType type, FamilyParameter parameter, string name)
        {
            try
            {
                var value = type.AsDouble(parameter);
                if (!value.HasValue || value.Value <= 0) throw new InvalidOperationException();
                return value.Value;
            }
            catch
            {
                throw new InvalidOperationException($"Family parameter '{name}' is not a positive length value on the source type.");
            }
        }

        private static void VerifyFamilyLength(FamilyType type, FamilyParameter parameter, double expected, string name)
        {
            var actual = ReadFamilyLength(type, parameter, name);
            if (Math.Abs(actual - expected) > 1e-7)
                throw new InvalidOperationException($"Family parameter '{name}' readback did not match the requested value.");
        }

        private static double ReadProjectLength(FamilySymbol symbol, string parameterName)
        {
            var parameter = symbol.LookupParameter(parameterName)
                ?? throw new InvalidOperationException($"Project type parameter '{parameterName}' was not found.");
            if (parameter.StorageType != StorageType.Double)
                throw new InvalidOperationException($"Project type parameter '{parameterName}' is not a length value.");
            return parameter.AsDouble();
        }

        private static void VerifyProjectLength(FamilySymbol symbol, string parameterName, double expected)
        {
            var actual = ReadProjectLength(symbol, parameterName);
            if (Math.Abs(actual - expected) > 1e-7)
                throw new InvalidOperationException($"Loaded project type parameter '{parameterName}' did not match the requested value.");
        }

        private static object ParameterReceipt(string name, double before, double after, string formula, bool isInstance) => new
        {
            parameterName = name,
            beforeInternalFeet = before,
            afterInternalFeet = after,
            formula,
            isInstance,
            writableTypeParameter = !isInstance && string.IsNullOrWhiteSpace(formula)
        };

        private static object ClearanceReceipt(PreparedPlan plan) => new
        {
            requestedSide = plan.ClearanceRequestedSide,
            resolvedSide = plan.ClearanceResolvedSide,
            offsetInternalFeet = plan.ClearanceOffsetFt,
            offsetDisplay = plan.ClearanceOffsetDisplay,
            connectorLocal = plan.ConnectorLocalX.HasValue ? new[] { plan.ConnectorLocalX.Value, plan.ConnectorLocalY.GetValueOrDefault() } : null,
            representation = "family_symbolic_plan",
            scope = "cloned_family",
            lineStyleName = plan.LineStyleName,
            linePatternName = plan.LinePatternName,
            lineWeight = plan.LineWeight,
            color = new[] { plan.Red, plan.Green, plan.Blue },
            segments = plan.ClearanceSegments.Select(segment => new[] { segment.X1, segment.Y1, segment.X2, segment.Y2 }).ToList()
        };

        private static string ResolveSavePath(string? requested, string newFamilyName)
        {
            if (!string.IsNullOrWhiteSpace(requested)) return WorkspacePaths.ResolveFileUnderWorkspace(requested);
            var invalid = Path.GetInvalidFileNameChars();
            var safe = new string(newFamilyName.Select(ch => invalid.Contains(ch) ? '_' : ch).ToArray()).Trim();
            if (safe.Length == 0) throw new ArgumentException("newFamilyName cannot produce an empty file name.");
            return WorkspacePaths.ResolveFileUnderWorkspace(Path.Combine("FamilyEvolution", safe + ".rfa"));
        }

        private static string RequiredName(string? value, string field)
        {
            var normalized = (value ?? "").Trim();
            if (normalized.Length == 0) throw new ArgumentException(field + " is required.");
            return normalized;
        }

        private static void MatchExpected(string label, string? expected, string actual)
        {
            if (string.IsNullOrWhiteSpace(expected)) return;
            if (!string.Equals(expected.Trim(), actual ?? "", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"Expected {label} '{expected.Trim()}', but found '{actual}'.");
        }

        private static KeyValuePair<string, string> Field(string key, string value) => new KeyValuePair<string, string>(key, value ?? "");
        private static bool ByteColor(int value) => value >= 0 && value <= 255;
    }
}
