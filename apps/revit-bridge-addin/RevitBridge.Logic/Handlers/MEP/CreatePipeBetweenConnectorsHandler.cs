using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    /// <summary>
    /// Creates one explicit pipe between exactly one open service connector on a
    /// source element and exactly one open service connector on a target element.
    /// This is intentionally narrower than nearest-neighbour routing: callers must
    /// name both owners, the service, pipe type, system type, size, and level.
    /// </summary>
    public sealed class CreatePipeBetweenConnectorsHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long sourceElementId { get; set; }
            public long targetElementId { get; set; }
            public string service { get; set; } = "";
            public string systemType { get; set; } = "";
            public string pipeType { get; set; } = "";
            public string pipeSize { get; set; } = "";
            public string levelName { get; set; } = "";
            public double maximumLengthFt { get; set; } = 5.0;
            public double sizeToleranceFt { get; set; } = 1.0 / 192.0;
            public bool dryRun { get; set; } = true;
            public bool verify { get; set; } = true;
        }

        private sealed class ConnectorCandidate
        {
            public Connector Connector { get; set; } = null!;
            public PipeSystemType Service { get; set; }
            public double DiameterFt { get; set; }
            public string ServiceBasis { get; set; } = "";
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
            if (p.sourceElementId <= 0 || p.targetElementId <= 0 || p.sourceElementId == p.targetElementId)
                throw new InvalidOperationException("sourceElementId and targetElementId must be distinct positive element ids.");
            if (p.maximumLengthFt <= 0 || p.maximumLengthFt > 100)
                throw new InvalidOperationException("maximumLengthFt must be greater than 0 and no more than 100 feet.");
            if (p.sizeToleranceFt < 0 || p.sizeToleranceFt > 0.25)
                throw new InvalidOperationException("sizeToleranceFt must be between 0 and 0.25 feet.");

            var expectedService = ParseService(p.service);
            var source = doc.GetElement(ElementIdCompat.Create(p.sourceElementId))
                ?? throw new InvalidOperationException($"Source element {p.sourceElementId} was not found.");
            var target = doc.GetElement(ElementIdCompat.Create(p.targetElementId))
                ?? throw new InvalidOperationException($"Target element {p.targetElementId} was not found.");
            var sourceCandidates = ServiceConnectors(source, expectedService);
            var targetCandidates = ServiceConnectors(target, expectedService);
            if (sourceCandidates.Count != 1)
                return Task.FromResult<object>(Blocked(p, $"Source element must expose exactly one open {p.service} connector; found {sourceCandidates.Count}.", sourceCandidates, targetCandidates));
            if (targetCandidates.Count != 1)
                return Task.FromResult<object>(Blocked(p, $"Target element must expose exactly one open {p.service} connector; found {targetCandidates.Count}.", sourceCandidates, targetCandidates));

            var sourceConnector = sourceCandidates[0];
            var targetConnector = targetCandidates[0];
            if (sourceConnector.Connector.Shape != ConnectorProfileType.Round || targetConnector.Connector.Shape != ConnectorProfileType.Round)
                return Task.FromResult<object>(Blocked(p, "Pipe connector bridge requires round connectors.", sourceCandidates, targetCandidates));
            if (Math.Abs(sourceConnector.DiameterFt - targetConnector.DiameterFt) > p.sizeToleranceFt)
                return Task.FromResult<object>(Blocked(p, "Source and target connector diameters do not match within sizeToleranceFt.", sourceCandidates, targetCandidates));

            var start = sourceConnector.Connector.Origin;
            var end = targetConnector.Connector.Origin;
            var lengthFt = start.DistanceTo(end);
            if (lengthFt <= 1e-6 || lengthFt > p.maximumLengthFt)
                return Task.FromResult<object>(Blocked(p, $"Connector distance {lengthFt:G6} ft is outside the permitted range (0, {p.maximumLengthFt:G6}].", sourceCandidates, targetCandidates));

            var systemType = MepRoutingUtil.FindSystemType(doc, Required(p.systemType, "systemType"), "pipe");
            var pipeType = MepRoutingUtil.FindPipeType(doc, Required(p.pipeType, "pipeType"));
            var level = MepRoutingUtil.ResolveLevel(doc, null, Required(p.levelName, "levelName"))
                ?? MepRoutingUtil.ResolveLevelFromZ(doc, (start.Z + end.Z) * 0.5);
            var warnings = new List<string>();
            var size = MepRoutingUtil.ChooseSize("pipe", null, p.pipeSize, p.pipeSize, "explicit_required", warnings);
            if (systemType == null || pipeType == null || level == null || size.Missing || !size.DiameterFt.HasValue)
                return Task.FromResult<object>(Blocked(p, "Could not resolve an explicit pipe system, type, level, and parseable size.", sourceCandidates, targetCandidates, warnings));
            if (Math.Abs(size.DiameterFt.Value - sourceConnector.DiameterFt) > p.sizeToleranceFt
                || Math.Abs(size.DiameterFt.Value - targetConnector.DiameterFt) > p.sizeToleranceFt)
                return Task.FromResult<object>(Blocked(p, "Requested pipe size does not match both native connector diameters within sizeToleranceFt.", sourceCandidates, targetCandidates, warnings));

            using (var tx = new Transaction(doc, p.dryRun ? "Create Pipe Between Connectors (Dry Run)" : "Create Pipe Between Connectors"))
            {
                tx.Start();
                try
                {
                    var pipe = Pipe.Create(doc, systemType.Id, pipeType.Id, level.Id, start, end);
                    MepRoutingUtil.TryApplyPipeSize(pipe, size, out var sizeApplied);
                    doc.Regenerate();

                    var pipeAtSource = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(pipe), start, 0.25);
                    var pipeAtTarget = MepRoutingUtil.FindClosestConnector(MepRoutingUtil.GetConnectors(pipe), end, 0.25);
                    if (!MepRoutingUtil.TryConnect(pipeAtSource, sourceConnector.Connector, out var sourceError))
                        throw new InvalidOperationException($"Could not connect created pipe to source element: {sourceError}");
                    if (!MepRoutingUtil.TryConnect(pipeAtTarget, targetConnector.Connector, out var targetError))
                        throw new InvalidOperationException($"Could not connect created pipe to target element: {targetError}");
                    doc.Regenerate();

                    var pipeId = ElementIdCompat.GetValue(pipe.Id);
                    var sourceVerified = IsConnectedTo(sourceConnector.Connector, pipeId);
                    var targetVerified = IsConnectedTo(targetConnector.Connector, pipeId);
                    var openConnectorCount = MepRoutingUtil.CountOpenConnectors(new Element[] { pipe });
                    if (p.verify && (!sourceVerified || !targetVerified || openConnectorCount != 0))
                        throw new InvalidOperationException($"Native verification failed: source={sourceVerified}, target={targetVerified}, openPipeConnectors={openConnectorCount}.");

                    var result = new
                    {
                        schema = "revit-operator.pipe-between-connectors.v1",
                        status = p.dryRun ? "DryRunReady" : "CreatedAndConnected",
                        dryRun = p.dryRun,
                        sourceElementId = p.sourceElementId,
                        targetElementId = p.targetElementId,
                        service = CanonicalService(expectedService),
                        connectorGeometryBasis = "native_runtime_connectors",
                        sourceConnectorServiceBasis = sourceConnector.ServiceBasis,
                        targetConnectorServiceBasis = targetConnector.ServiceBasis,
                        hiddenGeometryInferred = true,
                        start = Point(start),
                        end = Point(end),
                        lengthFt,
                        selected = new
                        {
                            systemTypeId = ElementIdCompat.GetValue(systemType.Id),
                            systemTypeName = systemType.Name,
                            pipeTypeId = ElementIdCompat.GetValue(pipeType.Id),
                            pipeTypeName = pipeType.Name,
                            levelId = ElementIdCompat.GetValue(level.Id),
                            levelName = level.Name,
                            diameterFt = size.DiameterFt
                        },
                        sizeApplied,
                        createdElementIds = p.dryRun ? new List<long>() : new List<long> { pipeId },
                        dryRunElementIds = p.dryRun ? new List<long> { pipeId } : new List<long>(),
                        sourceConnectionVerified = sourceVerified,
                        targetConnectionVerified = targetVerified,
                        openConnectorCount,
                        warnings,
                        rolledBack = p.dryRun
                    };
                    if (p.dryRun) tx.RollBack();
                    else tx.Commit();
                    return Task.FromResult<object>(result);
                }
                catch (Exception ex)
                {
                    try { tx.RollBack(); } catch { }
                    return Task.FromResult<object>(new
                    {
                        schema = "revit-operator.pipe-between-connectors.v1",
                        status = "Blocked",
                        dryRun = p.dryRun,
                        sourceElementId = p.sourceElementId,
                        targetElementId = p.targetElementId,
                        service = CanonicalService(expectedService),
                        error = ex.Message,
                        createdElementIds = new List<long>(),
                        rolledBack = true,
                        warnings
                    });
                }
            }
        }

        private static List<ConnectorCandidate> ServiceConnectors(Element element, PipeSystemType service)
        {
            var all = MepRoutingUtil.GetConnectors(element);
            var ownerServices = all
                .Select(SafePipeSystemType)
                .Where(candidate => candidate != PipeSystemType.UndefinedSystemType)
                .Distinct()
                .ToList();
            var ownerServiceIsUnambiguous = ownerServices.Count == 1 && ownerServices[0] == service;
            return all
                .Where(connector => connector.ConnectorType != ConnectorType.Logical
                    && !MepRoutingUtil.IsPhysicallyConnected(connector)
                    && (SafePipeSystemType(connector) == service
                        || (SafePipeSystemType(connector) == PipeSystemType.UndefinedSystemType && ownerServiceIsUnambiguous)))
                .Select(connector => new ConnectorCandidate
                {
                    Connector = connector,
                    Service = service,
                    DiameterFt = connector.Shape == ConnectorProfileType.Round ? connector.Radius * 2.0 : 0,
                    ServiceBasis = SafePipeSystemType(connector) == service
                        ? "connector_pipe_system_type"
                        : "unambiguous_owner_peer_connector_service"
                })
                .ToList();
        }

        private static PipeSystemType SafePipeSystemType(Connector connector)
        {
            try { return connector.PipeSystemType; }
            catch
            {
                try { return (connector.MEPSystem as PipingSystem)?.SystemType ?? PipeSystemType.UndefinedSystemType; }
                catch { return PipeSystemType.UndefinedSystemType; }
            }
        }

        private static PipeSystemType ParseService(string value)
        {
            switch (Normalize(value))
            {
                case "domesticcoldwater": return PipeSystemType.DomesticColdWater;
                case "domestichotwater": return PipeSystemType.DomesticHotWater;
                case "sanitary": return PipeSystemType.Sanitary;
                case "vent": return PipeSystemType.Vent;
                default: throw new InvalidOperationException("service must be domestic_cold_water, domestic_hot_water, sanitary, or vent.");
            }
        }

        private static string CanonicalService(PipeSystemType service)
        {
            if (service == PipeSystemType.DomesticColdWater) return "domestic_cold_water";
            if (service == PipeSystemType.DomesticHotWater) return "domestic_hot_water";
            if (service == PipeSystemType.Sanitary) return "sanitary";
            if (service == PipeSystemType.Vent) return "vent";
            return service.ToString();
        }

        private static bool IsConnectedTo(Connector connector, long ownerId)
        {
            try
            {
                foreach (Connector reference in connector.AllRefs)
                {
                    if (reference?.Owner == null || reference.Owner is MEPSystem) continue;
                    if (ElementIdCompat.GetValue(reference.Owner.Id) == ownerId) return true;
                }
            }
            catch { }
            return false;
        }

        private static object Blocked(
            Params p,
            string error,
            List<ConnectorCandidate> source,
            List<ConnectorCandidate> target,
            List<string>? warnings = null)
        {
            return new
            {
                schema = "revit-operator.pipe-between-connectors.v1",
                status = "Blocked",
                dryRun = p.dryRun,
                sourceElementId = p.sourceElementId,
                targetElementId = p.targetElementId,
                service = p.service,
                sourceCandidateCount = source.Count,
                targetCandidateCount = target.Count,
                error,
                createdElementIds = new List<long>(),
                rolledBack = true,
                warnings = warnings ?? new List<string>()
            };
        }

        private static string Required(string value, string label)
        {
            var result = (value ?? "").Trim();
            if (result.Length == 0) throw new InvalidOperationException($"{label} is required.");
            return result;
        }

        private static string Normalize(string value)
        {
            return new string((value ?? "").Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
        }

        private static object Point(XYZ point) => new { x = point.X, y = point.Y, z = point.Z };
    }
}
