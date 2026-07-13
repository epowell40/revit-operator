using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class MepRouteWorkflowHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string kind { get; set; } = "duct";
            public string? frameId { get; set; }
            public List<MepRoutingUtil.RoutePoint> points { get; set; } = new List<MepRoutingUtil.RoutePoint>();
            public long? viewId { get; set; }
            public string? roomNumber { get; set; }
            public string? levelName { get; set; }
            public long? levelId { get; set; }
            public string? systemType { get; set; }
            public string? ductType { get; set; }
            public string? pipeType { get; set; }
            public string? ductSize { get; set; }
            public string? diameter { get; set; }
            public string? pipeSize { get; set; }
            public List<string>? segmentSizes { get; set; }
            public string? sizePolicy { get; set; } = "use_default_with_warning";
            public string? elevationPolicy { get; set; } = "resolve_context_default";
            public string? routingMode { get; set; } = "polyline";
            public bool connectSegments { get; set; } = true;
            public bool connectToExisting { get; set; } = false;
            public bool requireExistingEndpointConnections { get; set; } = false;
            public double externalConnectionToleranceFt { get; set; } = 0.1;
            public bool verify { get; set; } = true;
            public double? defaultOffsetFt { get; set; }
            public double? ceilingOffsetFt { get; set; }

            public bool apply { get; set; } = false;
            public bool visualVerify { get; set; } = true;
            public long? visualViewId { get; set; }
            public int imageSize { get; set; } = 2200;
            public double focusPaddingFt { get; set; } = 4.0;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();

            var warnings = new List<string>();
            var routeParams = ToCreateParams(p, dryRun: true);
            var contextParams = new ResolveMepRoutingContextHandler.Params
            {
                viewId = p.viewId,
                roomNumber = p.roomNumber,
                levelName = p.levelName,
                levelId = p.levelId,
                systemKind = p.kind,
                routingMode = p.routingMode,
                defaultOffsetFt = p.defaultOffsetFt,
                ceilingOffsetFt = p.ceilingOffsetFt,
                dryRun = true
            };

            var routingContext = Invoke(new ResolveMepRoutingContextHandler(), app, contextParams);
            var dryRun = Invoke(new CreateMepRouteHandler(), app, routeParams);
            var dryRunJson = ToElement(dryRun);
            var dryRunStatus = ReadString(dryRunJson, "status");
            warnings.AddRange(ReadStringArray(dryRunJson, "warnings"));

            if (IsBlocked(dryRunStatus))
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    workflowMode = p.apply ? "applyRequested" : "dryRun",
                    executionOrder = BuildExecutionOrder(applied: false, visualAttempted: false),
                    routingContext,
                    dryRun,
                    applyResult = (object?)null,
                    visualVerification = new
                    {
                        status = "SkippedBlockedDryRun",
                        reason = "The dry-run did not pass, so no model write or visual export was attempted."
                    },
                    warnings = warnings.Distinct().ToList()
                });
            }

            if (!p.apply)
            {
                return Task.FromResult<object>(new
                {
                    status = "DryRunReady",
                    workflowMode = "dryRun",
                    executionOrder = BuildExecutionOrder(applied: false, visualAttempted: false),
                    routingContext,
                    dryRun,
                    applyResult = (object?)null,
                    visualVerification = new
                    {
                        status = "NotAvailableDryRun",
                        reason = "No visual capture was exported because dry-run route elements are rolled back.",
                        nextStep = "Re-run with apply=true to create the route and export a focused post-change capture."
                    },
                    warnings = warnings.Distinct().ToList()
                });
            }

            var applyParams = ToCreateParams(p, dryRun: false);
            var applyResult = Invoke(new CreateMepRouteHandler(), app, applyParams);
            var applyJson = ToElement(applyResult);
            var applyStatus = ReadString(applyJson, "status");
            warnings.AddRange(ReadStringArray(applyJson, "warnings"));
            if (IsBlocked(applyStatus))
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    workflowMode = "apply",
                    executionOrder = BuildExecutionOrder(applied: true, visualAttempted: false),
                    routingContext,
                    dryRun,
                    applyResult,
                    visualVerification = new
                    {
                        status = "SkippedApplyFailed",
                        reason = "The apply call did not create route elements, so no visual export was attempted."
                    },
                    warnings = warnings.Distinct().ToList()
                });
            }

            var createdElementIds = ReadLongArray(applyJson, "createdElementIds");
            var createdFittingIds = ReadLongArray(applyJson, "createdFittingIds");
            var allCreatedIds = createdElementIds.Concat(createdFittingIds).Where(id => id != 0).Distinct().ToList();
            object visualVerification;
            var visualAttempted = false;
            if (p.visualVerify && allCreatedIds.Count > 0)
            {
                visualAttempted = true;
                visualVerification = TryExportVisual(app, p, createdElementIds, createdFittingIds, allCreatedIds, applyJson);
            }
            else
            {
                visualVerification = new
                {
                    status = p.visualVerify ? "SkippedNoCreatedElements" : "SkippedByRequest",
                    reason = p.visualVerify
                        ? "The apply call returned no created element IDs to highlight."
                        : "visualVerify=false was requested."
                };
            }

            var visualStatus = ReadString(ToElement(visualVerification), "status");
            var finalStatus = visualStatus == "CaptureReadyForAIReview"
                ? "AppliedVisualVerificationReady"
                : "AppliedVisualVerificationIncomplete";

            return Task.FromResult<object>(new
            {
                status = finalStatus,
                workflowMode = "apply",
                executionOrder = BuildExecutionOrder(applied: true, visualAttempted),
                routingContext,
                dryRun,
                applyResult,
                visualVerification,
                warnings = warnings.Distinct().ToList()
            });
        }

        private static object TryExportVisual(
            UIApplication app,
            Params p,
            List<long> createdElementIds,
            List<long> createdFittingIds,
            List<long> allCreatedIds,
            JsonElement applyJson)
        {
            try
            {
                var groups = new List<HighlightAndExportHandler.HighlightGroup>();
                if (createdElementIds.Count > 0)
                {
                    groups.Add(new HighlightAndExportHandler.HighlightGroup
                    {
                        name = "route_segments",
                        elementIds = createdElementIds,
                        overrideStyle = new HighlightAndExportHandler.OverrideStyle { lineWeight = 8, r = 0, g = 180, b = 255 }
                    });
                }
                if (createdFittingIds.Count > 0)
                {
                    groups.Add(new HighlightAndExportHandler.HighlightGroup
                    {
                        name = "route_fittings",
                        elementIds = createdFittingIds,
                        overrideStyle = new HighlightAndExportHandler.OverrideStyle { lineWeight = 9, r = 255, g = 140, b = 0 }
                    });
                }

                var captureRequest = new HighlightAndExportHandler.Params
                {
                    viewId = p.visualViewId ?? p.viewId,
                    elementIds = allCreatedIds,
                    imageSize = Math.Max(512, Math.Min(4096, p.imageSize)),
                    focusElementIds = createdElementIds.Count > 0 ? createdElementIds : allCreatedIds,
                    focusPaddingFt = Math.Max(0.5, Math.Min(100.0, p.focusPaddingFt)),
                    highlightGroups = groups.Count > 0 ? groups : null
                };

                var capture = Invoke(new HighlightAndExportHandler(), app, captureRequest);
                var captureJson = ToElement(capture);
                return new
                {
                    status = "CaptureReadyForAIReview",
                    capture,
                    createdElementIds,
                    createdFittingIds,
                    expected = new
                    {
                        orderedPoints = ReadObjectArray(applyJson, "plannedPoints"),
                        segmentCount = ReadInt(applyJson, "segmentCount"),
                        connectionAttempts = ReadObjectArray(applyJson, "connectionAttempts")
                    },
                    aiReviewChecklist = new[]
                    {
                        "Confirm the highlighted route follows the ordered point path.",
                        "Confirm bends/fittings are present at internal route points when connectionAttempts indicate fitting creation.",
                        "Confirm the highlighted route is visible in the intended view and does not obviously run through unintended model context.",
                        "Confirm the final report cites this post-change capture path."
                    },
                    capturePath = ReadString(captureJson, "path")
                };
            }
            catch (Exception ex)
            {
                return new
                {
                    status = "CaptureFailed",
                    error = ex.Message,
                    createdElementIds,
                    createdFittingIds,
                    aiReviewChecklist = new[]
                    {
                        "The route was applied, but focused visual export failed.",
                        "Run /revit/highlight-and-export with createdElementIds and createdFittingIds to complete visual verification."
                    }
                };
            }
        }

        private static CreateMepRouteHandler.Params ToCreateParams(Params p, bool dryRun) => new CreateMepRouteHandler.Params
        {
            kind = p.kind,
            frameId = p.frameId,
            points = p.points ?? new List<MepRoutingUtil.RoutePoint>(),
            viewId = p.viewId,
            roomNumber = p.roomNumber,
            levelName = p.levelName,
            levelId = p.levelId,
            systemType = p.systemType,
            ductType = p.ductType,
            pipeType = p.pipeType,
            ductSize = p.ductSize,
            diameter = p.diameter,
            pipeSize = p.pipeSize,
            segmentSizes = p.segmentSizes,
            sizePolicy = p.sizePolicy,
            elevationPolicy = p.elevationPolicy,
            routingMode = p.routingMode,
            connectSegments = p.connectSegments,
            connectToExisting = p.connectToExisting,
            requireExistingEndpointConnections = p.requireExistingEndpointConnections,
            externalConnectionToleranceFt = p.externalConnectionToleranceFt,
            verify = p.verify,
            dryRun = dryRun,
            defaultOffsetFt = p.defaultOffsetFt,
            ceilingOffsetFt = p.ceilingOffsetFt
        };

        private static object Invoke(IRequestHandler handler, UIApplication app, object payload)
        {
            var json = JsonSerializer.Serialize(payload);
            return handler.Handle(app, json).GetAwaiter().GetResult();
        }

        private static string[] BuildExecutionOrder(bool applied, bool visualAttempted)
        {
            var steps = new List<string>
            {
                "resolve-routing-context",
                "dry-run-create-route"
            };
            if (applied) steps.Add("apply-create-route-in-ordered-point-segments");
            if (visualAttempted) steps.Add("highlight-created-elements-and-export-focused-post-change-image");
            return steps.ToArray();
        }

        private static bool IsBlocked(string status) =>
            status.Equals("Blocked", StringComparison.OrdinalIgnoreCase) ||
            status.Equals("Failed", StringComparison.OrdinalIgnoreCase);

        private static JsonElement ToElement(object value)
        {
            var json = JsonSerializer.Serialize(value);
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.Clone();
        }

        private static string ReadString(JsonElement obj, string name)
        {
            if (obj.ValueKind == JsonValueKind.Object &&
                obj.TryGetProperty(name, out var value) &&
                value.ValueKind == JsonValueKind.String)
            {
                return value.GetString() ?? "";
            }
            return "";
        }

        private static int? ReadInt(JsonElement obj, string name)
        {
            if (obj.ValueKind == JsonValueKind.Object &&
                obj.TryGetProperty(name, out var value) &&
                value.ValueKind == JsonValueKind.Number &&
                value.TryGetInt32(out var result))
            {
                return result;
            }
            return null;
        }

        private static List<long> ReadLongArray(JsonElement obj, string name)
        {
            if (obj.ValueKind != JsonValueKind.Object ||
                !obj.TryGetProperty(name, out var value) ||
                value.ValueKind != JsonValueKind.Array)
            {
                return new List<long>();
            }

            var result = new List<long>();
            foreach (var item in value.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.Number && item.TryGetInt64(out var id))
                    result.Add(id);
            }
            return result;
        }

        private static List<string> ReadStringArray(JsonElement obj, string name)
        {
            if (obj.ValueKind != JsonValueKind.Object ||
                !obj.TryGetProperty(name, out var value) ||
                value.ValueKind != JsonValueKind.Array)
            {
                return new List<string>();
            }

            var result = new List<string>();
            foreach (var item in value.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String)
                {
                    var text = item.GetString();
                    if (!string.IsNullOrWhiteSpace(text)) result.Add(text);
                }
            }
            return result;
        }

        private static List<object> ReadObjectArray(JsonElement obj, string name)
        {
            if (obj.ValueKind != JsonValueKind.Object ||
                !obj.TryGetProperty(name, out var value) ||
                value.ValueKind != JsonValueKind.Array)
            {
                return new List<object>();
            }

            return JsonSerializer.Deserialize<List<object>>(value.GetRawText()) ?? new List<object>();
        }
    }
}
