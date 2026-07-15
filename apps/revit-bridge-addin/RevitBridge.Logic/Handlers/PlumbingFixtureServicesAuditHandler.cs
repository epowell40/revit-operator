using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.MEP;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>
    /// Factual, read-only plumbing fixture connector and vent-continuation evidence.
    /// Engineering requirements remain evaluator-owned and are not encoded here.
    /// </summary>
    public sealed class PlumbingFixtureServicesAuditHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string levelName { get; set; } = string.Empty;
            public List<long> fixtureElementIds { get; set; } = new List<long>();
            public List<string> familyMatchTokens { get; set; } = new List<string>();
            public List<string> typeMatchTokens { get; set; } = new List<string>();
            public int maxElements { get; set; } = 5000;
            public int maxVentSearchElements { get; set; } = 2000;
            public int maxVentSearchHops { get; set; } = 40;
        }

        private sealed class VentTrace
        {
            public bool Found { get; set; }
            public bool Complete { get; set; } = true;
            public bool Truncated { get; set; }
            public List<long> PathElementIds { get; set; } = new List<long>();
            public List<object> PathEdges { get; set; } = new List<object>();
            public List<long> VentSystemElementIds { get; set; } = new List<long>();
            public List<string> VentSystemNames { get; set; } = new List<string>();
            public List<string> PathElementCategories { get; set; } = new List<string>();
            public int VisitedElementCount { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var levelName = (request.levelName ?? string.Empty).Trim();
            var requestedFixtureIds = new HashSet<long>((request.fixtureElementIds ?? new List<long>()).Where(id => id > 0));
            var familyTokens = NormalizeTokens(request.familyMatchTokens);
            var typeTokens = NormalizeTokens(request.typeMatchTokens);
            if (string.IsNullOrWhiteSpace(levelName)) throw new ArgumentException("levelName is required.");
            if (requestedFixtureIds.Count == 0 && familyTokens.Count == 0) throw new ArgumentException("familyMatchTokens is required when fixtureElementIds is empty.");
            if (requestedFixtureIds.Count == 0 && typeTokens.Count == 0) throw new ArgumentException("typeMatchTokens is required when fixtureElementIds is empty.");
            var maximum = request.maxElements <= 0 ? 5000 : Math.Min(request.maxElements, 5000);
            var ventMaximum = request.maxVentSearchElements <= 0 ? 2000 : Math.Min(request.maxVentSearchElements, 10000);
            var ventHops = request.maxVentSearchHops <= 0 ? 40 : Math.Min(request.maxVentSearchHops, 500);

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var document = uidoc.Document;
            if (string.IsNullOrWhiteSpace(document.PathName) || !File.Exists(document.PathName))
                throw new InvalidOperationException("Active document must be saved before plumbing evidence can be bound to a model hash.");

            var discovered = new FilteredElementCollector(document)
                .OfCategory(BuiltInCategory.OST_PlumbingFixtures)
                .WhereElementIsNotElementType()
                .OfType<FamilyInstance>()
                .OrderBy(instance => ElementIdCompat.GetValue(instance.Id))
                .ToList();
            if (discovered.Count > maximum)
                throw new InvalidOperationException($"Discovered plumbing fixture inventory exceeds maxElements ({maximum}).");

            var levelFixtures = discovered.Where(instance => string.Equals(
                GetLevelName(document, instance), levelName, StringComparison.OrdinalIgnoreCase)).ToList();
            var selected = requestedFixtureIds.Count > 0
                ? levelFixtures.Where(instance => requestedFixtureIds.Contains(ElementIdCompat.GetValue(instance.Id))).ToList()
                : levelFixtures.Where(instance =>
                {
                    var symbol = document.GetElement(instance.GetTypeId()) as FamilySymbol;
                    var family = symbol?.FamilyName ?? symbol?.Family?.Name ?? string.Empty;
                    var typeName = symbol?.Name ?? instance.Name ?? string.Empty;
                    return MatchesAny(family, familyTokens) && MatchesAny(typeName, typeTokens);
                }).ToList();
            if (selected.Count == 0) throw new InvalidOperationException("plumbing_audit_scoped_fixtures_missing");
            var missingRequestedFixtureIds = requestedFixtureIds.Except(selected.Select(instance => ElementIdCompat.GetValue(instance.Id))).OrderBy(id => id).ToList();
            if (missingRequestedFixtureIds.Count > 0)
                throw new InvalidOperationException("plumbing_audit_requested_fixtures_missing:" + string.Join(",", missingRequestedFixtureIds));

            var rows = new List<object>();
            var allComplete = true;
            var anyTruncated = false;
            foreach (var fixture in selected)
            {
                var fixtureId = ElementIdCompat.GetValue(fixture.Id);
                var symbol = document.GetElement(fixture.GetTypeId()) as FamilySymbol;
                var connectors = MepSystemUtil.GetConnectors(fixture).Where(connector => connector != null).ToList();
                if (connectors.Count > 64) throw new InvalidOperationException("plumbing_audit_connector_inventory_exceeds_limit:" + fixtureId);
                var connectorRows = new List<object>();
                for (var index = 0; index < connectors.Count; index++)
                {
                    var connector = connectors[index];
                    var pipeSystemType = SafePipeSystemType(connector);
                    var physicalIds = GetPhysicalConnectedOwnerIds(connector, fixture.Id);
                    var system = SafeMepSystem(connector);
                    var systemId = system?.Id == null ? (long?)null : ElementIdCompat.GetValue(system.Id);
                    var ventTrace = pipeSystemType == PipeSystemType.Sanitary
                        ? TraceToVent(document, fixture.Id, physicalIds, ventMaximum, ventHops)
                        : new VentTrace();
                    allComplete = allComplete && ventTrace.Complete;
                    anyTruncated = anyTruncated || ventTrace.Truncated;
                    connectorRows.Add(new
                    {
                        connectorIndex = index,
                        domain = SafeString(() => connector.Domain.ToString()),
                        pipeSystemType = pipeSystemType.ToString(),
                        systemElementId = systemId,
                        systemName = SafeString(() => system?.Name ?? string.Empty),
                        diameterInches = SafeDiameterInches(connector),
                        physicalConnectedElementIds = physicalIds,
                        physicalConnectionCount = physicalIds.Count,
                        isPhysicallyConnected = physicalIds.Count > 0,
                        ventContinuation = new
                        {
                            found = ventTrace.Found,
                            complete = ventTrace.Complete,
                            truncated = ventTrace.Truncated,
                            pathElementIds = ventTrace.PathElementIds,
                            pathEdges = ventTrace.PathEdges,
                            ventSystemElementIds = ventTrace.VentSystemElementIds,
                            ventSystemNames = ventTrace.VentSystemNames,
                            pathElementCategories = ventTrace.PathElementCategories,
                            visitedElementCount = ventTrace.VisitedElementCount
                        }
                    });
                }
                rows.Add(new
                {
                    elementId = fixtureId,
                    sourceScopedId = "host:" + fixtureId.ToString(CultureInfo.InvariantCulture),
                    builtInCategory = "OST_PlumbingFixtures",
                    familyName = symbol?.FamilyName ?? symbol?.Family?.Name ?? string.Empty,
                    typeName = symbol?.Name ?? fixture.Name ?? string.Empty,
                    elementName = fixture.Name ?? string.Empty,
                    levelName = GetLevelName(document, fixture),
                    connectorInventoryComplete = true,
                    connectorCount = connectors.Count,
                    connectors = connectorRows
                });
            }

            return Task.FromResult<object>(new
            {
                schema = "revit-operator.plumbing-fixture-services-audit.v1",
                modelSha256 = Sha256(document.PathName),
                documentPath = document.PathName,
                scopeMode = requestedFixtureIds.Count > 0 ? "exact_fixture_ids" : "level_inventory",
                selectedLevelName = levelName,
                fixtureElementIds = requestedFixtureIds.OrderBy(id => id).ToList(),
                familyMatchTokens = familyTokens,
                typeMatchTokens = typeTokens,
                fixtures = rows,
                diagnostics = new
                {
                    complete = allComplete && !anyTruncated,
                    truncated = anyTruncated,
                    inventoryComplete = true,
                    discoveredPlumbingFixtureCount = discovered.Count,
                    levelPlumbingFixtureCount = levelFixtures.Count,
                    selectedPlumbingFixtureCount = selected.Count,
                    limitation = "Factual native connector, piping-system classification, size, and physical vent-continuation evidence only. Fixture service requirements and size acceptance are evaluated separately from an immutable profile."
                }
            });
        }

        private static VentTrace TraceToVent(Document document, ElementId sourceFixtureId, IReadOnlyList<long> seedIds, int maximum, int maxHops)
        {
            var result = new VentTrace();
            var sourceId = ElementIdCompat.GetValue(sourceFixtureId);
            var visited = new HashSet<long>();
            var queue = new Queue<Tuple<long, List<long>, int>>();
            foreach (var seed in seedIds.Distinct().OrderBy(id => id))
                queue.Enqueue(Tuple.Create(seed, new List<long> { seed }, 0));
            while (queue.Count > 0 && visited.Count < maximum)
            {
                var item = queue.Dequeue();
                var elementId = item.Item1;
                var path = item.Item2;
                var depth = item.Item3;
                if (elementId == sourceId || !visited.Add(elementId)) continue;
                var element = document.GetElement(ElementIdCompat.Create(elementId));
                if (element == null || !IsDrainageTraversalCategory(element)) continue;

                var ventConnectors = MepSystemUtil.GetConnectors(element)
                    .Where(connector => connector != null && SafePipeSystemType(connector) == PipeSystemType.Vent)
                    .ToList();
                // Require at least one continuation beyond the fixture's direct sanitary segment.
                if (depth >= 1 && ventConnectors.Count > 0)
                {
                    result.Found = true;
                    result.PathElementIds = new List<long> { sourceId };
                    result.PathElementIds.AddRange(path);
                    result.PathElementCategories = path.Select(id => document.GetElement(ElementIdCompat.Create(id)))
                        .Where(candidate => candidate != null)
                        .Select(candidate => SelectionUtil.GetCategoryToken(candidate!) ?? candidate!.Category?.Name ?? string.Empty)
                        .Where(category => !string.IsNullOrWhiteSpace(category)).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(category => category).ToList();
                    for (var index = 0; index + 1 < result.PathElementIds.Count; index++)
                        result.PathEdges.Add(new { fromElementId = result.PathElementIds[index], toElementId = result.PathElementIds[index + 1] });
                    result.VentSystemElementIds = ventConnectors.Select(SafeMepSystem)
                        .Where(system => system?.Id != null)
                        .Select(system => ElementIdCompat.GetValue(system!.Id))
                        .Distinct().OrderBy(id => id).ToList();
                    result.VentSystemNames = ventConnectors.Select(connector => SafeString(() => connector.MEPSystem?.Name ?? string.Empty))
                        .Where(name => !string.IsNullOrWhiteSpace(name)).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(name => name).ToList();
                    result.VisitedElementCount = visited.Count;
                    return result;
                }
                if (depth >= maxHops) continue;
                foreach (var nextId in MepSystemUtil.GetConnectedOwnerElementIds(element)
                    .Select(ElementIdCompat.GetValue).Where(id => id > 0 && id != sourceId && !visited.Contains(id)).Distinct().OrderBy(id => id))
                {
                    var nextPath = new List<long>(path) { nextId };
                    queue.Enqueue(Tuple.Create(nextId, nextPath, depth + 1));
                }
            }
            result.VisitedElementCount = visited.Count;
            result.Truncated = queue.Count > 0;
            result.Complete = !result.Truncated;
            return result;
        }

        private static bool IsDrainageTraversalCategory(Element element)
        {
            var categoryId = ElementIdCompat.GetValue(element.Category?.Id);
            return categoryId == (long)(int)BuiltInCategory.OST_PipeCurves
                || categoryId == (long)(int)BuiltInCategory.OST_PipeFitting
                || categoryId == (long)(int)BuiltInCategory.OST_PipeAccessory;
        }

        private static List<long> GetPhysicalConnectedOwnerIds(Connector connector, ElementId sourceId)
        {
            var ids = new HashSet<long>();
            try
            {
                foreach (Connector reference in connector.AllRefs)
                {
                    var owner = reference?.Owner;
                    if (owner?.Id == null || owner.Id == sourceId || owner is MEPSystem) continue;
                    ids.Add(ElementIdCompat.GetValue(owner.Id));
                }
            }
            catch { }
            return ids.Where(id => id > 0).OrderBy(id => id).ToList();
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

        private static MEPSystem? SafeMepSystem(Connector connector)
        {
            try { return connector.MEPSystem; }
            catch { return null; }
        }

        private static double? SafeDiameterInches(Connector connector)
        {
            try
            {
                if (connector.Shape != ConnectorProfileType.Round) return null;
                var value = connector.Radius * 24.0;
                return double.IsNaN(value) || double.IsInfinity(value) || value <= 0 ? (double?)null : value;
            }
            catch { return null; }
        }

        private static string GetLevelName(Document document, FamilyInstance instance)
        {
            try { return document.GetElement(instance.LevelId)?.Name ?? string.Empty; }
            catch { return string.Empty; }
        }

        private static List<string> NormalizeTokens(IEnumerable<string>? values)
        {
            return (values ?? Enumerable.Empty<string>()).Select(value => (value ?? string.Empty).Trim())
                .Where(value => value.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(value => value).ToList();
        }

        private static bool MatchesAny(string value, IEnumerable<string> tokens)
        {
            return tokens.Any(token => (value ?? string.Empty).IndexOf(token, StringComparison.OrdinalIgnoreCase) >= 0);
        }

        private static string Sha256(string path)
        {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var hash = SHA256.Create())
                return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", string.Empty).ToLowerInvariant();
        }

        private static string SafeString(Func<string> read)
        {
            try { return (read() ?? string.Empty).Trim(); }
            catch { return string.Empty; }
        }
    }
}
