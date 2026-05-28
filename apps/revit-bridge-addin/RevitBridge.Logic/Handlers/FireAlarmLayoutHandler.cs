using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.FireAlarm;
using RevitBridge.Logic.LowVoltage.Core;
using RevitBridge.Logic.LowVoltage.Skills.FireAlarm;

namespace RevitBridge.Logic.Handlers
{
    public class FireAlarmLayoutHandler : IRequestHandler
    {
        public class Request
        {
            public string? runConfigPath { get; set; }
            public string? deviceMappingsPath { get; set; }
            public string? levelName { get; set; }
            public long? viewId { get; set; }
            public string? runId { get; set; }
            public bool dryRun { get; set; } = true;
            public bool createVisualizer { get; set; } = true;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var doc = app.ActiveUIDocument.Document;
            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, ReadCommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
            var request = JsonSerializer.Deserialize<Request>(jsonData ?? "{}", options) ?? new Request();
            request.runId ??= Guid.NewGuid().ToString("N");

            var view = ResolveView(doc, request.viewId, request.levelName);
            if (view == null)
            {
                return Task.FromResult<object>(new { error = "No suitable view found for fire alarm layout." });
            }

            var legacyConfig = LoadLegacyConfig(request.runConfigPath, options);
            var profile = ConvertLegacyConfig(legacyConfig);
            MergeLegacyMappings(profile, ResolveMappings(request, legacyConfig, options));

            var execution = LowVoltageLayoutRunner.Run(doc, view, new LowVoltageLayoutRequest
            {
                Discipline = "fire_alarm",
                PreviewOnly = request.dryRun,
                DisciplineProfileOverride = profile,
                RunId = request.runId,
                TaskContext = "legacy_fire_alarm_layout"
            });

            var report = BuildCompatibilityReport(request, view, execution);
            if (request.createVisualizer)
            {
                report.warnings.Add("Legacy uncovered-marker visualizer generation is not run automatically on the shared low-voltage path. Use preview annotations or /revit/fire-alarm-visualizer for tagged elements.");
            }

            return Task.FromResult<object>(new
            {
                runId = report.runId,
                levelName = report.levelName,
                viewId = report.viewId,
                dryRun = report.dryRun,
                assumptions = report.assumptions,
                placed = report.placed,
                warnings = report.warnings,
                errors = report.errors,
                uncoveredMarkersCreated = report.uncoveredMarkersCreated,
                result = execution.Result,
                diagnostics = execution.Diagnostics,
                graph = execution.Graph,
                createdElementIds = execution.CreatedElementIds
            });
        }

        private static FireAlarmRunConfig? LoadLegacyConfig(string? path, JsonSerializerOptions options)
        {
            var resolved = ResolveExistingPath(path);
            if (string.IsNullOrWhiteSpace(resolved)) return null;
            var raw = File.ReadAllText(resolved).TrimStart('\uFEFF');
            return JsonSerializer.Deserialize<FireAlarmRunConfig>(raw, options);
        }

        private static Dictionary<string, DeviceTypeMapping> ResolveMappings(Request request, FireAlarmRunConfig? config, JsonSerializerOptions options)
        {
            var path = ResolveExistingPath(request.deviceMappingsPath);
            if (string.IsNullOrWhiteSpace(path) && !string.IsNullOrWhiteSpace(config?.deviceMappingsPath))
            {
                path = ResolveExistingPath(config.deviceMappingsPath);
            }

            if (string.IsNullOrWhiteSpace(path)) return new Dictionary<string, DeviceTypeMapping>(StringComparer.OrdinalIgnoreCase);
            var raw = File.ReadAllText(path).TrimStart('\uFEFF');
            return JsonSerializer.Deserialize<Dictionary<string, DeviceTypeMapping>>(raw, options)
                ?? new Dictionary<string, DeviceTypeMapping>(StringComparer.OrdinalIgnoreCase);
        }

        private static FireAlarmProfile ConvertLegacyConfig(FireAlarmRunConfig? config)
        {
            var profile = FireAlarmProfile.CreateDefault();
            if (config == null) return profile;

            if (!string.IsNullOrWhiteSpace(config.profile))
            {
                profile.OccupancyProfile = config.profile;
            }

            profile.CorridorRules.MaxSpacingFt = Math.Max(1, config.placement?.corridorMaxSpacingFt ?? profile.CorridorRules.MaxSpacingFt);
            profile.CorridorRules.EndOffsetFt = Math.Max(0, config.placement?.corridorEndOffsetFt ?? profile.CorridorRules.EndOffsetFt);
            profile.CorridorRules.Enabled = (config.devices ?? new List<string>()).Any(device => string.Equals(device, "STROBES_CORRIDORS", StringComparison.OrdinalIgnoreCase));

            AppendPatterns(profile.SpaceTypeMappings, "corridor", config.classification?.corridorPatterns);
            AppendPatterns(profile.SpaceTypeMappings, "support_room", config.classification?.supportPatterns);
            AppendPatterns(profile.SpaceTypeMappings, "waiting", config.classification?.publicPatterns);

            var wantsRoomStrobes = (config.devices ?? new List<string>()).Any(device => string.Equals(device, "STROBES_ROOMS", StringComparison.OrdinalIgnoreCase));
            if (!wantsRoomStrobes)
            {
                foreach (var rule in profile.RoomTypeRules.Where(pair => !string.Equals(pair.Key, "corridor", StringComparison.OrdinalIgnoreCase)).Select(pair => pair.Value))
                {
                    rule.RequireDevice = false;
                }
            }

            return profile;
        }

        private static void MergeLegacyMappings(FireAlarmProfile profile, IReadOnlyDictionary<string, DeviceTypeMapping> mappings)
        {
            foreach (var mapping in mappings)
            {
                var deviceCategory = InferDeviceCategory(mapping.Key);
                if (string.IsNullOrWhiteSpace(deviceCategory)) continue;
                if (!profile.FamilySymbolPreferences.TryGetValue(deviceCategory, out var preferences))
                {
                    preferences = new List<string>();
                    profile.FamilySymbolPreferences[deviceCategory] = preferences;
                }

                if (!string.IsNullOrWhiteSpace(mapping.Value.family)) preferences.Add(mapping.Value.family);
                if (!string.IsNullOrWhiteSpace(mapping.Value.type)) preferences.Add(mapping.Value.type);
            }
        }

        private static FireAlarmLayoutReport BuildCompatibilityReport(Request request, View view, LowVoltageLayoutExecution execution)
        {
            var report = new FireAlarmLayoutReport
            {
                runId = request.runId,
                levelName = execution.NormalizedState.View.LevelName ?? request.levelName,
                viewId = ElementIdCompat.GetValue(view.Id),
                dryRun = request.dryRun
            };

            foreach (var classification in execution.Diagnostics.ClassifiedSpaces.OrderBy(item => item.RoomId))
            {
                var hasPlacement = execution.Result.ProposedActions.Any(action => action.RoomId == classification.RoomId || action.GroupId == classification.GroupId);
                var hasReview = execution.Result.ManualReviews.Any(review => review.RoomId == classification.RoomId || review.GroupId == classification.GroupId);
                report.assumptions.Add(new FireAlarmAssumption
                {
                    roomId = classification.RoomId,
                    roomNumber = execution.NormalizedState.Rooms.FirstOrDefault(room => room.Id == classification.RoomId)?.Number,
                    roomName = execution.NormalizedState.Rooms.FirstOrDefault(room => room.Id == classification.RoomId)?.Name,
                    areaFt2 = execution.NormalizedState.Rooms.FirstOrDefault(room => room.Id == classification.RoomId)?.Area ?? 0,
                    levelName = execution.NormalizedState.View.LevelName,
                    inferredClass = classification.Bucket,
                    classReasonCode = classification.Source,
                    notifyDecision = hasPlacement ? NotifyDecision.REQUIRE.ToString() : hasReview ? NotifyDecision.REVIEW.ToString() : NotifyDecision.EXCLUDE.ToString(),
                    notifyReasonCode = hasPlacement ? "LAYOUT_RULE" : hasReview ? "MANUAL_REVIEW" : "NO_REQUIREMENT"
                });
            }

            foreach (var placement in execution.Result.ProposedActions.Select((action, index) => new { action, index }))
            {
                var createdId = placement.index < execution.CreatedElementIds.Count ? execution.CreatedElementIds[placement.index] : 0;
                report.placed.Add(new LayoutPlacedInstance
                {
                    elementId = createdId,
                    deviceKind = placement.action.DeviceCategory,
                    family = placement.action.Meta.TryGetValue("family", out var family) ? family : null,
                    type = placement.action.DeviceType,
                    x = placement.action.Candidate.Location.X,
                    y = placement.action.Candidate.Location.Y,
                    z = placement.action.Candidate.Location.Z,
                    roomId = placement.action.RoomId
                });
            }

            report.warnings.AddRange(execution.Diagnostics.MissingFamilyTypes);
            report.warnings.AddRange(execution.Diagnostics.UnknownRoomClassifications);
            report.warnings.AddRange(execution.Diagnostics.RuleViolations.Select(violation => violation.Message));
            report.warnings.AddRange(execution.Diagnostics.ManualReviews.Select(review => review.Message));
            report.errors.AddRange(execution.Diagnostics.HostFailures);
            report.uncoveredMarkersCreated = 0;
            return report;
        }

        private static View? ResolveView(Document doc, long? requestedViewId, string? requestedLevelName)
        {
            if (requestedViewId.HasValue)
            {
                return doc.GetElement(ElementIdCompat.Create(requestedViewId.Value)) as View;
            }

            if (!string.IsNullOrWhiteSpace(requestedLevelName))
            {
                var matchingPlan = new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewPlan))
                    .Cast<ViewPlan>()
                    .FirstOrDefault(view =>
                        !view.IsTemplate
                        && view.GenLevel != null
                        && string.Equals(view.GenLevel.Name, requestedLevelName, StringComparison.OrdinalIgnoreCase));
                if (matchingPlan != null) return matchingPlan;
            }

            return doc.ActiveView;
        }

        private static void AppendPatterns(IDictionary<string, List<string>> mappings, string bucket, IEnumerable<string>? patterns)
        {
            if (patterns == null) return;
            if (!mappings.TryGetValue(bucket, out var values))
            {
                values = new List<string>();
                mappings[bucket] = values;
            }

            foreach (var pattern in patterns.Where(pattern => !string.IsNullOrWhiteSpace(pattern)))
            {
                if (!values.Contains(pattern, StringComparer.OrdinalIgnoreCase))
                {
                    values.Add(pattern);
                }
            }
        }

        private static string InferDeviceCategory(string key)
        {
            var normalized = key ?? string.Empty;
            if (normalized.IndexOf("strobe", StringComparison.OrdinalIgnoreCase) >= 0 || normalized.IndexOf("notification", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "notification_strobe";
            }
            if (normalized.IndexOf("smoke", StringComparison.OrdinalIgnoreCase) >= 0 || normalized.IndexOf("detector", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "smoke_detector";
            }
            if (normalized.IndexOf("pull", StringComparison.OrdinalIgnoreCase) >= 0 || normalized.IndexOf("station", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "pull_station";
            }

            return string.Empty;
        }

        private static string? ResolveExistingPath(string? path)
        {
            if (string.IsNullOrWhiteSpace(path)) return null;
            try
            {
                return WorkspacePaths.ResolveExistingFileUnderWorkspace(path);
            }
            catch
            {
                return null;
            }
        }
    }
}
