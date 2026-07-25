using System;
using System.Collections.Generic;
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
        private bool _isRunning;
        private string _activeUrl = "";
        private const string DefaultUrl = "http://localhost:5000/";
        private readonly Dictionary<string, HandlerRequest> _handlers;

        public RevitHttpServer(RevitEventService eventService)
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
                { "/revit/native-api-ops", new NativeApiOpsHandler() },
                { "/revit/self-test", new SelfTestHandler() },
                { "/revit/regenerate", new RegenerateHandler() },
                { "/revit/computer-use-observe", new ComputerUseObserveHandler() },
                { "/revit/computer-use-act", new ComputerUseActHandler() },
                { "/revit/computer-use-guard", new ComputerUseGuardHandler() },
                { "/revit/export-image", new ExportViewImageHandler() },
                { "/revit/query", new QueryElementsHandler() },
                { "/revit/delete", new DeleteElementsHandler() },
                { "/revit/set-parameter", new SetParameterHandler() },
                { "/revit/create-sheet", new CreateSheetHandler() },
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
                    WriteActiveUrlFile(candidateUrl);
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

            WriteActiveUrlFile("");
            WriteStartupLog("HTTP listener failed for every candidate URL; wrote empty bridge_url.txt.");
        }

        public void Stop()
        {
            _isRunning = false;
            try { _listener?.Stop(); } catch { }
            try { _listener?.Close(); } catch { }
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

            var portsRaw = (Environment.GetEnvironmentVariable("OPERATOR_REVIT_BRIDGE_FALLBACK_PORTS") ?? "5010,5011,5012,5013,5014").Trim();
            foreach (var part in portsRaw.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (int.TryParse(part.Trim(), out var port) && port > 0 && port <= 65535)
                {
                    AddCandidate(candidates, $"http://localhost:{port}/");
                }
            }

            return candidates;
        }

        private static string NormalizePrefix(string? value)
        {
            var raw = (value ?? "").Trim();
            if (raw.Length == 0) return "";
            if (!raw.EndsWith("/", StringComparison.Ordinal)) raw += "/";
            return raw;
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

            try
            {
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

                string path = req.Url.AbsolutePath;
                string requestBody = "";
                if (req.HasEntityBody)
                {
                    using (var reader = new StreamReader(req.InputStream, req.ContentEncoding))
                    {
                        requestBody = await reader.ReadToEndAsync();
                    }
                }

                // Bridge-layer write gate:
                // Any mutating endpoint requires an ephemeral write grant beyond X-Operator-Token.
                // This is critical when tools are executed indirectly (e.g., via MCP) where the Operator UI
                // is no longer the only approval gate.
                // GET is always treated as read-only here.
                var isGet = string.Equals(req.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase);
                if (!isGet && path != "/revit/ping" && path != "/revit/capabilities")
                {
                    try
                    {
                        var risk = GetRequestRisk(req.HttpMethod, path, requestBody);
                        var requiresGrant = risk >= OperatorActionRisk.Medium;
                        if (requiresGrant)
                        {
                            var grant = req.Headers["X-Operator-Write-Grant"];
                            if (!OperatorWriteGrant.ValidateAndConsumeIfNeeded(grant, out var err))
                            {
                                statusCode = 403;
                                responseText = JsonSerializer.Serialize(new
                                {
                                    error = "Write requires approval (missing/invalid X-Operator-Write-Grant).",
                                    details = err,
                                    hint = "Approve writes in the Operator pane, or explicitly issue a short-lived pane-free grant with the public MCP external-agent helper, then retry."
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
                        statusCode = 403;
                        responseText = JsonSerializer.Serialize(new
                        {
                            error = "Write requires approval (write gate error).",
                            details = ex.Message
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
                    responseText = JsonSerializer.Serialize(new { status = "ok", timestamp = DateTime.Now });
                }
                else if (path == "/revit/capabilities")
                {
                    responseText = JsonSerializer.Serialize(RevitBridge.Operator.OperatorCapabilities.Get());
                }
                else if (path == "/revit/write-grant-status")
                {
                    var status = OperatorWriteGrant.ReadStatus();
                    responseText = JsonSerializer.Serialize(new
                    {
                        status = "ok",
                        active = status.Active,
                        mode = status.Mode,
                        expires_at_utc = status.ExpiresAtUtc?.ToString("o"),
                        uses_remaining = status.UsesRemaining,
                        error = status.Error,
                        write_ready = status.Active
                    });
                }
                else if (_handlers.TryGetValue(path, out var handler))
                {
                    string body = requestBody;

                    // Support GET query-string style for documentation endpoints (human/tooling convenience).
                    // Operator tool calls from the agent typically use POST bodies (no query support in action runner).
                    var isDocEndpoint =
                        string.Equals(path, "/revit/tool-doc", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(path, "/revit/tool-examples", StringComparison.OrdinalIgnoreCase);

                    if (string.Equals(req.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase) && isDocEndpoint)
                    {
                        var qMethod = (req.QueryString?["method"] ?? "").Trim();
                        var qPath = (req.QueryString?["path"] ?? "").Trim();
                        body = JsonSerializer.Serialize(new { method = qMethod, path = qPath });
                    }

                    object result;
                    if (IsDirectDialogComputerUsePath(path) || IsDirectControlPlanePath(path))
                    {
                        result = await handler.Handle(null!, body);
                    }
                    else
                    {
                        result = await _eventService.Run(app => handler.Handle(app, body).GetAwaiter().GetResult());
                    }
                    responseText = JsonSerializer.Serialize(result);
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

                if (root is OperatorToolUserErrorException uex)
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
                        hint = uex.Hint
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
                        outcome_unknown = qex.OutcomeUnknown
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
                        outcome_unknown = true
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
                        phase = "request_validation"
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
                        inner = root.InnerException?.Message
                    });
                }
            }

            byte[] data = Encoding.UTF8.GetBytes(responseText);
            resp.ContentType = "application/json";
            resp.StatusCode = statusCode;
            await resp.OutputStream.WriteAsync(data, 0, data.Length);
            resp.Close();
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
            var risk = OperatorApprovalPolicy.GetRisk(method, path);
            if (risk < OperatorActionRisk.Medium) return risk;

            if (!string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase)) return risk;

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
