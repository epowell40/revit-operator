using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;

namespace RevitBridge.Operator
{
    internal static class OperatorToolIntrospection
    {
        public const string RegistryVersion = "operator.tool_registry.v1";
        public const string SearchVersion = "operator.tool_search.v1";
        public const string DocVersion = "operator.tool_doc.v1";
        public const string ExamplesVersion = "operator.tool_examples.v1";

        private static readonly object _lock = new object();
        private static JsonDocument? _examplesDoc;

        public static object GetRegistry()
        {
            var tools = new List<object>();
            foreach (var t in OperatorToolManifest.Tools)
            {
                var contract = DescribeTool(t.Method, t.Path, includeSchemas: true, includeExamples: false);
                tools.Add(contract);
            }

            return new
            {
                version = RegistryVersion,
                generated_at = DateTime.UtcNow.ToString("o"),
                tools
            };
        }

        public static object GetToolDoc(string method, string path)
        {
            return DescribeTool(method, path, includeSchemas: true, includeExamples: true);
        }

        public static object SearchTools(string query, string? group = null, string? risk = null, string? method = null, int? max = null)
        {
            var normalizedQuery = (query ?? "").Trim();
            if (string.IsNullOrWhiteSpace(normalizedQuery)) throw new InvalidOperationException("tool-search.query is required.");

            var normalizedGroup = NormalizeOptionalFilter(group);
            var normalizedRisk = NormalizeOptionalFilter(risk);
            var normalizedMethod = NormalizeOptionalFilter(method)?.ToUpperInvariant();
            var maxResults = Math.Max(1, Math.Min(12, max ?? 8));
            var queryTokens = Tokenize(normalizedQuery);

            var matches = OperatorToolManifest.Tools
                .Where(t => normalizedGroup == null || string.Equals(t.Group, normalizedGroup, StringComparison.OrdinalIgnoreCase))
                .Where(t => normalizedRisk == null || string.Equals(t.Risk, normalizedRisk, StringComparison.OrdinalIgnoreCase))
                .Where(t => normalizedMethod == null || string.Equals(t.Method, normalizedMethod, StringComparison.OrdinalIgnoreCase))
                .Select(t => ScoreTool(t, normalizedQuery, queryTokens))
                .Where(m => m.Score > 0)
                .OrderByDescending(m => m.Score)
                .ThenBy(m => m.Tool.RiskLevel)
                .ThenBy(m => m.Tool.Path, StringComparer.OrdinalIgnoreCase)
                .Take(maxResults)
                .Select(m => new
                {
                    group = m.Tool.Group,
                    method = m.Tool.Method,
                    path = m.Tool.Path,
                    title = m.Tool.Title,
                    risk = m.Tool.Risk,
                    description = m.Tool.Description,
                    example = m.Tool.Example,
                    score = m.Score,
                    match_reasons = m.MatchReasons
                })
                .ToList();

            return new
            {
                version = SearchVersion,
                generated_at = DateTime.UtcNow.ToString("o"),
                query = normalizedQuery,
                filters = new
                {
                    group = normalizedGroup,
                    risk = normalizedRisk,
                    method = normalizedMethod
                },
                returned = matches.Count,
                matches
            };
        }

        public static object GetToolExamples(string method, string path)
        {
            var ex = FindExamples(method, path);
            return new
            {
                version = ExamplesVersion,
                generated_at = DateTime.UtcNow.ToString("o"),
                method = (method ?? "").Trim().ToUpperInvariant(),
                path = (path ?? "").Trim(),
                examples = ex ?? new List<object>(),
                warning = ex == null ? "No examples found for this tool." : null
            };
        }

        private sealed class ToolSearchMatch
        {
            public OperatorToolInfo Tool { get; set; } = null!;
            public int Score { get; set; }
            public List<string> MatchReasons { get; set; } = new List<string>();
        }

        private static ToolSearchMatch ScoreTool(OperatorToolInfo tool, string normalizedQuery, IReadOnlyList<string> queryTokens)
        {
            var reasons = new List<string>();
            var score = 0;

            score += ScoreField(tool.Path, normalizedQuery, queryTokens, exactMatchScore: 140, tokenMatchScore: 28, reason: "path");
            if (score > 0 && FieldContains(tool.Path, normalizedQuery, queryTokens))
            {
                reasons.Add("path");
            }

            var titleScore = ScoreField(tool.Title, normalizedQuery, queryTokens, exactMatchScore: 120, tokenMatchScore: 30, reason: "title");
            score += titleScore;
            if (titleScore > 0) reasons.Add("title");

            var groupScore = ScoreField(tool.Group, normalizedQuery, queryTokens, exactMatchScore: 80, tokenMatchScore: 24, reason: "group");
            score += groupScore;
            if (groupScore > 0) reasons.Add("group");

            var descriptionScore = ScoreField(tool.Description, normalizedQuery, queryTokens, exactMatchScore: 55, tokenMatchScore: 12, reason: "description");
            score += descriptionScore;
            if (descriptionScore > 0) reasons.Add("description");

            var exampleScore = ScoreField(tool.Example, normalizedQuery, queryTokens, exactMatchScore: 45, tokenMatchScore: 10, reason: "example");
            score += exampleScore;
            if (exampleScore > 0) reasons.Add("example");

            var methodScore = ScoreField(tool.Method, normalizedQuery, queryTokens, exactMatchScore: 25, tokenMatchScore: 8, reason: "method");
            score += methodScore;
            if (methodScore > 0) reasons.Add("method");

            return new ToolSearchMatch
            {
                Tool = tool,
                Score = score,
                MatchReasons = reasons.Distinct(StringComparer.OrdinalIgnoreCase).ToList()
            };
        }

        private static int ScoreField(string? field, string normalizedQuery, IReadOnlyList<string> queryTokens, int exactMatchScore, int tokenMatchScore, string reason)
        {
            var value = (field ?? "").Trim();
            if (string.IsNullOrWhiteSpace(value)) return 0;

            var score = 0;
            if (value.IndexOf(normalizedQuery, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                score += exactMatchScore;
            }

            var matchedTokens = 0;
            foreach (var token in queryTokens)
            {
                if (token.Length < 2) continue;
                if (value.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    matchedTokens++;
                }
            }

            if (matchedTokens > 0)
            {
                score += matchedTokens * tokenMatchScore;
            }

            return score;
        }

        private static bool FieldContains(string? field, string normalizedQuery, IReadOnlyList<string> queryTokens)
        {
            var value = (field ?? "").Trim();
            if (string.IsNullOrWhiteSpace(value)) return false;
            if (value.IndexOf(normalizedQuery, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return queryTokens.Any(token => token.Length >= 2 && value.IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0);
        }

        private static string? NormalizeOptionalFilter(string? value)
        {
            var trimmed = (value ?? "").Trim();
            return string.IsNullOrWhiteSpace(trimmed) ? null : trimmed;
        }

        private static List<string> Tokenize(string value)
        {
            return (value ?? "")
                .Split(new[] { ' ', '\t', '\r', '\n', '-', '_', '/', '\\', '.', ':', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(token => token.Trim())
                .Where(token => token.Length >= 2)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private static object DescribeTool(string method, string path, bool includeSchemas, bool includeExamples)
        {
            var m = (method ?? "").Trim().ToUpperInvariant();
            var p = (path ?? "").Trim();

            var info = OperatorToolManifest.Tools.FirstOrDefault(x =>
                string.Equals(x.Method, m, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(x.Path, p, StringComparison.OrdinalIgnoreCase));

            var risk = info?.Risk ?? OperatorApprovalPolicy.GetRisk(m, p).ToString().ToLowerInvariant();

            var requestSchema = includeSchemas ? ToolSchemaBuilder.BuildRequestSchema(m, p) : null;
            var responseSchema = includeSchemas ? ToolSchemaBuilder.BuildResponseSchema(m, p) : null;

            var examples = includeExamples ? (FindExamples(m, p) ?? new List<object>()) : new List<object>();
            if (includeExamples && examples.Count > 3) examples = examples.Take(3).ToList();

            var (required, optional, enums, units, commonErrors, notes) = ToolSchemaBuilder.SummarizeContract(m, p, requestSchema);

            return new
            {
                version = DocVersion,
                method = m,
                path = p,
                risk,
                title = info?.Title ?? "",
                description = info?.Description ?? "",
                required_fields = required,
                optional_fields = optional,
                enums,
                units,
                common_errors = commonErrors,
                notes,
                request_schema = requestSchema,
                response_schema = responseSchema,
                examples
            };
        }

        private static List<object>? FindExamples(string method, string path)
        {
            try
            {
                var doc = GetExamplesDoc();
                if (doc == null) return null;
                if (!doc.RootElement.TryGetProperty("tools", out var tools) || tools.ValueKind != JsonValueKind.Array) return null;

                foreach (var t in tools.EnumerateArray())
                {
                    if (t.ValueKind != JsonValueKind.Object) continue;
                    var tm = t.TryGetProperty("method", out var mEl) && mEl.ValueKind == JsonValueKind.String ? (mEl.GetString() ?? "") : "";
                    var tp = t.TryGetProperty("path", out var pEl) && pEl.ValueKind == JsonValueKind.String ? (pEl.GetString() ?? "") : "";

                    if (!string.Equals(tm, method, StringComparison.OrdinalIgnoreCase)) continue;
                    if (!string.Equals(tp, path, StringComparison.OrdinalIgnoreCase)) continue;

                    if (!t.TryGetProperty("examples", out var ex) || ex.ValueKind != JsonValueKind.Array) return new List<object>();

                    // Convert JsonElements into plain objects (via raw JSON) so we can safely return them.
                    var outList = new List<object>();
                    foreach (var e in ex.EnumerateArray())
                    {
                        outList.Add(JsonSerializer.Deserialize<object>(e.GetRawText(), OperatorUiProtocol.JsonOptions) ?? new object());
                    }
                    return outList;
                }
            }
            catch
            {
                // ignore
            }
            return null;
        }

        private static JsonDocument? GetExamplesDoc()
        {
            lock (_lock)
            {
                if (_examplesDoc != null) return _examplesDoc;
                try
                {
                    var asm = typeof(OperatorToolIntrospection).Assembly;
                    var name = asm.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith("tool_examples.json", StringComparison.OrdinalIgnoreCase));
                    if (string.IsNullOrWhiteSpace(name)) return null;
                    using var s = asm.GetManifestResourceStream(name);
                    if (s == null) return null;
                    using var r = new StreamReader(s, Encoding.UTF8);
                    var json = r.ReadToEnd();
                    _examplesDoc = JsonDocument.Parse(json);
                    return _examplesDoc;
                }
                catch
                {
                    return null;
                }
            }
        }

        private static class ToolSchemaBuilder
        {
            private static readonly Dictionary<string, Type> RequestTypesByPath = new Dictionary<string, Type>(StringComparer.OrdinalIgnoreCase)
            {
                { "/revit/query", typeof(RevitBridge.Handlers.QueryElementsHandler.Params) },
                { "/revit/resolve", typeof(RevitBridge.Handlers.ResolveHandler.ResolveRequest) },
                { "/revit/get-parameters", typeof(RevitBridge.Handlers.GetElementParametersHandler.Params) },
                { "/revit/export-image", typeof(RevitBridge.Handlers.ExportViewImageHandler.Params) },
                { "/revit/export-images", typeof(RevitBridge.Handlers.ExportImagesBatchHandler.Params) },
                { "/revit/export-dwg", typeof(RevitBridge.Handlers.ExportDwgHandler.Params) },
                { "/revit/export-ifc", typeof(RevitBridge.Handlers.ExportIfcHandler.Params) },
                { "/revit/open-model", typeof(RevitBridge.Handlers.OpenModelHandler.Params) },
                { "/revit/close-active-model", typeof(RevitBridge.Handlers.CloseActiveModelHandler.Params) },
                { "/revit/save-as", typeof(RevitBridge.Handlers.SaveAsModelHandler.Params) },
                { "/revit/sync", typeof(RevitBridge.Handlers.SyncModelHandler.Params) },
                { "/revit/worksets", typeof(RevitBridge.Handlers.WorksetsHandler.Params) },
                { "/revit/project-parameters", typeof(RevitBridge.Handlers.ProjectParametersHandler.Params) },
                { "/revit/purge-unused", typeof(RevitBridge.Handlers.PurgeUnusedHandler.Params) },
                { "/revit/transfer-view-templates", typeof(RevitBridge.Handlers.TransferViewTemplatesHandler.Params) },
                { "/revit/create-sheet", typeof(RevitBridge.Handlers.CreateSheetHandler.Params) },
                { "/revit/duplicate-sheet", typeof(RevitBridge.Handlers.DuplicateSheetHandler.Params) },
                { "/revit/create-sheets", typeof(RevitBridge.Handlers.CreateSheetsBatchHandler.Params) },
                { "/revit/place-view", typeof(RevitBridge.Handlers.PlaceViewOnSheetHandler.Params) },
                { "/revit/place-views", typeof(RevitBridge.Handlers.PlaceViewsBatchHandler.Params) },
                { "/revit/align-viewports", typeof(RevitBridge.Handlers.AlignViewportsHandler.Params) },
                { "/revit/renumber-sheets", typeof(RevitBridge.Handlers.RenumberSheetsHandler.Params) },
                { "/revit/sync-sheet-names", typeof(RevitBridge.Handlers.SyncSheetNamesHandler.Params) },
                { "/revit/visibility", typeof(RevitBridge.Handlers.ViewVisibilityHandler.Params) },
                { "/revit/datums", typeof(RevitBridge.Handlers.DatumsHandler.Params) },
                { "/revit/create-text", typeof(RevitBridge.Handlers.CreateTextNoteHandler.Params) },
                { "/revit/delete", typeof(RevitBridge.Handlers.DeleteElementsHandler.Params) },
                { "/revit/set-parameter", typeof(RevitBridge.Handlers.SetParameterHandler.Params) },
                { "/revit/create-duct", typeof(RevitBridge.Handlers.CreateDuctHandler.Params) },
                { "/revit/create-pipe", typeof(RevitBridge.Handlers.CreatePipeHandler.Params) },
                { "/revit/create-family-instance", typeof(RevitBridge.Handlers.CreateFamilyInstanceHandler.Params) },
                { "/revit/link-cad", typeof(RevitBridge.Handlers.LinkCadHandler.Params) },
                { "/revit/link-revit", typeof(RevitBridge.Logic.Handlers.LinkRevitHandler.Params) },
                { "/revit/place-image", typeof(RevitBridge.Handlers.PlaceImageHandler.Params) },
                { "/revit/place-pdf-underlay", typeof(RevitBridge.Handlers.PlacePdfUnderlayHandler.Params) },
                { "/revit/import-zippybim-geometry", typeof(RevitBridge.Handlers.ImportZippyBimGeometryHandler.Params) },
                { "/revit/import-drawing-spec", typeof(RevitBridge.Handlers.ImportDrawingSpecHandler.Params) },
                { "/revit/import-excel-table", typeof(RevitBridge.Handlers.ImportExcelTableHandler.Params) },
                { "/revit/export-elements-xlsx", typeof(RevitBridge.Handlers.ExportElementsXlsxHandler.Params) },
                { "/revit/import-elements-xlsx-updates", typeof(RevitBridge.Handlers.ImportElementsXlsxUpdatesHandler.Params) },
                { "/revit/create-view", typeof(RevitBridge.Handlers.CreateViewHandler.Params) },
                { "/revit/annotation-symbol-leaders", typeof(RevitBridge.Logic.Handlers.Drafting.AnnotationSymbolLeadersHandler.Params) },
                { "/revit/keynotes", typeof(RevitBridge.Handlers.KeynotesHandler.Params) },

                // Logic handlers (proxies)
                { "/revit/rooms", typeof(RevitBridge.Logic.Handlers.RoomHandler.RoomRequest) },
                { "/revit/renumber-rooms", typeof(RevitBridge.Handlers.RenumberRoomsHandler.Params) },
                { "/revit/room-contents", typeof(RevitBridge.Logic.Handlers.RoomContentsHandler.Params) },
                { "/revit/spatial-context", typeof(RevitBridge.Handlers.SpatialContextHandler.Params) },
                { "/revit/find-elements", typeof(RevitBridge.Logic.Handlers.FindElementsHandler.Params) },
                { "/revit/update-parameter-by-query", typeof(RevitBridge.Logic.Handlers.UpdateParameterByQueryHandler.Params) },
                { "/revit/update-panel-parameter", typeof(RevitBridge.Logic.Handlers.UpdatePanelParameterHandler.Params) },
                { "/revit/locate-elements", typeof(RevitBridge.Logic.Handlers.LocateElementsHandler.Params) },
                { "/revit/get-placement-context", typeof(RevitBridge.Logic.Handlers.GetPlacementContextHandler.Params) },
                { "/revit/resolve-room-wall", typeof(RevitBridge.Logic.Handlers.ResolveRoomWallHandler.Params) },
                { "/revit/rank-similar-devices-on-wall", typeof(RevitBridge.Logic.Handlers.RankSimilarDevicesOnWallHandler.Params) },
                { "/revit/pick-candidate-cluster", typeof(RevitBridge.Logic.Handlers.PickCandidateClusterHandler.Params) },
                { "/revit/project-point-to-host-frame", typeof(RevitBridge.Logic.Handlers.ProjectPointToHostFrameHandler.Params) },
                { "/revit/audit-hosted-instance-placement", typeof(RevitBridge.Logic.Handlers.AuditHostedInstancePlacementHandler.Params) },
                { "/revit/resolve-redline-target", typeof(RevitBridge.Logic.Handlers.ResolveRedlineTargetHandler.Params) },
                { "/revit/propose-fix", typeof(RevitBridge.Logic.Handlers.ProposeFixHandler.Params) },
                { "/revit/find-duplicate-marks", typeof(RevitBridge.Handlers.FindDuplicateMarksHandler.Params) },
                { "/revit/airflow-qa", typeof(RevitBridge.Handlers.AirflowQaHandler.Params) },
                { "/revit/mep-workflows", typeof(RevitBridge.Handlers.MepWorkflowsHandler.Params) },
                { "/revit/resolve-mep-routing-context", typeof(RevitBridge.Logic.Handlers.MEP.ResolveMepRoutingContextHandler.Params) },
                { "/revit/create-mep-route", typeof(RevitBridge.Logic.Handlers.MEP.CreateMepRouteHandler.Params) },
                { "/revit/connect-mep-branch", typeof(RevitBridge.Logic.Handlers.MEP.ConnectMepBranchHandler.Params) },
                { "/revit/connect-existing-mep-branch", typeof(RevitBridge.Logic.Handlers.MEP.ConnectExistingMepBranchHandler.Params) },
                { "/revit/connect-mep-elements", typeof(RevitBridge.Logic.Handlers.MEP.ConnectMepElementsHandler.Params) },
                { "/revit/create-pipe-between-connectors", typeof(RevitBridge.Logic.Handlers.MEP.CreatePipeBetweenConnectorsHandler.Params) },
                { "/revit/existing-conditions-mep-draft-workflow", typeof(RevitBridge.Logic.Handlers.MEP.ExistingConditionsMepDraftWorkflowHandler.Params) },
                { "/revit/copy-mep-pattern", typeof(RevitBridge.Logic.Handlers.MEP.CopyMepPatternHandler.Params) },
                { "/revit/mep-route-workflow", typeof(RevitBridge.Logic.Handlers.MEP.MepRouteWorkflowHandler.Params) },
                { "/revit/mep-branch-network-workflow", typeof(RevitBridge.Logic.Handlers.MEP.MepBranchNetworkWorkflowHandler.Params) },
                { "/revit/edit-mep-route-elements", typeof(RevitBridge.Logic.Handlers.MEP.EditMepRouteElementsHandler.Params) },
                { "/revit/reroute-mep-route-segment", typeof(RevitBridge.Logic.Handlers.MEP.RerouteMepRouteSegmentHandler.Params) },
                { "/revit/arch-workflows", typeof(RevitBridge.Handlers.ArchWorkflowsHandler.Params) },
                { "/revit/trace-connected-network", typeof(RevitBridge.Logic.Handlers.MEP.TraceConnectedNetworkHandler.Params) },
                { "/revit/find-elements-by-parameter", typeof(RevitBridge.Logic.Handlers.MEP.FindElementsByParameterHandler.Params) },
                { "/revit/room_mep_intersect", typeof(RevitBridge.Logic.Handlers.MEP.RoomMepIntersectHandler.Params) },
                { "/revit/ducts-by-spatial-scope", typeof(RevitBridge.Logic.Handlers.MEP.DuctsBySpatialScopeHandler.Params) },
                { "/revit/sync-connected-sizes", typeof(RevitBridge.Logic.Handlers.MEP.SyncConnectedSizesHandler.Params) },
                { "/revit/resize-duct-run", typeof(RevitBridge.Logic.Handlers.MEP.ResizeDuctRunHandler.Params) },
                { "/revit/resize-ducts-by-scope", typeof(RevitBridge.Logic.Handlers.MEP.ResizeDuctsByScopeHandler.Params) },
                { "/revit/resize-ducts-in-room", typeof(RevitBridge.Logic.Handlers.MEP.ResizeDuctsInRoomHandler.Params) },
                { "/revit/resize-ductwork-by-scope", typeof(RevitBridge.Logic.Handlers.MEP.ResizeDuctworkByScopeHandler.Params) },
                { "/revit/repair-duct-continuity-by-scope", typeof(RevitBridge.Logic.Handlers.MEP.RepairDuctContinuityByScopeHandler.Params) },
                { "/revit/repair-mep-connectors", typeof(RevitBridge.Logic.Handlers.MEP.RepairMepConnectorsHandler.Params) },
                { "/revit/get-connectors", typeof(RevitBridge.Logic.Handlers.MEP.GetConnectorsHandler.Params) },
                { "/revit/align-room-tops-to-ceilings", typeof(RevitBridge.Logic.Handlers.AlignRoomTopsToCeilingsHandler.Params) },
                { "/revit/analyze-dimensions", typeof(RevitBridge.Logic.Handlers.AnalyzeDimensionsHandler.Params) },
                { "/revit/export-dimensioning-v2", typeof(RevitBridge.Logic.Handlers.ExportDimensioningV2Handler.Params) },
                { "/revit/quantify", typeof(RevitBridge.Logic.Handlers.QuantifyElementsHandler.QuantifyRequest) },
                { "/revit/quantify-visualize", typeof(RevitBridge.Logic.Handlers.QuantifyVisualizeHandler.Params) },
                { "/revit/ensure-spaces", typeof(RevitBridge.Logic.Handlers.EnsureSpacesHandler.Params) },
                { "/revit/create-zones", typeof(RevitBridge.Logic.Handlers.CreateZonesHandler.Params) },
                { "/revit/create-zone-visuals", typeof(RevitBridge.Logic.Handlers.CreateZoneVisualsHandler.Params) },
                { "/revit/query-zone-data", typeof(RevitBridge.Logic.Handlers.QueryZoneDataHandler.Params) },
                { "/revit/place-families", typeof(RevitBridge.Logic.Handlers.PlaceFamiliesHandler.PlacementRequest) },
                { "/revit/place-family-instance-on-host", typeof(RevitBridge.Logic.Handlers.PlaceFamilyInstanceOnHostHandler.Params) },
                { "/revit/create-similar-from-instance", typeof(RevitBridge.Logic.Handlers.CreateSimilarFromInstanceHandler.Params) },
                { "/revit/adjust-hosted-instance-on-host", typeof(RevitBridge.Logic.Handlers.AdjustHostedInstanceOnHostHandler.Params) },
                { "/revit/assign-electrical-circuit", typeof(RevitBridge.Logic.Handlers.AssignElectricalCircuitHandler.Params) },
                { "/revit/assign-electrical-distribution-system", typeof(RevitBridge.Logic.Handlers.AssignElectricalDistributionSystemHandler.Params) },
                { "/revit/load-family", typeof(RevitBridge.Logic.Handlers.LoadFamilyHandler.Params) },
                { "/revit/create-family-from-template", typeof(RevitBridge.Logic.Handlers.CreateFamilyFromTemplateHandler.Params) },
                { "/revit/tag-elements", typeof(RevitBridge.Logic.Handlers.TagElementsHandler.TagRequest) },
                { "/revit/create-schedule", typeof(RevitBridge.Logic.Handlers.CreateScheduleHandler.ScheduleRequest) },
                { "/revit/spatial-analysis", typeof(RevitBridge.Logic.Handlers.SpatialAnalysisHandler.Request) },
                { "/revit/duplicate-view", typeof(RevitBridge.Logic.Handlers.DuplicateViewHandler.DuplicateRequest) },
                { "/revit/get-element-summary", typeof(RevitBridge.Logic.Handlers.GetElementSummaryHandler.Params) },
                { "/revit/transaction-plan", typeof(RevitBridge.Logic.Handlers.TransactionPlanHandler.Params) },
                { "/revit/transaction-validate", typeof(RevitBridge.Logic.Handlers.TransactionValidateHandler.Params) },
                { "/revit/transaction-apply", typeof(RevitBridge.Logic.Handlers.TransactionApplyHandler.Params) },
                { "/revit/move-elements", typeof(RevitBridge.Logic.Handlers.MoveElementsHandler.Params) },
                { "/revit/rotate-elements", typeof(RevitBridge.Logic.Handlers.RotateElementsHandler.Params) },
                { "/revit/align-elements", typeof(RevitBridge.Logic.Handlers.AlignElementsHandler.Params) },
                { "/revit/measure-gap", typeof(RevitBridge.Logic.Handlers.MeasureGapHandler.Params) },
                { "/revit/model-health", typeof(RevitBridge.Handlers.ModelHealthHandler.Params) },
                { "/revit/qa-checks", typeof(RevitBridge.Handlers.QaChecksHandler.Params) },
                { "/revit/schedules", typeof(RevitBridge.Handlers.SchedulesHandler.Params) },
                { "/revit/update-schedule-cell", typeof(RevitBridge.Handlers.UpdateScheduleCellHandler.Params) },
                { "/revit/replace-schedule-values", typeof(RevitBridge.Handlers.ReplaceScheduleValuesHandler.Params) },
                { "/revit/configure-schedule", typeof(RevitBridge.Handlers.ConfigureScheduleHandler.Params) },
                { "/revit/export-schedule-csv", typeof(RevitBridge.Handlers.ExportScheduleCsvHandler.Params) },
                { "/revit/export-warnings-report", typeof(RevitBridge.Handlers.ExportWarningsReportHandler.Params) },
                { "/revit/warnings", typeof(RevitBridge.Handlers.ExportWarningsReportHandler.Params) },
                { "/revit/print-sets", typeof(RevitBridge.Handlers.PrintSetsHandler.Params) },
                { "/revit/print", typeof(RevitBridge.Handlers.PrintHandler.Params) },
                { "/revit/create-print-set", typeof(RevitBridge.Handlers.CreatePrintSetHandler.Params) },
                { "/revit/revisions", typeof(RevitBridge.Handlers.RevisionsHandler.Params) },
                { "/revit/create-revision", typeof(RevitBridge.Handlers.CreateRevisionHandler.Params) },
                { "/revit/apply-revision-to-sheets", typeof(RevitBridge.Handlers.ApplyRevisionToSheetsHandler.Params) },
                { "/revit/room-align-wall-to-nearest-column", typeof(RevitBridge.Logic.Handlers.RoomAlignWallToNearestColumnHandler.Params) },
                { "/revit/export-view-frame", typeof(RevitBridge.Logic.Handlers.ExportViewFrameHandler.Params) },
                { "/revit/export-view-region", typeof(RevitBridge.Logic.Handlers.ExportViewRegionHandler.Params) },
                { "/revit/export-visible-elements", typeof(RevitBridge.Logic.Handlers.ExportVisibleElementsHandler.Params) },
                { "/revit/pick-at-pixel", typeof(RevitBridge.Logic.Handlers.PickAtPixelHandler.Params) },
                { "/revit/set-selection", typeof(RevitBridge.Logic.Handlers.SetSelectionHandler.Params) },
                { "/revit/highlight-and-export", typeof(RevitBridge.Logic.Handlers.HighlightAndExportHandler.Params) },
                { "/revit/activate-view", typeof(RevitBridge.Logic.Handlers.ActivateViewHandler.Params) },
                { "/revit/regenerate", typeof(RevitBridge.Logic.Handlers.RegenerateHandler.Params) },
                { "/revit/computer-use-observe", typeof(RevitBridge.Operator.OperatorDialogComputerUse.ObserveParams) },
                { "/revit/computer-use-act", typeof(RevitBridge.Operator.OperatorDialogComputerUse.ActParams) },
                { "/revit/computer-use-guard", typeof(RevitBridge.Operator.OperatorDialogComputerUse.GuardParams) },
                { "/revit/resolve-room-plan-view", typeof(RevitBridge.Logic.Handlers.ResolveRoomPlanViewHandler.Params) },
                { "/revit/plan-dwelling-receptacles", typeof(RevitBridge.Logic.Handlers.PlanDwellingReceptaclesHandler.Params) },
                { "/revit/audit-electrical-circuit-loading", typeof(RevitBridge.Logic.Handlers.ElectricalCircuitLoadingAuditHandler.Params) },
                { "/revit/audit-plumbing-fixture-services", typeof(RevitBridge.Logic.Handlers.PlumbingFixtureServicesAuditHandler.Params) },
                { "/revit/plan-room-receptacles-from-analog", typeof(RevitBridge.Logic.Handlers.RoomReceptacleAnalogParams) },
                { "/revit/apply-room-receptacles-from-analog", typeof(RevitBridge.Logic.Handlers.RoomReceptacleAnalogParams) },
                { "/revit/list-element-types", typeof(RevitBridge.Logic.Handlers.ListElementTypesHandler.Params) },
                { "/revit/resolve-element-type", typeof(RevitBridge.Logic.Handlers.ResolveElementTypeHandler.Params) },
                { "/revit/change-element-type", typeof(RevitBridge.Logic.Handlers.ChangeElementTypeHandler.Params) },
                { "/revit/duplicate-element-type", typeof(RevitBridge.Logic.Handlers.DuplicateElementTypeHandler.Params) },
                { "/revit/set-type-parameters", typeof(RevitBridge.Logic.Handlers.SetTypeParametersHandler.Params) },
                { "/revit/duplicate-type-and-swap-instance", typeof(RevitBridge.Logic.Handlers.DuplicateTypeAndSwapInstanceHandler.Params) },
                { "/revit/plan-family-evolution", typeof(RevitBridge.Logic.Handlers.PlanFamilyEvolutionHandler.Params) },
                { "/revit/apply-family-evolution", typeof(RevitBridge.Logic.Handlers.ApplyFamilyEvolutionHandler.Params) },
                { "/revit/read-family-evolution", typeof(RevitBridge.Logic.Handlers.ReadFamilyEvolutionHandler.Params) },
                { "/revit/replace-door", typeof(RevitBridge.Logic.Handlers.ReplaceDoorHandler.Params) },
                { "/revit/titleblock-label-map", typeof(RevitBridge.Logic.Handlers.TitleblockLabelMapHandler.Params) },
                { "/revit/capture-sheet-region", typeof(RevitBridge.Logic.Handlers.CaptureSheetRegionHandler.Params) },
                { "/revit/verify-parameter-on-sheet", typeof(RevitBridge.Logic.Handlers.VerifyParameterOnSheetHandler.Params) },
                { "/revit/titleblock-family-update-text", typeof(RevitBridge.Logic.Handlers.TitleblockFamilyUpdateTextHandler.Params) },
                { "/revit/titleblock-date-candidates", typeof(RevitBridge.Logic.Handlers.TitleblockDateCandidatesHandler.Params) },
                { "/revit/titleblock-set-date-smart", typeof(RevitBridge.Logic.Handlers.TitleblockSetDateSmartHandler.Params) },
                { "/revit/get-titleblock-info", typeof(RevitBridge.Logic.Handlers.GetTitleblockInfoHandler.Params) },
                { "/revit/get-family-file-path", typeof(RevitBridge.Logic.Handlers.GetFamilyFilePathHandler.Params) },
                { "/revit/open-family-doc", typeof(RevitBridge.Logic.Handlers.OpenFamilyDocHandler.Params) },
                { "/revit/find-text-notes", typeof(RevitBridge.Logic.Handlers.FindTextNotesHandler.Params) },
                { "/revit/replace-text-note", typeof(RevitBridge.Logic.Handlers.ReplaceTextNoteHandler.Params) },
                { "/revit/save-family-doc", typeof(RevitBridge.Logic.Handlers.SaveFamilyDocHandler.Params) },
                { "/revit/load-family-doc", typeof(RevitBridge.Logic.Handlers.LoadFamilyDocHandler.Params) },
                { "/revit/close-doc", typeof(RevitBridge.Logic.Handlers.CloseDocHandler.Params) },
                { "/revit/edit-family-from-instance", typeof(RevitBridge.Logic.Handlers.EditFamilyFromInstanceHandler.Params) },
                { "/revit/inspect-family-content", typeof(RevitBridge.Logic.Handlers.InspectFamilyContentHandler.Params) },
                { "/revit/find-family-text-notes", typeof(RevitBridge.Logic.Handlers.FindFamilyTextNotesHandler.Params) },
                { "/revit/set-text-note-text", typeof(RevitBridge.Logic.Handlers.SetTextNoteTextHandler.Params) },
                { "/revit/reload-family-edit-session", typeof(RevitBridge.Logic.Handlers.ReloadFamilyEditSessionHandler.Params) },
            };

            public static object? BuildRequestSchema(string method, string path)
            {
                var m = (method ?? "").Trim().ToUpperInvariant();
                var p = (path ?? "").Trim();
                if (m == "GET") return null;

                // Introspection endpoints (POST) – keep small.
                if (string.Equals(p, "/revit/tool-search", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "query", Str() },
                            { "group", Str() },
                            { "risk", Str(new[] { "low", "medium", "high" }) },
                            { "method", Str(new[] { "GET", "POST" }) },
                            { "max", Int() }
                        },
                        required: new[] { "query" });
                }

                if (string.Equals(p, "/revit/tool-doc", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(p, "/revit/tool-examples", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "method", Str(new[] { "GET", "POST" }) },
                            { "path", Str() }
                        },
                        required: new[] { "method", "path" });
                }

                // Quantify has a small, stable semantic contract whose bounded
                // enum/collection truth cannot be recovered from CLR reflection.
                // Advertise the same constraints enforced by the native validator
                // so generic callers can fail before any Revit dispatch.
                if (string.Equals(p, "/revit/quantify", StringComparison.OrdinalIgnoreCase))
                {
                    var parameterFilter = Obj(
                        props: new Dictionary<string, object>
                        {
                            { "param", Str() },
                            { "value", Str() },
                            { "op", Str() }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);
                    var filters = Obj(
                        props: new Dictionary<string, object>
                        {
                            { "level", Str() },
                            { "keywords_include", Arr(Str(), maxItems: 20) },
                            { "keywords_exclude", Arr(Str(), maxItems: 20) },
                            { "parameters", Arr(parameterFilter, maxItems: 20) }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "intent", Str(new[] { "count", "list", "count_and_list" }) },
                            { "scope", Str(new[] { "host", "links", "both" }) },
                            { "categories", Arr(Str(), minItems: 1, maxItems: 10) },
                            { "filters", filters },
                            { "group_by", Arr(Str(), maxItems: 3) },
                            { "room_resolution", Bool() }
                        },
                        required: new[] { "intent", "categories" },
                        additionalProps: false);
                }

                if (string.Equals(p, "/revit/native-api-policy", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "profile", Str(new[] { "balanced", "broad", "unrestricted" }) },
                            { "maxRisk", Str(new[] { "low", "medium", "high" }) },
                            { "allowMutating", Bool() },
                            { "blockFreezeRisk", Bool() },
                            { "maxResults", Int() },
                            { "maxInvocationParams", Int() }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);
                }

                if (string.Equals(p, "/revit/native-api-catalog", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "query", Str() },
                            { "namespacePrefix", Str() },
                            { "typeContains", Str() },
                            { "risk", Str(new[] { "low", "medium", "high" }) },
                            { "offset", Int() },
                            { "limit", Int() }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);
                }

                if (string.Equals(p, "/revit/native-api-search", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "query", Str() },
                            { "namespacePrefix", Str() },
                            { "risk", Str(new[] { "low", "medium", "high" }) },
                            { "max", Int() }
                        },
                        required: new[] { "query" },
                        additionalProps: false);
                }

                if (string.Equals(p, "/revit/native-api-call", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "memberId", Str() },
                            { "target", Str(new[] { "uiapp", "uidoc", "doc", "view" }) },
                            { "args", Arr(new Dictionary<string, object>()) },
                            { "dryRun", Bool() }
                        },
                        required: new[] { "memberId" },
                        additionalProps: false);
                }

                if (string.Equals(p, "/revit/native-api-ops", StringComparison.OrdinalIgnoreCase))
                {
                    var operation = Obj(
                        props: new Dictionary<string, object>
                        {
                            { "id", Str() },
                            { "op", Str(new[] { "construct", "call", "get_property" }) },
                            { "memberId", Str() },
                            { "target", Str() },
                            { "args", Arr(new Dictionary<string, object>()) },
                            { "property", Str() }
                        },
                        required: new[] { "id", "op" },
                        additionalProps: false);
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "operations", Arr(operation) },
                            { "returns", Arr(Str()) },
                            { "maxTotalMs", Int() },
                            { "maxOperationMs", Int() }
                        },
                        required: new[] { "operations" },
                        additionalProps: false);
                }

                if (string.Equals(p, "/revit/native-api-mutation-ops", StringComparison.OrdinalIgnoreCase))
                {
                    var operation = Obj(
                        props: new Dictionary<string, object>
                        {
                            { "id", Str() },
                            { "op", Str(new[] { "construct", "call", "get_property" }) },
                            { "memberId", Str() },
                            { "target", Str() },
                            { "args", Arr(new Dictionary<string, object>()) },
                            { "property", Str() }
                        },
                        required: new[] { "id", "op" },
                        additionalProps: false);
                    var transaction = Obj(
                        props: new Dictionary<string, object>
                        {
                            { "mode", Str(new[] { "rollback", "commit" }) },
                            { "name", Str() },
                            { "maxAffectedElements", Int() },
                            { "allowCreate", Bool() },
                            { "allowedExistingElementIds", Arr(Int()) }
                        },
                        required: new[] { "mode", "maxAffectedElements" },
                        additionalProps: false);
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "operations", Arr(operation) },
                            { "returns", Arr(Str()) },
                            { "transaction", transaction },
                            { "maxTotalMs", Int() },
                            { "maxOperationMs", Int() }
                        },
                        required: new[] { "operations", "transaction" },
                        additionalProps: false);
                }

                if (string.Equals(p, "/revit/self-test", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "include_export_image", Bool() },
                            { "include_rooms", Bool() }
                        },
                        required: Array.Empty<string>());
                }

                if (string.Equals(p, "/revit/inspect-family-content", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "elementId", Int() },
                            { "contains", Str() },
                            { "maxElements", Int() },
                            { "includeParameters", Bool() },
                            { "includeOtherElements", Bool() }
                        },
                        required: new[] { "elementId" },
                        additionalProps: false);
                }

                if (string.Equals(p, "/revit/resolve-room-plan-view", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "roomNumber", Str() },
                            { "preferViewNameContains", Str() },
                            { "maxCandidates", Int() }
                        },
                        required: new[] { "roomNumber" },
                        additionalProps: false);
                }

                if (string.Equals(p, "/revit/query-zone-data", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "levelName", Str() }
                        },
                        required: new[] { "levelName" },
                        additionalProps: false);
                }

                if (string.Equals(p, "/revit/room_mep_intersect", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "roomNumber", Str() },
                            { "plenumTopLevelName", Str() },
                            { "categories", Arr(Str()) },
                            { "systemClassification", Str() },
                            { "sizeEquals", Str() },
                            { "intersectMode", Str(new[] { "bbox", "centerline" }) },
                            { "verticalTolerance", Num() },
                            { "limit", Int() }
                        },
                        required: new[] { "roomNumber", "plenumTopLevelName" },
                        additionalProps: false);
                }

                if (string.Equals(p, "/revit/state-snapshot", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "include_dialogs", Bool() },
                            { "include_selection_details", Bool() },
                            { "include_sheet_viewports", Bool() },
                            { "include_all_views_index", Bool() },
                            { "include_warnings_summary", Bool() },
                            { "include_warnings_detail", Bool() },
                            { "include_element_bboxes", Bool() },
                            { "max_items", Int() }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);
                }
                if (string.Equals(p, "/revit/capture-screenshare", StringComparison.OrdinalIgnoreCase))
                {
                    return OneOf(
                        Null(),
                        Obj(
                            props: new Dictionary<string, object>
                            {
                                { "includeContext", Bool() }
                            },
                            required: Array.Empty<string>(),
                            additionalProps: false));
                }

                if (string.Equals(p, "/revit/views", StringComparison.OrdinalIgnoreCase) && string.Equals(m, "POST", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "action", Str(new[] { "list", "count" }) },
                            { "viewIds", Arr(Int()) },
                            { "levelNames", Arr(Str()) },
                            { "viewTypes", Arr(Str()) },
                            { "disciplines", Arr(Str()) },
                            { "viewNames", Arr(Str()) },
                            { "nameContainsAny", Arr(Str()) },
                            { "semanticGroups", Arr(Str(new[] { "power", "lighting", "electrical", "mechanical", "hvac", "plumbing", "fire_alarm", "architectural" })) },
                            { "includeTemplates", Bool() },
                            { "offset", Int(minimum: 0, maximum: 200000) },
                            { "limit", Int(minimum: 1, maximum: 500) }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);
                }

                // Sheets listing (paging + prefix matching).
                if (string.Equals(p, "/revit/sheets", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "action", Str(new[] { "list", "count", "detail" }) },
                            { "countOnly", Bool() }, // legacy alias for action=count
                            { "sheetNumberPrefix", Str() },
                            { "query", Str() },
                            { "exact", Bool() },
                            { "offset", Int() },
                            { "limit", Int() },
                            { "all", Bool() },
                            { "max", Int() }, // legacy alias for limit
                            { "sheetNumber", Str() }, // detail
                            { "sheetId", Int() }, // detail
                            { "viewId", Int() }, // detail
                            { "includePlacedViews", Bool() }, // detail
                            { "includeViewports", Bool() }, // detail
                            { "includeTitleBlocks", Bool() }, // detail
                            { "includeViewportGeometry", Bool() }, // detail
                            { "includeSheetOutline", Bool() }, // detail
                            { "includeSchedules", Bool() } // detail
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);
                }

                // Project-wide element discovery is deliberately usable with an
                // empty object and every scope/filter/expansion field is optional.
                // net48 reflection cannot recover nullable-reference metadata and
                // would otherwise mark every string filter as simultaneously required.
                if (string.Equals(p, "/revit/find-elements", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "viewId", Int() },
                            { "sheetNumber", Str() },
                            { "includeSheetElements", Bool() },
                            { "includeViewportElements", Bool() },
                            { "sheetRegions", Arr(SchemaFromType(typeof(RevitBridge.Logic.Handlers.FindElementsHandler.SheetRegion), depth: 0)) },
                            { "regionPaddingFt", Num() },
                            { "category", Str() },
                            { "categories", Arr(Str()) },
                            { "typeNameContains", Str() },
                            { "familyNameContains", Str() },
                            { "nameContains", Str() },
                            { "markContains", Str() },
                            { "textContains", Str() },
                            { "identityTerms", Arr(Str()) },
                            { "physicalElementsOnly", Bool() },
                            { "topLevelInstancesOnly", Bool() },
                            { "expandIdentityAcronymsInParameters", Bool() },
                            { "includeGeometry", Bool() },
                            { "limit", Int(minimum: 1, maximum: 5000) }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);
                }

                // Dialog observation is valid with an empty body. Reflection on
                // net48 cannot recover nullable-reference metadata, so keep the
                // optional dialog selectors optional in the published schema.
                if (string.Equals(p, "/revit/computer-use-observe", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "includeScreenshot", Bool() },
                            { "screenshotMaxSidePx", Int() },
                            { "maxDialogs", Int() },
                            { "onlyModal", Bool() },
                            { "titleContains", Str() },
                            { "dialogIdContains", Str() }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);
                }

                // Schedule reads have two conditional shapes. Listing needs no
                // selector; detail requires either scheduleId or query. Do not use
                // reflection here because nullable-reference metadata is not
                // available in the net48 build and would make action/query appear
                // universally required.
                if (string.Equals(p, "/revit/schedules", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "action", Str(new[] { "list", "detail" }) },
                            { "scheduleId", Int(1) },
                            { "query", Str() },
                            { "exact", Bool() },
                            { "max", Int(1, 2000) },
                            { "includeFields", Bool() },
                            { "includeData", Bool() },
                            { "rowOffset", Int(0, 1000000) },
                            { "columnOffset", Int(0, 1000000) },
                            { "maxRows", Int(1, 500) },
                            { "maxColumns", Int(1, 100) }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);
                }

                // Schedule-backed writes are intentionally fail-closed and have
                // conditional selectors. Reflection cannot recover nullable
                // reference metadata in the net48 build, so advertise only the
                // fields the handlers actually require unconditionally.
                if (string.Equals(p, "/revit/update-schedule-cell", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "scheduleId", Int() },
                            { "scheduleQuery", Str() },
                            { "scheduleExact", Bool() },
                            { "rowKey", Str() },
                            { "rowField", Str() },
                            { "targetField", Str() },
                            { "expectedValue", Str() },
                            { "value", Str() },
                            { "apply", Bool() },
                            { "dryRun", Bool() },
                            { "maxSchedules", Int() }
                        },
                        required: new[] { "rowKey", "targetField", "value" },
                        additionalProps: false);
                }

                if (string.Equals(p, "/revit/replace-schedule-values", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "sheetNumbers", Arr(Str()) },
                            { "scheduleIds", Arr(Int()) },
                            { "fieldNames", Arr(Str()) },
                            { "valueContains", Str() },
                            { "expectedValue", Str() },
                            { "replaceFrom", Str() },
                            { "replaceTo", Str() },
                            { "expectedPlanHash", Str() },
                            { "apply", Bool() },
                            { "dryRun", Bool() },
                            { "maxSchedules", Int() },
                            { "maxCandidates", Int() },
                            { "maxChanges", Int() }
                        },
                        required: new[] { "valueContains", "replaceFrom", "replaceTo" },
                        additionalProps: false);
                }

                if (string.Equals(p, "/revit/set-parameter", StringComparison.OrdinalIgnoreCase))
                {
                    var changeSchema = Obj(
                        props: new Dictionary<string, object>
                        {
                            { "elementId", Int() },
                            { "parameterName", Str() },
                            { "value", Str() },
                            { "expectedOldValue", Str() },
                            { "preserveTextCase", Bool() }
                        },
                        required: new[] { "elementId", "parameterName", "value" },
                        additionalProps: false);
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "changes", Arr(changeSchema) },
                            { "apply", Bool() },
                            { "dryRun", Bool() },
                            { "confirm", Str() },
                            { "excludeElementIds", Arr(Int()) },
                            { "preserveTextCase", Bool() }
                        },
                        required: new[] { "changes" },
                        additionalProps: false);
                }

                // Parameter reads accept exactly one selector family: element IDs,
                // categories, or a guarded all-model scan. The validator enforces
                // the conditional requirements for allModelInstances; every field
                // must remain optional in this top-level JSON schema.
                if (string.Equals(p, "/revit/get-parameters", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "elementId", Int() },
                            { "elementIds", Arr(Int()) },
                            { "category", Str() },
                            { "categories", Arr(Str()) },
                            { "allModelInstances", Bool() },
                            { "names", Arr(Str()) },
                            { "includeStringParameters", Bool() },
                            { "valueContains", Str() },
                            { "valueEquals", Str() },
                            { "caseSensitive", Bool() },
                            { "writableOnly", Bool() },
                            { "includeEmpty", Bool() },
                            { "offset", Int() },
                            { "limit", Int() }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);
                }

                // Export PDF (views/sheets). Supports viewIds OR selector OR sheetNumberPrefix/sheetQuery convenience.
                if (string.Equals(p, "/revit/export-pdf", StringComparison.OrdinalIgnoreCase))
                {
                    var selectorSchema = Obj(
                        props: new Dictionary<string, object>
                        {
                            { "query", Str() },
                            { "exact", Bool() },
                            { "max", Int() },
                            { "sheetNumberPrefixes", Arr(Str()) },
                            { "nameIncludes", Arr(Str()) },
                            { "semanticGroup", Str(new[] { "power", "lighting", "mechanical", "electrical", "plumbing", "cover", "fire_alarm" }) },
                            { "semanticGroups", Arr(Str(new[] { "power", "lighting", "mechanical", "electrical", "plumbing", "cover", "fire_alarm" })) }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: true);

                    var core = Obj(
                        props: new Dictionary<string, object>
                        {
                            { "viewIds", Arr(Int()) },
                            { "fileName", Str() },
                            { "sheetQuery", Str() },
                            { "sheetNumberPrefix", Str() },
                            { "sheetGroup", Str(new[] { "power", "lighting", "mechanical", "electrical", "plumbing", "cover", "fire_alarm" }) },
                            { "semanticSheetGroup", Str(new[] { "power", "lighting", "mechanical", "electrical", "plumbing", "cover", "fire_alarm" }) },
                            { "all", Bool() },
                            { "max", Int() },
                            { "printSetName", Str() },
                            { "printSetExact", Bool() },
                            { "selector", selectorSchema },
                            { "combine", Bool() },
                            { "outputFolder", Str() },
                            { "baseFileName", Str() },
                            { "perSheetFileNameTemplate", Str() },
                            { "colorMode", Str(new[] { "Color", "Grayscale", "BlackLine" }) },
                            { "dryRun", Bool() },
                            { "preflight", Bool() },
                            { "preflightOnly", Bool() }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: true);

                    return OneOf(Null(), core);
                }

                // create-view is a tagged union. Its string selectors are conditional on
                // action, but nullable-reference metadata is unavailable in the net48
                // reflection build. The generic fallback would therefore advertise every
                // string selector as simultaneously required and reject valid rename,
                // template, and view-creation requests before Revit sees them. Keep the
                // root permissive; OperatorActionSchemaValidator enforces the exact
                // action-specific combinations immediately before handler execution.
                if (string.Equals(p, "/revit/create-view", StringComparison.OrdinalIgnoreCase))
                {
                    var point = Obj(
                        props: new Dictionary<string, object>
                        {
                            { "x", Num() },
                            { "y", Num() },
                            { "z", Num() }
                        },
                        required: new[] { "x", "y" },
                        additionalProps: false);

                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "action", Str(new[] { "create_floor_plan", "create_3d", "create_dependent", "create_callout", "create_section", "create_elevation", "create_camera", "create_drafting", "create_legend", "create_view_template", "rename_batch" }) },
                            { "name", Str() },
                            { "levelId", Int() },
                            { "levelName", Str() },
                            { "planType", Str(new[] { "floor", "ceiling", "engineering", "structural" }) },
                            { "perspective", Bool() },
                            { "sourceViewId", Int() },
                            { "calloutType", Str(new[] { "detail", "section" }) },
                            { "sectionHeight", Num() },
                            { "sectionDepth", Num() },
                            { "elevationIndex", Int() },
                            { "templateId", Int() },
                            { "templateName", Str() },
                            { "scale", Int() },
                            { "detailLevel", Str() },
                            { "discipline", Str() },
                            { "p1", point },
                            { "p2", point },
                            { "eye", point },
                            { "target", point },
                            { "up", point },
                            { "viewIds", Arr(Int()) },
                            { "nameContains", Str() },
                            { "prefix", Str() },
                            { "suffix", Str() },
                            { "findText", Str() },
                            { "replaceText", Str() },
                            { "exact", Bool() },
                            { "max", Int() },
                            { "dryRun", Bool() }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);
                }

                // create-schedule is also a conditional union: name/scheduleName and
                // category/categoryName are aliases, clone sources apply only to kind=clone,
                // and active-sheet coordinates apply only when placement is requested.
                // net48 reflection cannot recover those relationships and otherwise marks
                // every string alias as required, encouraging callers to fill irrelevant
                // fields with empty/default values. Publish the full optional vocabulary;
                // OperatorActionSchemaValidator remains authoritative for each mode.
                if (string.Equals(p, "/revit/create-schedule", StringComparison.OrdinalIgnoreCase))
                {
                    var sheetPlacement = Obj(
                        props: new Dictionary<string, object>
                        {
                            { "sheetId", Int() },
                            { "sheetNumber", Str() },
                            { "query", Str() },
                            { "exact", Bool() },
                            { "x", Num() },
                            { "y", Num() }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);

                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "name", Str() },
                            { "scheduleName", Str() },
                            { "category", Str() },
                            { "categoryName", Str() },
                            { "kind", Str(new[] { "regular", "material_takeoff", "key", "keynote_legend", "multi_category", "sheet_list", "view_list", "clone" }) },
                            { "sourceScheduleId", Int() },
                            { "sourceQuery", Str() },
                            { "sourceExact", Bool() },
                            { "fields", Arr(Str()) },
                            { "addFields", Arr(Str()) },
                            { "includeLinkedFiles", Bool() },
                            { "reuseIfExists", Bool() },
                            { "dryRun", Bool() },
                            { "filterBySheet", Bool() },
                            { "placeOnActiveSheet", Bool() },
                            { "placeOnActiveSheetX", Num() },
                            { "placeOnActiveSheetY", Num() },
                            { "placeOnSheet", sheetPlacement }
                        },
                        required: Array.Empty<string>(),
                        additionalProps: false);
                }

                // Some tools accept null bodies intentionally (back-compat and convenience).
                if (string.Equals(p, "/revit/export-image", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(p, "/revit/export-view-frame", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(p, "/revit/export-visible-elements", StringComparison.OrdinalIgnoreCase))
                {
                    // null | object
                    var core = SchemaFromType(RequestTypesByPath[p], depth: 0);
                    return OneOf(Null(), core);
                }

                // Route request DTOs contain several mutually exclusive nullable string
                // selectors (ductType/pipeType/conduitType and their sizes). The generic
                // net48 reflection fallback cannot recover nullable-reference metadata and
                // would incorrectly advertise every selector as simultaneously required.
                // The handlers require ordered points; kind defaults to duct and every
                // other selector is conditional or has a guarded native fallback.
                if (string.Equals(p, "/revit/create-mep-route", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(p, "/revit/mep-route-workflow", StringComparison.OrdinalIgnoreCase))
                {
                    return WithRequiredFields(SchemaFromType(RequestTypesByPath[p], depth: 0), "points");
                }

                // This route accepts two alternative request shapes: either one of
                // parameterName/parameter/paramName plus value, or a predicates array.
                // The net48 reflection fallback cannot represent that conditional union
                // and otherwise advertises every nullable string alias (including the
                // optional systemName filter) as simultaneously required. Publish no
                // unconditional root requirements; native schema validation enforces the
                // selected shape before handler execution.
                if (string.Equals(p, "/revit/find-elements-by-parameter", StringComparison.OrdinalIgnoreCase))
                {
                    return WithRequiredFields(SchemaFromType(RequestTypesByPath[p], depth: 0));
                }

                // Default: schema from request type when known, else generic object.
                if (RequestTypesByPath.TryGetValue(p, out var t))
                {
                    return SchemaFromType(t, depth: 0);
                }

                return Obj(new Dictionary<string, object>(), required: Array.Empty<string>(), additionalProps: true);
            }

            public static object? BuildResponseSchema(string method, string path)
            {
                var m = (method ?? "").Trim().ToUpperInvariant();
                var p = (path ?? "").Trim();
                if (m == "GET") return Obj(new Dictionary<string, object>(), required: Array.Empty<string>(), additionalProps: true);

                if (string.Equals(p, "/revit/tool-search", StringComparison.OrdinalIgnoreCase))
                {
                    return Obj(
                        props: new Dictionary<string, object>
                        {
                            { "version", Str() },
                            { "generated_at", Str() },
                            { "query", Str() },
                            {
                                "filters",
                                Obj(
                                    props: new Dictionary<string, object>
                                    {
                                        { "group", OneOf(Str(), Null()) },
                                        { "risk", OneOf(Str(), Null()) },
                                        { "method", OneOf(Str(), Null()) }
                                    },
                                    required: Array.Empty<string>(),
                                    additionalProps: false)
                            },
                            { "returned", Int() },
                            {
                                "matches",
                                Arr(
                                    Obj(
                                        props: new Dictionary<string, object>
                                        {
                                            { "group", Str() },
                                            { "method", Str(new[] { "GET", "POST" }) },
                                            { "path", Str() },
                                            { "title", Str() },
                                            { "risk", Str(new[] { "low", "medium", "high" }) },
                                            { "description", Str() },
                                            { "example", OneOf(Str(), Null()) },
                                            { "score", Int() },
                                            { "match_reasons", Arr(Str()) }
                                        },
                                        required: new[] { "group", "method", "path", "title", "risk", "description", "score", "match_reasons" },
                                        additionalProps: false))
                            }
                        },
                        required: new[] { "version", "generated_at", "query", "filters", "returned", "matches" },
                        additionalProps: false);
                }

                // Default: unknown shapes; we provide example payloads separately.
                return Obj(new Dictionary<string, object>(), required: Array.Empty<string>(), additionalProps: true);
            }

            public static (List<string> required, List<string> optional, Dictionary<string, string[]> enums, List<object> units, List<string> commonErrors, List<string> notes)
                SummarizeContract(string method, string path, object? requestSchema)
            {
                var req = new List<string>();
                var opt = new List<string>();

                var enumMap = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);
                var unitNotes = new List<object>();
                var commonErrors = new List<string>();
                var notes = new List<string>();

                var m = (method ?? "").Trim().ToUpperInvariant();
                var p = (path ?? "").Trim();

                if (m == "GET")
                {
                    notes.Add("GET tools do not accept request bodies.");
                    return (req, opt, enumMap, unitNotes, commonErrors, notes);
                }

                // Enumerations + units contracts for common tokens.
                if (p == "/revit/measure-gap" || p == "/revit/align-elements")
                {
                    enumMap["axis"] = new[] { "viewX", "viewY" };
                    notes.Add("Axis is in the active view basis: viewX=RightDirection, viewY=UpDirection.");
                    notes.Add("Side depends on axis: for axis=viewX use left|right; for axis=viewY use top|bottom.");
                    unitNotes.Add(new { unit = "feet", fields = new[] { "options.zeroToleranceFt", "options.minAbsNormalDot (unitless)", "gapFt" } });
                }

                if (p == "/revit/move-elements")
                {
                    enumMap["mode"] = new[] { "vector", "fromTo" };
                    enumMap["behavior"] = new[] { "allOrNothing", "bestEffort" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "vectorX", "vectorY", "vectorZ", "fromX", "fromY", "fromZ", "toX", "toY", "toZ" } });
                    notes.Add("Set moveTogether=true with behavior=allOrNothing to translate a connected set in one ElementTransformUtils.MoveElements call. moveTogether is incompatible with bestEffort.");
                }

                if (p == "/revit/rotate-elements")
                {
                    enumMap["behavior"] = new[] { "allOrNothing", "bestEffort" };
                    enumMap["axis.mode"] = new[] { "zThroughPoint", "throughPoints" };
                    unitNotes.Add(new { unit = "degrees", fields = new[] { "angleDegrees" } });
                    unitNotes.Add(new { unit = "feet", fields = new[] { "axis.pointX", "axis.pointY", "axis.pointZ" } });
                    notes.Add("axis.mode=zThroughPoint creates a vertical axis through (pointX,pointY,pointZ); throughPoints creates an arbitrary 3D axis from that point to (endPointX,endPointY,endPointZ).");
                }

                if (p == "/revit/create-view")
                {
                    enumMap["action"] = new[] { "create_floor_plan", "create_3d", "create_dependent", "create_callout", "create_section", "create_elevation", "create_camera", "create_drafting", "create_legend", "create_view_template", "rename_batch" };
                    enumMap["planType"] = new[] { "floor", "ceiling", "engineering", "structural" };
                    enumMap["calloutType"] = new[] { "detail", "section" };
                    notes.Add("Fields are conditional on action; the native validator reports the exact missing combination.");
                    notes.Add("rename_batch requires viewIds or nameContains plus prefix, suffix, or findText; set dryRun=true to preview exact old/new names without applying them.");
                }

                if (p == "/revit/create-schedule")
                {
                    enumMap["kind"] = new[] { "regular", "material_takeoff", "key", "keynote_legend", "multi_category", "sheet_list", "view_list", "clone" };
                    notes.Add("Fields are conditional on schedule kind; name/scheduleName and category/categoryName are aliases, and clone requires sourceScheduleId or sourceQuery.");
                    notes.Add("Omit placeOnActiveSheetX/Y unless placeOnActiveSheet=true; use placeOnSheet for explicit sheet placement.");
                    unitNotes.Add(new { unit = "feet", fields = new[] { "placeOnActiveSheetX", "placeOnActiveSheetY", "placeOnSheet.x", "placeOnSheet.y" } });
                }

                if (p == "/revit/room-contents")
                {
                    enumMap["mode"] = new[] { "auto", "roomAware", "geometry" };
                    enumMap["verticalScope"] = new[] { "room", "plenum", "room+plenum" };
                    enumMap["spatialKindPreference"] = new[] { "auto", "room", "space" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "plenumMaxZ", "verticalRange.minZ", "verticalRange.maxZ" } });
                    notes.Add("mode=auto uses roomAware first, then geometry fallback for categories that are not room-aware (common for MEP).");
                    notes.Add("roomAware: elements with Room/Space association (mostly FamilyInstance). geometry: test element location/bbox points against Room/Space containment.");
                    notes.Add("verticalScope=room uses true Room/Space containment. verticalScope=plenum projects XY into the room footprint and filters by Z between the room top and the next level (or plenumMaxZ).");
                    notes.Add("verticalScope=room+plenum evaluates both scopes in one call.");
                    notes.Add("Successful room-contents responses now include the resolved spatial location plus true boundaryLoops/boundary metadata for the resolved Room or Space.");
                    notes.Add("includeLinked=true keeps link-scoped ids (link:<instanceId>:<elementId>) and transformed host/source metadata, but final inclusion still depends on Revit link visibility and accessible link documents.");
                    notes.Add("Element rows now emit explicit hostingSurface.mode/surfaceType and hostLinkInstanceId/hostLinkedElementId fields when Revit exposes them, reducing downstream host inference.");
                }

                if (p == "/revit/rooms")
                {
                    enumMap["action"] = new[] { "list", "detail" };
                    enumMap["spatialKindPreference"] = new[] { "auto", "room", "space" };
                    notes.Add("Use spatialKindPreference=space when a room number is known to resolve to an MEP Space instead of an architectural Room.");
                    notes.Add("detail with roomNumber + spatialKindPreference resolves deterministically without a separate /revit/spaces endpoint.");
                }

                if (p == "/revit/locate-elements")
                {
                    enumMap["spatialResolution"] = new[] { "association", "geometry", "geometry_with_nearest" };
                    enumMap["spatialVerticalScope"] = new[] { "volume", "same_level" };
                    enumMap["spatialKindPreference"] = new[] { "auto", "room", "space", "all" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "maxDistanceFt", "items[*].spatialContext.matches[*].boundaryDistanceFt", "items[*].spatialContext.nearestCandidates[*].boundaryDistanceFt" } });
                    notes.Add("association preserves the fast existing FamilyInstance Room/Space lookup. geometry adds phase-aware Room/Space containment against host and transformed linked spatial elements. geometry_with_nearest also returns ranked candidates for unresolved elements. spatialVerticalScope=volume is the strict 3D default; same_level ignores association-only evidence, requires factual same-level 2D footprints for above-ceiling/plenum devices, and never broadens to another level. Pairing same_level with association promotes the request to geometry.");
                    notes.Add("Geometry mode uses an explicit phase or the active-view phase when available. If neither exists, it first evaluates mapped phases where the target exists. When those phases contain no footprint, it may evaluate all mapped phase variants, but resolves only when the containing variants agree on one numbered identity; phaseFallbackUsed reports that provenance and disagreements remain ambiguous. Unloaded links, unavailable transforms, unavailable element representative points, missing vertical extents, and boundary-only evidence fail closed instead of becoming Room assignments.");
                    notes.Add("Use spatialKindPreference=room when the user explicitly asks for room numbers. Linked architectural Rooms retain link instance, source document, source-scoped id, phase, containment method, and ambiguity. Same-phase spatial ids remain distinct even when their labels match; only one-per-phase variants with valid lifecycle mapping and one stable numbered identity may collapse across phases.");
                    notes.Add("superComponentId/topLevelParentId/isNested identify nested FamilyInstance records so child geometry is not silently counted as another physical device.");
                }

                if (p == "/revit/ducts-by-spatial-scope")
                {
                    enumMap["roomMode"] = new[] { "auto", "roomAware", "geometry" };
                    enumMap["verticalScope"] = new[] { "room", "plenum", "room+plenum" };
                    notes.Add("This endpoint performs fallback in order: room association, space association, then geometry checks.");
                    notes.Add("Default ductwork categories are Duct Curves + Duct Fittings + Air Terminals.");
                }

                if (p == "/revit/resize-ductwork-by-scope")
                {
                    enumMap["scope.roomMode"] = new[] { "auto", "roomAware", "geometry" };
                    enumMap["scope.verticalScope"] = new[] { "room", "plenum", "room+plenum" };
                    enumMap["resolveTypeDriven"] = new[] { "auto", "duplicate", "skip" };
                    notes.Add("One-shot ductwork resize by spatial scope; internally scopes elements then applies duct resize + connected fitting/terminal sync.");
                }

                if (p == "/revit/repair-duct-continuity-by-scope")
                {
                    enumMap["scope.roomMode"] = new[] { "auto", "roomAware", "geometry" };
                    enumMap["scope.verticalScope"] = new[] { "room", "plenum", "room+plenum" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "maxGapFt", "preAudit.likelyMissingSegments[*].distanceFt", "attempts[*].gapFt", "attempts[*].profile.widthFt", "attempts[*].profile.heightFt", "attempts[*].profile.diameterFt" } });
                    notes.Add("Provide either scope or exact elementIds. Exact elementIds require expectedModelPath and are preferred for staged benchmark repairs.");
                    notes.Add("Supports Round, Rectangular, and Oval profiles. Facing collinear endpoints use one direct bridge; orthogonal endpoints use two matching-profile segments and a native elbow.");
                    notes.Add("Dry-run executes the native repair in one transaction, rolls it back, and returns exact connector-topology and transient-created-ID proof.");
                }

                if (p == "/revit/repair-mep-connectors")
                {
                    enumMap["connectionKind"] = new[] { "auto", "direct", "elbow", "transition" };
                    enumMap["repair.kind"] = new[] { "move_elements_vector", "set_curve_line", "set_flex_curve", "resize_round_connectors" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "repair.vectorX", "repair.vectorY", "repair.vectorZ", "repair.startXyz[*]", "repair.endXyz[*]", "repair.flexPoints[*][*]", "repair.connectorChanges[*].expectedOriginXyz[*]", "repair.connectorChanges[*].diameterFt", "originToleranceFt", "maxConnectorDistanceFt", "connectionMaxDistanceFt" } });
                    notes.Add("Choose exactly one mode: disconnectOnlyPairs, connectOpenPair, disconnectPairs plus repair, or standalone repair.");
                    notes.Add("Use native connector IDs when available. Enumeration-index connector IDs must include exact expectedOriginXyz guards.");
                    notes.Add("resize_round_connectors changes only explicitly identified native round connector diameters and includes connector sizes in rollback fingerprints.");
                    notes.Add("connectOpenPair dry-runs execute the native connection or fitting operation, roll it back, and return the transient fitting identity plus rollback proof.");
                    notes.Add("Positive-gap elbows are allowed within connectionMaxDistanceFt because Revit trims connected curves back from the theoretical fitting centerline.");
                    notes.Add("All dry-runs preserve exact before/final connector-topology fingerprints and report rollback proof.");
                }

                if (p == "/revit/resize-ducts-in-room")
                {
                    enumMap["roomMode"] = new[] { "auto", "roomAware", "geometry" };
                    enumMap["verticalScope"] = new[] { "room", "plenum", "auto", "room+plenum" };
                    enumMap["resolveTypeDriven"] = new[] { "auto", "duplicate", "skip" };
                    notes.Add("verticalScope=room+plenum applies both scopes; verticalScope=auto attempts room first, then plenum if needed.");
                }

                if (p == "/revit/find-elements")
                {
                    notes.Add("Scope precedence: if viewId is provided it is used; otherwise sheetNumber scopes to views placed on that sheet (viewports).");
                    notes.Add("For redline workflows, provide sheetRegions (sheet UV boxes) to return only elements overlapping mapped markup areas.");
                    notes.Add("Categories are BuiltInCategory tokens like OST_Doors, OST_TitleBlocks, OST_GenericModel.");
                    notes.Add("For ordinary whole-document object discovery, identityTerms searches instance name, family, type, category, and Mark while preserving matched-term/field evidence; combine physicalElementsOnly and topLevelInstancesOnly to exclude schedules, legends, annotations, and nested child components.");
                    notes.Add("expandIdentityAcronymsInParameters is seed-gated: only categories with a physical first-pass identity match are scanned for delimiter-bounded phrase acronyms in string parameters, and exact parameter-name/value evidence is returned.");
                    unitNotes.Add(new { unit = "feet", fields = new[] { "items[*].geometry.locationPoint", "items[*].geometry.locationCurve.start", "items[*].geometry.locationCurve.end", "items[*].geometry.locationCurve.midpoint", "items[*].geometry.locationCurve.lengthFt", "items[*].geometry.boundingBox.min", "items[*].geometry.boundingBox.max", "items[*].geometry.boundingBox.center", "items[*].geometry.boundingBox.size" } });
                    notes.Add("includeGeometry=true returns model/world coordinates, transformed axis-aligned bounding boxes, FamilyInstance facing/hand orientation, and type/level/host ids for bounded project-wide spatial analysis without requiring a visible view export.");
                }

                if (p == "/revit/export-visible-elements")
                {
                    unitNotes.Add(new { unit = "pixels", fields = new[] { "imageSize", "items[*].anchor.image.x", "items[*].anchor.image.y", "items[*].bbox.image.minX", "items[*].bbox.image.minY", "items[*].bbox.image.maxX", "items[*].bbox.image.maxY" } });
                    unitNotes.Add(new { unit = "feet", fields = new[] { "items[*].anchor.model.x", "items[*].anchor.model.y", "items[*].anchor.model.z", "items[*].bbox.model.min.x", "items[*].bbox.model.min.y", "items[*].bbox.model.min.z", "items[*].bbox.model.max.x", "items[*].bbox.model.max.y", "items[*].bbox.model.max.z", "items[*].geometry.lengthFt" } });
                    notes.Add("Use this when you need a full visible-element manifest tied to the same exported image and affine mapping basis.");
                    notes.Add("Supported for crop-box-backed 2D views only; use sheet-aware tools for DrawingSheet workflows.");
                    notes.Add("categories/excludeCategories accept BuiltInCategory tokens and exact category names when tokens are unavailable.");
                    notes.Add("includeLinked=true keeps link-scoped ids and transformed source/host/hostingSurface payloads so linked rows can be consumed without re-deriving host coordinates.");
                    notes.Add("Orientation payloads include facing/hand vectors plus plan-azimuth and basis vectors when available; linked rows are transformed into host coordinates.");
                    notes.Add("Mapping corners are emitted from the saved raster frame; crop-box corners are included only as reference metadata when the raster aspect differs.");
                }

                if (p == "/revit/room_mep_intersect")
                {
                    enumMap["intersectMode"] = new[] { "bbox", "centerline" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "verticalTolerance" } });
                    notes.Add("intersectMode='bbox' uses solid/solid-like bbox overlap; 'centerline' uses centerline (or sampled curve points) + bbox fallback.");
                    notes.Add("Filters are applied after room lookup and plenum volume computation.");
                }

                if (p == "/revit/resize-ducts-by-scope")
                {
                    enumMap["scope.type"] = new[] { "equipment", "room", "view" };
                    enumMap["scopeMode"] = new[] { "connectedRun", "bboxIntersect", "centerlineIntersect" };
                    unitNotes.Add(new { unit = "length text or feet", fields = new[] { "fromDiameter", "toDiameter" } });
                    notes.Add("Room scope uses room+plenum intersection with bbox/centerline modes; equipment scope traces connected run from Mark-resolved equipment.");
                    notes.Add("When includeFittings/includeTerminals are true, the tool runs sync-connected-sizes and attempts type-driven duplicate+swap for scoped instances.");
                }

                if (p == "/revit/align-room-tops-to-ceilings")
                {
                    enumMap["behavior"] = new[] { "allOrNothing", "bestEffort" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "toleranceFt", "changes[*].baseZ", "changes[*].currentTopZ", "changes[*].newTopZ", "changes[*].ceilingBottomZ" } });
                    notes.Add("Primary ceiling is selected by: largest computed area, then lowest bottom elevation, constrained to the room footprint (XY test at room base).");
                    notes.Add("This tool modifies room height settings (UpperLimit/LimitOffset or UnboundedHeight) and requires approval when not dryRun.");
                }

                if (p == "/revit/link-cad")
                {
                    enumMap["placement"] = new[] { "origin", "center" };
                    notes.Add("sourcePath can be Workspace-relative OR an external path under OPERATOR_ALLOWED_EXTERNAL_ROOTS.");
                }

                if (p == "/revit/link-revit")
                {
                    enumMap["action"] = new[] { "link", "unload" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "x", "y", "z" } });
                    notes.Add("sourcePath can be Workspace-relative OR an external path under OPERATOR_ALLOWED_EXTERNAL_ROOTS.");
                    notes.Add("Run dryRun:true first; apply creates a RevitLinkType plus RevitLinkInstance and returns both ids.");
                    notes.Add("Use action:'unload' with linkTypeId before deleting the last link instance when strict cleanup must remove the RevitLinkType.");
                }

                if (p == "/revit/visibility")
                {
                    enumMap["action"] = new[]
                    {
                        "get", "set_template", "hide_category", "show_category", "set_scale", "set_detail_level",
                        "set_discipline", "set_phase", "set_phase_filter", "set_section_box", "clear_section_box",
                        "set_crop_box", "clear_crop_box", "set_scope_box", "clear_scope_box", "set_view_range", "set_underlay", "clear_underlay",
                        "set_category_override", "clear_category_override",
                        "apply_view_filter", "create_view_filter", "remove_view_filter", "clear_filter_override",
                        "isolate_elements_temp", "isolate_categories_temp", "clear_temp_hide_isolate",
                        "reveal_hidden_on", "reveal_hidden_off", "hide_elements", "unhide_elements"
                    };
                    enumMap["ruleOperator"] = new[] { "equals", "not_equals", "contains", "not_contains", "begins_with", "ends_with", "greater", "greater_or_equal", "less", "less_or_equal" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "annotationCropMarginFeet", "viewRangeTopOffsetFeet", "viewRangeCutOffsetFeet", "viewRangeBottomOffsetFeet", "viewRangeDepthOffsetFeet" } });
                    notes.Add("Use get with includeLinkedModels:true before linked-model graphics or phase mapping work; it reports Revit link ids/names, loaded document titles, common linked categories, linked phases, and phase-map rows when available.");
                    notes.Add("Do not treat linkedModelName/linkName with set_category_override as a proven linked category override; Revit 2024 lacks a per-linked-category lineweight API in this handler, so those requests block with linked_model_category_override_not_supported instead of changing host categories.");
                    notes.Add("set_crop_box accepts annotationCropActive and annotationCropMarginFeet; use them for sheet views so the viewport box does not include distant stray annotations.");
                    notes.Add("set_view_range changes only supplied top/cut/bottom/view-depth level or offset fields; dryRun:true executes the native setter inside a rolled-back transaction and returns current plus proposed plane readback.");
                    notes.Add("create_view_filter supports one-rule parameter filters and immediately applies the filter to the target view.");
                }

                if (p == "/revit/mep-workflows")
                {
                    notes.Add("connect_elements_with_duct supports optional ductSize (for example \"8\\\"\" or \"24x12\") to write size on the created segment.");
                }

                if (p == "/revit/resolve-mep-routing-context")
                {
                    enumMap["systemKind"] = new[] { "duct", "pipe" };
                    enumMap["routingMode"] = new[] { "auto", "above_ceiling", "plenum_midpoint", "level_offset" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "defaultOffsetFt", "ceilingOffsetFt", "recommendedElevation.zFt", "level.elevation", "ceiling.bottomZ" } });
                    notes.Add("Use this before creating MEP redline routes when elevation is missing or likely plan-only.");
                    notes.Add("Fallback elevations are explicit assumptions in the response; do not hide them from the user.");
                }

                if (p == "/revit/create-mep-route")
                {
                    enumMap["kind"] = new[] { "duct", "pipe", "conduit" };
                    enumMap["ductShape"] = new[] { "round", "rectangular", "oval" };
                    enumMap["sizePolicy"] = new[] { "explicit_required", "use_default_with_warning" };
                    enumMap["elevationPolicy"] = new[] { "explicit_required", "resolve_context_default" };
                    enumMap["routingMode"] = new[] { "orthogonal", "polyline" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "points[*].x", "points[*].y", "points[*].z", "points[*].xyz", "defaultOffsetFt", "ceilingOffsetFt", "totalLengthFt" } });
                    unitNotes.Add(new { unit = "pixels", fields = new[] { "points[*].xPx", "points[*].yPx" } });
                    notes.Add("Always dry-run first. If size is omitted, default policy uses 8x8 duct or 1 inch pipe and returns a warning.");
                    notes.Add("Use segmentSizes with one size per segment to draft multi-section routes; internal joints with differing adjacent sizes expect transition fittings.");
                    notes.Add("Internal route joints attempt Revit NewTransitionFitting for size changes, otherwise NewElbowFitting, then fall back to Connector.ConnectTo; fitting ids are returned when created.");
                    notes.Add("Connector verification is conservative: created standalone routes normally report open endpoint connectors until connected to equipment or existing runs.");
                    notes.Add("Only points is universally required. For kind=duct use ductType or ductTypeId plus ductSize/diameter; for kind=pipe use pipeType or pipeTypeId plus pipeSize/diameter; for kind=conduit use conduitType or conduitTypeId plus diameter. These alternatives are not simultaneous requirements.");
                }

                if (p == "/revit/connect-mep-branch")
                {
                    enumMap["kind"] = new[] { "duct", "pipe" };
                    enumMap["connectionMode"] = new[] { "tee", "tap", "auto" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "branchPoints[*].x", "branchPoints[*].y", "branchPoints[*].z", "mainIntersection.distanceToMainFt" } });
                    notes.Add("Apply is implemented when branch start is within tolerance of an existing open main connector; the branch snaps to that connector and creates branch segments/fittings.");
                    notes.Add("A duct/pipe non-connector tee path is available when dry-run reports splitPlan.applySupported=true and connectionMode is tee/auto: the tool splits a straight main, creates the branch, requires a tee fitting, audits continuity, and exports a focused capture.");
                    notes.Add("A duct/pipe non-connector tap path is available with connectionMode:'tap': the tool leaves the straight main intact, creates branch segments, requires Revit NewTakeoffFitting, audits continuity, and exports a focused capture.");
                    notes.Add("For named tap/takeoff requests, pass takeoffFamilyName and/or takeoffTypeName. Dry-run returns selected.takeoffRoutingPreference candidates and tapApplyPrecheck; pipe tap apply requires an explicit takeoff/tap routing preference, while ordinary pipe junction preferences belong on split tee. Apply reports connectionAttempts[*].fitting/requestedTakeoff/routingPreference and rolls back on takeoff_type_mismatch.");
                    notes.Add("Use branchSegmentSizes with one size per branch segment to draft reducer/transition branches; dry-run returns branchPlan.jointPlan and apply prefers transition fittings where adjacent branch sizes differ.");
                    notes.Add("Run dry-run first and inspect splitPlan, selected, connectionAttempts, connectedNetworkAudit, and focusedCapture. Unsupported Revit takeoff/fitting cases block and roll back instead of leaving disconnected geometry.");
                }

                if (p == "/revit/mep-route-workflow")
                {
                    enumMap["kind"] = new[] { "duct", "pipe", "conduit" };
                    enumMap["ductShape"] = new[] { "round", "rectangular", "oval" };
                    enumMap["sizePolicy"] = new[] { "explicit_required", "use_default_with_warning" };
                    enumMap["elevationPolicy"] = new[] { "explicit_required", "resolve_context_default" };
                    enumMap["routingMode"] = new[] { "orthogonal", "polyline" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "points[*].x", "points[*].y", "points[*].z", "points[*].xyz", "defaultOffsetFt", "ceilingOffsetFt", "focusPaddingFt" } });
                    unitNotes.Add(new { unit = "pixels", fields = new[] { "points[*].xPx", "points[*].yPx", "imageSize" } });
                    notes.Add("Execution order is fixed: resolve context, dry-run route, apply route only if dry-run is not blocked, then highlight/export the applied elements for visual review.");
                    notes.Add("When apply=false the workflow returns DryRunReady and no visual capture because dry-run elements are rolled back.");
                    notes.Add("When apply=true and visualVerify=true, successful responses include visualVerification.capture.path plus AI review checklist text.");
                    notes.Add("Only points is universally required. Route type, system, shape, and size fields are conditional on kind and may use either stable type IDs or names.");
                }

                if (p == "/revit/mep-branch-network-workflow")
                {
                    enumMap["kind"] = new[] { "duct", "pipe" };
                    enumMap["branches[*].connectionMode"] = new[] { "tee", "tap", "auto" };
                    enumMap["accessories[*].action"] = new[] { "insert", "delete", "remove", "type_change", "change_type" };
                    enumMap["sizePolicy"] = new[] { "explicit_required", "use_default_with_warning" };
                    enumMap["elevationPolicy"] = new[] { "explicit_required", "resolve_context_default" };
                    unitNotes.Add(new { unit = "feet", fields = new[] { "mainPoints[*].x", "mainPoints[*].y", "mainPoints[*].z", "branches[*].connectionPoint.x", "branches[*].points[*].x", "focusPaddingFt" } });
                    unitNotes.Add(new { unit = "pixels", fields = new[] { "mainPoints[*].xPx", "mainPoints[*].yPx", "branches[*].connectionPoint.xPx", "branches[*].points[*].xPx", "imageSize" } });
                    notes.Add("This workflow drafts a main route plus multiple branch connections by composing /revit/create-mep-route and /revit/connect-mep-branch.");
                    notes.Add("Dry-run plans branch projections and branch-level reducer/transition joint plans against the requested main segment geometry before any model write.");
                    notes.Add("Use branches[*].branchSegmentSizes with one size per branch segment; networkPlan.branches[*].jointPlan reports transition expectations before apply.");
                    notes.Add("Apply creates the main, branches, and accessories inside one TransactionGroup. Any branch, accessory, or semantic-verification failure rolls back the complete network; success reports atomicCommitSucceeded=true.");
                    notes.Add("Accessory graph nodes are accepted in the request and surfaced in networkPlan. Apply supports duct/pipe accessory insertion hosted on a created main or branch segment with a compatible resolved family symbol and chainageFt/point, optionally loading an explicit workspace-scoped familyPath first, plus explicit target-id duct/pipe accessory delete and type_change with a compatible loaded type.");
                    notes.Add("Accessory delete/type_change must provide targetElementId or targetElementIds. Type changes also require typeId, targetTypeName, familySymbolId, or familyName/typeName. Inserted accessories must match the route kind category.");
                }

                if (p == "/revit/arch-workflows")
                {
                    enumMap["action"] = new[]
                    {
                        "create_walls_from_polyline",
                        "change_wall_type",
                        "join_wall_geometry",
                        "place_hosted_instances",
                        "swap_family_type_in_view",
                        "create_model_group_and_place",
                        "array_elements",
                        "mirror_elements",
                        "copy_same_place",
                        "create_reference_plane",
                        "purge_duplicate_line_patterns",
                        "create_floor_from_walls",
                        "create_ceiling_in_room",
                        "create_rooms_and_tags",
                        "create_room_separation_lines"
                    };
                    notes.Add("Use place_hosted_instances for door/window hosted placement on selected walls; optional alignToElementId enables post-place alignment in the same call.");
                    notes.Add("create_floor_from_walls and create_ceiling_in_room provide one-call architectural slab/ceiling authoring from existing model context.");
                }

                if (p == "/revit/list-element-types")
                {
                    enumMap["action"] = new[] { "list", "rename_types", "purge_unused_in_family" };
                    notes.Add("Use action=rename_types for regex-based type rename plans/applies within a single family.");
                    notes.Add("Use action=purge_unused_in_family to delete unused FamilySymbol types while retaining at least one type.");
                }

                if (p == "/revit/create-family-instance")
                {
                    notes.Add("symbolName or typeName is required.");
                    notes.Add("viewId or sheetNumber can target view-specific/sheet annotation placement.");
                    notes.Add("count + spacingX/Y/Z enables repeated placement in one call.");
                }

                if (p == "/revit/state-snapshot")
                {
                    unitNotes.Add(new { unit = "count", fields = new[] { "max_items" } });
                    notes.Add("Core snapshot fields are always present; unsupported values resolve as null.");
                    notes.Add("Defaults: include_dialogs=true, include_selection_details=true, include_sheet_viewports=true, include_all_views_index=false, include_warnings_summary=true, include_warnings_detail=false, include_element_bboxes=false.");
                }
                if (p == "/revit/computer-use-observe")
                {
                    unitNotes.Add(new { unit = "pixels", fields = new[] { "screenshotMaxSidePx" } });
                    unitNotes.Add(new { unit = "count", fields = new[] { "maxDialogs" } });
                    notes.Add("Dialog-scoped computer-use MVP for Revit-owned modal/top-level dialog windows only; this is not generic desktop automation.");
                    notes.Add("When includeScreenshot=true, screenshot_path points to a saved dialog artifact that can be attached/viewed for model-side reasoning.");
                }
                if (p == "/revit/computer-use-act" || p == "/revit/computer-use-guard")
                {
                    enumMap["button"] = new[] { "default", "ok", "close", "yes", "no", "cancel", "retry", "continue" };
                    enumMap["interactionMode"] = new[] { "message", "mouse", "message_then_mouse" };
                    enumMap["cursorRestoreMode"] = new[] { "restore", "keep" };
                    unitNotes.Add(new { unit = "milliseconds", fields = p == "/revit/computer-use-act" ? new[] { "waitForDialogMs" } : new[] { "ttlMs" } });
                    if (p == "/revit/computer-use-act")
                    {
                        unitNotes.Add(new { unit = "pixels", fields = new[] { "screenshotMaxSidePx" } });
                        notes.Add("Acts only on currently visible Revit-owned dialogs and prefers the default button when no selector is supplied.");
                        notes.Add("interactionMode defaults to message_then_mouse: BM_CLICK first, then a physical cursor click only if the same dialog remains visible. Use message to forbid mouse movement or mouse to force the fallback.");
                        notes.Add("cursorRestoreMode defaults to keep so follow-up screenshots/actions preserve pointer continuity. Use restore only after the click is verified or when no follow-up mouse precision is needed.");
                    }
                    else
                    {
                        unitNotes.Add(new { unit = "count", fields = new[] { "maxTriggers" } });
                        unitNotes.Add(new { unit = "pixels", fields = new[] { "screenshotMaxSidePx" } });
                        notes.Add("Guard is a short-lived auto-dismiss rule for the next matching dialog; event-time matching uses dialog/message metadata and live title matching happens during the actual click attempt.");
                        notes.Add("interactionMode has the same semantics as computer-use-act; cursorRestoreMode controls whether mouse modes keep or restore the cursor after the click. The default is keep.");
                    }
                }
                if (p == "/revit/place-image" || p == "/revit/place-pdf-underlay")
                {
                    enumMap["placement"] = new[] { "origin", "center" };
                    unitNotes.Add(new { unit = "inches", fields = new[] { "xInches", "yInches", "widthInches", "heightInches" } });
                }

                if (p == "/revit/draw-detail-curves" || p == "/revit/create-filled-region" || p == "/revit/create-revision-cloud")
                {
                    unitNotes.Add(new { unit = "feet", fields = new[] { "point.xyz" } });
                    unitNotes.Add(new { unit = "pixels", fields = new[] { "point.xPx", "point.yPx" } });
                    unitNotes.Add(new { unit = "inches", fields = new[] { "point.xIn", "point.yIn" } });
                    notes.Add("Drafting point contract: provide ONE of xyz(feet), xPx/yPx(with frameId), or xIn/yIn(inches).");
                }

                // Common error reasons.
                if (p == "/revit/pick-at-pixel")
                {
                    commonErrors.Add("Unknown or expired frameId (re-run export-view-frame).");
                    commonErrors.Add("Missing required parameter: frameId.");
                }
                if (p == "/revit/export-view-region")
                {
                    commonErrors.Add("region is required and must be an object.");
                    commonErrors.Add("region.mode must be one of: focusElements | center.");
                }
                if (p == "/revit/export-visible-elements")
                {
                    commonErrors.Add("View type is unsupported; export-visible-elements requires a crop-box-backed 2D view.");
                    commonErrors.Add("Crop box activation failed; activate crop in the target view or use export-view-region.");
                }

                // Infer fields from schema for convenience.
                try
                {
                    var json = JsonSerializer.Serialize(requestSchema, OperatorUiProtocol.JsonOptions);
                    using var doc = JsonDocument.Parse(json);
                    var root = doc.RootElement;

                    // If schema is oneOf(null, object) pick the object branch for field summaries.
                    if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("oneOf", out var oneOf) && oneOf.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var branch in oneOf.EnumerateArray())
                        {
                            if (branch.ValueKind == JsonValueKind.Object &&
                                branch.TryGetProperty("type", out var t) &&
                                t.ValueKind == JsonValueKind.String &&
                                string.Equals(t.GetString(), "object", StringComparison.OrdinalIgnoreCase))
                            {
                                root = branch;
                                break;
                            }
                        }
                    }

                    if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("properties", out var props) && props.ValueKind == JsonValueKind.Object)
                    {
                        var all = props.EnumerateObject().Select(x => x.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
                        var required = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                        if (root.TryGetProperty("required", out var reqEl) && reqEl.ValueKind == JsonValueKind.Array)
                        {
                            foreach (var r in reqEl.EnumerateArray())
                            {
                                if (r.ValueKind == JsonValueKind.String) required.Add(r.GetString() ?? "");
                            }
                        }

                        foreach (var r in required.Where(x => !string.IsNullOrWhiteSpace(x))) req.Add(r);
                        foreach (var f in all)
                        {
                            if (string.IsNullOrWhiteSpace(f)) continue;
                            if (!required.Contains(f)) opt.Add(f);
                        }
                    }
                }
                catch
                {
                    // ignore schema parse issues
                }

                return (req, opt, enumMap, unitNotes, commonErrors, notes);
            }

            private static object SchemaFromType(Type t, int depth)
            {
                if (depth > 4) return Obj(new Dictionary<string, object>(), required: Array.Empty<string>(), additionalProps: true);

                if (t == typeof(string)) return Str();
                if (t == typeof(bool)) return Bool();
                if (t == typeof(int) || t == typeof(long) || t == typeof(short)) return Int();
                if (t == typeof(double) || t == typeof(float) || t == typeof(decimal)) return Num();

                var nullable = Nullable.GetUnderlyingType(t);
                if (nullable != null)
                {
                    return OneOf(Null(), SchemaFromType(nullable, depth + 1));
                }

                if (t.IsArray)
                {
                    var it = t.GetElementType() ?? typeof(object);
                    return Arr(SchemaFromType(it, depth + 1));
                }

                if (IsListLike(t, out var itemType))
                {
                    return Arr(SchemaFromType(itemType, depth + 1));
                }

                // Complex objects.
                var props = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                var required = new List<string>();
                object? instance = null;
                try { instance = Activator.CreateInstance(t); } catch { instance = null; }

                foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (!p.CanRead) continue;
                    if (p.GetIndexParameters().Length > 0) continue;

                    var pt = p.PropertyType;
                    var schema = SchemaFromType(pt, depth + 1);
                    props[p.Name] = WithHeuristicDescription(p.Name, pt, schema);

                    var defaultVal = instance != null ? SafeGet(p, instance) : null;
                    var isNullable = !pt.IsValueType || Nullable.GetUnderlyingType(pt) != null;
                    if (!isNullable && IsDefaultValue(pt, defaultVal))
                    {
                        // Non-nullable value type with default(T): require for correctness.
                        required.Add(p.Name);
                    }
                    else if (pt == typeof(string) && defaultVal == null)
                    {
                        // Strings default to null when omitted; most handlers expect them.
                        required.Add(p.Name);
                    }
                }

                return Obj(props, required.ToArray(), additionalProps: false);
            }

            private static object WithHeuristicDescription(string name, Type t, object schema)
            {
                // Add lightweight units contract to property schema without making it verbose.
                try
                {
                    if (schema is Dictionary<string, object> d)
                    {
                        var n = (name ?? "").Trim();
                        var ln = n.ToLowerInvariant();

                        string? desc = null;
                        if (ln.EndsWith("id")) desc = "Revit element id (integer).";
                        else if (ln.EndsWith("px") || ln.Contains("xpx") || ln.Contains("ypx")) desc = "Pixels in exported frame image.";
                        else if (ln.EndsWith("inches") || ln.EndsWith("xin") || ln.EndsWith("yin")) desc = "Inches.";
                        else if (ln.EndsWith("ft") || ln.Contains("vector") || ln.Contains("start") || ln.Contains("end") || ln.Contains("from") || ln.Contains("to"))
                        {
                            if (t == typeof(double) || t == typeof(float) || t == typeof(decimal) || Nullable.GetUnderlyingType(t) == typeof(double))
                                desc = "Feet.";
                        }

                        if (!string.IsNullOrWhiteSpace(desc))
                            d["description"] = desc;
                    }
                }
                catch
                {
                    // ignore
                }
                return schema;
            }

            private static object WithRequiredFields(object schema, params string[] requiredFields)
            {
                if (schema is Dictionary<string, object> dictionary)
                {
                    dictionary["required"] = requiredFields ?? Array.Empty<string>();
                }
                return schema;
            }

            private static bool IsListLike(Type t, out Type itemType)
            {
                itemType = typeof(object);
                if (!t.IsGenericType) return false;
                var def = t.GetGenericTypeDefinition();
                if (def == typeof(List<>) || def == typeof(IReadOnlyList<>) || def == typeof(IList<>) || def == typeof(IEnumerable<>))
                {
                    itemType = t.GetGenericArguments()[0];
                    return true;
                }
                return false;
            }

            private static object? SafeGet(PropertyInfo p, object instance)
            {
                try { return p.GetValue(instance); } catch { return null; }
            }

            private static bool IsDefaultValue(Type t, object? v)
            {
                try
                {
                    if (t == typeof(bool)) return (v is bool b) ? b == false : true;
                    if (t == typeof(int)) return (v is int i) ? i == 0 : true;
                    if (t == typeof(long)) return (v is long l) ? l == 0 : true;
                    if (t == typeof(double)) return (v is double d) ? Math.Abs(d) < 1e-12 : true;
                }
                catch { }
                return v == null;
            }

            private static object Obj(Dictionary<string, object> props, string[] required, bool additionalProps = false) =>
                new Dictionary<string, object>
                {
                    { "type", "object" },
                    { "additionalProperties", additionalProps },
                    { "properties", props },
                    { "required", required ?? Array.Empty<string>() }
                };

            private static object Arr(object items, long? minItems = null, long? maxItems = null)
            {
                var schema = new Dictionary<string, object> { { "type", "array" }, { "items", items } };
                if (minItems.HasValue) schema["minItems"] = minItems.Value;
                if (maxItems.HasValue) schema["maxItems"] = maxItems.Value;
                return schema;
            }

            private static object Str(string[]? enumVals = null) =>
                enumVals == null
                    ? new Dictionary<string, object> { { "type", "string" } }
                    : new Dictionary<string, object> { { "type", "string" }, { "enum", enumVals } };

            private static object Bool() => new Dictionary<string, object> { { "type", "boolean" } };
            private static object Int(long? minimum = null, long? maximum = null)
            {
                var schema = new Dictionary<string, object> { { "type", "integer" } };
                if (minimum.HasValue) schema["minimum"] = minimum.Value;
                if (maximum.HasValue) schema["maximum"] = maximum.Value;
                return schema;
            }
            private static object Num() => new Dictionary<string, object> { { "type", "number" } };
            private static object Null() => new Dictionary<string, object> { { "type", "null" } };

            private static object OneOf(params object[] schemas) =>
                new Dictionary<string, object> { { "oneOf", schemas } };
        }
    }
}
