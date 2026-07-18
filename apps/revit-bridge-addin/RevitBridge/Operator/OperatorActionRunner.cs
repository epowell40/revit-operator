using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Handlers;
using RevitBridge.Services;
using HandlerRequest = RevitBridge.Common.IRequestHandler;
using CreateSimilarFromInstanceActionHandler = RevitBridge.Logic.Handlers.CreateSimilarFromInstanceHandler;
using AdjustHostedInstanceOnHostActionHandler = RevitBridge.Logic.Handlers.AdjustHostedInstanceOnHostHandler;
using LowVoltageLayoutActionHandler = RevitBridge.Logic.Handlers.LowVoltageLayoutHandler;
using PickCandidateClusterActionHandler = RevitBridge.Logic.Handlers.PickCandidateClusterHandler;
using PlaceFamilyInstanceOnHostActionHandler = RevitBridge.Logic.Handlers.PlaceFamilyInstanceOnHostHandler;
using ProjectPointToHostFrameActionHandler = RevitBridge.Logic.Handlers.ProjectPointToHostFrameHandler;
using AuditHostedInstancePlacementActionHandler = RevitBridge.Logic.Handlers.AuditHostedInstancePlacementHandler;
using ResolveRoomWallActionHandler = RevitBridge.Logic.Handlers.ResolveRoomWallHandler;
using RankSimilarDevicesOnWallActionHandler = RevitBridge.Logic.Handlers.RankSimilarDevicesOnWallHandler;
using AssignElectricalCircuitActionHandler = RevitBridge.Logic.Handlers.AssignElectricalCircuitHandler;

namespace RevitBridge.Operator
{
    internal sealed class OperatorActionRunner
    {
        private readonly RevitEventService _eventService;
        private readonly Dictionary<string, HandlerRequest> _handlers;

        public OperatorActionRunner(RevitEventService eventService)
        {
            _eventService = eventService;
            _handlers = new Dictionary<string, HandlerRequest>(StringComparer.OrdinalIgnoreCase)
            {
                { "/revit/context", new ContextHandler() },
                { "/revit/state-snapshot", new RevitStateSnapshotHandler() },
                { "/revit/native-capabilities", new NativeCapabilitiesHandler() },
                { "/revit/views", new RevitBridge.Logic.Handlers.ListViewsHandler() },
                { "/revit/tool-registry", new ToolRegistryHandler() },
                { "/revit/tool-search", new ToolSearchHandler() },
                { "/revit/tool-doc", new ToolDocHandler() },
                { "/revit/tool-examples", new ToolExamplesHandler() },
                { "/revit/native-api-policy", new NativeApiPolicyHandler() },
                { "/revit/native-api-catalog", new NativeApiCatalogHandler() },
                { "/revit/native-api-search", new NativeApiSearchHandler() },
                { "/revit/native-api-call", new NativeApiCallHandler() },
                { "/revit/self-test", new SelfTestHandler() },
                { "/revit/regenerate", new RegenerateHandler() },
                { "/revit/computer-use-observe", new ComputerUseObserveHandler() },
                { "/revit/computer-use-act", new ComputerUseActHandler() },
                { "/revit/computer-use-guard", new ComputerUseGuardHandler() },
                { "/revit/open-model", new OpenModelHandler() },
                { "/revit/save-as", new SaveAsModelHandler() },
                { "/revit/sync", new SyncModelHandler() },
                { "/revit/worksets", new WorksetsHandler() },
                { "/revit/project-parameters", new ProjectParametersHandler() },
                { "/revit/purge-unused", new PurgeUnusedHandler() },
                { "/revit/transfer-view-templates", new TransferViewTemplatesHandler() },
                { "/revit/rooms", new RoomHandler() },
                { "/revit/linked-room-boundaries", new LinkedRoomBoundariesHandler() },
                { "/revit/renumber-rooms", new RenumberRoomsHandler() },
                { "/revit/room-contents", new RoomContentsHandler() },
                { "/revit/spatial-context", new SpatialContextHandler() },
                { "/revit/find-elements", new FindElementsHandler() },
                { "/revit/update-parameter-by-query", new UpdateParameterByQueryHandler() },
                { "/revit/update-panel-parameter", new UpdatePanelParameterHandler() },
                { "/revit/locate-elements", new LocateElementsHandler() },
                { "/revit/get-placement-context", new GetPlacementContextHandler() },
                { "/revit/resolve-room-wall", new ResolveRoomWallActionHandler() },
                { "/revit/rank-similar-devices-on-wall", new RankSimilarDevicesOnWallActionHandler() },
                { "/revit/pick-candidate-cluster", new PickCandidateClusterActionHandler() },
                { "/revit/project-point-to-host-frame", new ProjectPointToHostFrameActionHandler() },
                { "/revit/audit-hosted-instance-placement", new AuditHostedInstancePlacementActionHandler() },
                { "/revit/resolve-redline-target", new ResolveRedlineTargetHandler() },
                { "/revit/propose-fix", new ProposeFixHandler() },
                { "/revit/find-duplicate-marks", new FindDuplicateMarksHandler() },
                { "/revit/airflow-qa", new AirflowQaHandler() },
                { "/revit/mep-workflows", new MepWorkflowsHandler() },
                { "/revit/resolve-mep-routing-context", new ResolveMepRoutingContextHandler() },
                { "/revit/create-mep-route", new CreateMepRouteHandler() },
                { "/revit/connect-mep-branch", new ConnectMepBranchHandler() },
                { "/revit/connect-mep-elements", new RevitBridge.Logic.Handlers.MEP.ConnectMepElementsHandler() },
                { "/revit/create-pipe-between-connectors", new RevitBridge.Logic.Handlers.MEP.CreatePipeBetweenConnectorsHandler() },
                { "/revit/existing-conditions-mep-draft-workflow", new RevitBridge.Logic.Handlers.MEP.ExistingConditionsMepDraftWorkflowHandler() },
                { "/revit/copy-mep-pattern", new RevitBridge.Logic.Handlers.MEP.CopyMepPatternHandler() },
                { "/revit/mep-route-workflow", new MepRouteWorkflowHandler() },
                { "/revit/mep-branch-network-workflow", new RevitBridge.Logic.Handlers.MEP.MepBranchNetworkWorkflowHandler() },
                { "/revit/edit-mep-route-elements", new RevitBridge.Logic.Handlers.MEP.EditMepRouteElementsHandler() },
                { "/revit/reroute-mep-route-segment", new RevitBridge.Logic.Handlers.MEP.RerouteMepRouteSegmentHandler() },

                // MEP / connectivity helpers (read-only)
                { "/revit/trace-connected-network", new TraceConnectedNetworkHandler() },
                { "/revit/room_mep_intersect", new RoomMepIntersectHandler() },
                { "/revit/ducts-by-spatial-scope", new DuctsBySpatialScopeHandler() },
                { "/revit/find-elements-by-parameter", new FindElementsByParameterHandler() },
                { "/revit/sync-connected-sizes", new SyncConnectedSizesHandler() },
                { "/revit/resize-duct-run", new ResizeDuctRunHandler() },
                { "/revit/resize-ducts-by-scope", new ResizeDuctsByScopeHandler() },
                { "/revit/resize-ducts-in-room", new ResizeDuctsInRoomHandler() },
                { "/revit/resize-ductwork-by-scope", new ResizeDuctworkByScopeHandler() },
                { "/revit/repair-duct-continuity-by-scope", new RepairDuctContinuityByScopeHandler() },
                { "/revit/get-connectors", new GetConnectorsHandler() },
                { "/revit/align-room-tops-to-ceilings", new AlignRoomTopsToCeilingsHandler() },
                { "/revit/export-image", new ExportViewImageHandler() },
                { "/revit/export-pdf", new ExportPdfHandler() },
                { "/revit/print", new PrintHandler() },
                { "/revit/export-images", new ExportImagesBatchHandler() },
                { "/revit/export-dwg", new ExportDwgHandler() },
                { "/revit/export-ifc", new ExportIfcHandler() },
                { "/revit/export-view-frame", new ExportViewFrameHandler() },
                { "/revit/export-view-region", new ExportViewRegionHandler() },
                { "/revit/export-visible-elements", new ExportVisibleElementsHandler() },
                { "/revit/pick-at-pixel", new PickAtPixelHandler() },
                { "/revit/highlight-and-export", new HighlightAndExportHandler() },
                { "/revit/activate-view", new ActivateViewHandler() },
                { "/revit/query", new QueryElementsHandler() },
                { "/revit/resolve", new ResolveHandler() },
                { "/revit/get-element-summary", new GetElementSummaryHandler() },
                { "/revit/get-parameters", new GetElementParametersHandler() },
                { "/revit/quantify", new QuantifyElementsHandler() },
                { "/revit/quantify-visualize", new QuantifyVisualizeHandler() },
                { "/revit/sheets", new ListSheetsHandler() },
                { "/revit/schedules", new SchedulesHandler() },
                { "/revit/configure-schedule", new ConfigureScheduleHandler() },
                { "/revit/export-schedule-csv", new ExportScheduleCsvHandler() },
                { "/revit/export-warnings-report", new ExportWarningsReportHandler() },
                { "/revit/warnings", new ExportWarningsReportHandler() },
                { "/revit/model-health", new ModelHealthHandler() },
                { "/revit/qa-checks", new QaChecksHandler() },
                { "/revit/print-sets", new PrintSetsHandler() },
                { "/revit/create-print-set", new CreatePrintSetHandler() },
                { "/revit/revisions", new RevisionsHandler() },
                { "/revit/create-revision", new CreateRevisionHandler() },
                { "/revit/apply-revision-to-sheets", new ApplyRevisionToSheetsHandler() },
                { "/revit/get-titleblock-info", new GetTitleblockInfoHandler() },
                { "/revit/titleblock-label-map", new TitleblockLabelMapHandler() },
                { "/revit/capture-sheet-region", new CaptureSheetRegionHandler() },
                { "/revit/verify-parameter-on-sheet", new VerifyParameterOnSheetHandler() },
                { "/revit/titleblock-family-update-text", new TitleblockFamilyUpdateTextHandler() },
                { "/revit/titleblock-date-candidates", new TitleblockDateCandidatesHandler() },
                { "/revit/titleblock-set-date-smart", new TitleblockSetDateSmartHandler() },
                { "/revit/get-family-file-path", new GetFamilyFilePathHandler() },
                { "/revit/open-family-doc", new OpenFamilyDocHandler() },
                { "/revit/find-text-notes", new FindTextNotesHandler() },
                { "/revit/replace-text-note", new ReplaceTextNoteHandler() },
                { "/revit/save-family-doc", new SaveFamilyDocHandler() },
                { "/revit/load-family-doc", new LoadFamilyDocHandler() },
                { "/revit/close-doc", new CloseDocHandler() },
                { "/revit/edit-family-from-instance", new EditFamilyFromInstanceHandler() },
                { "/revit/find-family-text-notes", new FindFamilyTextNotesHandler() },
                { "/revit/set-text-note-text", new SetTextNoteTextHandler() },
                { "/revit/reload-family-edit-session", new ReloadFamilyEditSessionHandler() },
                { "/revit/transaction-plan", new TransactionPlanHandler() },
                { "/revit/transaction-validate", new TransactionValidateHandler() },
                { "/revit/transaction-apply", new TransactionApplyHandler() },

                // Drafting / documentation
                { "/revit/visibility", new ViewVisibilityHandler() },
                { "/revit/datums", new DatumsHandler() },
                { "/revit/create-text", new CreateTextNoteHandler() },
                { "/revit/import-drawing-spec", new ImportDrawingSpecHandler() },
                { "/revit/import-excel-table", new ImportExcelTableHandler() },
                { "/revit/export-elements-xlsx", new ExportElementsXlsxHandler() },
                { "/revit/import-elements-xlsx-updates", new ImportElementsXlsxUpdatesHandler() },
                { "/revit/create-drafting-view", new CreateDraftingViewHandler() },
                { "/revit/create-view", new CreateViewHandler() },
                { "/revit/draw-detail-curves", new DrawDetailCurvesHandler() },
                { "/revit/create-filled-region", new CreateFilledRegionHandler() },
                { "/revit/create-revision-cloud", new CreateRevisionCloudHandler() },
                { "/revit/keynotes", new KeynotesHandler() },
                { "/revit/tag-elements", new TagElementsHandler() },
                { "/revit/create-dimension", new CreateDimensionHandler() },
                { "/revit/create-sheet", new CreateSheetHandler() },
                { "/revit/create-sheets", new CreateSheetsBatchHandler() },
                { "/revit/place-view", new PlaceViewOnSheetHandler() },
                { "/revit/place-views", new PlaceViewsBatchHandler() },
                { "/revit/align-viewports", new AlignViewportsHandler() },
                { "/revit/renumber-sheets", new RenumberSheetsHandler() },
                { "/revit/sync-sheet-names", new SyncSheetNamesHandler() },
                { "/revit/link-cad", new LinkCadHandler() },
                { "/revit/link-revit", new RevitBridge.Logic.Handlers.LinkRevitHandler() },
                { "/revit/place-image", new PlaceImageHandler() },
                { "/revit/place-pdf-underlay", new PlacePdfUnderlayHandler() },
                { "/revit/import-zippybim-geometry", new ImportZippyBimGeometryHandler() },
                { "/revit/create-schedule", new CreateScheduleHandler() },

                // Model manipulation
                { "/revit/delete", new DeleteElementsHandler() },
                { "/revit/set-parameter", new SetParameterHandler() },
                { "/revit/create-duct", new CreateDuctHandler() },
                { "/revit/create-pipe", new CreatePipeHandler() },
                { "/revit/create-family-instance", new CreateFamilyInstanceHandler() },
                { "/revit/place-families", new PlaceFamiliesHandler() },
                { "/revit/place-family-instance-on-host", new PlaceFamilyInstanceOnHostActionHandler() },
                { "/revit/create-similar-from-instance", new CreateSimilarFromInstanceActionHandler() },
                { "/revit/adjust-hosted-instance-on-host", new AdjustHostedInstanceOnHostActionHandler() },
                { "/revit/assign-electrical-circuit", new AssignElectricalCircuitActionHandler() },
                { "/revit/load-family", new LoadFamilyHandler() },
                { "/revit/create-family-from-template", new CreateFamilyFromTemplateHandler() },
                { "/revit/duplicate-view", new DuplicateViewHandler() },
                { "/revit/change-element-type", new ChangeElementTypeHandler() },
                { "/revit/replace-door", new ReplaceDoorHandler() },
                { "/revit/move-elements", new MoveElementsHandler() },
                { "/revit/rotate-elements", new RotateElementsHandler() },
                { "/revit/align-elements", new AlignElementsHandler() },
                { "/revit/measure-gap", new MeasureGapHandler() },
                { "/revit/room-align-wall-to-nearest-column", new RoomAlignWallToNearestColumnHandler() },

                // Analytics / workflows
                { "/revit/get-lighting-data", new GetLightingDataHandler() },
                { "/revit/analyze-dimensions", new AnalyzeDimensionsHandler() },
                { "/revit/export-dimensioning-v2", new ExportDimensioningV2Handler() },
                { "/revit/spatial-analysis", new SpatialAnalysisHandler() },
                { "/revit/fire-damper-audit", new FireDamperHandler() },
                { "/revit/lighting-audit", new LightingHandler() },

                // Fire alarm
                { "/revit/fire-alarm-layout", new FireAlarmLayoutHandler() },
                { "/revit/low-voltage-layout", new LowVoltageLayoutActionHandler() },
                { "/revit/fire-alarm-visualizer", new FireAlarmVisualizerHandler() },

                // Zones/spaces
                { "/revit/ensure-spaces", new EnsureSpacesHandler() },
                { "/revit/create-zones", new CreateZonesHandler() },
                { "/revit/create-zone-visuals", new CreateZoneVisualsHandler() },
                { "/revit/query-zone-data", new QueryZoneDataHandler() },

                // Selection / types
                { "/revit/set-selection", new SetSelectionHandler() },
                { "/revit/resolve-room-plan-view", new ResolveRoomPlanViewHandler() },
                { "/revit/plan-dwelling-receptacles", new PlanDwellingReceptaclesHandler() },
                { "/revit/audit-electrical-circuit-loading", new RevitBridge.Logic.Handlers.ElectricalCircuitLoadingAuditHandler() },
                { "/revit/audit-plumbing-fixture-services", new RevitBridge.Logic.Handlers.PlumbingFixtureServicesAuditHandler() },
                { "/revit/plan-room-receptacles-from-analog", new PlanRoomReceptaclesFromAnalogHandler() },
                { "/revit/apply-room-receptacles-from-analog", new ApplyRoomReceptaclesFromAnalogHandler() },
                { "/revit/list-element-types", new ListElementTypesHandler() },
                { "/revit/resolve-element-type", new ResolveElementTypeHandler() },
                { "/revit/duplicate-element-type", new DuplicateElementTypeHandler() },
                { "/revit/set-type-parameters", new SetTypeParametersHandler() },
                { "/revit/duplicate-type-and-swap-instance", new DuplicateTypeAndSwapInstanceHandler() },
                { "/revit/plan-family-evolution", new RevitBridge.Logic.Handlers.PlanFamilyEvolutionHandler() },
                { "/revit/apply-family-evolution", new RevitBridge.Logic.Handlers.ApplyFamilyEvolutionHandler() },
                { "/revit/read-family-evolution", new RevitBridge.Logic.Handlers.ReadFamilyEvolutionHandler() }
            };
        }

        public async Task<object> ExecuteAsync(OperatorActionCall action, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var method = (action.Method ?? "").Trim().ToUpperInvariant();
            var path = (action.Path ?? "").Trim();
            var risk = OperatorApprovalPolicy.GetRisk(method, path);

            if (!OperatorActionAllowlist.IsAllowed(method, path))
            {
                throw new InvalidOperationException($"Action not allowlisted: {method} {path}");
            }

            OperatorActionSchemaValidator.ValidateOrThrow(action);

            if (string.Equals(path, "/revit/ping", StringComparison.OrdinalIgnoreCase))
            {
                return new { status = "ok", timestamp = DateTime.Now };
            }

            if (string.Equals(path, "/revit/capabilities", StringComparison.OrdinalIgnoreCase))
            {
                return OperatorCapabilities.Get();
            }

            if (!_handlers.TryGetValue(path, out var handler))
            {
                throw new InvalidOperationException($"No handler mapped for: {path}");
            }

            var jsonBody = "";
            if (action.Body != null)
            {
                if (action.Body is JsonElement je)
                {
                    jsonBody = je.GetRawText();
                }
                else
                {
                    jsonBody = JsonSerializer.Serialize(action.Body, OperatorUiProtocol.JsonOptions);
                }
            }

            if (IsDirectDialogComputerUsePath(path))
            {
                return await handler.Handle(null!, jsonBody).ConfigureAwait(false);
            }

            return await _eventService.Run(app =>
            {
                var result = handler.Handle(app, jsonBody).GetAwaiter().GetResult();

                // Best-effort UI refresh after actions that likely modified the model. This reduces "it worked but I can't see it"
                // confusion due to view redraw / regeneration lag.
                if (method == "POST" && risk >= OperatorActionRisk.Medium)
                {
                    TryRefreshGraphics(app);
                }

                return result;
            }).ConfigureAwait(false);
        }

        private static bool IsDirectDialogComputerUsePath(string path)
        {
            return string.Equals(path, "/revit/computer-use-observe", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(path, "/revit/computer-use-act", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(path, "/revit/computer-use-guard", StringComparison.OrdinalIgnoreCase);
        }

        private static void TryRefreshGraphics(Autodesk.Revit.UI.UIApplication app)
        {
            try
            {
                var uidoc = app?.ActiveUIDocument;
                if (uidoc == null) return;
                try { uidoc.Document?.Regenerate(); } catch { }
                try { uidoc.RefreshActiveView(); } catch { }
            }
            catch
            {
                // Never fail the action on refresh issues.
            }
        }
    }
}
