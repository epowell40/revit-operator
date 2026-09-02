using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Handlers;
using RevitBridge.Operator;
using RevitBridge.Services;
using CreateSimilarFromInstanceActionHandler = RevitBridge.Logic.Handlers.CreateSimilarFromInstanceHandler;
using AdjustHostedInstanceOnHostActionHandler = RevitBridge.Logic.Handlers.AdjustHostedInstanceOnHostHandler;
using HandlerRequest = RevitBridge.Common.IRequestHandler;
using LowVoltageLayoutActionHandler = RevitBridge.Logic.Handlers.LowVoltageLayoutHandler;
using PickCandidateClusterActionHandler = RevitBridge.Logic.Handlers.PickCandidateClusterHandler;
using PlaceFamilyInstanceOnHostActionHandler = RevitBridge.Logic.Handlers.PlaceFamilyInstanceOnHostHandler;
using ProjectPointToHostFrameActionHandler = RevitBridge.Logic.Handlers.ProjectPointToHostFrameHandler;
using AuditHostedInstancePlacementActionHandler = RevitBridge.Logic.Handlers.AuditHostedInstancePlacementHandler;
using ResolveRoomWallActionHandler = RevitBridge.Logic.Handlers.ResolveRoomWallHandler;
using RankSimilarDevicesOnWallActionHandler = RevitBridge.Logic.Handlers.RankSimilarDevicesOnWallHandler;
using AssignElectricalCircuitActionHandler = RevitBridge.Logic.Handlers.AssignElectricalCircuitHandler;
using AssignElectricalDistributionSystemActionHandler = RevitBridge.Logic.Handlers.AssignElectricalDistributionSystemHandler;

namespace RevitBridge.Server
{
    public class RevitHttpServer
    {
        private HttpListener _listener;
        private readonly RevitEventService _eventService;
        private readonly IOperatorNativeHttpAuthorizer _nativeHttpAuthorizer;
        private readonly OperatorNativeTransportReplayCache _nativeTransportReplayCache = new OperatorNativeTransportReplayCache();
        private bool _isRunning;
        private string _activeUrl = "";
        private string _nativeTransportEpoch = "";
        private bool _ownsActiveDiscoveryReceipt;
        private const string DefaultUrl = "http://127.0.0.1:5000/";
        private const string DiscoveryMutexName = @"Local\RevitOperator.BridgeDiscovery.v1";
        private readonly Dictionary<string, HandlerRequest> _handlers;

        public RevitHttpServer(RevitEventService eventService, IOperatorNativeHttpAuthorizer nativeHttpAuthorizer)
        {
            _eventService = eventService ?? throw new ArgumentNullException(nameof(eventService));
            _nativeHttpAuthorizer = nativeHttpAuthorizer ?? throw new ArgumentNullException(nameof(nativeHttpAuthorizer));

            _handlers = new Dictionary<string, HandlerRequest>(StringComparer.OrdinalIgnoreCase)
            {
                { "/revit/context", new ContextHandler() },
                { "/revit/state-snapshot", new RevitStateSnapshotHandler() },
                { "/revit/dynamic-runtime/bootstrap", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicRuntimeBootstrapHandler() },
                { "/revit/dynamic-runtime/register", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicRuntimeRegistrationHandler() },
                { "/revit/dynamic-runtime/snapshot", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicRuntimeSnapshotHandler() },
                { "/revit/dynamic-runtime/preview", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicRuntimePreviewHandler() },
                { "/revit/dynamic-runtime/authorize-apply", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicRuntimeApplyAuthorizationHandler() },
                { "/revit/dynamic-runtime/apply", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicRuntimeApplyHandler() },
                { "/revit/dynamic-runtime/observe-v1", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicRuntimeObservationV1Handler() },
                { "/revit/dynamic-runtime/observe-building-systems-v1", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicBuildingSystemsObservationV1Handler() },
                { "/revit/dynamic-runtime/result-reference-facts-v1", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicResultReferenceFactsV1Handler() },
                { "/revit/dynamic-runtime/mep-result-preview-v1", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicMepResultPreviewV1Handler() },
                { "/revit/dynamic-runtime/mep-result-authorize-v1", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicMepResultAuthorizeV1Handler() },
                { "/revit/dynamic-runtime/mep-result-apply-v1", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicMepResultApplyV1Handler() },
                { "/revit/dynamic-runtime/annotation-result-preview-v1", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicAnnotationResultPreviewV1Handler() },
                { "/revit/dynamic-runtime/annotation-result-authorize-v1", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicAnnotationResultAuthorizeV1Handler() },
                { "/revit/dynamic-runtime/annotation-result-apply-v1", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicAnnotationResultApplyV1Handler() },
                { "/revit/dynamic-runtime/core-preview-v1", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicCoreOperationPreviewV1Handler() },
                { "/revit/dynamic-runtime/core-authorize-v1", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicCoreOperationAuthorizeV1Handler() },
                { "/revit/dynamic-runtime/core-apply-v1", new RevitBridge.Logic.Handlers.DynamicRuntime.DynamicCoreOperationApplyV1Handler() },
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
                { "/revit/native-api-ops", new NativeApiOpsHandler() },
                { "/revit/native-api-mutation-ops", new NativeApiMutationOpsHandler() },
                { "/revit/self-test", new SelfTestHandler() },
                { "/revit/regenerate", new RegenerateHandler() },
                { "/revit/computer-use-observe", new ComputerUseObserveHandler() },
                { "/revit/computer-use-act", new ComputerUseActHandler() },
                { "/revit/computer-use-guard", new ComputerUseGuardHandler() },
                { "/revit/capture-screenshare", new RevitBridge.Logic.Handlers.CaptureScreenshareHandler() },
                { "/revit/export-image", new ExportViewImageHandler() },
                { "/revit/query", new QueryElementsHandler() },
                { "/revit/delete", new DeleteElementsHandler() },
                { "/revit/set-parameter", new SetParameterHandler() },
                { "/revit/create-sheet", new CreateSheetHandler() },
                { "/revit/duplicate-sheet", new DuplicateSheetHandler() },
                { "/revit/create-sheets", new CreateSheetsBatchHandler() },
                { "/revit/place-view", new PlaceViewOnSheetHandler() },
                { "/revit/place-views", new PlaceViewsBatchHandler() },
                { "/revit/align-viewports", new AlignViewportsHandler() },
                { "/revit/renumber-sheets", new RenumberSheetsHandler() },
                { "/revit/sync-sheet-names", new SyncSheetNamesHandler() },
                { "/revit/create-text", new CreateTextNoteHandler() },
                { "/revit/import-drawing-spec", new ImportDrawingSpecHandler() },
                { "/revit/import-excel-table", new ImportExcelTableHandler() },
                { "/revit/export-elements-xlsx", new ExportElementsXlsxHandler() },
                { "/revit/import-elements-xlsx-updates", new ImportElementsXlsxUpdatesHandler() },
                { "/revit/create-drafting-view", new CreateDraftingViewHandler() },
                { "/revit/create-view", new CreateViewHandler() },
                { "/revit/draw-detail-curves", new DrawDetailCurvesHandler() },
                { "/revit/annotation-symbol-leaders", new AnnotationSymbolLeadersHandler() },
                { "/revit/create-filled-region", new CreateFilledRegionHandler() },
                { "/revit/create-revision-cloud", new CreateRevisionCloudHandler() },
                { "/revit/keynotes", new KeynotesHandler() },
                { "/revit/link-cad", new LinkCadHandler() },
                { "/revit/link-revit", new RevitBridge.Logic.Handlers.LinkRevitHandler() },
                { "/revit/place-image", new PlaceImageHandler() },
                { "/revit/place-pdf-underlay", new PlacePdfUnderlayHandler() },
                { "/revit/import-zippybim-geometry", new ImportZippyBimGeometryHandler() },
                { "/revit/create-duct", new CreateDuctHandler() },
                { "/revit/create-pipe", new CreatePipeHandler() },
                { "/revit/get-parameters", new GetElementParametersHandler() },
                { "/revit/create-family-instance", new CreateFamilyInstanceHandler() },

                // EPIC-0002: Safety primitives (Plan / Apply / Validate) + element summary ("Eyes/Hands")
                { "/revit/get-element-summary", new GetElementSummaryHandler() },
                { "/revit/transaction-plan", new TransactionPlanHandler() },
                { "/revit/transaction-apply", new TransactionApplyHandler() },
                { "/revit/transaction-validate", new TransactionValidateHandler() },

                { "/revit/visibility", new ViewVisibilityHandler() },
                { "/revit/datums", new DatumsHandler() },
                { "/revit/export-pdf", new ExportPdfHandler() },
                { "/revit/print", new PrintHandler() },
                { "/revit/export-images", new ExportImagesBatchHandler() },
                { "/revit/export-dwg", new ExportDwgHandler() },
                { "/revit/export-ifc", new ExportIfcHandler() },
                { "/revit/get-lighting-data", new GetLightingDataHandler() },
                { "/revit/sync", new SyncModelHandler() },
                { "/revit/open-model", new OpenModelHandler() },
                { "/revit/close-active-model", new CloseActiveModelHandler() },
                { "/revit/save-as", new SaveAsModelHandler() },
                { "/revit/worksets", new WorksetsHandler() },
                { "/revit/project-parameters", new ProjectParametersHandler() },
                { "/revit/purge-unused", new PurgeUnusedHandler() },
                { "/revit/transfer-view-templates", new TransferViewTemplatesHandler() },
                { "/revit/resolve", new ResolveHandler() },
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
                { "/revit/connect-existing-mep-branch", new ConnectExistingMepBranchHandler() },
                { "/revit/connect-mep-elements", new RevitBridge.Logic.Handlers.MEP.ConnectMepElementsHandler() },
                { "/revit/create-pipe-between-connectors", new RevitBridge.Logic.Handlers.MEP.CreatePipeBetweenConnectorsHandler() },
                { "/revit/existing-conditions-mep-draft-workflow", new RevitBridge.Logic.Handlers.MEP.ExistingConditionsMepDraftWorkflowHandler() },
                { "/revit/copy-mep-pattern", new RevitBridge.Logic.Handlers.MEP.CopyMepPatternHandler() },
                { "/revit/mep-route-workflow", new MepRouteWorkflowHandler() },
                { "/revit/mep-branch-network-workflow", new RevitBridge.Logic.Handlers.MEP.MepBranchNetworkWorkflowHandler() },
                { "/revit/edit-mep-route-elements", new RevitBridge.Logic.Handlers.MEP.EditMepRouteElementsHandler() },
                { "/revit/reroute-mep-route-segment", new RevitBridge.Logic.Handlers.MEP.RerouteMepRouteSegmentHandler() },
                { "/revit/arch-workflows", new ArchWorkflowsHandler() },
                { "/revit/trace-connected-network", new TraceConnectedNetworkHandler() },
                { "/revit/find-elements-by-parameter", new FindElementsByParameterHandler() },
                { "/revit/room_mep_intersect", new RoomMepIntersectHandler() },
                { "/revit/ducts-by-spatial-scope", new DuctsBySpatialScopeHandler() },
                { "/revit/sync-connected-sizes", new SyncConnectedSizesHandler() },
                { "/revit/resize-duct-run", new ResizeDuctRunHandler() },
                { "/revit/resize-ducts-by-scope", new ResizeDuctsByScopeHandler() },
                { "/revit/resize-ducts-in-room", new ResizeDuctsInRoomHandler() },
                { "/revit/resize-ductwork-by-scope", new ResizeDuctworkByScopeHandler() },
                { "/revit/repair-duct-continuity-by-scope", new RepairDuctContinuityByScopeHandler() },
                { "/revit/repair-mep-connectors", new RepairMepConnectorsHandler() },
                { "/revit/get-connectors", new GetConnectorsHandler() },
                { "/revit/audit-electrical-circuit-loading", new RevitBridge.Logic.Handlers.ElectricalCircuitLoadingAuditHandler() },
                { "/revit/audit-plumbing-fixture-services", new RevitBridge.Logic.Handlers.PlumbingFixtureServicesAuditHandler() },
                { "/revit/align-room-tops-to-ceilings", new AlignRoomTopsToCeilingsHandler() },
                { "/revit/analyze-dimensions", new AnalyzeDimensionsHandler() },
                { "/revit/export-dimensioning-v2", new ExportDimensioningV2Handler() },
                { "/revit/duplicate-view", new DuplicateViewHandler() },
                { "/revit/create-dimension", new CreateDimensionHandler() },
                { "/revit/quantify", new QuantifyElementsHandler() },
                { "/revit/quantify-visualize", new QuantifyVisualizeHandler() },
                { "/revit/ensure-spaces", new EnsureSpacesHandler() },
                { "/revit/create-zones", new CreateZonesHandler() },
                { "/revit/create-zone-visuals", new CreateZoneVisualsHandler() },
                { "/revit/query-zone-data", new QueryZoneDataHandler() },
                { "/revit/place-families", new PlaceFamiliesHandler() },
                { "/revit/place-family-instance-on-host", new PlaceFamilyInstanceOnHostActionHandler() },
                { "/revit/create-similar-from-instance", new CreateSimilarFromInstanceActionHandler() },
                { "/revit/adjust-hosted-instance-on-host", new AdjustHostedInstanceOnHostActionHandler() },
                { "/revit/assign-electrical-circuit", new AssignElectricalCircuitActionHandler() },
                { "/revit/assign-electrical-distribution-system", new AssignElectricalDistributionSystemActionHandler() },
                { "/revit/load-family", new LoadFamilyHandler() },
                { "/revit/create-family-from-template", new CreateFamilyFromTemplateHandler() },
                { "/revit/tag-elements", new TagElementsHandler() },
                { "/revit/create-schedule", new CreateScheduleHandler() },
                { "/revit/spatial-analysis", new SpatialAnalysisHandler() },
                { "/revit/fire-damper-audit", new FireDamperHandler() },
                { "/revit/lighting-audit", new LightingHandler() },
                { "/revit/sheets", new ListSheetsHandler() },
                { "/revit/schedules", new SchedulesHandler() },
                { "/revit/update-schedule-cell", new UpdateScheduleCellHandler() },
                { "/revit/replace-schedule-values", new ReplaceScheduleValuesHandler() },
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

                // Family editing (static titleblock text)
                { "/revit/get-family-file-path", new GetFamilyFilePathHandler() },
                { "/revit/open-family-doc", new OpenFamilyDocHandler() },
                { "/revit/find-text-notes", new FindTextNotesHandler() },
                { "/revit/replace-text-note", new ReplaceTextNoteHandler() },
                { "/revit/save-family-doc", new SaveFamilyDocHandler() },
                { "/revit/load-family-doc", new LoadFamilyDocHandler() },
                { "/revit/close-doc", new CloseDocHandler() },

                { "/revit/edit-family-from-instance", new EditFamilyFromInstanceHandler() },
                { "/revit/inspect-family-content", new InspectFamilyContentHandler() },
                { "/revit/find-family-text-notes", new FindFamilyTextNotesHandler() },
                { "/revit/set-text-note-text", new SetTextNoteTextHandler() },
                { "/revit/reload-family-edit-session", new ReloadFamilyEditSessionHandler() },

                // EPIC-0009: Fire Alarm layout + coverage visualizer (MVP)
                { "/revit/fire-alarm-layout", new FireAlarmLayoutHandler() },
                { "/revit/low-voltage-layout", new LowVoltageLayoutActionHandler() },
                { "/revit/fire-alarm-visualizer", new FireAlarmVisualizerHandler() },

                // EPIC-0008: Pixel-based element selection
                { "/revit/export-view-frame", new ExportViewFrameHandler() },
                { "/revit/export-view-region", new ExportViewRegionHandler() },
                { "/revit/export-visible-elements", new ExportVisibleElementsHandler() },
                { "/revit/pick-at-pixel", new PickAtPixelHandler() },
                { "/revit/set-selection", new SetSelectionHandler() },
                { "/revit/highlight-and-export", new HighlightAndExportHandler() },
                { "/revit/activate-view", new ActivateViewHandler() },
                { "/revit/resolve-room-plan-view", new ResolveRoomPlanViewHandler() },
                { "/revit/plan-dwelling-receptacles", new PlanDwellingReceptaclesHandler() },
                { "/revit/plan-room-receptacles-from-analog", new PlanRoomReceptaclesFromAnalogHandler() },
                { "/revit/apply-room-receptacles-from-analog", new ApplyRoomReceptaclesFromAnalogHandler() },

                // Type utilities (needed for "swap double door -> single door" workflows)
                { "/revit/list-element-types", new ListElementTypesHandler() },
                { "/revit/resolve-element-type", new ResolveElementTypeHandler() },
                { "/revit/change-element-type", new ChangeElementTypeHandler() },
                { "/revit/duplicate-element-type", new DuplicateElementTypeHandler() },
                { "/revit/set-type-parameters", new SetTypeParametersHandler() },
                { "/revit/duplicate-type-and-swap-instance", new DuplicateTypeAndSwapInstanceHandler() },
                { "/revit/plan-family-evolution", new RevitBridge.Logic.Handlers.PlanFamilyEvolutionHandler() },
                { "/revit/apply-family-evolution", new RevitBridge.Logic.Handlers.ApplyFamilyEvolutionHandler() },
                { "/revit/read-family-evolution", new RevitBridge.Logic.Handlers.ReadFamilyEvolutionHandler() },
                { "/revit/replace-door", new ReplaceDoorHandler() },

                // EPIC-0010: Safe move primitive + region-based capture
                { "/revit/move-elements", new MoveElementsHandler() },
                { "/revit/rotate-elements", new RotateElementsHandler() },

                // EPIC-0011: Face alignment primitives
                { "/revit/align-elements", new AlignElementsHandler() },
                { "/revit/measure-gap", new MeasureGapHandler() },
                { "/revit/room-align-wall-to-nearest-column", new RoomAlignWallToNearestColumnHandler() },
            };
        }

        public void Start()
        {
            if (_isRunning) return;
            WriteStartupLog("HTTP server Start begin.");
            _nativeTransportEpoch = OperatorNativeTransportCodec.CreateServerEpoch();

            foreach (var candidateUrl in ResolveCandidateUrls())
            {
                try
                {
                    WriteStartupLog($"Trying HTTP listener prefix {candidateUrl}");
                    var listener = new HttpListener();
                    listener.Prefixes.Add(candidateUrl);
                    listener.Start();
                    _listener = listener;
                    _activeUrl = candidateUrl;
                    _isRunning = true;
                    _ownsActiveDiscoveryReceipt = TryPublishActiveDiscoveryReceipts(candidateUrl, _nativeTransportEpoch);
                    if (!_ownsActiveDiscoveryReceipt)
                    {
                        WriteStartupLog("A live Revit bridge already owns the global discovery receipts; this fallback listener will not replace them.");
                    }
                    WriteStartupLog($"HTTP listener started at {candidateUrl}");
                    Task.Run(() => HandleIncomingConnections());
                    return;
                }
                catch (Exception ex)
                {
                    WriteStartupLog($"HTTP listener failed at {candidateUrl}: {ex.GetType().FullName}: {ex.Message}");
                    try { _listener?.Close(); } catch { }
                }
            }

            WriteStartupLog("HTTP listener failed for every candidate URL; preserved any discovery receipts owned by another Revit process.");
        }

        public void Stop()
        {
            var activeUrl = _activeUrl;
            var nativeTransportEpoch = _nativeTransportEpoch;
            _isRunning = false;
            try { _listener?.Stop(); } catch { }
            try { _listener?.Close(); } catch { }
            if (_ownsActiveDiscoveryReceipt)
            {
                ClearActiveDiscoveryReceiptsIfOwned(activeUrl, nativeTransportEpoch);
            }
            _ownsActiveDiscoveryReceipt = false;
            _nativeTransportEpoch = "";
        }

        private static IEnumerable<string> ResolveCandidateUrls()
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            void AddCandidate(List<string> output, string? value)
            {
                var url = NormalizePrefix(value);
                if (string.IsNullOrWhiteSpace(url)) return;
                if (seen.Add(url)) output.Add(url);
            }

            var candidates = new List<string>();
            AddCandidate(candidates, Environment.GetEnvironmentVariable("OPERATOR_REVIT_BRIDGE_URL"));
            AddCandidate(candidates, Environment.GetEnvironmentVariable("REVIT_BRIDGE_URL"));
            AddCandidate(candidates, DefaultUrl);

            var portsRaw = (Environment.GetEnvironmentVariable("OPERATOR_REVIT_BRIDGE_FALLBACK_PORTS") ?? "").Trim();
            if (portsRaw.Length == 0)
            {
                for (var port = 5010; port <= 5030; port++) AddCandidate(candidates, $"http://127.0.0.1:{port}/");
                return candidates;
            }
            foreach (var part in portsRaw.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (int.TryParse(part.Trim(), out var port) && port > 0 && port <= 65535)
                {
                    AddCandidate(candidates, $"http://127.0.0.1:{port}/");
                }
            }

            return candidates;
        }

        private static string NormalizePrefix(string? value)
        {
            return OperatorNativeHttpRequestFence.TryNormalizeLoopbackPrefix(value, out var prefix) ? prefix : "";
        }

        private static void WriteActiveUrlFile(string url)
        {
            try
            {
                var root = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "RevitOperator");
                Directory.CreateDirectory(root);
                File.WriteAllText(Path.Combine(root, "bridge_url.txt"), (url ?? "").TrimEnd('/') + Environment.NewLine);
            }
            catch { }
        }

        private static void WriteActiveTransportReceipt(string url, string serverEpoch)
        {
            try
            {
                var root = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "RevitOperator");
                Directory.CreateDirectory(root);
                var receipt = JsonSerializer.Serialize(new
                {
                    version = OperatorNativeTransportProtocol.Version,
                    algorithm = OperatorNativeTransportProtocol.Algorithm,
                    transport_path = OperatorNativeTransportProtocol.TransportPath,
                    url = (url ?? "").TrimEnd('/'),
                    server_epoch = serverEpoch ?? ""
                });
                var receiptPath = Path.Combine(root, "bridge_transport.v1.json");
                var pendingPath = receiptPath + ".pending";
                File.WriteAllText(pendingPath, receipt + Environment.NewLine);
                if (File.Exists(receiptPath))
                {
                    File.Replace(pendingPath, receiptPath, null);
                }
                else
                {
                    File.Move(pendingPath, receiptPath);
                }
            }
            catch { }
        }

        private static void WriteActiveListenerIdentityReceipt(string url, string serverEpoch)
        {
            try
            {
                using (var process = Process.GetCurrentProcess())
                {
                    var receipt = JsonSerializer.Serialize(new
                    {
                        version = "revit-operator.bridge-listener-identity.v1",
                        url = (url ?? "").TrimEnd('/'),
                        server_epoch = serverEpoch ?? "",
                        pid = process.Id,
                        created_utc = process.StartTime.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)
                    });
                    var root = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "RevitOperator");
                    Directory.CreateDirectory(root);
                    var receiptPath = Path.Combine(root, "bridge_listener_identity.v1.json");
                    var pendingPath = receiptPath + ".pending";
                    File.WriteAllText(pendingPath, receipt + Environment.NewLine);
                    if (File.Exists(receiptPath))
                    {
                        File.Replace(pendingPath, receiptPath, null);
                    }
                    else
                    {
                        File.Move(pendingPath, receiptPath);
                    }
                }
            }
            catch { }
        }

        private static bool TryPublishActiveDiscoveryReceipts(string url, string serverEpoch)
        {
            var ownsMutex = false;
            Mutex? mutex = null;
            try
            {
                var root = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "RevitOperator");
                Directory.CreateDirectory(root);
                mutex = new Mutex(false, DiscoveryMutexName);
                try
                {
                    ownsMutex = mutex.WaitOne(TimeSpan.FromSeconds(5));
                }
                catch (AbandonedMutexException)
                {
                    ownsMutex = true;
                }
                if (!ownsMutex) return false;

                var listenerPath = Path.Combine(root, "bridge_listener_identity.v1.json");
                if (HasLiveForeignDiscoveryOwner(listenerPath)) return false;

                WriteActiveUrlFile(url);
                WriteActiveTransportReceipt(url, serverEpoch);
                WriteActiveListenerIdentityReceipt(url, serverEpoch);
                return true;
            }
            catch { return false; }
            finally
            {
                if (ownsMutex)
                {
                    try { mutex?.ReleaseMutex(); } catch { }
                }
                mutex?.Dispose();
            }
        }

        private static void ClearActiveDiscoveryReceiptsIfOwned(string url, string serverEpoch)
        {
            var ownsMutex = false;
            Mutex? mutex = null;
            try
            {
                mutex = new Mutex(false, DiscoveryMutexName);
                try
                {
                    ownsMutex = mutex.WaitOne(TimeSpan.FromSeconds(5));
                }
                catch (AbandonedMutexException)
                {
                    ownsMutex = true;
                }
                if (!ownsMutex) return;

                var root = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "RevitOperator");
                var listenerPath = Path.Combine(root, "bridge_listener_identity.v1.json");
                if (!IsExactDiscoveryOwner(listenerPath, url, serverEpoch)) return;

                File.Delete(Path.Combine(root, "bridge_url.txt"));
                File.Delete(Path.Combine(root, "bridge_transport.v1.json"));
                File.Delete(Path.Combine(root, "bridge_transport.v1.json.pending"));
                File.Delete(listenerPath);
                File.Delete(listenerPath + ".pending");
            }
            catch { }
            finally
            {
                if (ownsMutex)
                {
                    try { mutex?.ReleaseMutex(); } catch { }
                }
                mutex?.Dispose();
            }
        }

        private static bool HasLiveForeignDiscoveryOwner(string listenerPath)
        {
            try
            {
                using (var document = JsonDocument.Parse(File.ReadAllText(listenerPath)))
                {
                    var root = document.RootElement;
                    var pid = root.GetProperty("pid").GetInt32();
                    if (pid == Process.GetCurrentProcess().Id) return false;
                    var createdUtc = root.GetProperty("created_utc").GetString() ?? "";
                    if (!DateTimeOffset.TryParseExact(
                        createdUtc,
                        "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                        CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                        out var expectedStart)) return false;
                    using (var process = Process.GetProcessById(pid))
                    {
                        var actualStart = process.StartTime.ToUniversalTime();
                        return Math.Abs((actualStart - expectedStart.UtcDateTime).TotalMilliseconds) < 1000;
                    }
                }
            }
            catch { return false; }
        }

        private static bool IsExactDiscoveryOwner(string listenerPath, string url, string serverEpoch)
        {
            try
            {
                using (var document = JsonDocument.Parse(File.ReadAllText(listenerPath)))
                {
                    var root = document.RootElement;
                    return string.Equals(root.GetProperty("version").GetString(), "revit-operator.bridge-listener-identity.v1", StringComparison.Ordinal)
                        && root.GetProperty("pid").GetInt32() == Process.GetCurrentProcess().Id
                        && string.Equals(root.GetProperty("url").GetString(), (url ?? "").TrimEnd('/'), StringComparison.Ordinal)
                        && string.Equals(root.GetProperty("server_epoch").GetString(), serverEpoch ?? "", StringComparison.Ordinal);
                }
            }
            catch { return false; }
        }
        private static void WriteStartupLog(string message)
        {
            try
            {
                var root = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "RevitOperator",
                    "Logs");
                Directory.CreateDirectory(root);
                File.AppendAllText(
                    Path.Combine(root, "revit-addin-startup.log"),
                    $"[{DateTime.Now:O}] {message}{Environment.NewLine}");
            }
            catch { }
        }

        private async Task HandleIncomingConnections()
        {
            while (_isRunning)
            {
                try
                {
                    var ctx = await _listener.GetContextAsync();
                    _ = ProcessRequest(ctx);
                }
                catch (HttpListenerException) { if (!_isRunning) return; }
                catch (ObjectDisposedException) { if (!_isRunning) return; }
            }
        }

        private async Task ProcessRequest(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            var resp = ctx.Response;
            string responseText = "{}";
            int statusCode = 200;
            var correlationId = Guid.NewGuid().ToString("N");
            var actionPath = "";
            var actionMethod = "";
            var requestedEffect = "read";
            var nativeDispatchStarted = false;
            OperatorNativeTransportRequestContext? protectedTransportRequest = null;
            var operatorToken = "";

            try
            {
                operatorToken = OperatorSecurity.GetOrCreateOperatorToken();
                if (!OperatorNativeHttpRequestFence.IsLoopbackEndpoint(req.RemoteEndPoint))
                {
                    throw new OperatorNativeHttpAdmissionException(
                        "CERTIFICATION_DIRECT_REMOTE_CLIENT_REJECTED",
                        "The native Revit bridge accepts loopback clients only.",
                        403,
                        false,
                        "healthy");
                }
                var laboratoryBypass = OperatorNativeHttpRuntimeProfile.IsExactDevelopmentLaboratory(
                    Environment.GetEnvironmentVariable("REVIT_OPERATOR_MODE"),
                    Environment.GetEnvironmentVariable("OPERATOR_TOOL_EXPOSURE_PROFILE"));
                var rawUrl = req.RawUrl ?? req.Url.AbsolutePath;
                var queryIndex = rawUrl.IndexOf('?');
                var rawPath = queryIndex >= 0 ? rawUrl.Substring(0, queryIndex) : rawUrl;
                var hasQuery = queryIndex >= 0;
                var directDynamicRuntime =
                    string.Equals(req.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase)
                    && rawPath.StartsWith("/revit/dynamic-runtime/", StringComparison.OrdinalIgnoreCase)
                    && !hasQuery
                    && (req.ContentType ?? "").StartsWith("application/json", StringComparison.OrdinalIgnoreCase);
                var protectedLaboratoryEvidence = laboratoryBypass
                    && string.Equals(
                        Environment.GetEnvironmentVariable("OPERATOR_CERTIFICATION_PROTECTED_LABORATORY"),
                        "1",
                        StringComparison.Ordinal)
                    && string.Equals(req.HttpMethod, "POST", StringComparison.Ordinal)
                    && string.Equals(rawPath, OperatorNativeTransportProtocol.TransportPath, StringComparison.Ordinal)
                    && string.Equals(req.ContentType, OperatorNativeTransportProtocol.ContentType, StringComparison.Ordinal);

                OperatorNativeHttpRequest? effectiveRequest = null;
                OperatorNativeHttpAuthorizationReceipt? deploymentGeneralAgentFinalReceipt = null;
                string path;
                string requestBody;
                if ((laboratoryBypass && !protectedLaboratoryEvidence) || directDynamicRuntime)
                {
                    correlationId = OperatorCorrelationId.NormalizeOrCreate(req.Headers["X-Operator-Correlation-Id"], correlationId);
                    resp.Headers["X-Operator-Correlation-Id"] = correlationId;
                    var token = req.Headers["X-Operator-Token"];
                    if (!OperatorSecurity.TokenMatches(token))
                    {
                        statusCode = 401;
                        responseText = JsonSerializer.Serialize(new { error = "Unauthorized (missing/invalid X-Operator-Token)." });
                        byte[] denied = Encoding.UTF8.GetBytes(responseText);
                        resp.ContentType = "application/json";
                        resp.StatusCode = statusCode;
                        await resp.OutputStream.WriteAsync(denied, 0, denied.Length);
                        resp.Close();
                        return;
                    }

                    var bodyBytes = await ReadRequestBodyBytesAsync(req, OperatorNativeHttpRequestFence.MaximumBodyUtf8Bytes);
                    path = req.Url.AbsolutePath;
                    requestBody = req.HasEntityBody ? Encoding.UTF8.GetString(bodyBytes) : "";
                }
                else
                {
                    if (!string.Equals(rawPath, req.Url.AbsolutePath, StringComparison.Ordinal))
                        throw OperatorNativeHttpAdmissionException.InvalidRequest(
                            "Certified native Revit requests cannot use encoded or normalized paths.");
                    OperatorNativeTransportHttpAdapter.ValidateCertifiedOuterRequest(
                        req.ContentType,
                        req.Headers.AllKeys);
                    var envelopeBytes = await ReadRequestBodyBytesAsync(
                        req,
                        OperatorNativeTransportProtocol.MaximumRequestEnvelopeUtf8Bytes);
                    protectedTransportRequest = OperatorNativeTransportHttpAdapter.OpenCertifiedRequest(
                        operatorToken,
                        _nativeTransportEpoch,
                        envelopeBytes,
                        req.HttpMethod,
                        rawPath,
                        hasQuery,
                        req.ContentType,
                        req.Headers.AllKeys,
                        DateTimeOffset.UtcNow,
                        _nativeTransportReplayCache);
                    if (protectedLaboratoryEvidence)
                    {
                        if (protectedTransportRequest.LaboratoryEvidence == null)
                            throw new OperatorNativeHttpAdmissionException(
                                "CERTIFICATION_LABORATORY_EVIDENCE_DISPATCH_REQUIRED",
                                "Protected laboratory evidence requires exact authenticated evidence dispatch metadata.",
                                403,
                                false,
                                "healthy");
                        if (protectedTransportRequest.Request.Channel != protectedTransportRequest.LaboratoryEvidence.Channel
                            || protectedTransportRequest.Request.Alias != protectedTransportRequest.LaboratoryEvidence.Alias)
                            throw new OperatorNativeHttpAdmissionException(
                                "CERTIFICATION_LABORATORY_EVIDENCE_CHANNEL_MISMATCH",
                                "Protected laboratory evidence does not bind the exact authenticated channel and alias.",
                                403,
                                false,
                                "healthy");
                        var isMove = string.Equals(protectedTransportRequest.Request.Method, "POST", StringComparison.Ordinal)
                            && string.Equals(protectedTransportRequest.Request.Path, "/revit/move-elements", StringComparison.Ordinal);
                        if (isMove != (protectedTransportRequest.LaboratoryMoveEvidenceAdmission != null))
                            throw new OperatorNativeHttpAdmissionException(
                                "CERTIFICATION_LABORATORY_MOVE_EVIDENCE_ADMISSION_REQUIRED",
                                isMove
                                    ? "Protected laboratory move evidence requires its exact reviewed family admission."
                                    : "Laboratory move evidence admission is forbidden for every other route.",
                                403,
                                false,
                                "healthy");
                        if (isMove && (protectedTransportRequest.Request.Channel != protectedTransportRequest.LaboratoryMoveEvidenceAdmission!.Channel
                            || protectedTransportRequest.Request.Alias != protectedTransportRequest.LaboratoryMoveEvidenceAdmission.Alias))
                            throw new OperatorNativeHttpAdmissionException(
                                "CERTIFICATION_LABORATORY_MOVE_EVIDENCE_CHANNEL_MISMATCH",
                                "Protected laboratory move evidence does not bind the exact typed channel and alias.",
                                403,
                                false,
                                "healthy");
                    }
                    else if (protectedTransportRequest.LaboratoryEvidence != null
                        || protectedTransportRequest.LaboratoryMoveEvidenceAdmission != null)
                    {
                        throw new OperatorNativeHttpAdmissionException(
                            "CERTIFICATION_LABORATORY_EVIDENCE_DISPATCH_FORBIDDEN",
                            "Laboratory evidence dispatch metadata is forbidden outside the exact protected laboratory lane.",
                            403,
                            false,
                            "healthy");
                    }
                    correlationId = protectedTransportRequest.Request.RequestId;
                    var sourceRequest = protectedTransportRequest.Request;
                    if (protectedLaboratoryEvidence)
                    {
                        // This is an explicitly selected evidence-generation lane,
                        // not certified production admission. It retains encrypted,
                        // replay-protected transport and all ordinary write grants,
                        // but does not manufacture an L4 policy decision.
                        if (sourceRequest.CertificationEnvelope != null)
                            throw new OperatorNativeHttpAdmissionException(
                                "CERTIFICATION_LABORATORY_FAMILY_ADMISSION_FORBIDDEN",
                                "Protected laboratory evidence cannot carry a certification envelope or request-family admission.",
                                403,
                                false,
                                "healthy");
                        OperatorLaboratoryExecutionReceiptAuthority.RequireNoCallerAuthoredReceipt(
                            sourceRequest.BodyPresent,
                            sourceRequest.BodyJson);
                        effectiveRequest = sourceRequest;
                        requestBody = sourceRequest.BodyJson;
                    }
                    else
                    {
                        // A deployment-backed General Agent receipt already carries the
                        // final exact request/body authorization. Retain that one-use
                        // receipt until native dispatch instead of making a second hosted
                        // authorization call from Revit's API thread. Certified request-
                        // family work keeps the existing preflight + final protocol.
                        var firstStage = sourceRequest.CertificationEnvelope == null ? "final" : "preflight";
                        var earlyReceipt = await _nativeHttpAuthorizer.AuthorizeAsync(sourceRequest, CancellationToken.None, firstStage);
                        if (sourceRequest.CertificationEnvelope == null && earlyReceipt.IsDeploymentGeneralAgent)
                        {
                            deploymentGeneralAgentFinalReceipt = earlyReceipt;
                            effectiveRequest = sourceRequest;
                            requestBody = earlyReceipt.CanonicalBodyJson;
                        }
                        else
                        {
                            var canonicalBody = OperatorNativeHttpDispatchFence.RequireFreshOneUse(
                                earlyReceipt,
                                sourceRequest,
                                DateTimeOffset.UtcNow);
                            effectiveRequest = OperatorNativeHttpDispatchFence.CreateFreshEffectiveRequest(sourceRequest, canonicalBody);
                            requestBody = effectiveRequest.BodyJson;
                        }
                    }
                    path = effectiveRequest.Path;
                }

                // Bridge-layer write gate:
                // Any mutating endpoint requires an ephemeral write grant beyond X-Operator-Token.
                // This is critical when tools are executed indirectly (e.g., via MCP) where the Operator UI
                // is no longer the only approval gate.
                // GET is always treated as read-only here.
                var effectiveMethod = effectiveRequest?.Method ?? req.HttpMethod;
                actionMethod = effectiveMethod;
                actionPath = path;
                requestedEffect = OperatorApprovalPolicy.GetEffectWireValue(effectiveMethod, path, requestBody);
                var isGet = string.Equals(effectiveMethod, "GET", StringComparison.OrdinalIgnoreCase);
                if (!isGet && path != "/revit/ping" && path != "/revit/capabilities")
                {
                    try
                    {
                        var risk = GetRequestRisk(effectiveMethod, path, requestBody);
                        var requiresGrant = risk >= OperatorActionRisk.Medium;
                        if (requiresGrant)
                        {
                            var grant = protectedTransportRequest?.WriteGrant ?? req.Headers["X-Operator-Write-Grant"];
                            if (!OperatorWriteGrant.ValidateAndConsumeIfNeeded(grant, out var err))
                            {
                                if (protectedTransportRequest != null)
                                    throw new OperatorNativeHttpAdmissionException(
                                        "CERTIFICATION_DIRECT_WRITE_GRANT_REQUIRED",
                                        "Write requires approval (missing/invalid protected write grant): " + err,
                                        403,
                                        false,
                                        "healthy");
                                statusCode = 403;
                                responseText = JsonSerializer.Serialize(new
                                {
                                    error = "Write requires approval (missing/invalid X-Operator-Write-Grant).",
                                    details = err,
                                    hint = "Approve writes in the Operator pane, or explicitly issue a short-lived pane-free grant with the public MCP external-agent helper, then retry.",
                                    request_dispatched = false,
                                    outcome_unknown = false,
                                    canonical_attempt_settlement = OperatorAttemptSettlement.None(
                                        requestedEffect, effectiveMethod, path, "write_grant_required", "write_grant")
                                });

                                byte[] denied = Encoding.UTF8.GetBytes(responseText);
                                resp.ContentType = "application/json";
                                resp.StatusCode = statusCode;
                                await resp.OutputStream.WriteAsync(denied, 0, denied.Length);
                                resp.Close();
                                return;
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        if (protectedTransportRequest != null) throw;
                        statusCode = 403;
                        responseText = JsonSerializer.Serialize(new
                        {
                            error = "Write requires approval (write gate error).",
                            details = ex.Message,
                            request_dispatched = false,
                            outcome_unknown = false,
                            canonical_attempt_settlement = OperatorAttemptSettlement.None(
                                requestedEffect, effectiveMethod, path, "write_grant_validation_failed", "write_grant")
                        });
                        byte[] denied = Encoding.UTF8.GetBytes(responseText);
                        resp.ContentType = "application/json";
                        resp.StatusCode = statusCode;
                        await resp.OutputStream.WriteAsync(denied, 0, denied.Length);
                        resp.Close();
                        return;
                    }
                }
                
                if (path == "/revit/ping")
                {
                    if (effectiveRequest != null && !protectedLaboratoryEvidence)
                        requestBody = await RequireFinalNativeAuthorizationAsync(effectiveRequest, requestBody, CancellationToken.None, deploymentGeneralAgentFinalReceipt);
                    responseText = JsonSerializer.Serialize(OperatorAttemptSuccessfulSettlement.Attach(
                        new { status = "ok", timestamp = DateTime.Now }, requestedEffect, effectiveMethod, path,
                        attemptId: correlationId));
                }
                else if (path == "/revit/capabilities")
                {
                    if (effectiveRequest != null && !protectedLaboratoryEvidence)
                        requestBody = await RequireFinalNativeAuthorizationAsync(effectiveRequest, requestBody, CancellationToken.None, deploymentGeneralAgentFinalReceipt);
                    responseText = JsonSerializer.Serialize(OperatorAttemptSuccessfulSettlement.Attach(
                        RevitBridge.Operator.OperatorCapabilities.Get(), requestedEffect, effectiveMethod, path,
                        attemptId: correlationId));
                }
                else if (path == "/revit/write-grant-status")
                {
                    if (effectiveRequest != null && !protectedLaboratoryEvidence)
                        requestBody = await RequireFinalNativeAuthorizationAsync(effectiveRequest, requestBody, CancellationToken.None, deploymentGeneralAgentFinalReceipt);
                    var status = OperatorWriteGrant.ReadStatus();
                    responseText = JsonSerializer.Serialize(OperatorAttemptSuccessfulSettlement.Attach(new
                    {
                        status = "ok",
                        active = status.Active,
                        mode = status.Mode,
                        expires_at_utc = status.ExpiresAtUtc?.ToString("o"),
                        uses_remaining = status.UsesRemaining,
                        error = status.Error,
                        write_ready = status.Active
                    }, requestedEffect, effectiveMethod, path, attemptId: correlationId));
                }
                else if (_handlers.TryGetValue(path, out var handler))
                {
                    string body = requestBody;

                    // Support GET query-string style for documentation endpoints (human/tooling convenience).
                    // Operator tool calls from the agent typically use POST bodies (no query support in action runner).
                    var isDocEndpoint =
                        string.Equals(path, "/revit/tool-doc", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(path, "/revit/tool-examples", StringComparison.OrdinalIgnoreCase);

                    if (laboratoryBypass && string.Equals(req.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase) && isDocEndpoint)
                    {
                        var qMethod = (req.QueryString?["method"] ?? "").Trim();
                        var qPath = (req.QueryString?["path"] ?? "").Trim();
                        body = JsonSerializer.Serialize(new { method = qMethod, path = qPath });
                    }

                    object result;
                    if (IsDirectDialogComputerUsePath(path) || IsDirectControlPlanePath(path))
                    {
                        if (effectiveRequest != null && !protectedLaboratoryEvidence)
                            body = await RequireFinalNativeAuthorizationAsync(effectiveRequest, requestBody, CancellationToken.None, deploymentGeneralAgentFinalReceipt);
                        result = handler is NativeApiPolicyHandler nativeApiPolicyHandler
                            ? await nativeApiPolicyHandler.HandleForMethod(null!, body, effectiveMethod)
                            : await handler.Handle(null!, body);
                    }
                    else
                    {
                        var risk = GetRequestRisk(effectiveMethod, path, body);
                        var deadline = OperatorActionDeadlinePolicy.Resolve(effectiveMethod, path, risk.ToString());
                        using var localDeadline = new CancellationTokenSource(deadline.Budget);
                        try
                        {
                            var capturedEffectiveRequest = effectiveRequest;
                            var capturedRequiresCertifiedAuthorization = !protectedLaboratoryEvidence;
                            var capturedDeploymentGeneralAgentFinalReceipt = deploymentGeneralAgentFinalReceipt;
                            var capturedBody = body;
                            result = await _eventService.Run(
                                app =>
                                {
                                    var dispatchBody = capturedBody;
                                    OperatorCertifiedMoveExecutionStart? executionStart = null;
                                    OperatorCertifiedMoveExecutionStart? laboratoryMoveExecutionStart = null;
                                    OperatorCertifiedFamilyExecutionContext? executionContext = null;
                                    if (capturedEffectiveRequest != null && capturedRequiresCertifiedAuthorization)
                                    {
                                        dispatchBody = RequireFinalNativeAuthorizationAsync(
                                            capturedEffectiveRequest,
                                            capturedBody,
                                            localDeadline.Token,
                                            capturedDeploymentGeneralAgentFinalReceipt).GetAwaiter().GetResult();
                                        executionContext = capturedEffectiveRequest.CertificationEnvelope?.RequestFamilyAdmission == null
                                            ? null
                                            : OperatorCertifiedFamilyExecutionContext.Direct(capturedEffectiveRequest);
                                        executionStart = OperatorCertifiedMovePreviewAuthority.CaptureStartAndConsumeApplyReceipt(
                                            app,
                                            capturedEffectiveRequest.CertificationEnvelope,
                                            dispatchBody,
                                            executionContext);
                                    }
                                    else if (capturedEffectiveRequest != null && protectedLaboratoryEvidence)
                                    {
                                        laboratoryMoveExecutionStart = OperatorLaboratoryMoveEvidenceAuthority.CaptureStartAndConsumeApplyReceipt(
                                            app,
                                            protectedTransportRequest!.LaboratoryMoveEvidenceAdmission,
                                            protectedTransportRequest.LaboratoryEvidence!,
                                            dispatchBody);
                                    }
                                    object nativeResult;
                                    try
                                    {
                                        nativeDispatchStarted = true;
                                        nativeResult = handler.Handle(app, dispatchBody).GetAwaiter().GetResult();
                                    }
                                    catch (Exception error) when (executionStart?.Phase == "apply"
                                        || laboratoryMoveExecutionStart?.Phase == "apply")
                                    {
                                        throw new OperatorCertifiedFamilyOutcomeUnknownException(
                                            "Committed move handler failed after native dispatch; mutation outcome requires reconciliation.",
                                            error);
                                    }
                                    var certifiedResult = OperatorCertifiedMovePreviewAuthority.AttachReceiptAfterVerifiedRollback(
                                        app,
                                        nativeResult,
                                        capturedEffectiveRequest?.CertificationEnvelope,
                                        dispatchBody,
                                        executionStart,
                                        executionContext);
                                    if (capturedEffectiveRequest != null && protectedLaboratoryEvidence)
                                    {
                                        try
                                        {
                                            return OperatorLaboratoryExecutionReceiptAuthority.AttachAfterRevitThreadCompletion(
                                                app,
                                                certifiedResult,
                                                protectedTransportRequest!,
                                                DateTimeOffset.UtcNow,
                                                laboratoryMoveExecutionStart);
                                        }
                                        catch (Exception error) when (laboratoryMoveExecutionStart?.Phase == "apply")
                                        {
                                            throw new OperatorCertifiedFamilyOutcomeUnknownException(
                                                "Committed laboratory move outcome could not be independently certified after handler dispatch.",
                                                error);
                                        }
                                    }
                                    return certifiedResult;
                                },
                                localDeadline.Token,
                                correlationId);
                        }
                        catch (OperationCanceledException) when (localDeadline.IsCancellationRequested)
                        {
                            throw deadline.CreateTimeoutException(correlationId);
                        }
                    }
                    responseText = JsonSerializer.Serialize(OperatorAttemptSuccessfulSettlement.Attach(
                        result, requestedEffect, effectiveMethod, path, attemptId: correlationId));
                }
                else
                {
                    statusCode = 404;
                    responseText = JsonSerializer.Serialize(new { error = $"Path {path} not found" });
                }
            }
            catch (Exception ex)
            {
                var root = ex;
                if (ex is AggregateException ae)
                {
                    var flat = ae.Flatten();
                    root = flat.InnerException ?? flat;
                }

                if (root is OperatorNativeHttpAdmissionException nativeAdmission)
                {
                    statusCode = nativeAdmission.HttpStatusCode;
                    responseText = JsonSerializer.Serialize(new
                    {
                        ok = false,
                        error = nativeAdmission.Message,
                        code = nativeAdmission.Code,
                        retryable = nativeAdmission.Retryable,
                        phase = nativeAdmission.Phase,
                        host_health = nativeAdmission.HostHealth,
                        opens_circuit = nativeAdmission.OpensCircuit,
                        request_dispatched = false,
                        outcome_unknown = false,
                        correlation_id = correlationId,
                        canonical_attempt_settlement = OperatorAttemptSettlement.None(
                            requestedEffect, actionMethod, actionPath, nativeAdmission.Code, "admission_policy")
                    });
                }
                else if (root is OperatorToolUserErrorException uex)
                {
                    // This is a user-actionable tool response (e.g., typed confirmation required),
                    // not a transport/server failure. Return 200 so tool callers can read fields
                    // like requiredConfirm without treating the call as an exception.
                    statusCode = 200;
                    responseText = JsonSerializer.Serialize(new
                    {
                        ok = false,
                        error = uex.Message,
                        code = uex.Code,
                        requiredConfirm = uex.RequiredConfirm,
                        confirmReceived = uex.ConfirmReceived,
                        maxChangesPerCall = uex.MaxChangesPerCall,
                        hint = uex.Hint,
                        correlation_id = correlationId,
                        request_dispatched = false,
                        outcome_unknown = false,
                        canonical_attempt_settlement = OperatorAttemptSettlement.None(
                            requestedEffect, actionMethod, actionPath, uex.Code, "schema_validator")
                    });
                }
                else if (root is RevitEventQueueException qex)
                {
                    statusCode = string.Equals(qex.Code, "revit_external_event_busy", StringComparison.OrdinalIgnoreCase) ? 409 : 503;
                    responseText = JsonSerializer.Serialize(new
                    {
                        ok = false,
                        error = qex.Message,
                        code = qex.Code,
                        retryable = qex.Retryable,
                        phase = qex.Phase,
                        host_health = qex.HostHealth,
                        request_dispatched = qex.OutcomeUnknown,
                        outcome_unknown = qex.OutcomeUnknown,
                        correlation_id = qex.CorrelationId ?? correlationId,
                        canonical_attempt_settlement = qex.OutcomeUnknown
                            ? OperatorAttemptSettlement.Unknown(requestedEffect, actionMethod, actionPath, qex.Code)
                            : OperatorAttemptSettlement.None(requestedEffect, actionMethod, actionPath, qex.Code)
                    });
                }
                else if (root is IOperatorRevitFailureMetadata)
                {
                    var failure = OperatorCourierFailureClassifier.Classify(root, correlationId);
                    failure.AttemptSettlement = OperatorAttemptFailureSettlement.FromFailure(
                        failure, requestedEffect, actionMethod, actionPath).Bind(
                            null, correlationId, null, null, null, null);
                    statusCode = failure.OutcomeUnknown
                        ? 408
                        : string.Equals(failure.HostHealth, "unavailable", StringComparison.OrdinalIgnoreCase)
                            ? 503
                            : failure.Retryable ? 409 : 500;
                    responseText = JsonSerializer.Serialize(new
                    {
                        ok = failure.Ok,
                        error = failure.Error,
                        code = failure.Code,
                        retryable = failure.Retryable,
                        phase = failure.Phase,
                        host_health = failure.HostHealth,
                        opens_circuit = failure.OpensCircuit,
                        request_dispatched = failure.AttemptSettlement?.RequestDispatched,
                        outcome_unknown = failure.OutcomeUnknown,
                        correlation_id = failure.CorrelationId ?? correlationId,
                        deadline_class = failure.DeadlineClass,
                        deadline_ms = failure.DeadlineMs,
                        canonical_attempt_settlement = failure.AttemptSettlement
                    });
                }
                else if (root is OperationCanceledException)
                {
                    statusCode = 408;
                    responseText = JsonSerializer.Serialize(new
                    {
                        ok = false,
                        error = "The Revit action was canceled after submission; its outcome is unknown.",
                        code = "revit_action_canceled_outcome_unknown",
                        retryable = false,
                        phase = "revit_external_event",
                        host_health = "degraded",
                        request_dispatched = true,
                        outcome_unknown = true,
                        correlation_id = correlationId,
                        canonical_attempt_settlement = OperatorAttemptSettlement.Unknown(
                            requestedEffect, actionMethod, actionPath, "revit_action_canceled_outcome_unknown")
                    });
                }
                else if (root is ArgumentException)
                {
                    statusCode = 400;
                    responseText = JsonSerializer.Serialize(new
                    {
                        ok = false,
                        error = root.Message,
                        code = "invalid_revit_tool_request",
                        retryable = false,
                        phase = "request_validation",
                        request_dispatched = false,
                        outcome_unknown = false,
                        correlation_id = correlationId,
                        canonical_attempt_settlement = OperatorAttemptSettlement.None(
                            requestedEffect, actionMethod, actionPath, "invalid_revit_tool_request", "schema_validator")
                    });
                }
                else
                {
                    statusCode = 500;
                    responseText = JsonSerializer.Serialize(new
                    {
                        error = root.Message,
                        type = root.GetType().FullName,
                        stack = root.StackTrace,
                        inner = root.InnerException?.Message,
                        correlation_id = correlationId,
                        request_dispatched = nativeDispatchStarted,
                        outcome_unknown = requestedEffect == "apply" && nativeDispatchStarted,
                        canonical_attempt_settlement = requestedEffect == "apply" && nativeDispatchStarted
                            ? OperatorAttemptSettlement.Unknown(requestedEffect, actionMethod, actionPath, "native_handler_failed_after_dispatch")
                            : OperatorAttemptSettlement.None(requestedEffect, actionMethod, actionPath, "native_handler_failed_without_persistent_effect")
                    });
                }
            }

            byte[] data;
            if (protectedTransportRequest != null)
            {
                var protectedResponse = OperatorNativeTransportHttpAdapter.CreateCertifiedResponse(
                    operatorToken,
                    protectedTransportRequest,
                    statusCode,
                    responseText,
                    DateTimeOffset.UtcNow);
                data = protectedResponse.BodyUtf8;
                resp.ContentType = protectedResponse.ContentType;
                // The application status is confidential and authenticated inside
                // the envelope. A caller must never trust this outer HTTP status.
                resp.StatusCode = protectedResponse.OuterStatusCode;
            }
            else
            {
                data = Encoding.UTF8.GetBytes(responseText);
                resp.ContentType = "application/json";
                resp.StatusCode = statusCode;
            }
            await resp.OutputStream.WriteAsync(data, 0, data.Length);
            resp.Close();
        }

        private async Task<string> RequireFinalNativeAuthorizationAsync(
            OperatorNativeHttpRequest effectiveRequest,
            string expectedCanonicalBody,
            CancellationToken cancellationToken,
            OperatorNativeHttpAuthorizationReceipt? preauthorizedFinalReceipt = null)
        {
            var finalReceipt = preauthorizedFinalReceipt
                ?? await _nativeHttpAuthorizer.AuthorizeAsync(effectiveRequest, cancellationToken, "final").ConfigureAwait(false);
            return await OperatorNativeHttpDispatchFence.RequireFreshOneUseWithQueueRefreshAsync(
                _nativeHttpAuthorizer,
                finalReceipt,
                effectiveRequest,
                expectedCanonicalBody,
                cancellationToken).ConfigureAwait(false);
        }

        private static async Task<byte[]> ReadRequestBodyBytesAsync(HttpListenerRequest request, int maximumBytes)
        {
            if (!request.HasEntityBody) return Array.Empty<byte>();
            if (request.ContentLength64 > maximumBytes)
                throw OperatorNativeHttpAdmissionException.InvalidRequest(
                    "Certified native Revit request body exceeds the 2 MiB UTF-8 limit.");

            using var output = new MemoryStream();
            var buffer = new byte[16 * 1024];
            while (true)
            {
                var read = await request.InputStream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                if (read <= 0) break;
                if (output.Length + read > maximumBytes)
                    throw OperatorNativeHttpAdmissionException.InvalidRequest(
                        "Certified native Revit request body exceeds the 2 MiB UTF-8 limit.");
                output.Write(buffer, 0, read);
            }
            return output.ToArray();
        }

        private static bool IsDirectControlPlanePath(string path)
        {
            return string.Equals(path, "/revit/tool-registry", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(path, "/revit/tool-search", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(path, "/revit/tool-doc", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(path, "/revit/tool-examples", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(path, "/revit/native-api-policy", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(path, "/revit/native-api-catalog", StringComparison.OrdinalIgnoreCase) ||
                   string.Equals(path, "/revit/native-api-search", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsDirectDialogComputerUsePath(string path)
        {
            return string.Equals(path, "/revit/computer-use-observe", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(path, "/revit/computer-use-act", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(path, "/revit/computer-use-guard", StringComparison.OrdinalIgnoreCase);
        }

        private static OperatorActionRisk GetRequestRisk(string method, string path, string body)
        {
            var risk = OperatorApprovalPolicy.GetRisk(method, path, body);
            if (risk < OperatorActionRisk.Medium) return risk;

            if (!string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase)) return risk;

            if (string.Equals(path, "/revit/dynamic-runtime/preview", StringComparison.OrdinalIgnoreCase) &&
                IsExplicitDynamicRuntimePreview(body))
            {
                return OperatorActionRisk.Low;
            }

            if (OperatorDryRunTurnPolicy.IsScheduleCellUpdatePreview(method, path, body))
            {
                return OperatorActionRisk.Low;
            }

            // These MEP endpoints are safe to run without a write grant only when the
            // request is explicitly a preview. Actual route creation remains gated.
            if ((string.Equals(path, "/revit/mep-route-workflow", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/mep-branch-network-workflow", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/reroute-mep-route-segment", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/create-mep-route", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/connect-mep-branch", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/connect-existing-mep-branch", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/connect-mep-elements", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/create-pipe-between-connectors", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/existing-conditions-mep-draft-workflow", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/resize-ductwork-by-scope", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/repair-duct-continuity-by-scope", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/repair-mep-connectors", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/copy-mep-pattern", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/create-duct", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(path, "/revit/create-pipe", StringComparison.OrdinalIgnoreCase)) &&
                IsExplicitMepRoutePreview(path, body))
            {
                return OperatorActionRisk.Low;
            }

            if (string.Equals(path, "/revit/link-cad", StringComparison.OrdinalIgnoreCase) &&
                IsExplicitDryRunPreview(body))
            {
                return OperatorActionRisk.Low;
            }

            return risk;
        }

        private static bool IsExplicitDryRunPreview(string body)
        {
            if (string.IsNullOrWhiteSpace(body)) return false;

            try
            {
                using var doc = JsonDocument.Parse(body);
                var root = doc.RootElement;
                return root.ValueKind == JsonValueKind.Object &&
                    root.TryGetProperty("dryRun", out var dryRun) &&
                    dryRun.ValueKind == JsonValueKind.True;
            }
            catch
            {
                return false;
            }
        }

        private static bool IsExplicitDynamicRuntimePreview(string body)
        {
            if (string.IsNullOrWhiteSpace(body)) return false;
            try
            {
                using var doc = JsonDocument.Parse(body);
                var root = doc.RootElement;
                return root.ValueKind == JsonValueKind.Object && root.TryGetProperty("phase", out var phase) && phase.ValueKind == JsonValueKind.String && string.Equals(phase.GetString(), "preview", StringComparison.Ordinal);
            }
            catch { return false; }
        }

        private static bool IsExplicitMepRoutePreview(string path, string body)
        {
            if (string.IsNullOrWhiteSpace(body)) return false;

            try
            {
                using var doc = JsonDocument.Parse(body);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return false;

                if (root.TryGetProperty("dryRun", out var dryRun) &&
                    dryRun.ValueKind == JsonValueKind.True)
                {
                    return true;
                }

                // Workflow endpoints use apply=false as the public dry-run flag.
                if ((string.Equals(path, "/revit/mep-route-workflow", StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(path, "/revit/mep-branch-network-workflow", StringComparison.OrdinalIgnoreCase) ||
                     string.Equals(path, "/revit/reroute-mep-route-segment", StringComparison.OrdinalIgnoreCase)) &&
                    root.TryGetProperty("apply", out var apply) &&
                    apply.ValueKind == JsonValueKind.False)
                {
                    return true;
                }
            }
            catch
            {
                return false;
            }

            return false;
        }
    }
}
