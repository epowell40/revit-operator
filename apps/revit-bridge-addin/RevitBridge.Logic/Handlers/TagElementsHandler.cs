using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Common.Annotation;

namespace RevitBridge.Logic.Handlers
{
    public sealed class TagElementsHandler : IRequestHandler
    {
        public sealed class CategoryTagTypeMap
        {
            public string? categoryName { get; set; }
            public long? tagTypeId { get; set; }
            public string? tagTypeName { get; set; }
            public string? tagFamilyName { get; set; }
        }

        public sealed class TagRequest
        {
            public long? viewId { get; set; }
            public string? viewName { get; set; }
            public List<long>? elementIds { get; set; }
            public List<string>? categoryNames { get; set; }
            public List<CategoryTagTypeMap>? categoryTagTypeMap { get; set; }
            public long? tagTypeId { get; set; }
            public string? tagTypeName { get; set; }
            public string? tagFamilyName { get; set; } // compatibility alias
            public bool? onlyUntagged { get; set; }
            public bool? addLeader { get; set; }
            public string? orientation { get; set; } // horizontal|vertical
            public double? offsetX { get; set; }
            public double? offsetY { get; set; }
            public string? placementMode { get; set; } // offset|geometry_aware
            public string? placementProfile { get; set; } // auto|mep|electrical|architectural
            public double? tagWidthPaperInches { get; set; }
            public double? tagHeightPaperInches { get; set; }
            public double? clearancePaperInches { get; set; }
            public int? maxRepairAttempts { get; set; }
            public bool? autoLoadTagFamily { get; set; }
            public string? tagFamilySourceProjectPath { get; set; }
            public string? tagFamilySourceCategory { get; set; }
            public string? tagFamilySourceFamilyName { get; set; }
            public string? tagFamilySourceTypeName { get; set; }
            public string? generatedTagFamilyName { get; set; }
            public string? generatedTagContentProfile { get; set; } // none|airflow_only
            public bool? ensureTagCategoryVisible { get; set; }
            public bool? inspectTagFamilyElements { get; set; }
            public int? max { get; set; }
            public bool? dryRun { get; set; }
        }

        private sealed class GeometryPlacementPlan
        {
            public Element Target { get; set; } = null!;
            public TagRect2 TargetBounds { get; set; } = null!;
            public IReadOnlyList<TagPlacementCandidate> Candidates { get; set; } = Array.Empty<TagPlacementCandidate>();
            public double PlaneW { get; set; }
            public bool LeaderEnabled { get; set; }
        }

        private sealed class GeometryObstacleSet
        {
            public List<TagRect2> HeadObstacles { get; } = new List<TagRect2>();
            public List<TagRect2> SoftHeadObstacles { get; } = new List<TagRect2>();
            public List<TagRect2> LeaderProtectedObstacles { get; } = new List<TagRect2>();
            public List<TagSegment2> LeaderSegments { get; } = new List<TagSegment2>();
        }

        private sealed class GeometryPlacementOutcome
        {
            public string Status { get; set; } = "not_run";
            public string? Side { get; set; }
            public int Attempts { get; set; }
            public int CollisionCount { get; set; }
            public bool OutsideTarget { get; set; }
            public bool CollisionFree { get; set; }
            public bool LeaderApplied { get; set; }
            public string LeaderGeometryStatus { get; set; } = "not_requested";
            public int LeaderCrossingCount { get; set; }
            public int LeaderProtectedCrossingCount { get; set; }
            public double? LeaderLength { get; set; }
            public TagSegment2? LeaderSegment { get; set; }
            public List<TagSegment2> LeaderSegments { get; set; } = new List<TagSegment2>();
            public int SoftObstacleCount { get; set; }
            public double SoftObstacleArea { get; set; }
            public TagRect2? TargetBounds { get; set; }
            public TagRect2? TagBounds { get; set; }
            public XYZ? TagHeadPosition { get; set; }
            public double? AnchorOffsetU { get; set; }
            public double? AnchorOffsetV { get; set; }
        }

        private sealed class TagFamilyResolution
        {
            public string Status { get; set; } = "missing";
            public string? TargetTagCategory { get; set; }
            public string? SourceTagCategory { get; set; }
            public string? SourceProjectPath { get; set; }
            public string? FamilyName { get; set; }
            public string? TypeName { get; set; }
            public ElementId? TypeId { get; set; }
            public ElementId? FamilyId { get; set; }
            public string? GeneratedFamilyPath { get; set; }
            public string? Error { get; set; }
            public List<TagFamilyCandidate> SourceCandidates { get; set; } = new List<TagFamilyCandidate>();
            public string? ElementInventoryStatus { get; set; }
            public string? ElementInventoryError { get; set; }
            public int ElementInventoryTotalCount { get; set; }
            public bool ElementInventoryTruncated { get; set; }
            public List<TagFamilyElementInventoryItem> ElementInventory { get; set; } = new List<TagFamilyElementInventoryItem>();
            public string ContentProfile { get; set; } = TagFamilyContentPolicy.None;
            public string ContentSanitizationStatus { get; set; } = "not_requested";
            public List<TagFamilyTextElementReceipt> KeptTextElements { get; set; } = new List<TagFamilyTextElementReceipt>();
            public List<TagFamilyTextElementReceipt> RemovedTextElements { get; set; } = new List<TagFamilyTextElementReceipt>();
        }

        private sealed class TagVisibilityOutcome
        {
            public string Status { get; set; } = "not_requested";
            public bool Requested { get; set; }
            public long? CategoryId { get; set; }
            public string? CategoryName { get; set; }
            public long? OwnerViewId { get; set; }
            public string? OwnerViewName { get; set; }
            public string? OwnerKind { get; set; }
            public bool WasHidden { get; set; }
            public bool IsHidden { get; set; }
            public bool Changed { get; set; }
            public string? Error { get; set; }
        }

        private sealed class TagFamilyTextElementReceipt
        {
            public long ElementId { get; set; }
            public string SampleText { get; set; } = "";
        }

        private sealed class TagFamilyElementInventoryItem
        {
            public long ElementId { get; set; }
            public string ElementClass { get; set; } = "";
            public string? Category { get; set; }
            public string? Name { get; set; }
            public List<object> Parameters { get; set; } = new List<object>();
        }

        private sealed class TagFamilyCandidate
        {
            public string FamilyName { get; set; } = "";
            public string TypeName { get; set; } = "";
        }

        private sealed class TagFamilyLoadOptions : IFamilyLoadOptions
        {
            public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues)
            {
                overwriteParameterValues = false;
                return true;
            }

            public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues)
            {
                source = FamilySource.Family;
                overwriteParameterValues = false;
                return true;
            }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new TagRequest()
                : (JsonSerializer.Deserialize<TagRequest>(jsonData) ?? new TagRequest());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var view = ResolveView(doc, p.viewId, p.viewName, app.ActiveUIDocument?.ActiveView);
            if (view == null) throw new InvalidOperationException("tag-elements requires viewId or viewName (or an active view).");

            var max = p.max.GetValueOrDefault(5000);
            if (max < 1) max = 1;
            if (max > 5000) max = 5000;

            var targets = ResolveTargets(doc, view, p, max, out var unresolvedCategories);
            var onlyUntagged = p.onlyUntagged ?? true;
            var placementMode = ResolvePlacementMode(p.placementMode);
            var geometryAware = placementMode == "geometry_aware";
            var placementProfile = ResolvePlacementProfile(p.placementProfile);
            var addLeader = p.addLeader ?? geometryAware;
            var offset = new XYZ(p.offsetX ?? 1.0, p.offsetY ?? 1.0, 0);
            var orientation = ResolveOrientation(p.orientation);
            var dryRun = p.dryRun ?? false;
            var viewScale = Math.Max(1, view.Scale);
            var tagWidth = ResolvePaperInches(p.tagWidthPaperInches, 0.60, 0.05, 4.0) * viewScale / 12.0;
            var tagHeight = ResolvePaperInches(p.tagHeightPaperInches, 0.18, 0.05, 2.0) * viewScale / 12.0;
            var clearance = ResolvePaperInches(p.clearancePaperInches, 0.08, 0.0, 1.0) * viewScale / 12.0;
            var maxRepairAttempts = Math.Max(1, Math.Min(180, p.maxRepairAttempts ?? 180));
            var ensureTagCategoryVisible = p.ensureTagCategoryVisible ?? geometryAware;
            var targetTagCategory = ResolveCommonTargetTagCategory(targets);

            var existingTagged = onlyUntagged
                ? CollectTaggedElementIdsOnView(doc, view.Id)
                : new HashSet<long>();

            var planned = targets
                .Select(e => new
                {
                    elementId = ElementIdCompat.GetValue(e.Id),
                    category = e.Category?.Name,
                    alreadyTagged = existingTagged.Contains(ElementIdCompat.GetValue(e.Id))
                })
                .ToList();

            var skippedAlready = onlyUntagged ? planned.Count(x => x.alreadyTagged) : 0;
            var plannedToTag = onlyUntagged ? planned.Count(x => !x.alreadyTagged) : planned.Count;
            var mapping = ResolveCategoryTagTypeMap(doc, p.categoryTagTypeMap, out var mappingWarnings);
            var defaultTypeId = ResolveDefaultTagTypeId(doc, p.tagTypeId, p.tagTypeName, p.tagFamilyName);
            var tagFamilyResolution = geometryAware && TagWorkPolicy.RequiresFamilyResolution(dryRun, plannedToTag)
                ? ResolveGeometryTagFamily(app.Application, doc, targets, defaultTypeId, p, dryRun)
                : null;
            if (defaultTypeId == null && tagFamilyResolution?.TypeId != null) defaultTypeId = tagFamilyResolution.TypeId;
            if (dryRun && p.inspectTagFamilyElements == true && tagFamilyResolution?.TypeId != null)
                InspectTagFamilyElements(doc, tagFamilyResolution);
            if (!dryRun && plannedToTag > 0 && geometryAware && defaultTypeId == null && p.autoLoadTagFamily == true)
                throw new InvalidOperationException(tagFamilyResolution?.Error ?? "A compatible tag family could not be loaded.");

            var geometryPlans = geometryAware && dryRun
                ? BuildGeometryPlans(doc, view, targets, existingTagged, onlyUntagged, tagWidth, tagHeight, clearance, placementProfile, maxRepairAttempts, addLeader)
                : new Dictionary<long, GeometryPlacementPlan>();
            var tagVisibility = EvaluateTagVisibility(doc, view, targetTagCategory, ensureTagCategoryVisible, dryRun: true);

            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    viewId = ElementIdCompat.GetValue(view.Id),
                    targetCount = planned.Count,
                    plannedToTag,
                    skippedAlreadyTagged = skippedAlready,
                    unresolvedCategories,
                    mappingWarnings,
                    tagFamily = TagFamilyPayload(tagFamilyResolution),
                    tagVisibility,
                    defaultTagTypeId = defaultTypeId == null ? (long?)null : ElementIdCompat.GetValue(defaultTypeId),
                    placementMode,
                    placementProfile = geometryAware ? placementProfile : null,
                    geometry = geometryAware ? new
                    {
                        tagWidthModelFeet = tagWidth,
                        tagHeightModelFeet = tagHeight,
                        clearanceModelFeet = clearance,
                        plannedCount = geometryPlans.Count,
                        plans = geometryPlans.Values.Take(200).Select(BuildGeometryPlanReadback).ToList()
                    } : null,
                    targets = planned.Take(200).ToList()
                });
            }

            var tagIds = new List<long>();
            var tagReadback = new List<object>();
            var errors = new List<object>();
            var skippedNoLocation = 0;
            var geometryOutcomes = new List<GeometryPlacementOutcome>();
            var actualObstacles = geometryAware
                ? CollectGeometryObstacles(doc, view, targets, tagWidth, tagHeight)
                : new GeometryObstacleSet();
            var tagSizeCalibration = new TagSizeCalibration(tagWidth, tagHeight);

            using (var t = new Transaction(doc, "Tag Elements"))
            {
                t.Start();
                tagVisibility = EvaluateTagVisibility(doc, view, targetTagCategory, ensureTagCategoryVisible, dryRun: false);
                if (ensureTagCategoryVisible && !string.IsNullOrWhiteSpace(tagVisibility.Error))
                    throw new InvalidOperationException($"Tag category visibility could not be ensured: {tagVisibility.Error}");
                IEnumerable<Element> orderedTargets = geometryAware
                    ? targets.OrderBy(element => ElementIdCompat.GetValue(element.Id))
                    : targets.AsEnumerable();
                foreach (var element in orderedTargets)
                {
                    var elementId = ElementIdCompat.GetValue(element.Id);
                    if (onlyUntagged && existingTagged.Contains(elementId))
                    {
                        continue;
                    }

                    var geometryPlan = geometryAware
                        ? BuildGeometryPlan(view, element, actualObstacles, tagSizeCalibration.Width, tagSizeCalibration.Height, clearance, placementProfile, maxRepairAttempts, addLeader)
                        : null;
                    var point = geometryPlan?.Candidates.FirstOrDefault() is TagPlacementCandidate firstCandidate
                        ? FromViewCoordinates(view, firstCandidate.HeadX, firstCandidate.HeadY, geometryPlan.PlaneW)
                        : ResolveTagPoint(element, view, offset);
                    if (point == null)
                    {
                        skippedNoLocation++;
                        continue;
                    }

                    try
                    {
                        var mappedTypeId = ResolveMappedTypeForElement(element, mapping);
                        var targetTypeId = mappedTypeId ?? defaultTypeId;
                        if (targetTypeId != null && targetTypeId != ElementId.InvalidElementId &&
                            doc.GetElement(targetTypeId) is FamilySymbol targetSymbol && !targetSymbol.IsActive)
                        {
                            targetSymbol.Activate();
                            doc.Regenerate();
                        }

                        var tag = CreateTagElement(doc, view, element, geometryAware ? false : addLeader, orientation, point);
                        if (targetTypeId != null && targetTypeId != ElementId.InvalidElementId)
                        {
                            try
                            {
                                tag.ChangeTypeId(targetTypeId);
                            }
                            catch
                            {
                                // Keep created tag even if specific type is invalid for this category/view.
                            }
                        }

                        GeometryPlacementOutcome? outcome = null;
                        if (geometryAware && geometryPlan != null && tag is IndependentTag independentTag)
                        {
                            outcome = RepairAndReadGeometryPlacement(
                                doc,
                                view,
                                independentTag,
                                geometryPlan,
                                actualObstacles,
                                clearance,
                                maxRepairAttempts);
                            geometryOutcomes.Add(outcome);
                            var hasMeasurableGeometry = outcome.TagBounds != null && !string.Equals(outcome.Status, "no_geometry", StringComparison.OrdinalIgnoreCase);
                            if (hasMeasurableGeometry && outcome.TagBounds != null)
                            {
                                var measuredWidth = outcome.TagBounds.MaxX - outcome.TagBounds.MinX;
                                var measuredHeight = outcome.TagBounds.MaxY - outcome.TagBounds.MinY;
                                tagSizeCalibration.Observe(measuredWidth, measuredHeight);
                            }
                            if (outcome.CollisionFree && addLeader)
                            {
                                ValidateAppliedLeader(doc, view, independentTag, geometryPlan, actualObstacles, clearance, outcome);
                            }
                            if (!TagWorkPolicy.KeepCreatedTag(geometryAware: true, hasMeasurableGeometry, outcome.CollisionFree))
                            {
                                doc.Delete(tag.Id);
                                errors.Add(new
                                {
                                    elementId,
                                    failureKind = hasMeasurableGeometry
                                        ? (addLeader && (!outcome.LeaderApplied || !string.Equals(outcome.LeaderGeometryStatus, "actual", StringComparison.OrdinalIgnoreCase) || outcome.LeaderCrossingCount > 0 || outcome.LeaderProtectedCrossingCount > 0) ? "tag_unresolved_leader_collision" : "tag_unresolved_collision")
                                        : "tag_no_geometry",
                                    error = hasMeasurableGeometry
                                        ? $"No professionally clear tag/leader position remained after {outcome.Attempts} bounded attempts. The unresolved tag was removed."
                                        : "The selected tag type produced no visible/measurable tag-head geometry. The test tag was removed."
                                });
                                continue;
                            }
                            if (outcome.TagBounds != null)
                            {
                                actualObstacles.HeadObstacles.Add(outcome.TagBounds);
                                actualObstacles.LeaderProtectedObstacles.Add(outcome.TagBounds);
                            }
                            foreach (var leaderSegment in outcome.LeaderSegments) actualObstacles.LeaderSegments.Add(leaderSegment);
                        }
                        else if (geometryAware)
                        {
                            doc.Delete(tag.Id);
                            errors.Add(new
                            {
                                elementId,
                                failureKind = "tag_unsupported_geometry_kind",
                                error = $"Geometry-aware placement is not yet supported for {tag.GetType().Name}. The unverified tag was removed."
                            });
                            continue;
                        }

                        tagIds.Add(ElementIdCompat.GetValue(tag.Id));
                        tagReadback.Add(BuildTagReadback(doc, tag, element, view, outcome));
                        if (onlyUntagged) existingTagged.Add(elementId);
                    }
                    catch (Exception ex)
                    {
                        errors.Add(new { elementId, error = ex.Message });
                    }
                }

                if (tagIds.Count == 0 &&
                    string.Equals(tagFamilyResolution?.Status, "imported", StringComparison.OrdinalIgnoreCase) &&
                    (tagFamilyResolution?.FamilyId != null || tagFamilyResolution?.TypeId != null))
                {
                    try
                    {
                        doc.Delete(tagFamilyResolution.FamilyId ?? tagFamilyResolution.TypeId!);
                        tagFamilyResolution.Status = "import_rejected_no_geometry";
                        tagFamilyResolution.Error = "The imported tag type produced no visible/measurable tag-head geometry and was removed.";
                    }
                    catch (Exception cleanupEx)
                    {
                        tagFamilyResolution.Status = "import_rejected_cleanup_failed";
                        tagFamilyResolution.Error = cleanupEx.Message;
                    }
                }

                t.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                viewId = ElementIdCompat.GetValue(view.Id),
                targetCount = planned.Count,
                taggedCount = tagIds.Count,
                skippedAlreadyTagged = skippedAlready,
                skippedNoLocation,
                errorCount = errors.Count,
                unresolvedCategories,
                mappingWarnings,
                tagFamily = TagFamilyPayload(tagFamilyResolution),
                tagVisibility,
                placementMode,
                placementProfile = geometryAware ? placementProfile : null,
                geometry = geometryAware ? new
                {
                    evaluatedCount = geometryOutcomes.Count,
                    collisionFreeCount = geometryOutcomes.Count(x => x.CollisionFree),
                    repairedCount = geometryOutcomes.Count(x => x.Attempts > 1),
                    unresolvedCollisionCount = geometryOutcomes.Count(x => !x.CollisionFree),
                    leaderAppliedCount = geometryOutcomes.Count(x => x.LeaderApplied),
                    actualLeaderReadbackCount = geometryOutcomes.Count(x => x.LeaderGeometryStatus == "actual"),
                    predictedLeaderFallbackCount = geometryOutcomes.Count(x => x.LeaderGeometryStatus == "predicted_fallback"),
                    unavailableLeaderGeometryCount = geometryOutcomes.Count(x => x.LeaderGeometryStatus == "unavailable"),
                    leaderCrossingCount = geometryOutcomes.Sum(x => x.LeaderCrossingCount),
                    leaderProtectedCrossingCount = geometryOutcomes.Sum(x => x.LeaderProtectedCrossingCount)
                } : null,
                tagIds,
                tags = tagReadback,
                tagReadback,
                errors = errors.Take(200).ToList()
            });
        }

        private static TagVisibilityOutcome EvaluateTagVisibility(
            Document doc,
            View view,
            BuiltInCategory? targetTagCategory,
            bool requested,
            bool dryRun)
        {
            var outcome = new TagVisibilityOutcome { Requested = requested };
            if (!requested) return outcome;
            if (targetTagCategory == null)
            {
                outcome.Status = "unsupported_target_categories";
                outcome.Error = "A single supported target tag category is required to ensure visibility.";
                return outcome;
            }

            try
            {
                var category = doc.Settings.Categories.get_Item(targetTagCategory.Value);
                if (category == null)
                {
                    outcome.Status = "category_not_found";
                    outcome.Error = $"Tag category {targetTagCategory.Value} is not available in this document.";
                    return outcome;
                }

                var templateId = ElementIdCompat.GetValue(view.ViewTemplateId);
                var owner = templateId > 0 ? doc.GetElement(view.ViewTemplateId) as View : view;
                if (owner == null)
                {
                    outcome.Status = "visibility_owner_not_found";
                    outcome.Error = "The view visibility owner could not be resolved.";
                    return outcome;
                }

                var canHide = owner.CanCategoryBeHidden(category.Id);
                var hidden = canHide && owner.GetCategoryHidden(category.Id);
                var decision = TagVisibilityPolicy.Decide(
                    requested,
                    dryRun,
                    ElementIdCompat.GetValue(view.Id),
                    templateId > 0 ? templateId : (long?)null,
                    canHide,
                    hidden);
                outcome.Status = decision.Status;
                outcome.CategoryId = ElementIdCompat.GetValue(category.Id);
                outcome.CategoryName = category.Name;
                outcome.OwnerViewId = decision.OwnerViewId;
                outcome.OwnerViewName = owner.Name;
                outcome.OwnerKind = decision.OwnerKind;
                outcome.WasHidden = decision.WasHidden;
                outcome.IsHidden = hidden;

                if (decision.ApplyChange)
                {
                    owner.SetCategoryHidden(category.Id, false);
                    doc.Regenerate();
                    outcome.IsHidden = owner.GetCategoryHidden(category.Id);
                    outcome.Changed = !outcome.IsHidden;
                    outcome.Status = outcome.Changed ? "shown" : "show_failed";
                    if (!outcome.Changed) outcome.Error = "The tag category remained hidden after the visibility update.";
                }
            }
            catch (Exception ex)
            {
                outcome.Status = "visibility_error";
                outcome.Error = ex.Message;
            }
            return outcome;
        }

        private static string ResolvePlacementMode(string? value)
        {
            var normalized = (value ?? "offset").Trim().ToLowerInvariant();
            return normalized == "geometry_aware" ? "geometry_aware" : "offset";
        }

        private static string ResolvePlacementProfile(string? value)
        {
            var normalized = (value ?? "auto").Trim().ToLowerInvariant();
            return normalized == "mep" || normalized == "electrical" || normalized == "architectural"
                ? normalized
                : "auto";
        }

        private static double ResolvePaperInches(double? value, double fallback, double min, double max)
        {
            var resolved = value ?? fallback;
            if (double.IsNaN(resolved) || double.IsInfinity(resolved)) return fallback;
            return Math.Max(min, Math.Min(max, resolved));
        }

        private static Dictionary<long, GeometryPlacementPlan> BuildGeometryPlans(
            Document doc,
            View view,
            IReadOnlyList<Element> targets,
            ISet<long> existingTagged,
            bool onlyUntagged,
            double tagWidth,
            double tagHeight,
            double clearance,
            string profile,
            int maxCandidates,
            bool leaderEnabled)
        {
            var plans = new Dictionary<long, GeometryPlacementPlan>();
            var obstacles = CollectGeometryObstacles(doc, view, targets, tagWidth, tagHeight);

            foreach (var target in targets.OrderBy(x => ElementIdCompat.GetValue(x.Id)))
            {
                var targetId = ElementIdCompat.GetValue(target.Id);
                if (onlyUntagged && existingTagged.Contains(targetId)) continue;
                var plan = BuildGeometryPlan(view, target, obstacles, tagWidth, tagHeight, clearance, profile, maxCandidates, leaderEnabled);
                if (plan == null) continue;
                plans[targetId] = plan;
                var selected = plan.Candidates.FirstOrDefault(candidate => candidate.CollisionFree);
                if (selected == null) continue;
                obstacles.HeadObstacles.Add(selected.Bounds);
                obstacles.LeaderProtectedObstacles.Add(selected.Bounds);
                if (leaderEnabled && selected.LeaderSegment != null) obstacles.LeaderSegments.Add(selected.LeaderSegment);
            }

            return plans;
        }

        private static GeometryPlacementPlan? BuildGeometryPlan(
            View view,
            Element target,
            GeometryObstacleSet obstacles,
            double tagWidth,
            double tagHeight,
            double clearance,
            string profile,
            int maxCandidates,
            bool leaderEnabled)
        {
            var targetBounds = ToViewRect(target.get_BoundingBox(view), view);
            if (targetBounds == null) return null;
            var center = ResolveElementCenter(target, view);
            if (center == null) return null;
            var candidates = TagPlacementPlanner.RankCandidates(new TagPlacementRequest
            {
                Target = targetBounds,
                Obstacles = obstacles.HeadObstacles,
                SoftObstacles = obstacles.SoftHeadObstacles,
                LeaderProtectedObstacles = obstacles.LeaderProtectedObstacles,
                LeaderSegments = obstacles.LeaderSegments,
                LeaderEnabled = leaderEnabled,
                TagWidth = tagWidth,
                TagHeight = tagHeight,
                Clearance = clearance,
                Profile = profile,
                MaxCandidates = maxCandidates
            });
            if (candidates.Count == 0) return null;
            return new GeometryPlacementPlan
            {
                Target = target,
                TargetBounds = targetBounds,
                Candidates = candidates,
                PlaneW = center.DotProduct(view.ViewDirection.Normalize()),
                LeaderEnabled = leaderEnabled
            };
        }

        private static object BuildGeometryPlanReadback(GeometryPlacementPlan plan)
        {
            var candidate = plan.Candidates.First();
            return new
            {
                targetElementId = ElementIdCompat.GetValue(plan.Target.Id),
                targetBounds = RectPayload(plan.TargetBounds),
                plannedHead = new { u = candidate.HeadX, v = candidate.HeadY },
                plannedBounds = RectPayload(candidate.Bounds),
                side = candidate.Side,
                collisionFree = candidate.CollisionFree,
                collisionCount = candidate.CollisionCount,
                softObstacleCount = candidate.SoftObstacleCount,
                softObstacleArea = candidate.SoftObstacleArea,
                leaderLength = candidate.LeaderLength,
                leaderCrossingCount = candidate.LeaderCrossingCount,
                leaderProtectedCrossingCount = candidate.LeaderProtectedCrossingCount,
                leaderSegment = candidate.LeaderSegment == null ? null : SegmentPayload(candidate.LeaderSegment),
                candidateCount = plan.Candidates.Count
            };
        }

        private static GeometryObstacleSet CollectGeometryObstacles(Document doc, View view, IReadOnlyList<Element> targets, double tagWidth, double tagHeight)
        {
            var obstacles = new GeometryObstacleSet();
            var targetIds = new HashSet<long>(targets.Select(target => ElementIdCompat.GetValue(target.Id)));
            foreach (var target in targets)
            {
                var rect = ToViewRect(target.get_BoundingBox(view), view);
                if (rect == null) continue;
                obstacles.HeadObstacles.Add(rect);
                obstacles.LeaderProtectedObstacles.Add(rect);
            }

            foreach (var element in new FilteredElementCollector(doc, view.Id).WhereElementIsNotElementType())
            {
                if (element?.Category == null) continue;
                if (element.Category.CategoryType == CategoryType.Annotation)
                {
                    TagRect2? rect;
                    if (element is IndependentTag existingTag)
                    {
                        var head = existingTag.TagHeadPosition;
                        var right = view.RightDirection.Normalize();
                        var up = view.UpDirection.Normalize();
                        var centerU = head.DotProduct(right);
                        var centerV = head.DotProduct(up);
                        rect = new TagRect2(centerU - tagWidth * 0.5, centerV - tagHeight * 0.5, centerU + tagWidth * 0.5, centerV + tagHeight * 0.5);
                        if (!AddExistingTagLeaderSegments(view, existingTag, obstacles.LeaderSegments))
                            throw new InvalidOperationException($"Existing leader geometry for tag {ElementIdCompat.GetValue(existingTag.Id)} could not be measured. Geometry-aware placement stopped to avoid an unverified leader crossing.");
                    }
                    else
                    {
                        rect = ToViewRect(element.get_BoundingBox(view), view);
                    }
                    if (rect == null) continue;
                    obstacles.HeadObstacles.Add(rect);
                    obstacles.LeaderProtectedObstacles.Add(rect);
                }
                else if (!targetIds.Contains(ElementIdCompat.GetValue(element.Id)) && IsSoftPlanObstacle(element) && obstacles.SoftHeadObstacles.Count < 3000)
                {
                    var rect = ToViewRect(element.get_BoundingBox(view), view);
                    if (rect != null) obstacles.SoftHeadObstacles.Add(rect);
                }
            }
            return obstacles;
        }

        private static GeometryPlacementOutcome RepairAndReadGeometryPlacement(
            Document doc,
            View view,
            IndependentTag tag,
            GeometryPlacementPlan plan,
            GeometryObstacleSet obstacles,
            double clearance,
            int maxAttempts)
        {
            GeometryPlacementOutcome? best = null;
            TagAnchorCalibration? anchorCalibration = null;
            var attempts = 0;
            foreach (var candidate in TagCandidateProbePolicy.Select(plan.Candidates, maxAttempts))
            {
                attempts++;
                var anchorU = anchorCalibration?.AnchorXForCenter(candidate.HeadX) ?? candidate.HeadX;
                var anchorV = anchorCalibration?.AnchorYForCenter(candidate.HeadY) ?? candidate.HeadY;
                var head = FromViewCoordinates(view, anchorU, anchorV, plan.PlaneW);
                tag.TagHeadPosition = head;
                doc.Regenerate();
                var tagBounds = ToViewRect(tag.get_BoundingBox(view), view);
                if (tagBounds == null) continue;

                if (anchorCalibration == null)
                {
                    anchorCalibration = TagAnchorCalibration.FromMeasurement(anchorU, anchorV, tagBounds);
                    anchorU = anchorCalibration.AnchorXForCenter(candidate.HeadX);
                    anchorV = anchorCalibration.AnchorYForCenter(candidate.HeadY);
                    head = FromViewCoordinates(view, anchorU, anchorV, plan.PlaneW);
                    tag.TagHeadPosition = head;
                    doc.Regenerate();
                    tagBounds = ToViewRect(tag.get_BoundingBox(view), view);
                    if (tagBounds == null) continue;
                }

                var collisionCount = obstacles.HeadObstacles.Count(x => tagBounds.Intersects(x.Inflate(clearance)));
                var softObstacleCount = obstacles.SoftHeadObstacles.Count(rect => tagBounds.Intersects(rect));
                var softObstacleArea = obstacles.SoftHeadObstacles
                    .Where(rect => tagBounds.Intersects(rect))
                    .Sum(tagBounds.IntersectionArea);
                var leaderSegment = plan.LeaderEnabled ? TagPlacementPlanner.BuildLeaderSegment(plan.TargetBounds, tagBounds) : null;
                var leaderCrossingCount = leaderSegment == null ? 0 : obstacles.LeaderSegments.Count(segment => leaderSegment.Intersects(segment));
                var leaderProtectedCrossingCount = leaderSegment == null
                    ? 0
                    : obstacles.LeaderProtectedObstacles.Count(rect => !SameRect(rect, plan.TargetBounds) && leaderSegment.CrossesInterior(rect.Inflate(clearance)));
                var collisionFree = collisionCount == 0 && leaderCrossingCount == 0 && leaderProtectedCrossingCount == 0;
                var outcome = new GeometryPlacementOutcome
                {
                    Status = collisionFree ? (attempts == 1 ? "placed" : "repaired") : "collision",
                    Side = candidate.Side,
                    Attempts = attempts,
                    CollisionCount = collisionCount,
                    SoftObstacleCount = softObstacleCount,
                    SoftObstacleArea = softObstacleArea,
                    LeaderSegment = leaderSegment,
                    LeaderSegments = leaderSegment == null ? new List<TagSegment2>() : new List<TagSegment2> { leaderSegment },
                    LeaderLength = leaderSegment?.Length,
                    LeaderCrossingCount = leaderCrossingCount,
                    LeaderProtectedCrossingCount = leaderProtectedCrossingCount,
                    LeaderGeometryStatus = plan.LeaderEnabled ? "predicted" : "not_requested",
                    OutsideTarget = !tagBounds.Intersects(plan.TargetBounds.Inflate(clearance)),
                    CollisionFree = collisionFree,
                    TargetBounds = plan.TargetBounds,
                    TagBounds = tagBounds,
                    TagHeadPosition = head,
                    AnchorOffsetU = anchorCalibration.OffsetX,
                    AnchorOffsetV = anchorCalibration.OffsetY
                };
                if (best == null || PlacementFailureScore(outcome) < PlacementFailureScore(best) ||
                    (PlacementFailureScore(outcome) == PlacementFailureScore(best) && outcome.SoftObstacleArea < best.SoftObstacleArea)) best = outcome;
                if (outcome.CollisionFree) return outcome;
            }

            if (best != null && best.TagHeadPosition != null)
            {
                tag.TagHeadPosition = best.TagHeadPosition;
                doc.Regenerate();
                best.Status = "unresolved_collision";
                best.Attempts = attempts;
                return best;
            }

            return new GeometryPlacementOutcome
            {
                Status = "no_geometry",
                Attempts = attempts,
                CollisionCount = -1,
                OutsideTarget = false,
                CollisionFree = false,
                TargetBounds = plan.TargetBounds
            };
        }

        private static int PlacementFailureScore(GeometryPlacementOutcome outcome) =>
            Math.Max(0, outcome.CollisionCount) + outcome.LeaderCrossingCount + outcome.LeaderProtectedCrossingCount;

        private static void ValidateAppliedLeader(
            Document doc,
            View view,
            IndependentTag tag,
            GeometryPlacementPlan plan,
            GeometryObstacleSet obstacles,
            double clearance,
            GeometryPlacementOutcome outcome)
        {
            try
            {
                tag.HasLeader = true;
                doc.Regenerate();
                outcome.LeaderApplied = tag.HasLeader;
            }
            catch
            {
                outcome.LeaderApplied = false;
            }

            if (!outcome.LeaderApplied)
            {
                outcome.LeaderGeometryStatus = "apply_failed";
                outcome.CollisionFree = false;
                return;
            }

            var actualSegments = ReadIndependentTagLeaderSegments(tag, view);
            if (actualSegments.Count == 0)
            {
                outcome.LeaderGeometryStatus = "unavailable";
                outcome.CollisionFree = false;
                outcome.Status = "leader_geometry_unavailable";
                return;
            }

            outcome.LeaderGeometryStatus = "actual";
            outcome.LeaderSegments = actualSegments;
            outcome.LeaderSegment = actualSegments.FirstOrDefault();
            outcome.LeaderLength = actualSegments.Sum(segment => segment.Length);
            outcome.LeaderCrossingCount = actualSegments.Sum(segment => obstacles.LeaderSegments.Count(existing => segment.Intersects(existing)));
            outcome.LeaderProtectedCrossingCount = actualSegments.Sum(segment =>
                obstacles.LeaderProtectedObstacles.Count(rect => !SameRect(rect, plan.TargetBounds) && segment.CrossesInterior(rect.Inflate(clearance))));
            outcome.CollisionFree = outcome.CollisionCount == 0 && outcome.LeaderCrossingCount == 0 && outcome.LeaderProtectedCrossingCount == 0;
            if (!outcome.CollisionFree) outcome.Status = "actual_leader_collision";
        }

        private static bool AddExistingTagLeaderSegments(
            View view,
            IndependentTag tag,
            ICollection<TagSegment2> destination)
        {
            if (!tag.HasLeader) return true;
            var actual = ReadIndependentTagLeaderSegments(tag, view);
            if (actual.Count > 0)
            {
                foreach (var segment in actual) destination.Add(segment);
                return true;
            }
            return false;
        }

        private static List<TagSegment2> ReadIndependentTagLeaderSegments(IndependentTag tag, View view)
        {
            var segments = new List<TagSegment2>();
            try
            {
                if (!tag.HasLeader) return segments;
                var head = tag.TagHeadPosition;
                var references = TryReadTaggedReferences(tag);
                if (references.Count > 0)
                {
                    foreach (var reference in references)
                    {
                        var end = TryInvokeXyzMethod(tag, "GetLeaderEnd", reference);
                        var elbow = TryInvokeXyzMethod(tag, "GetLeaderElbow", reference);
                        AddLeaderPath(end, elbow, head, view, segments);
                    }
                }
                else
                {
                    AddLeaderPath(
                        TryReadXyzProperty(tag, "LeaderEnd"),
                        TryReadXyzProperty(tag, "LeaderElbow"),
                        head,
                        view,
                        segments);
                }
            }
            catch
            {
                segments.Clear();
            }
            return segments;
        }

        private static void AddLeaderPath(XYZ? end, XYZ? elbow, XYZ head, View view, ICollection<TagSegment2> destination)
        {
            if (end == null) return;
            if (elbow != null)
            {
                AddLeaderSegment(end, elbow, view, destination);
                AddLeaderSegment(elbow, head, view, destination);
                return;
            }
            AddLeaderSegment(end, head, view, destination);
        }

        private static List<object> TryReadTaggedReferences(IndependentTag tag)
        {
            try
            {
                var method = tag.GetType().GetMethod("GetTaggedReferences", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                if (method?.Invoke(tag, null) is System.Collections.IEnumerable values)
                    return values.Cast<object>().Where(value => value != null).ToList();
            }
            catch
            {
                // Legacy Revit versions expose leader geometry as properties instead.
            }
            return new List<object>();
        }

        private static XYZ? TryInvokeXyzMethod(object source, string methodName, object argument)
        {
            try
            {
                var method = source.GetType().GetMethods(BindingFlags.Instance | BindingFlags.Public)
                    .FirstOrDefault(candidate => candidate.Name == methodName && candidate.GetParameters().Length == 1);
                return method?.Invoke(source, new[] { argument }) as XYZ;
            }
            catch
            {
                return null;
            }
        }

        private static void AddLeaderSegment(XYZ start, XYZ end, View view, ICollection<TagSegment2> destination)
        {
            var right = view.RightDirection.Normalize();
            var up = view.UpDirection.Normalize();
            var segment = new TagSegment2(
                start.DotProduct(right),
                start.DotProduct(up),
                end.DotProduct(right),
                end.DotProduct(up));
            if (segment.Length > 1e-9) destination.Add(segment);
        }

        private static XYZ? TryReadXyzProperty(object source, string propertyName)
        {
            try
            {
                return source.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public)?.GetValue(source, null) as XYZ;
            }
            catch
            {
                return null;
            }
        }

        private static bool IsSoftPlanObstacle(Element element)
        {
            if (element is Wall || element is FamilyInstance) return true;
            var categoryId = ElementIdCompat.GetValue(element.Category?.Id);
            return categoryId == (long)BuiltInCategory.OST_DuctCurves ||
                   categoryId == (long)BuiltInCategory.OST_PipeCurves ||
                   categoryId == (long)BuiltInCategory.OST_CableTray ||
                   categoryId == (long)BuiltInCategory.OST_Conduit ||
                   categoryId == (long)BuiltInCategory.OST_RoomSeparationLines;
        }

        private static bool SameRect(TagRect2 left, TagRect2 right, double tolerance = 1e-9) =>
            Math.Abs(left.MinX - right.MinX) <= tolerance &&
            Math.Abs(left.MinY - right.MinY) <= tolerance &&
            Math.Abs(left.MaxX - right.MaxX) <= tolerance &&
            Math.Abs(left.MaxY - right.MaxY) <= tolerance;

        private static XYZ? ResolveElementCenter(Element element, View view)
        {
            if (element.Location is LocationPoint lp && lp.Point != null) return lp.Point;
            var bbox = element.get_BoundingBox(view);
            if (bbox == null) return null;
            var localCenter = (bbox.Min + bbox.Max) * 0.5;
            return bbox.Transform?.OfPoint(localCenter) ?? localCenter;
        }

        private static TagRect2? ToViewRect(BoundingBoxXYZ? bbox, View view)
        {
            if (bbox == null) return null;
            var right = view.RightDirection.Normalize();
            var up = view.UpDirection.Normalize();
            var points = new List<XYZ>();
            foreach (var x in new[] { bbox.Min.X, bbox.Max.X })
            foreach (var y in new[] { bbox.Min.Y, bbox.Max.Y })
            foreach (var z in new[] { bbox.Min.Z, bbox.Max.Z })
            {
                var localPoint = new XYZ(x, y, z);
                points.Add(bbox.Transform?.OfPoint(localPoint) ?? localPoint);
            }
            return new TagRect2(
                points.Min(p => p.DotProduct(right)),
                points.Min(p => p.DotProduct(up)),
                points.Max(p => p.DotProduct(right)),
                points.Max(p => p.DotProduct(up)));
        }

        private static XYZ FromViewCoordinates(View view, double u, double v, double w)
        {
            var right = view.RightDirection.Normalize();
            var up = view.UpDirection.Normalize();
            var normal = view.ViewDirection.Normalize();
            return right.Multiply(u) + up.Multiply(v) + normal.Multiply(w);
        }

        private static object RectPayload(TagRect2 rect) => new
        {
            minU = rect.MinX,
            minV = rect.MinY,
            maxU = rect.MaxX,
            maxV = rect.MaxY,
            centerU = rect.CenterX,
            centerV = rect.CenterY
        };

        private static object SegmentPayload(TagSegment2 segment) => new
        {
            startU = segment.StartX,
            startV = segment.StartY,
            endU = segment.EndX,
            endV = segment.EndY,
            length = segment.Length
        };

        private static object? TagFamilyPayload(TagFamilyResolution? resolution) => resolution == null ? null : new
        {
            status = resolution.Status,
            targetTagCategory = resolution.TargetTagCategory,
            sourceTagCategory = resolution.SourceTagCategory,
            sourceProjectPath = resolution.SourceProjectPath,
            familyName = resolution.FamilyName,
            typeName = resolution.TypeName,
            typeId = resolution.TypeId == null ? (long?)null : ElementIdCompat.GetValue(resolution.TypeId),
            familyId = resolution.FamilyId == null ? (long?)null : ElementIdCompat.GetValue(resolution.FamilyId),
            generatedFamilyPath = resolution.GeneratedFamilyPath,
            error = resolution.Error,
            elementInventoryStatus = resolution.ElementInventoryStatus,
            elementInventoryError = resolution.ElementInventoryError,
            elementInventoryTotalCount = resolution.ElementInventoryTotalCount,
            elementInventoryTruncated = resolution.ElementInventoryTruncated,
            elementInventory = resolution.ElementInventory.Take(300).Select(x => new
            {
                elementId = x.ElementId,
                elementClass = x.ElementClass,
                category = x.Category,
                name = x.Name,
                parameters = x.Parameters
            }).ToList(),
            contentProfile = resolution.ContentProfile,
            contentSanitizationStatus = resolution.ContentSanitizationStatus,
            keptTextElements = resolution.KeptTextElements.Select(x => new { elementId = x.ElementId, sampleText = x.SampleText }).ToList(),
            removedTextElements = resolution.RemovedTextElements.Select(x => new { elementId = x.ElementId, sampleText = x.SampleText }).ToList(),
            sourceCandidates = resolution.SourceCandidates.Take(100).Select(x => new
            {
                familyName = x.FamilyName,
                typeName = x.TypeName
            }).ToList()
        };

        private static void InspectTagFamilyElements(Document projectDoc, TagFamilyResolution resolution)
        {
            Document? familyDoc = null;
            try
            {
                if (resolution.TypeId == null || projectDoc.GetElement(resolution.TypeId) is not FamilySymbol symbol)
                {
                    resolution.ElementInventoryStatus = "type_unavailable";
                    return;
                }

                familyDoc = projectDoc.EditFamily(symbol.Family);
                if (familyDoc == null) throw new InvalidOperationException("Could not open the selected tag family for read-only inspection.");
                var familyElements = new FilteredElementCollector(familyDoc)
                    .WhereElementIsNotElementType()
                    .ToElements()
                    .OrderBy(TagFamilyInspectionPriority)
                    .ThenBy(element => element.GetType().Name, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(element => ElementIdCompat.GetValue(element.Id))
                    .ToList();
                resolution.ElementInventoryTotalCount = familyElements.Count;
                resolution.ElementInventoryTruncated = familyElements.Count > 300;
                resolution.ElementInventory = familyElements
                    .Take(300)
                    .Select(element => new TagFamilyElementInventoryItem
                    {
                        ElementId = ElementIdCompat.GetValue(element.Id),
                        ElementClass = element.GetType().Name,
                        Category = SafeElementCategoryName(element),
                        Name = SafeElementName(element),
                        Parameters = ReadElementParameterInventory(element)
                    })
                    .ToList();
                resolution.ElementInventoryStatus = "inspected";
            }
            catch (Exception ex)
            {
                resolution.ElementInventoryStatus = "inspection_failed";
                resolution.ElementInventoryError = ex.Message;
            }
            finally
            {
                if (familyDoc != null) try { familyDoc.Close(false); } catch { }
            }
        }

        private static int TagFamilyInspectionPriority(Element element)
        {
            var className = element.GetType().Name;
            if (element is FamilyInstance || element is CurveElement || element is GenericForm || element is Dimension || element is ReferencePlane ||
                className.IndexOf("Label", StringComparison.OrdinalIgnoreCase) >= 0 ||
                className.IndexOf("Text", StringComparison.OrdinalIgnoreCase) >= 0)
                return 0;

            if (element is GraphicsStyle || element is Material || element is FillPatternElement || element is LinePatternElement ||
                element is ParameterElement || element is View || element is Level ||
                className.IndexOf("Asset", StringComparison.OrdinalIgnoreCase) >= 0)
                return 2;

            return 1;
        }

        private static string? SafeElementCategoryName(Element element)
        {
            try { return element.Category?.Name; }
            catch { return null; }
        }

        private static string? SafeElementName(Element element)
        {
            try { return element.Name; }
            catch { return null; }
        }

        private static List<object> ReadElementParameterInventory(Element element)
        {
            var parameters = new List<object>();
            foreach (Parameter parameter in element.Parameters)
            {
                if (parameters.Count >= 30) break;
                try
                {
                    string? value;
                    switch (parameter.StorageType)
                    {
                        case StorageType.Double:
                            value = parameter.AsValueString() ?? parameter.AsDouble().ToString("R");
                            break;
                        case StorageType.Integer:
                            value = parameter.AsValueString() ?? parameter.AsInteger().ToString();
                            break;
                        case StorageType.String:
                            value = parameter.AsString();
                            break;
                        case StorageType.ElementId:
                            value = ElementIdCompat.GetValue(parameter.AsElementId()).ToString();
                            break;
                        default:
                            value = null;
                            break;
                    }

                    parameters.Add(new
                    {
                        name = parameter.Definition?.Name,
                        storageType = parameter.StorageType.ToString(),
                        value,
                        isReadOnly = parameter.IsReadOnly
                    });
                }
                catch
                {
                    // Diagnostic inventory is best-effort per parameter.
                }
            }
            return parameters;
        }

        private static TagFamilyResolution ResolveGeometryTagFamily(
            Autodesk.Revit.ApplicationServices.Application application,
            Document doc,
            IReadOnlyList<Element> targets,
            ElementId? requestedTypeId,
            TagRequest request,
            bool dryRun)
        {
            var targetTagCategory = ResolveCommonTargetTagCategory(targets);
            var contentProfile = TagFamilyContentPolicy.NormalizeProfile(request.generatedTagContentProfile);
            if (targetTagCategory == null)
            {
                return new TagFamilyResolution { Status = "unsupported_target_categories", Error = "Geometry-aware auto-loading requires targets from one supported tag category." };
            }

            if (requestedTypeId != null && doc.GetElement(requestedTypeId) is FamilySymbol requestedSymbol && contentProfile == TagFamilyContentPolicy.None)
            {
                return ResolutionFromSymbol("requested", targetTagCategory.Value, requestedSymbol);
            }

            var exactSourceSelection =
                !string.IsNullOrWhiteSpace(request.tagFamilySourceFamilyName) ||
                !string.IsNullOrWhiteSpace(request.tagFamilySourceTypeName);
            var loaded = exactSourceSelection ? null : new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .OfCategory(targetTagCategory.Value)
                .Cast<FamilySymbol>()
                .OrderBy(x => x.FamilyName ?? string.Empty, StringComparer.OrdinalIgnoreCase)
                .ThenBy(x => x.Name ?? string.Empty, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
            if (loaded != null && contentProfile == TagFamilyContentPolicy.None) return ResolutionFromSymbol("loaded", targetTagCategory.Value, loaded);

            if (request.autoLoadTagFamily != true)
            {
                return new TagFamilyResolution
                {
                    Status = "missing",
                    TargetTagCategory = targetTagCategory.Value.ToString(),
                    Error = "No compatible tag family is loaded. Supply a workspace-scoped source project and set autoLoadTagFamily=true."
                };
            }

            var sourcePathInput = (request.tagFamilySourceProjectPath ?? string.Empty).Trim();
            if (sourcePathInput.Length == 0)
            {
                return new TagFamilyResolution
                {
                    Status = "source_required",
                    TargetTagCategory = targetTagCategory.Value.ToString(),
                    Error = "tagFamilySourceProjectPath is required when autoLoadTagFamily=true."
                };
            }

            var sourcePath = WorkspacePaths.ResolveExistingFileUnderWorkspace(sourcePathInput);
            if (string.Equals(Path.GetFullPath(sourcePath), Path.GetFullPath(doc.PathName ?? string.Empty), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Tag-family source project must differ from the active project.");
            var sourceTagCategory = ResolveBuiltInCategory(request.tagFamilySourceCategory, BuiltInCategory.OST_DoorTags);
            if (sourceTagCategory != targetTagCategory.Value)
            {
                return new TagFamilyResolution
                {
                    Status = "source_category_mismatch",
                    TargetTagCategory = targetTagCategory.Value.ToString(),
                    SourceTagCategory = sourceTagCategory.ToString(),
                    SourceProjectPath = sourcePath,
                    Error = "The source tag category must exactly match the target tag category; cross-category tag cloning is not supported."
                };
            }
            var familyName = SanitizeFamilyName(request.generatedTagFamilyName, DefaultGeneratedTagFamilyName(targetTagCategory.Value));
            return ImportTagFamilyFromSource(
                application,
                doc,
                sourcePath,
                sourceTagCategory,
                targetTagCategory.Value,
                familyName,
                request.tagFamilySourceFamilyName,
                request.tagFamilySourceTypeName,
                contentProfile,
                dryRun);
        }

        private static TagFamilyResolution ImportTagFamilyFromSource(
            Autodesk.Revit.ApplicationServices.Application application,
            Document targetDoc,
            string sourcePath,
            BuiltInCategory sourceTagCategory,
            BuiltInCategory targetTagCategory,
            string familyName,
            string? requestedSourceFamilyName,
            string? requestedSourceTypeName,
            string contentProfile,
            bool dryRun)
        {
            Document? sourceDoc = null;
            Document? familyDoc = null;
            try
            {
                sourceDoc = application.OpenDocumentFile(sourcePath);
                var sourceSymbols = new FilteredElementCollector(sourceDoc)
                    .OfClass(typeof(FamilySymbol))
                    .OfCategory(sourceTagCategory)
                    .Cast<FamilySymbol>()
                    .OrderBy(x => x.FamilyName ?? string.Empty, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(x => x.Name ?? string.Empty, StringComparer.OrdinalIgnoreCase)
                    .ToList();
                var sourceCandidates = sourceSymbols
                    .Select(x => new TagFamilyCandidate
                    {
                        FamilyName = x.FamilyName ?? string.Empty,
                        TypeName = x.Name ?? string.Empty
                    })
                    .Distinct(new TagFamilyCandidateComparer())
                    .Take(100)
                    .ToList();
                var familyFilter = (requestedSourceFamilyName ?? string.Empty).Trim();
                var typeFilter = (requestedSourceTypeName ?? string.Empty).Trim();
                var sourceSymbol = sourceSymbols.FirstOrDefault(x =>
                    (familyFilter.Length == 0 || string.Equals(x.FamilyName ?? string.Empty, familyFilter, StringComparison.OrdinalIgnoreCase)) &&
                    (typeFilter.Length == 0 || string.Equals(x.Name ?? string.Empty, typeFilter, StringComparison.OrdinalIgnoreCase)));
                if (sourceSymbol == null)
                {
                    return new TagFamilyResolution
                    {
                        Status = "source_tag_missing",
                        TargetTagCategory = targetTagCategory.ToString(),
                        SourceTagCategory = sourceTagCategory.ToString(),
                        SourceProjectPath = sourcePath,
                        ContentProfile = contentProfile,
                        SourceCandidates = sourceCandidates,
                        Error = sourceSymbols.Count == 0
                            ? "The source project does not contain a compatible source tag family."
                            : "No source tag family/type matched the requested exact selection."
                    };
                }

                if (dryRun)
                {
                    return new TagFamilyResolution
                    {
                        Status = "source_available",
                        TargetTagCategory = targetTagCategory.ToString(),
                        SourceTagCategory = sourceTagCategory.ToString(),
                        SourceProjectPath = sourcePath,
                        FamilyName = familyName,
                        TypeName = sourceSymbol.Name,
                        ContentProfile = contentProfile,
                        ContentSanitizationStatus = contentProfile == TagFamilyContentPolicy.None ? "not_requested" : "planned",
                        SourceCandidates = sourceCandidates
                    };
                }

                familyDoc = sourceDoc.EditFamily(sourceSymbol.Family);
                if (familyDoc == null) throw new InvalidOperationException("Could not edit the source tag family.");
                var targetCategory = Category.GetCategory(familyDoc, targetTagCategory);
                if (targetCategory == null) throw new InvalidOperationException($"Target tag category {targetTagCategory} is unavailable in the family document.");
                using (var familyTransaction = new Transaction(familyDoc, "Retarget Tag Family"))
                {
                    familyTransaction.Start();
                    familyDoc.OwnerFamily.FamilyCategory = targetCategory;
                    familyTransaction.Commit();
                }
                var contentReceipt = SanitizeTagFamilyContent(familyDoc, contentProfile);

                var outputDir = WorkspacePaths.EnsureDir("artifacts", "tag-families");
                var outputPath = Path.Combine(outputDir, familyName + ".rfa");
                familyDoc.SaveAs(outputPath, new SaveAsOptions { OverwriteExistingFile = true, Compact = true });
                familyDoc.Close(false);
                familyDoc = null;

                Family? loadedFamily;
                using (var loadTransaction = new Transaction(targetDoc, "Load Geometry-Aware Tag Family"))
                {
                    loadTransaction.Start();
                    targetDoc.LoadFamily(outputPath, new TagFamilyLoadOptions(), out loadedFamily);
                    if (loadedFamily == null) throw new InvalidOperationException("Revit did not return the imported tag family.");
                    loadTransaction.Commit();
                }

                var loadedSymbols = loadedFamily.GetFamilySymbolIds()
                    .Select(id => targetDoc.GetElement(id))
                    .OfType<FamilySymbol>()
                    .ToList();
                var loadedSymbol = loadedSymbols.FirstOrDefault(x =>
                        x.Category != null &&
                        ElementIdCompat.GetValue(x.Category.Id) == (long)targetTagCategory &&
                        string.Equals(x.Name ?? string.Empty, sourceSymbol.Name ?? string.Empty, StringComparison.OrdinalIgnoreCase))
                    ?? loadedSymbols.FirstOrDefault(x =>
                        x.Category != null && ElementIdCompat.GetValue(x.Category.Id) == (long)targetTagCategory)
                    ?? loadedSymbols.FirstOrDefault();
                if (loadedSymbol == null) throw new InvalidOperationException("Imported tag family did not contain a usable type.");
                var resolution = ResolutionFromSymbol("imported", targetTagCategory, loadedSymbol);
                resolution.SourceTagCategory = sourceTagCategory.ToString();
                resolution.SourceProjectPath = sourcePath;
                resolution.GeneratedFamilyPath = outputPath;
                resolution.SourceCandidates = sourceCandidates;
                resolution.ContentProfile = contentProfile;
                resolution.ContentSanitizationStatus = contentReceipt.Status;
                resolution.KeptTextElements = contentReceipt.Kept;
                resolution.RemovedTextElements = contentReceipt.Removed;
                return resolution;
            }
            catch (Exception ex)
            {
                return new TagFamilyResolution
                {
                    Status = "import_failed",
                    TargetTagCategory = targetTagCategory.ToString(),
                    SourceTagCategory = sourceTagCategory.ToString(),
                    SourceProjectPath = sourcePath,
                    FamilyName = familyName,
                    ContentProfile = contentProfile,
                    Error = ex.Message
                };
            }
            finally
            {
                if (familyDoc != null) try { familyDoc.Close(false); } catch { }
                if (sourceDoc != null) try { sourceDoc.Close(false); } catch { }
            }
        }

        private sealed class TagFamilyContentSanitizationReceipt
        {
            public string Status { get; set; } = "not_requested";
            public List<TagFamilyTextElementReceipt> Kept { get; set; } = new List<TagFamilyTextElementReceipt>();
            public List<TagFamilyTextElementReceipt> Removed { get; set; } = new List<TagFamilyTextElementReceipt>();
        }

        private static TagFamilyContentSanitizationReceipt SanitizeTagFamilyContent(Document familyDoc, string contentProfile)
        {
            var receipt = new TagFamilyContentSanitizationReceipt();
            if (contentProfile == TagFamilyContentPolicy.None) return receipt;

            var textElements = new FilteredElementCollector(familyDoc)
                .OfClass(typeof(TextElement))
                .WhereElementIsNotElementType()
                .Cast<TextElement>()
                .ToList();
            foreach (var textElement in textElements)
            {
                var item = new TagFamilyTextElementReceipt
                {
                    ElementId = ElementIdCompat.GetValue(textElement.Id),
                    SampleText = textElement.Text ?? string.Empty
                };
                if (TagFamilyContentPolicy.ShouldKeepText(contentProfile, textElement.Text)) receipt.Kept.Add(item);
                else receipt.Removed.Add(item);
            }

            if (receipt.Kept.Count == 0)
                throw new InvalidOperationException($"Tag-family content profile {contentProfile} found no compatible label text and refused to produce a blank family.");

            if (receipt.Removed.Count == 0)
            {
                receipt.Status = "no_changes";
                return receipt;
            }

            using (var transaction = new Transaction(familyDoc, "Sanitize Generated Tag Content"))
            {
                transaction.Start();
                familyDoc.Delete(receipt.Removed.Select(x => ElementIdCompat.Create(x.ElementId)).ToList());
                transaction.Commit();
            }
            receipt.Status = "sanitized";
            return receipt;
        }

        private sealed class TagFamilyCandidateComparer : IEqualityComparer<TagFamilyCandidate>
        {
            public bool Equals(TagFamilyCandidate? x, TagFamilyCandidate? y) =>
                string.Equals(x?.FamilyName ?? string.Empty, y?.FamilyName ?? string.Empty, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(x?.TypeName ?? string.Empty, y?.TypeName ?? string.Empty, StringComparison.OrdinalIgnoreCase);

            public int GetHashCode(TagFamilyCandidate obj) =>
                StringComparer.OrdinalIgnoreCase.GetHashCode((obj.FamilyName ?? string.Empty) + "\u001f" + (obj.TypeName ?? string.Empty));
        }

        private static TagFamilyResolution ResolutionFromSymbol(string status, BuiltInCategory targetTagCategory, FamilySymbol symbol) => new TagFamilyResolution
        {
            Status = status,
            TargetTagCategory = targetTagCategory.ToString(),
            FamilyName = symbol.FamilyName,
            TypeName = symbol.Name,
            TypeId = symbol.Id,
            FamilyId = symbol.Family?.Id
        };

        private static BuiltInCategory? ResolveCommonTargetTagCategory(IReadOnlyList<Element> targets)
        {
            var categories = targets.Select(ResolveTargetTagCategory).Distinct().ToList();
            return categories.Count == 1 ? categories[0] : null;
        }

        private static BuiltInCategory? ResolveTargetTagCategory(Element element)
        {
            if (element.Category == null) return null;
            var id = ElementIdCompat.GetValue(element.Category.Id);
            if (id == (long)BuiltInCategory.OST_DuctTerminal) return BuiltInCategory.OST_DuctTerminalTags;
            if (id == (long)BuiltInCategory.OST_MechanicalEquipment) return BuiltInCategory.OST_MechanicalEquipmentTags;
            if (id == (long)BuiltInCategory.OST_ElectricalEquipment) return BuiltInCategory.OST_ElectricalEquipmentTags;
            if (id == (long)BuiltInCategory.OST_ElectricalFixtures) return BuiltInCategory.OST_ElectricalFixtureTags;
            if (id == (long)BuiltInCategory.OST_LightingFixtures) return BuiltInCategory.OST_LightingFixtureTags;
            if (id == (long)BuiltInCategory.OST_PlumbingFixtures) return BuiltInCategory.OST_PlumbingFixtureTags;
            return null;
        }

        private static BuiltInCategory ResolveBuiltInCategory(string? token, BuiltInCategory fallback)
        {
            var value = (token ?? string.Empty).Trim();
            return value.Length > 0 && Enum.TryParse(value, true, out BuiltInCategory parsed) ? parsed : fallback;
        }

        private static string DefaultGeneratedTagFamilyName(BuiltInCategory targetTagCategory)
        {
            if (targetTagCategory == BuiltInCategory.OST_DuctTerminalTags) return "Operator Air Terminal Tag";
            if (targetTagCategory == BuiltInCategory.OST_MechanicalEquipmentTags) return "Operator Mechanical Equipment Tag";
            if (targetTagCategory == BuiltInCategory.OST_ElectricalEquipmentTags) return "Operator Electrical Equipment Tag";
            if (targetTagCategory == BuiltInCategory.OST_ElectricalFixtureTags) return "Operator Electrical Fixture Tag";
            if (targetTagCategory == BuiltInCategory.OST_LightingFixtureTags) return "Operator Lighting Fixture Tag";
            if (targetTagCategory == BuiltInCategory.OST_PlumbingFixtureTags) return "Operator Plumbing Fixture Tag";
            return "Operator Element Tag";
        }

        private static string SanitizeFamilyName(string? value, string fallback)
        {
            var name = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
            foreach (var invalid in Path.GetInvalidFileNameChars()) name = name.Replace(invalid, '_');
            return name.Length > 100 ? name.Substring(0, 100) : name;
        }

        private static View? ResolveView(Document doc, long? viewId, string? viewName, View? activeView)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                var byId = doc.GetElement(ElementIdCompat.Create(viewId.Value)) as View;
                if (byId != null) return byId;
            }

            var name = (viewName ?? string.Empty).Trim();
            if (name.Length > 0)
            {
                var byName = new FilteredElementCollector(doc)
                    .OfClass(typeof(View))
                    .Cast<View>()
                    .FirstOrDefault(v => !v.IsTemplate && string.Equals((v.Name ?? string.Empty).Trim(), name, StringComparison.OrdinalIgnoreCase));
                if (byName != null) return byName;
            }

            return activeView;
        }

        private static List<Element> ResolveTargets(Document doc, View view, TagRequest p, int max, out List<string> unresolvedCategories)
        {
            unresolvedCategories = new List<string>();
            var byId = new Dictionary<long, Element>();

            var ids = p.elementIds ?? new List<long>();
            foreach (var id in ids)
            {
                if (id <= 0) continue;
                var element = doc.GetElement(ElementIdCompat.Create(id));
                if (element == null || element.Category == null) continue;
                byId[ElementIdCompat.GetValue(element.Id)] = element;
                if (byId.Count >= max) break;
            }

            var categoryNames = (p.categoryNames ?? new List<string>())
                .Select(x => (x ?? string.Empty).Trim())
                .Where(x => x.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            if (categoryNames.Count > 0 && byId.Count < max)
            {
                var categoryIds = new HashSet<long>();
                foreach (var categoryName in categoryNames)
                {
                    var category = ResolveCategory(doc, categoryName);
                    if (category == null)
                    {
                        unresolvedCategories.Add(categoryName);
                        continue;
                    }
                    categoryIds.Add(ElementIdCompat.GetValue(category.Id));
                }

                var collector = new FilteredElementCollector(doc, view.Id)
                    .WhereElementIsNotElementType()
                    .ToElements();

                foreach (var element in collector)
                {
                    if (element?.Category == null) continue;
                    if (!categoryIds.Contains(ElementIdCompat.GetValue(element.Category.Id))) continue;
                    byId[ElementIdCompat.GetValue(element.Id)] = element;
                    if (byId.Count >= max) break;
                }
            }

            if (byId.Count == 0)
            {
                throw new InvalidOperationException("tag-elements requires elementIds and/or categoryNames with at least one resolvable target.");
            }

            return byId.Values.ToList();
        }

        private static Category? ResolveCategory(Document doc, string token)
        {
            var trimmed = (token ?? string.Empty).Trim();
            if (trimmed.Length == 0) return null;

            foreach (Category cat in doc.Settings.Categories)
            {
                if (cat == null) continue;
                if (string.Equals(cat.Name, trimmed, StringComparison.OrdinalIgnoreCase))
                {
                    return cat;
                }
            }

            if (Enum.TryParse(trimmed, true, out BuiltInCategory bic))
            {
                try
                {
                    return Category.GetCategory(doc, bic);
                }
                catch
                {
                    // ignore
                }
            }

            return null;
        }

        private static TagOrientation ResolveOrientation(string? orientation)
        {
            var value = (orientation ?? "horizontal").Trim().ToLowerInvariant();
            return value == "vertical"
                ? TagOrientation.Vertical
                : TagOrientation.Horizontal;
        }

        private static XYZ? ResolveTagPoint(Element element, View view, XYZ offset)
        {
            if (element.Location is LocationPoint lp && lp.Point != null)
            {
                return lp.Point + offset;
            }

            var bbox = element.get_BoundingBox(view);
            if (bbox != null)
            {
                return ((bbox.Min + bbox.Max) * 0.5) + offset;
            }

            return null;
        }

        private static Element CreateTagElement(Document doc, View view, Element element, bool addLeader, TagOrientation orientation, XYZ point)
        {
            if (element is Room room)
            {
                var tag = doc.Create.NewRoomTag(new LinkElementId(room.Id), new UV(point.X, point.Y), view.Id);
                if (tag == null) throw new InvalidOperationException("Room tag creation returned null.");
                return tag;
            }

            if (element is Space space)
            {
                var tag = doc.Create.NewSpaceTag(space, new UV(point.X, point.Y), view);
                if (tag == null) throw new InvalidOperationException("Space tag creation returned null.");
                return tag;
            }

            return IndependentTag.Create(
                doc,
                view.Id,
                new Reference(element),
                addLeader,
                TagMode.TM_ADDBY_CATEGORY,
                orientation,
                point);
        }

        private static object BuildTagReadback(Document doc, Element tag, Element target, View view, GeometryPlacementOutcome? geometryOutcome)
        {
            var type = doc.GetElement(tag.GetTypeId()) as ElementType;
            var family = type is FamilySymbol fs ? fs.FamilyName : type?.FamilyName;
            return new
            {
                tagId = ElementIdCompat.GetValue(tag.Id),
                targetElementId = ElementIdCompat.GetValue(target.Id),
                viewId = ElementIdCompat.GetValue(view.Id),
                targetCategory = target.Category?.Name,
                tagCategory = tag.Category?.Name,
                tagTypeId = type == null ? (long?)null : ElementIdCompat.GetValue(type.Id),
                tagTypeName = type?.Name,
                tagFamilyName = family,
                value = ReadTagDisplayValue(tag),
                tagHeadPosition = geometryOutcome?.TagHeadPosition == null ? null : new
                {
                    x = geometryOutcome.TagHeadPosition.X,
                    y = geometryOutcome.TagHeadPosition.Y,
                    z = geometryOutcome.TagHeadPosition.Z
                },
                geometryPlacement = geometryOutcome == null ? null : new
                {
                    status = geometryOutcome.Status,
                    side = geometryOutcome.Side,
                    attempts = geometryOutcome.Attempts,
                    collisionCount = geometryOutcome.CollisionCount,
                    softObstacleCount = geometryOutcome.SoftObstacleCount,
                    softObstacleArea = geometryOutcome.SoftObstacleArea,
                    outsideTarget = geometryOutcome.OutsideTarget,
                    collisionFree = geometryOutcome.CollisionFree,
                    leaderApplied = geometryOutcome.LeaderApplied,
                    leaderGeometryStatus = geometryOutcome.LeaderGeometryStatus,
                    leaderLength = geometryOutcome.LeaderLength,
                    leaderCrossingCount = geometryOutcome.LeaderCrossingCount,
                    leaderProtectedCrossingCount = geometryOutcome.LeaderProtectedCrossingCount,
                    leaderSegments = geometryOutcome.LeaderSegments.Select(SegmentPayload).ToList(),
                    targetBounds = geometryOutcome.TargetBounds == null ? null : RectPayload(geometryOutcome.TargetBounds),
                    tagBounds = geometryOutcome.TagBounds == null ? null : RectPayload(geometryOutcome.TagBounds),
                    anchorOffset = geometryOutcome.AnchorOffsetU == null || geometryOutcome.AnchorOffsetV == null ? null : new
                    {
                        u = geometryOutcome.AnchorOffsetU,
                        v = geometryOutcome.AnchorOffsetV
                    }
                }
            };
        }

        private static string? ReadTagDisplayValue(Element tag)
        {
            if (tag is IndependentTag independentTag)
            {
                return independentTag.TagText;
            }

            var tagText = tag.GetType().GetProperty("TagText", BindingFlags.Instance | BindingFlags.Public);
            if (tagText != null && tagText.GetValue(tag, null) is string reflectedTagText)
            {
                return reflectedTagText;
            }

            return null;
        }

        private static HashSet<long> CollectTaggedElementIdsOnView(Document doc, ElementId viewId)
        {
            var ids = new HashSet<long>();
            var tags = new FilteredElementCollector(doc, viewId)
                .OfClass(typeof(IndependentTag))
                .Cast<IndependentTag>();

            foreach (var tag in tags)
            {
                foreach (var id in GetTaggedElementIds(tag))
                {
                    if (id != null && id != ElementId.InvalidElementId)
                    {
                        ids.Add(ElementIdCompat.GetValue(id));
                    }
                }
            }

            return ids;
        }

        private static IEnumerable<ElementId> GetTaggedElementIds(IndependentTag tag)
        {
            var method = tag.GetType().GetMethod("GetTaggedLocalElementIds", BindingFlags.Instance | BindingFlags.Public);
            if (method != null)
            {
                var values = method.Invoke(tag, null) as System.Collections.IEnumerable;
                if (values != null)
                {
                    foreach (var item in values)
                    {
                        if (item is ElementId id) yield return id;
                    }
                    yield break;
                }
            }

            var prop = tag.GetType().GetProperty("TaggedLocalElementId", BindingFlags.Instance | BindingFlags.Public);
            if (prop != null && prop.GetValue(tag, null) is ElementId singleId)
            {
                yield return singleId;
            }
        }

        private static Dictionary<long, ElementId?> ResolveCategoryTagTypeMap(Document doc, List<CategoryTagTypeMap>? map, out List<object> warnings)
        {
            var resolved = new Dictionary<long, ElementId?>();
            warnings = new List<object>();
            if (map == null || map.Count == 0) return resolved;

            foreach (var entry in map)
            {
                var categoryName = (entry?.categoryName ?? string.Empty).Trim();
                if (categoryName.Length == 0) continue;

                var category = ResolveCategory(doc, categoryName);
                if (category == null)
                {
                    warnings.Add(new { categoryName, warning = "Category not found." });
                    continue;
                }

                var typeId = ResolveDefaultTagTypeId(doc, entry?.tagTypeId, entry?.tagTypeName, entry?.tagFamilyName);
                if (typeId == null)
                {
                    warnings.Add(new { categoryName, warning = "Tag type not found." });
                }

                resolved[ElementIdCompat.GetValue(category.Id)] = typeId;
            }

            return resolved;
        }

        private static ElementId? ResolveMappedTypeForElement(Element element, Dictionary<long, ElementId?> map)
        {
            if (element.Category == null) return null;
            var categoryId = ElementIdCompat.GetValue(element.Category.Id);
            return map.TryGetValue(categoryId, out var typeId) ? typeId : null;
        }

        private static ElementId? ResolveDefaultTagTypeId(Document doc, long? tagTypeId, string? tagTypeName, string? tagFamilyName)
        {
            if (tagTypeId.HasValue && tagTypeId.Value > 0)
            {
                var byId = ElementIdCompat.Create(tagTypeId.Value);
                if (doc.GetElement(byId) is ElementType) return byId;
            }

            var typeName = (tagTypeName ?? string.Empty).Trim();
            var familyName = (tagFamilyName ?? string.Empty).Trim();
            if (typeName.Length == 0 && familyName.Length == 0) return null;

            var symbols = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>();

            foreach (var symbol in symbols)
            {
                var symbolName = (symbol.Name ?? string.Empty).Trim();
                var family = (symbol.FamilyName ?? string.Empty).Trim();

                var typeMatch = typeName.Length == 0 || symbolName.Equals(typeName, StringComparison.OrdinalIgnoreCase) || symbolName.IndexOf(typeName, StringComparison.OrdinalIgnoreCase) >= 0;
                var familyMatch = familyName.Length == 0 || family.Equals(familyName, StringComparison.OrdinalIgnoreCase) || family.IndexOf(familyName, StringComparison.OrdinalIgnoreCase) >= 0;
                if (typeMatch && familyMatch)
                {
                    return symbol.Id;
                }
            }

            return null;
        }
    }
}
