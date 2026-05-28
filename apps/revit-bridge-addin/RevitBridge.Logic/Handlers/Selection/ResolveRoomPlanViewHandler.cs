using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.Core;

namespace RevitBridge.Logic.Handlers
{
    public class ResolveRoomPlanViewHandler : IRequestHandler
    {
        public class Params
        {
            public string roomNumber { get; set; } = "";
            public string? preferViewNameContains { get; set; }
            public int maxCandidates { get; set; } = 10;
        }

        private sealed class ViewCandidate
        {
            public ViewPlan view { get; set; } = null!;
            public double score { get; set; }
            public string reason { get; set; } = "";
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            if (p == null) throw new ArgumentException("Invalid JSON payload.");
            if (string.IsNullOrWhiteSpace(p.roomNumber)) throw new ArgumentException("Missing required parameter: roomNumber");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new Exception("No active UI document.");
            var doc = uidoc.Document;

            var warnings = new List<string>();

            var roomNumber = p.roomNumber.Trim();
            var resolved = SpatialElementResolver.ResolveByNumber(doc, roomNumber);
            var spatial = resolved.Element;
            if (spatial == null)
                throw new ArgumentException($"Room/Space number '{roomNumber}' not found.");

            var levelId = spatial.LevelId;
            if (levelId == ElementId.InvalidElementId && spatial is Room roomLevelFallback)
            {
                var param = roomLevelFallback.get_Parameter(BuiltInParameter.ROOM_LEVEL_ID);
                if (param != null && param.StorageType == StorageType.ElementId)
                    levelId = param.AsElementId();
            }

            if (levelId == ElementId.InvalidElementId)
                throw new Exception($"{resolved.SpatialKind} {RevitBridge.Common.ElementIdCompat.GetValue(spatial.Id)} has no valid level association.");

            var level = doc.GetElement(levelId) as Level;
            var levelName = level?.Name ?? "(unknown)";

            var viewPlans = new FilteredElementCollector(doc)
                .OfClass(typeof(ViewPlan))
                .Cast<ViewPlan>()
                .Where(v => v != null && !v.IsTemplate)
                .ToList();

            var preferToken = string.IsNullOrWhiteSpace(p.preferViewNameContains) ? null : p.preferViewNameContains.Trim();
            var candidates = new List<ViewCandidate>();

            foreach (var v in viewPlans)
            {
                Level? genLevel = null;
                try { genLevel = v.GenLevel; } catch { genLevel = null; }
                if (genLevel == null || genLevel.Id != levelId) continue;

                var name = v.Name ?? "";
                var upper = name.ToUpperInvariant();

                double score = 0;
                var reasons = new List<string>();

                if (v.ViewType == ViewType.FloorPlan) { score += 10; reasons.Add("floorplan"); }
                else if (v.ViewType == ViewType.EngineeringPlan) { score += 6; reasons.Add("engineeringplan"); }
                else { score += 1; reasons.Add("other_plan"); }

                if (!string.IsNullOrEmpty(levelName))
                {
                    if (string.Equals(name, levelName, StringComparison.OrdinalIgnoreCase)) { score += 4; reasons.Add("name_equals_level"); }
                    else if (name.IndexOf(levelName, StringComparison.OrdinalIgnoreCase) >= 0) { score += 2.5; reasons.Add("name_contains_level"); }
                }

                if (upper.Contains("FLOOR")) { score += 1.2; reasons.Add("name_contains_floor"); }
                if (upper.Contains("PLAN")) { score += 1.0; reasons.Add("name_contains_plan"); }
                if (upper.Contains("RCP") || upper.Contains("CEILING")) { score -= 6.0; reasons.Add("ceiling_penalty"); }
                if (upper.Contains("AREA")) { score -= 2.0; reasons.Add("area_penalty"); }

                try
                {
                    var primaryId = v.GetPrimaryViewId();
                    if (primaryId != ElementId.InvalidElementId) { score -= 1.0; reasons.Add("dependent_penalty"); }
                }
                catch { /* ignore */ }

                if (preferToken != null && name.IndexOf(preferToken, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    score += 2.0;
                    reasons.Add("preferViewNameContains");
                }

                candidates.Add(new ViewCandidate
                {
                    view = v,
                    score = score,
                    reason = string.Join(",", reasons)
                });
            }

            if (candidates.Count == 0)
                throw new Exception($"No plan views found for level '{levelName}' (id {RevitBridge.Common.ElementIdCompat.GetValue(levelId)}).");

            var best = candidates
                .OrderByDescending(c => c.score)
                .ThenBy(c => c.view.Name ?? "")
                .First();

            var bbox = SafeBbox(spatial);

            var outCandidates = candidates
                .OrderByDescending(c => c.score)
                .Take(Math.Max(1, p.maxCandidates))
                .Select(c => new
                {
                    viewId = RevitBridge.Common.ElementIdCompat.GetValue(c.view.Id),
                    viewName = c.view.Name,
                    viewType = c.view.ViewType.ToString(),
                    levelId = RevitBridge.Common.ElementIdCompat.GetValue(c.view.GenLevel?.Id),
                    score = c.score,
                    reason = c.reason
                })
                .ToList();

            return Task.FromResult<object>(new
            {
                roomId = RevitBridge.Common.ElementIdCompat.GetValue(spatial.Id),
                roomNumber = resolved.Number,
                roomName = spatial.Name,
                spatialKind = resolved.SpatialKind.Length > 0 ? resolved.SpatialKind : GetSpatialKind(spatial),
                resolvedSpatial = new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(spatial.Id),
                    type = resolved.SpatialKind.Length > 0 ? resolved.SpatialKind : GetSpatialKind(spatial),
                    number = resolved.Number,
                    confidence = resolved.Confidence,
                    matchMode = resolved.MatchMode
                },
                levelId = RevitBridge.Common.ElementIdCompat.GetValue(levelId),
                levelName,
                bestViewId = RevitBridge.Common.ElementIdCompat.GetValue(best.view.Id),
                bestViewName = best.view.Name,
                bestViewType = best.view.ViewType.ToString(),
                roomBbox = bbox == null ? null : new
                {
                    minXyz = new[] { bbox.Min.X, bbox.Min.Y, bbox.Min.Z },
                    maxXyz = new[] { bbox.Max.X, bbox.Max.Y, bbox.Max.Z }
                },
                candidates = outCandidates,
                warnings
            });
        }

        private static double SafeArea(SpatialElement spatial)
        {
            try
            {
                if (spatial is Room r) return r.Area;
                if (spatial is Space s) return s.Area;
                return 0.0;
            }
            catch { return 0.0; }
        }

        private static BoundingBoxXYZ? SafeBbox(SpatialElement spatial)
        {
            try { return spatial.get_BoundingBox(null); } catch { return null; }
        }

        private static string GetSpatialKind(SpatialElement spatial)
        {
            if (spatial is Room) return "Room";
            if (spatial is Space) return "Space";
            return "SpatialElement";
        }
    }
}
