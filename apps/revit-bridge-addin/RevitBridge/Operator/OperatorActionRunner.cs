using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using RevitBridge.Common;
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
using AssignElectricalDistributionSystemActionHandler = RevitBridge.Logic.Handlers.AssignElectricalDistributionSystemHandler;

namespace RevitBridge.Operator
{
    internal sealed class OperatorActionRunner
    {
        private static readonly TimeSpan CourierFinalExecutionRefreshTimeout = TimeSpan.FromSeconds(5);
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
                { "/revit/native-api-ops", new NativeApiOpsHandler() },
                { "/revit/native-api-mutation-ops", new NativeApiMutationOpsHandler() },
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
                { "/revit/repair-mep-connectors", new RepairMepConnectorsHandler() },
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
                { "/revit/annotation-symbol-leaders", new AnnotationSymbolLeadersHandler() },
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
                { "/revit/assign-electrical-distribution-system", new AssignElectricalDistributionSystemActionHandler() },
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
            var risk = OperatorApprovalPolicy.GetRisk(method, path, jsonBody);
            var correlationId = OperatorCorrelationId.NormalizeOrCreate(action.CorrelationId, action.ActionId);
            action.CorrelationId = correlationId;

            // Courier v2 actions are constructed only after a fresh backend
            // receipt. Check the binding before every path, including direct
            // control-plane handlers that bypass the ExternalEvent queue.
            ValidateCourierFinalExecutionAuthorization(action, method, path, correlationId);

            if (!OperatorActionAllowlist.IsAllowed(method, path))
            {
                throw new InvalidOperationException($"Action not allowlisted: {method} {path}");
            }

            OperatorActionSchemaValidator.ValidateOrThrow(action);

            if (string.Equals(path, "/revit/ping", StringComparison.OrdinalIgnoreCase))
            {
                RefreshAndValidateCourierFinalExecutionAuthorization(action, method, path, correlationId, cancellationToken);
                return new { status = "ok", timestamp = DateTime.Now };
            }

            if (string.Equals(path, "/revit/capabilities", StringComparison.OrdinalIgnoreCase))
            {
                RefreshAndValidateCourierFinalExecutionAuthorization(action, method, path, correlationId, cancellationToken);
                return OperatorCapabilities.Get();
            }

            if (string.Equals(path, "/revit/write-grant-status", StringComparison.OrdinalIgnoreCase))
            {
                RefreshAndValidateCourierFinalExecutionAuthorization(action, method, path, correlationId, cancellationToken);
                var status = OperatorWriteGrant.ReadStatus();
                return new
                {
                    status = "ok",
                    active = status.Active,
                    mode = status.Mode,
                    expires_at_utc = status.ExpiresAtUtc?.ToString("o"),
                    uses_remaining = status.UsesRemaining,
                    error = status.Error,
                    write_ready = status.Active
                };
            }

            if (!_handlers.TryGetValue(path, out var handler))
            {
                throw new InvalidOperationException($"No handler mapped for: {path}");
            }

            if (IsDirectDialogComputerUsePath(path))
            {
                RefreshAndValidateCourierFinalExecutionAuthorization(action, method, path, correlationId, cancellationToken);
                return await handler.Handle(null!, jsonBody).ConfigureAwait(false);
            }

            // Catalog, documentation, and policy operations do not touch the Revit API.
            // Keep them off Revit's single-threaded ExternalEvent queue so discovery and
            // payload repair remain responsive while a model operation is pending.
            if (IsDirectControlPlanePath(path))
            {
                RefreshAndValidateCourierFinalExecutionAuthorization(action, method, path, correlationId, cancellationToken);
                return handler is NativeApiPolicyHandler nativeApiPolicyHandler
                    ? await nativeApiPolicyHandler.HandleForMethod(null!, jsonBody, method).ConfigureAwait(false)
                    : await handler.Handle(null!, jsonBody).ConfigureAwait(false);
            }

            var dialogComputerUse = App.Instance?.DialogComputerUse;
            var dialogEventCursor = dialogComputerUse?.CaptureEventCursor() ?? 0;
            var autoGuardArmed = ShouldAutoArmRetryableDialogGuard(method, path, jsonBody) && dialogComputerUse != null;
            var autoGuardId = autoGuardArmed ? dialogComputerUse!.ArmRetryableWarningCancelGuard() : null;

            object result;
            var deadline = OperatorActionDeadlinePolicy.Resolve(method, path, risk.ToString());
            using var localDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            localDeadline.CancelAfter(deadline.Budget);
            try
            {
                result = await _eventService.Run(app =>
                {
                    ValidateExpectedDocument(app, action);
                    // This is deliberately immediately adjacent to the Revit
                    // handler. The prequeue receipt only admits this event;
                    // a queued ExternalEvent must obtain a new fixed-route
                    // backend decision before it can reach Revit.
                    RefreshAndValidateCourierFinalExecutionAuthorization(
                        action,
                        method,
                        path,
                        correlationId,
                        localDeadline.Token);
                    var executionStart = OperatorCertifiedMovePreviewAuthority.CaptureStartAndConsumeApplyReceipt(
                        app,
                        action.CourierVerifiedClaim?.Envelope,
                        jsonBody);
                    object handlerResult;
                    try
                    {
                        handlerResult = handler.Handle(app, jsonBody).GetAwaiter().GetResult();
                    }
                    catch (Exception error) when (executionStart?.Phase == "apply")
                    {
                        throw new OperatorCertifiedFamilyOutcomeUnknownException(
                            "Committed move handler failed after native dispatch; mutation outcome requires reconciliation.",
                            error);
                    }
                    handlerResult = OperatorCertifiedMovePreviewAuthority.AttachReceiptAfterVerifiedRollback(
                        app,
                        handlerResult,
                        action.CourierVerifiedClaim?.Envelope,
                        jsonBody,
                        executionStart);

                    // Best-effort UI refresh after actions that likely modified the model. This reduces "it worked but I can't see it"
                    // confusion due to view redraw / regeneration lag.
                    if (method == "POST" && risk >= OperatorActionRisk.Medium)
                    {
                        TryRefreshGraphics(app);
                    }

                    return handlerResult;
                }, localDeadline.Token, correlationId).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && localDeadline.IsCancellationRequested)
            {
                throw deadline.CreateTimeoutException(correlationId);
            }
            finally
            {
                if (autoGuardId != null) dialogComputerUse?.DisarmGuard(autoGuardId);
            }

            var recoveredDialog = dialogComputerUse?.GetResolvedRetryableRecoveryAfter(dialogEventCursor);
            // Dialog resolution is finalized asynchronously after the handler can return. Poll whenever
            // any new dialog event occurred during this action, including when the guard was armed
            // explicitly by the sidecar rather than by this runner.
            if (recoveredDialog == null && dialogComputerUse != null && dialogComputerUse.CaptureEventCursor() > dialogEventCursor)
            {
                for (var attempt = 0; attempt < 10 && recoveredDialog == null; attempt++)
                {
                    await Task.Delay(100, cancellationToken).ConfigureAwait(false);
                    recoveredDialog = dialogComputerUse?.GetResolvedRetryableRecoveryAfter(dialogEventCursor);
                }
            }

            if (recoveredDialog != null)
            {
                throw new OperatorRecoveredDialogException(recoveredDialog, result);
            }

            return result;
        }

        private static void ValidateCourierFinalExecutionAuthorization(
            OperatorActionCall action,
            string method,
            string path,
            string correlationId,
            bool requireFinalFamilyStage = false)
        {
            var authorization = action.CourierFinalExecutionAuthorization;
            if (authorization == null)
            {
                if (action.CourierJobExpiresAtUtc.HasValue)
                    throw new OperatorCourierFinalExecutionRejectedException("Courier final-execution expiry is present without an authorization receipt.");
                return;
            }

            if (!OperatorCourierFinalExecutionAuthorizationBinder.IsTargetExecutorBound(
                    action.CourierVerifiedClaim,
                    action.CourierLocalExecutorId)
                || !OperatorCourierFinalExecutionAuthorizationBinder.IsBoundToExecutor(
                    authorization,
                    action.CourierLocalExecutorId)
                || (requireFinalFamilyStage
                    && authorization.RequestFamilyAdmission != null
                    && !string.Equals(authorization.AuthorizationStage, "final", StringComparison.Ordinal))
                || !TryGetActionBody(action, out var bodyPresent, out var bodyJson)
                || !OperatorCourierFinalExecutionAuthorizationBinder.IsBoundToAction(
                    authorization,
                    action.CourierJobExpiresAtUtc,
                    action.ActionId,
                    correlationId,
                    method,
                    path,
                    action.ExpectedDocumentTitle,
                    action.ExpectedDocumentPath,
                    bodyPresent,
                    bodyJson,
                    DateTimeOffset.UtcNow))
            {
                throw new OperatorCourierFinalExecutionRejectedException("Courier final-execution authorization is expired, malformed, or no longer bound to the queued action.");
            }
        }

        private static void RefreshCourierFinalExecutionAuthorization(
            OperatorActionCall action,
            CancellationToken queueCancellationToken)
        {
            var isV2CourierAction = action.CourierVerifiedClaim != null
                || !string.IsNullOrWhiteSpace(action.CourierLocalExecutorId)
                || action.CourierFinalExecutionRefreshAsync != null;
            if (!isV2CourierAction) return;

            var refresh = action.CourierFinalExecutionRefreshAsync;
            if (refresh == null)
            {
                throw new OperatorCourierFinalExecutionRejectedException(
                    "Courier v2 action is missing its authoritative final-execution refresh.");
            }

            try
            {
                using var refreshTimeout = CancellationTokenSource.CreateLinkedTokenSource(queueCancellationToken);
                refreshTimeout.CancelAfter(CourierFinalExecutionRefreshTimeout);
                var authorization = OperatorCourierFinalExecutionAuthorizationBinder.RequireFreshBoundAuthorizationAsync(
                    refresh,
                    action.CourierVerifiedClaim,
                    action.CourierLocalExecutorId,
                    refreshTimeout.Token).GetAwaiter().GetResult();
                action.CourierFinalExecutionAuthorization = authorization;
            }
            catch (OperatorCourierFinalExecutionRejectedException)
            {
                throw;
            }
            catch (Exception error)
            {
                // There is intentionally no offline/cached fallback. Network,
                // backend denial, session revocation, policy mismatch, and the
                // bounded timeout all mean zero handler invocation.
                throw new OperatorCourierFinalExecutionRejectedException(
                    "Courier v2 final-execution refresh was unavailable or rejected; no Revit action was executed.",
                    error);
            }
        }

        private static void RefreshAndValidateCourierFinalExecutionAuthorization(
            OperatorActionCall action,
            string method,
            string path,
            string correlationId,
            CancellationToken cancellationToken)
        {
            RefreshCourierFinalExecutionAuthorization(action, cancellationToken);
            ValidateCourierFinalExecutionAuthorization(action, method, path, correlationId, requireFinalFamilyStage: true);
        }

        private static bool TryGetActionBody(OperatorActionCall action, out bool bodyPresent, out string bodyJson)
        {
            bodyPresent = action.Body != null;
            bodyJson = "";
            if (!bodyPresent) return true;
            try
            {
                bodyJson = action.Body is JsonElement jsonElement
                    ? jsonElement.GetRawText()
                    : JsonSerializer.Serialize(action.Body, OperatorUiProtocol.JsonOptions);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void ValidateExpectedDocument(Autodesk.Revit.UI.UIApplication app, OperatorActionCall action)
        {
            var expectedTitle = (action.ExpectedDocumentTitle ?? "").Trim();
            var expectedPath = (action.ExpectedDocumentPath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(expectedTitle) && string.IsNullOrWhiteSpace(expectedPath)) return;

            var document = app?.ActiveUIDocument?.Document;
            var actualTitle = (document?.Title ?? "").Trim();
            var actualPath = (document?.PathName ?? "").Trim();
            var pathMatches = string.IsNullOrWhiteSpace(expectedPath) ||
                string.Equals(expectedPath, actualPath, StringComparison.OrdinalIgnoreCase);
            var titleMatches = string.IsNullOrWhiteSpace(expectedTitle) ||
                string.Equals(expectedTitle, actualTitle, StringComparison.OrdinalIgnoreCase);
            if (pathMatches && titleMatches) return;

            throw new OperatorTargetDocumentMismatchException(
                $"The courier job is bound to document '{expectedTitle}' ({expectedPath}), but this Revit process currently has '{actualTitle}' ({actualPath}) active. No action was executed.");
        }

        private sealed class OperatorTargetDocumentMismatchException : InvalidOperationException, IOperatorRevitFailureMetadata
        {
            public OperatorTargetDocumentMismatchException(string message) : base(message) { }
            public string Code => "revit_courier_target_document_mismatch";
            public bool Retryable => false;
            public string Phase => "courier_target_validation";
            public string HostHealth => "healthy";
            public bool OpensCircuit => false;
            public bool OutcomeUnknown => false;
        }

        private sealed class OperatorCourierFinalExecutionRejectedException : InvalidOperationException, IOperatorRevitFailureMetadata
        {
            public OperatorCourierFinalExecutionRejectedException(string message) : base(message) { }
            public OperatorCourierFinalExecutionRejectedException(string message, Exception inner) : base(message, inner) { }
            public string Code => "CERTIFICATION_FINAL_EXECUTION_REJECTED";
            public bool Retryable => false;
            public string Phase => "certification_final_execution";
            public string HostHealth => "healthy";
            public bool OpensCircuit => false;
            public bool OutcomeUnknown => false;
        }

        internal async Task ProbeRevitHostAsync(CancellationToken cancellationToken)
        {
            await _eventService.Run(_ => true, cancellationToken).ConfigureAwait(false);
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

        private static bool ShouldAutoArmRetryableDialogGuard(string method, string path, string jsonBody)
        {
            if (!string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase)) return false;
            if (!string.Equals(path, "/revit/existing-conditions-mep-draft-workflow", StringComparison.OrdinalIgnoreCase)) return false;
            if (string.IsNullOrWhiteSpace(jsonBody)) return false;

            try
            {
                using var document = JsonDocument.Parse(jsonBody);
                if (document.RootElement.ValueKind != JsonValueKind.Object) return false;
                return document.RootElement.TryGetProperty("dryRun", out var dryRun) &&
                    dryRun.ValueKind == JsonValueKind.False;
            }
            catch
            {
                return false;
            }
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

    internal sealed class OperatorRecoveredDialogException : InvalidOperationException
    {
        public OperatorRecoveredDialogException(
            OperatorDialogComputerUse.ResolvedDialogRecovery recovery,
            object provisionalHandlerResult)
            : base($"Revit retryable dialog {recovery.DialogId} was cancelled by sidecar guard {recovery.MatchedGuardId}; the handler result is provisional and native readback is required before any retry.")
        {
            var receipt = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            try
            {
                using var document = JsonDocument.Parse(JsonSerializer.Serialize(provisionalHandlerResult, OperatorUiProtocol.JsonOptions));
                if (document.RootElement.ValueKind == JsonValueKind.Object)
                {
                    foreach (var property in document.RootElement.EnumerateObject())
                    {
                        receipt[property.Name] = property.Value.Clone();
                    }
                }
            }
            catch
            {
                // The typed recovery receipt below remains sufficient even when the provisional result is not serializable.
            }

            receipt["status"] = "Blocked";
            receipt["error"] = "retryable_revit_dialog_recovered";
            receipt["rollbackVerified"] = false;
            receipt["requiresReadback"] = true;
            receipt["provisionalHandlerResult"] = provisionalHandlerResult;
            receipt["dialogRecovery"] = recovery.ToReceipt();
            Receipt = receipt;
        }

        public object Receipt { get; }
    }
}
