using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.Core;

namespace RevitBridge.Logic.Handlers.MEP
{
    public sealed class ResizeDuctsInRoomHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string roomNumber { get; set; } = "";
            public string roomMode { get; set; } = "geometry"; // auto | geometry | roomAware
            public string verticalScope { get; set; } = "plenum"; // room | plenum | auto | room+plenum
            public string? plenumTopLevelName { get; set; } // optional override when verticalScope=plenum
            public string? systemClassification { get; set; } // Supply|Return|Exhaust|Any
            public string? sizeFrom { get; set; } // e.g. 8"
            public string sizeTo { get; set; } = ""; // e.g. 10"
            public bool includeFittings { get; set; } = true;
            public bool includeTerminals { get; set; } = true;
            public bool includeEquipment { get; set; } = true;
            public bool stopAtBranchFittings { get; set; } = true;
            public string resolveTypeDriven { get; set; } = "auto"; // auto | duplicate | skip
            public bool eliminateTransitions { get; set; } = false;
            public bool verify { get; set; } = false;
            public bool dryRun { get; set; } = true;
            public string? confirm { get; set; }
            public int? maxElements { get; set; } = 5000;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var roomNumber = (p.roomNumber ?? "").Trim();
            if (roomNumber.Length == 0) throw new ArgumentException("roomNumber is required.");
            var sizeTo = (p.sizeTo ?? "").Trim();
            if (sizeTo.Length == 0) throw new ArgumentException("sizeTo is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var resolved = SpatialElementResolver.ResolveByNumber(doc, roomNumber);
            if (resolved.Element == null) throw new InvalidOperationException($"Room/Space '{roomNumber}' not found.");

            var verticalScope = (p.verticalScope ?? "plenum").Trim();
            if (verticalScope.Length == 0) verticalScope = "plenum";
            if (!verticalScope.Equals("room", StringComparison.OrdinalIgnoreCase) &&
                !verticalScope.Equals("plenum", StringComparison.OrdinalIgnoreCase) &&
                !verticalScope.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                !verticalScope.Equals("room+plenum", StringComparison.OrdinalIgnoreCase))
            {
                throw new ArgumentException("verticalScope must be one of: room | plenum | auto | room+plenum.");
            }

            var scopeOrder = verticalScope.Equals("auto", StringComparison.OrdinalIgnoreCase) || verticalScope.Equals("room+plenum", StringComparison.OrdinalIgnoreCase)
                ? new[] { "room", "plenum" }
                : new[] { verticalScope.ToLowerInvariant() };
            var stopAfterFirstScopeHit = verticalScope.Equals("auto", StringComparison.OrdinalIgnoreCase);

            var roomMode = (p.roomMode ?? "geometry").Trim();
            if (roomMode.Length == 0) roomMode = "geometry";
            string[] roomModeOrder;
            if (roomMode.Equals("auto", StringComparison.OrdinalIgnoreCase))
            {
                roomModeOrder = new[] { "roomAware", "geometry" };
            }
            else if (roomMode.Equals("roomAware", StringComparison.OrdinalIgnoreCase) || roomMode.Equals("geometry", StringComparison.OrdinalIgnoreCase))
            {
                roomModeOrder = new[] { roomMode.ToLowerInvariant() };
            }
            else
            {
                throw new ArgumentException("roomMode must be one of: auto | geometry | roomAware.");
            }

            var attemptDetails = new System.Collections.Generic.List<object>();
            var usedVerticalScopes = new System.Collections.Generic.List<string>();
            string? usedPlenumTopLevelName = null;
            var matchedCount = 0;
            var matchedAny = false;

            foreach (var attempt in scopeOrder)
            {
                var needsPlenum = attempt.Equals("plenum", StringComparison.OrdinalIgnoreCase);
                var plenumTopLevelName = needsPlenum
                    ? ((p.plenumTopLevelName ?? "").Trim().Length > 0 ? (p.plenumTopLevelName ?? "").Trim() : ResolvePlenumTopLevelName(doc, resolved.Element))
                    : null;
                if (needsPlenum && string.IsNullOrWhiteSpace(plenumTopLevelName))
                    throw new InvalidOperationException($"Could not infer plenum top level for {resolved.SpatialKind} '{roomNumber}'.");

                var scopeMatched = false;
                foreach (var modeAttempt in roomModeOrder)
                {
                    var req = new ResizeDuctsByScopeHandler.Params
                    {
                        scope = new ResizeDuctsByScopeHandler.ScopeSpec
                        {
                            type = "room",
                            roomNumber = roomNumber,
                            plenumTopLevelName = plenumTopLevelName
                        },
                        systemClassification = p.systemClassification,
                        fromDiameter = p.sizeFrom,
                        toDiameter = sizeTo,
                        includeFittings = p.includeFittings,
                        includeTerminals = p.includeTerminals,
                        includeEquipment = p.includeEquipment,
                        scopeMode = modeAttempt.Equals("geometry", StringComparison.OrdinalIgnoreCase) ? "bboxIntersect" : "connectedRun",
                        roomMode = modeAttempt,
                        verticalScope = attempt,
                        stopAtBranchFittings = p.stopAtBranchFittings,
                        stopAtTransitions = !p.eliminateTransitions,
                        resolveTypeDriven = p.resolveTypeDriven,
                        eliminateTransitions = p.eliminateTransitions,
                        verify = p.verify,
                        dryRun = p.dryRun,
                        confirm = p.confirm,
                        maxElements = p.maxElements
                    };

                    var attemptResult = new ResizeDuctsByScopeHandler().Handle(app, JsonSerializer.Serialize(req)).GetAwaiter().GetResult();
                    var attemptMatched = ReadMatchedCount(attemptResult);
                    matchedCount += attemptMatched;
                    usedPlenumTopLevelName = plenumTopLevelName;
                    attemptDetails.Add(new
                    {
                        verticalScope = attempt,
                        roomMode = modeAttempt,
                        matchedCount = attemptMatched,
                        result = attemptResult
                    });

                    if (attemptMatched > 0)
                    {
                        scopeMatched = true;
                        matchedAny = true;
                        break;
                    }
                }

                if (scopeMatched) usedVerticalScopes.Add(attempt);
                if (stopAfterFirstScopeHit && matchedAny) break;
            }

            return Task.FromResult<object>(new
            {
                endpoint = "/revit/resize-ducts-in-room",
                status = p.dryRun ? "Dry Run" : "Applied",
                room = new
                {
                    query = roomNumber,
                    resolvedId = RevitBridge.Common.ElementIdCompat.GetValue(resolved.Element.Id),
                    resolvedType = resolved.SpatialKind,
                    resolvedNumber = resolved.Number,
                    confidence = resolved.Confidence,
                    matchMode = resolved.MatchMode
                },
                roomMode = roomMode.Equals("auto", StringComparison.OrdinalIgnoreCase) ? "auto" : roomModeOrder.First(),
                roomModeOrder,
                requestedVerticalScope = verticalScope,
                usedVerticalScopes,
                plenumTopLevelName = usedPlenumTopLevelName,
                matchedCount,
                result = attemptDetails.Count == 1 ? attemptDetails[0] : attemptDetails
            });
        }

        private static int ReadMatchedCount(object? payload)
        {
            if (payload == null) return 0;
            try
            {
                using var doc = JsonDocument.Parse(JsonSerializer.Serialize(payload));
                if (doc.RootElement.TryGetProperty("counts", out var c) &&
                    c.ValueKind == JsonValueKind.Object &&
                    c.TryGetProperty("matchedCount", out var m) &&
                    m.ValueKind == JsonValueKind.Number &&
                    m.TryGetInt32(out var count))
                {
                    return Math.Max(0, count);
                }
            }
            catch
            {
                // ignore
            }
            return 0;
        }

        private static string? ResolvePlenumTopLevelName(Document doc, SpatialElement spatial)
        {
            if (doc == null || spatial == null) return null;
            var baseLevel = doc.GetElement(spatial.LevelId) as Level;
            if (baseLevel == null) return null;

            var next = new FilteredElementCollector(doc)
                .OfClass(typeof(Level))
                .Cast<Level>()
                .Where(l => l != null && l.Elevation > baseLevel.Elevation + 1e-6)
                .OrderBy(l => l.Elevation)
                .FirstOrDefault();

            return (next ?? baseLevel).Name;
        }
    }
}
