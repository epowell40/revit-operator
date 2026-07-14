using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;

namespace RevitBridge.Logic
{
    public class LogicService : ILogicService
    {
        private readonly Dictionary<string, IRequestHandler> _handlers;

        public LogicService()
        {
            _handlers = new Dictionary<string, IRequestHandler>(StringComparer.OrdinalIgnoreCase)
            {
                { "/revit/context", new ContextHandler() },
                { "/revit/state-snapshot", new RevitStateSnapshotHandler() },
                { "/revit/views", new ListViewsHandler() },
                { "/revit/export-image", new ExportViewImageHandler() },
                { "/revit/query", new QueryElementsHandler() },
                { "/revit/delete", new DeleteElementsHandler() },
                { "/revit/set-parameter", new SetParameterHandler() },
                { "/revit/create-sheet", new CreateSheetHandler() },
                { "/revit/place-view", new PlaceViewOnSheetHandler() },
                { "/revit/create-text", new CreateTextNoteHandler() },
                { "/revit/create-duct", new CreateDuctHandler() },
                { "/revit/create-pipe", new CreatePipeHandler() },
                { "/revit/get-parameters", new GetElementParametersHandler() },
                { "/revit/create-family-instance", new CreateFamilyInstanceHandler() },
                { "/revit/visibility", new ViewVisibilityHandler() },
                { "/revit/export-pdf", new ExportPdfHandler() },
                { "/revit/get-lighting-data", new GetLightingDataHandler() },
                { "/revit/sync", new SyncModelHandler() },
                { "/revit/open-model", new OpenModelHandler() },
                { "/revit/resolve", new ResolveHandler() },
                { "/revit/rooms", new RoomHandler() },
                { "/revit/linked-room-boundaries", new LinkedRoomBoundariesHandler() },
                { "/revit/room-contents", new RoomContentsHandler() },
                { "/revit/audit-electrical-circuit-loading", new ElectricalCircuitLoadingAuditHandler() },
                { "/revit/audit-plumbing-fixture-services", new PlumbingFixtureServicesAuditHandler() },
                { "/revit/resolve-mep-routing-context", new RevitBridge.Logic.Handlers.MEP.ResolveMepRoutingContextHandler() },
                { "/revit/create-mep-route", new RevitBridge.Logic.Handlers.MEP.CreateMepRouteHandler() },
                { "/revit/connect-mep-branch", new RevitBridge.Logic.Handlers.MEP.ConnectMepBranchHandler() },
                { "/revit/connect-mep-elements", new RevitBridge.Logic.Handlers.MEP.ConnectMepElementsHandler() },
                { "/revit/existing-conditions-mep-draft-workflow", new RevitBridge.Logic.Handlers.MEP.ExistingConditionsMepDraftWorkflowHandler() },
                { "/revit/copy-mep-pattern", new RevitBridge.Logic.Handlers.MEP.CopyMepPatternHandler() },
                { "/revit/mep-route-workflow", new RevitBridge.Logic.Handlers.MEP.MepRouteWorkflowHandler() },
                { "/revit/mep-branch-network-workflow", new RevitBridge.Logic.Handlers.MEP.MepBranchNetworkWorkflowHandler() },
                { "/revit/edit-mep-route-elements", new RevitBridge.Logic.Handlers.MEP.EditMepRouteElementsHandler() },
                { "/revit/reroute-mep-route-segment", new RevitBridge.Logic.Handlers.MEP.RerouteMepRouteSegmentHandler() },
                { "/revit/ducts-by-spatial-scope", new RevitBridge.Logic.Handlers.MEP.DuctsBySpatialScopeHandler() },
                { "/revit/resize-ductwork-by-scope", new RevitBridge.Logic.Handlers.MEP.ResizeDuctworkByScopeHandler() },
                { "/revit/repair-duct-continuity-by-scope", new RevitBridge.Logic.Handlers.MEP.RepairDuctContinuityByScopeHandler() },
                { "/revit/analyze-dimensions", new AnalyzeDimensionsHandler() },
                { "/revit/export-dimensioning-v2", new ExportDimensioningV2Handler() },
                { "/revit/create-dimension", new CreateDimensionHandler() },
                { "/revit/quantify", new QuantifyElementsHandler() },
                { "/revit/quantify-visualize", new QuantifyVisualizeHandler() },
                { "/revit/ensure-spaces", new EnsureSpacesHandler() },
                { "/revit/create-zones", new CreateZonesHandler() },
                { "/revit/create-zone-visuals", new CreateZoneVisualsHandler() },
                { "/revit/query-zone-data", new QueryZoneDataHandler() },
                { "/revit/link-revit", new LinkRevitHandler() },
                { "/revit/place-families", new PlaceFamiliesHandler() },
                { "/revit/place-family-instance-on-host", new PlaceFamilyInstanceOnHostHandler() },
                { "/revit/create-similar-from-instance", new CreateSimilarFromInstanceHandler() },
                { "/revit/load-family", new LoadFamilyHandler() },
                { "/revit/create-family-from-template", new CreateFamilyFromTemplateHandler() },
                { "/revit/plan-family-evolution", new PlanFamilyEvolutionHandler() },
                { "/revit/apply-family-evolution", new ApplyFamilyEvolutionHandler() },
                { "/revit/read-family-evolution", new ReadFamilyEvolutionHandler() },
                { "/revit/tag-elements", new TagElementsHandler() },
                { "/revit/create-schedule", new CreateScheduleHandler() },
                { "/revit/spatial-analysis", new SpatialAnalysisHandler() },
                { "/revit/fire-damper-audit", new FireDamperHandler() },
                { "/revit/lighting-audit", new LightingHandler() },
                { "/revit/align-ceiling-devices", new AlignCeilingDevicesHandler() },
                { "/revit/duplicate-view", new DuplicateViewHandler() },

                // EPIC-0009: Fire Alarm layout + coverage visualizer (MVP)
                { "/revit/fire-alarm-layout", new FireAlarmLayoutHandler() },
                { "/revit/low-voltage-layout", new LowVoltageLayoutHandler() },
                { "/revit/fire-alarm-visualizer", new FireAlarmVisualizerHandler() },

                // EPIC-0008: Pixel-based element selection
                { "/revit/export-view-frame", new ExportViewFrameHandler() },
                { "/revit/export-view-region", new ExportViewRegionHandler() },
                { "/revit/export-visible-elements", new ExportVisibleElementsHandler() },
                { "/revit/pick-at-pixel", new PickAtPixelHandler() },
                { "/revit/pick-candidate-cluster", new PickCandidateClusterHandler() },
                { "/revit/set-selection", new SetSelectionHandler() },
                { "/revit/highlight-and-export", new HighlightAndExportHandler() },
                { "/revit/activate-view", new ActivateViewHandler() },
                { "/revit/resolve-room-plan-view", new ResolveRoomPlanViewHandler() },
                { "/revit/plan-dwelling-receptacles", new PlanDwellingReceptaclesHandler() },
                { "/revit/plan-room-receptacles-from-analog", new PlanRoomReceptaclesFromAnalogHandler() },
                { "/revit/apply-room-receptacles-from-analog", new ApplyRoomReceptaclesFromAnalogHandler() },
                { "/revit/resolve-room-wall", new ResolveRoomWallHandler() },

                // Type utilities
                { "/revit/list-element-types", new ListElementTypesHandler() },
                { "/revit/change-element-type", new ChangeElementTypeHandler() },
                { "/revit/replace-door", new ReplaceDoorHandler() },

                // EPIC-0010: Safe move primitive + region-based capture
                { "/revit/move-elements", new MoveElementsHandler() },

                // EPIC-0011: Face alignment primitives
                { "/revit/align-elements", new AlignElementsHandler() },
                { "/revit/measure-gap", new MeasureGapHandler() },
                { "/revit/room-align-wall-to-nearest-column", new RoomAlignWallToNearestColumnHandler() }
            };
        }

        public bool CanHandle(string path)
        {
            return _handlers.ContainsKey(path);
        }

        public object Handle(string path, string body, UIApplication app)
        {
            if (_handlers.TryGetValue(path, out var handler))
            {
                // Synchronous wait
                return handler.Handle(app, body).GetAwaiter().GetResult();
            }
            return null;
        }
    }
}
