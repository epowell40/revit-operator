using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitBridge.Common;
using RevitBridge.Common.LowVoltage.Core.Candidates;
using RevitBridge.Common.LowVoltage.Core.Diagnostics;
using RevitBridge.Common.LowVoltage.Core.Export;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Graphs;
using RevitBridge.Common.LowVoltage.Core.Normalization;
using RevitBridge.Common.LowVoltage.Core.Placement;
using RevitBridge.Common.LowVoltage.Core.Profiles;
using RevitBridge.Common.LowVoltage.Core.Preview;
using RevitBridge.Common.LowVoltage.Core.Rules;
using RevitBridge.Logic.LowVoltage.Core.Export;
using RevitBridge.Logic.LowVoltage.Core.Placement;
using RevitBridge.Logic.LowVoltage.Skills.DataOutlets;
using RevitBridge.Logic.LowVoltage.Skills.FireAlarm;
using RevitBridge.Logic.LowVoltage.Skills.NurseCall;
using RevitBridge.Logic.LowVoltage.Skills.PowerOutlets;

namespace RevitBridge.Logic.LowVoltage.Core
{
    public class LowVoltageLayoutRequest
    {
        public string Discipline { get; set; } = "fire_alarm";
        public bool PreviewOnly { get; set; } = true;
        public bool WriteSnapshots { get; set; }
        public string? SnapshotDirectory { get; set; }
        public string? NormalizationProfilePath { get; set; }
        public string? DisciplineProfilePath { get; set; }
        public string? TaskContext { get; set; }
        public string? RunId { get; set; }
        public object? DisciplineProfileOverride { get; set; }
    }

    public class LowVoltageLayoutExecution
    {
        public string Discipline { get; set; } = string.Empty;
        public long ViewId { get; set; }
        public ModelState InputState { get; set; } = new ModelState();
        public ModelState NormalizedState { get; set; } = new ModelState();
        public SpaceGraph Graph { get; set; } = new SpaceGraph();
        public List<CandidatePoint> Candidates { get; set; } = new List<CandidatePoint>();
        public LayoutResult Result { get; set; } = new LayoutResult();
        public DiagnosticReport Diagnostics { get; set; } = new DiagnosticReport();
        public List<long> CreatedElementIds { get; set; } = new List<long>();
    }

    public static class LowVoltageLayoutRunner
    {
        public static LowVoltageLayoutExecution Run(Document doc, View view, LowVoltageLayoutRequest request)
        {
            var exportedState = RevitLowVoltageExporter.Export(doc, view);
            var inputState = Clone(exportedState);
            var diagnostics = new DiagnosticReport();

            var normalizationProfile = LoadNormalizationProfile(request.NormalizationProfilePath);
            NormalizationEngine.Normalize(exportedState, normalizationProfile, diagnostics.UnknownRoomClassifications);

            var disciplineProfile = ResolveDisciplineProfile(request);
            var graph = SpaceGraphBuilder.Build(exportedState);
            var candidates = BuildCandidates(exportedState, disciplineProfile);
            var engine = ResolveRuleEngine(request.Discipline);
            var result = engine.Evaluate(new LayoutContext
            {
                Discipline = request.Discipline,
                State = exportedState,
                Graph = graph,
                Candidates = candidates,
                DisciplineProfile = disciplineProfile,
                TaskContext = request.TaskContext,
                Diagnostics = diagnostics
            });

            diagnostics.Assumptions.AddRange(result.Assumptions.Where(value => !string.IsNullOrWhiteSpace(value)));
            foreach (var violation in result.Violations)
            {
                if (!diagnostics.RuleViolations.Any(existing =>
                        existing.RuleId == violation.RuleId
                        && existing.RoomId == violation.RoomId
                        && existing.CandidateId == violation.CandidateId
                        && existing.GroupId == violation.GroupId
                        && string.Equals(existing.Message, violation.Message, StringComparison.OrdinalIgnoreCase)))
                {
                    diagnostics.RuleViolations.Add(violation);
                }
            }

            foreach (var review in result.ManualReviews)
            {
                if (!diagnostics.ManualReviews.Any(existing =>
                        existing.Code == review.Code
                        && existing.RoomId == review.RoomId
                        && existing.GroupId == review.GroupId
                        && existing.CandidateId == review.CandidateId))
                {
                    diagnostics.ManualReviews.Add(review);
                }
            }
            diagnostics.ProposedDevices.AddRange(result.ProposedActions.Select(action => new ProposedDeviceDiagnostic
            {
                ActionId = action.ActionId,
                DeviceCategory = action.DeviceCategory,
                DeviceType = action.DeviceType,
                RoomId = action.RoomId ?? action.Candidate.RoomId,
                GroupId = action.GroupId,
                FamilyTypeId = action.FamilyTypeId
            }));

            if (!result.Preview.Any())
            {
                result.Preview = PreviewBuilder.FromActions(result.ProposedActions);
            }

            if (request.WriteSnapshots)
            {
                var directory = string.IsNullOrWhiteSpace(request.SnapshotDirectory)
                    ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RevitOperator", "LowVoltage", DateTime.UtcNow.ToString("yyyyMMdd_HHmmss"))
                    : request.SnapshotDirectory!;
                SnapshotWriter.Write(directory, "input_state.json", inputState);
                SnapshotWriter.Write(directory, "normalized_state.json", exportedState);
                SnapshotWriter.Write(directory, "candidates.json", candidates);
                SnapshotWriter.Write(directory, "result.json", result);
            }

            var created = new List<long>();
            if (!request.PreviewOnly)
            {
                using var transaction = new Transaction(doc, "Low Voltage Layout Placement");
                transaction.Start();
                try
                {
                    created = PlacementActionExecutor.Execute(doc, result.ProposedActions, request.RunId);
                    transaction.Commit();
                }
                catch (Exception ex)
                {
                    diagnostics.HostFailures.Add(ex.Message);
                    transaction.RollBack();
                }
            }

            return new LowVoltageLayoutExecution
            {
                Discipline = request.Discipline,
                ViewId = ElementIdCompat.GetValue(view.Id),
                InputState = inputState,
                NormalizedState = exportedState,
                Graph = graph,
                Candidates = candidates,
                Result = result,
                Diagnostics = diagnostics,
                CreatedElementIds = created
            };
        }

        private static List<CandidatePoint> BuildCandidates(ModelState state, object? disciplineProfile)
        {
            var corridorSpacing = 24.0;
            var corridorEndOffset = 8.0;
            if (disciplineProfile is FireAlarmProfile fireAlarmProfile)
            {
                corridorSpacing = fireAlarmProfile.CorridorRules.MaxSpacingFt;
                corridorEndOffset = fireAlarmProfile.CorridorRules.EndOffsetFt;
            }

            return new[]
            {
                CandidateGenerator.GenerateWallHostPoints(state.Walls),
                CandidateGenerator.GenerateCeilingHostPoints(state.Ceilings),
                CandidateGenerator.GenerateRoomCenteredPoints(state.Rooms),
                CandidateGenerator.GenerateRoomEntryPoints(state.Rooms, state.Openings),
                CandidateGenerator.GenerateNearFixturePoints(state.Fixtures),
                CandidateGenerator.GenerateNearEquipmentPoints(state.Equipment),
                CandidateGenerator.GenerateCorridorOffsetPoints(state.Rooms),
                CandidateGenerator.GenerateCorridorCenterlinePoints(state.Rooms, corridorSpacing, corridorEndOffset),
                CandidateGenerator.GenerateCorridorEndOffsetPoints(state.Rooms, corridorEndOffset)
            }
            .SelectMany(set => set)
            .GroupBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .OrderBy(candidate => candidate.Id, StringComparer.OrdinalIgnoreCase)
            .ToList();
        }

        private static NormalizationProfile LoadNormalizationProfile(string? path)
        {
            var resolved = path;
            if (string.IsNullOrWhiteSpace(resolved) || !File.Exists(resolved))
            {
                resolved = Path.Combine(AppDomain.CurrentDomain.BaseDirectory ?? string.Empty, "Profiles", "Normalization", "low_voltage.default.json");
            }

            return File.Exists(resolved) ? NormalizationProfileLoader.Load(resolved) : new NormalizationProfile();
        }

        private static object? ResolveDisciplineProfile(LowVoltageLayoutRequest request)
        {
            if (request.DisciplineProfileOverride != null) return request.DisciplineProfileOverride;
            var path = request.DisciplineProfilePath;
            switch ((request.Discipline ?? string.Empty).ToLowerInvariant())
            {
                case "nurse_call":
                    if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                    {
                        path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory ?? string.Empty, "Profiles", "NurseCall", "nurse_call.hospital_default.json");
                    }
                    return NurseCallProfileLoader.Load(path);
                case "data_outlets":
                    if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                    {
                        path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory ?? string.Empty, "Profiles", "DataOutlets", "data_outlets.hospital_default.json");
                    }
                    return DataOutletsProfileLoader.Load(path);
                case "power_outlets":
                    if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                    {
                        path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory ?? string.Empty, "Profiles", "PowerOutlets", "power_outlets.hospital_default.json");
                    }
                    return PowerOutletsProfileLoader.Load(path);
                case "fire_alarm":
                    if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                    {
                        path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory ?? string.Empty, "Profiles", "FireAlarm", "fire_alarm.hospital_default.json");
                    }
                    return FireAlarmProfileLoader.Load(path);
                default:
                    return null;
            }
        }

        private static ILowVoltageRuleEngine ResolveRuleEngine(string discipline)
            => (discipline ?? "fire_alarm").ToLowerInvariant() switch
            {
                "nurse_call" => new NurseCallRuleEngine(),
                "data_outlets" => new DataOutletsRuleEngine(),
                "power_outlets" => new PowerOutletsRuleEngine(),
                _ => new FireAlarmRuleEngine()
            };

        private static ModelState Clone(ModelState state)
        {
            var json = JsonSerializer.Serialize(state);
            return JsonSerializer.Deserialize<ModelState>(json) ?? new ModelState();
        }
    }
}
