using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>
    /// Factual, read-only circuit-loading evidence. This handler deliberately does not
    /// claim NEC/AHJ compliance; the evaluator applies a separately sourced profile.
    /// </summary>
    public sealed class ElectricalCircuitLoadingAuditHandler : IRequestHandler
    {
        public sealed class WireAmpacityProfile
        {
            public string wireSizeToken { get; set; } = string.Empty;
            public double ampacityAmps { get; set; }
        }

        public sealed class Params
        {
            public List<long> elementIds { get; set; } = new List<long>();
            public string panelName { get; set; } = string.Empty;
            public List<WireAmpacityProfile> wireAmpacityProfiles { get; set; } = new List<WireAmpacityProfile>();
            public int maxElements { get; set; } = 5000;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var requestedPanelName = (request.panelName ?? string.Empty).Trim();
            var requestedIds = (request.elementIds ?? new List<long>()).Where(id => id > 0).Distinct().OrderBy(id => id).ToList();
            var maximum = request.maxElements <= 0 ? 5000 : Math.Min(request.maxElements, 5000);
            if (requestedIds.Count > 0 && !string.IsNullOrWhiteSpace(requestedPanelName))
                throw new ArgumentException("Provide either panelName or elementIds, not both.");
            if (requestedIds.Count == 0 && string.IsNullOrWhiteSpace(requestedPanelName))
                throw new ArgumentException("panelName or elementIds is required.");
            ValidateProfiles(request.wireAmpacityProfiles);

            var uidoc = app.ActiveUIDocument ?? throw new InvalidOperationException("No active UI document.");
            var document = uidoc.Document;
            if (string.IsNullOrWhiteSpace(document.PathName) || !File.Exists(document.PathName))
                throw new InvalidOperationException("Active document must be saved before circuit evidence can be bound to a model hash.");

            var discoveredFixtures = new FilteredElementCollector(document)
                .OfCategory(BuiltInCategory.OST_ElectricalFixtures)
                .WhereElementIsNotElementType()
                .OfType<FamilyInstance>()
                .ToDictionary(instance => ElementIdCompat.GetValue(instance.Id));
            if (discoveredFixtures.Count > maximum)
                throw new InvalidOperationException($"Discovered electrical fixture inventory exceeds maxElements ({maximum}).");

            var discoveredSystemsByElement = discoveredFixtures.ToDictionary(
                pair => pair.Key,
                pair => GetPowerSystems(pair.Value));
            var discoveredUncircuitedIds = discoveredSystemsByElement
                .Where(pair => pair.Value.Count == 0).Select(pair => pair.Key).OrderBy(id => id).ToList();
            var discoveredAmbiguousIds = discoveredSystemsByElement
                .Where(pair => pair.Value.Count > 1).Select(pair => pair.Key).OrderBy(id => id).ToList();

            var scopedInstances = new Dictionary<long, FamilyInstance>();
            var systems = new Dictionary<long, ElectricalSystem>();
            var systemsByElement = new Dictionary<long, List<long>>();
            var missingIds = new List<long>();
            long? selectedPanelElementId = null;
            var panelInventoryComplete = false;
            if (!string.IsNullOrWhiteSpace(requestedPanelName))
            {
                var panelSystems = discoveredSystemsByElement.Values.SelectMany(value => value)
                    .GroupBy(system => ElementIdCompat.GetValue(system.Id)).Select(group => group.First())
                    .Where(system => string.Equals(SafeString(() => system.PanelName), requestedPanelName, StringComparison.OrdinalIgnoreCase))
                    .OrderBy(system => ElementIdCompat.GetValue(system.Id)).ToList();
                if (panelSystems.Count == 0) throw new InvalidOperationException("circuit_audit_panel_not_found:" + requestedPanelName);
                var panelElementIds = panelSystems.Select(system => SafeElementId(() => system.BaseEquipment?.Id))
                    .Where(id => id.HasValue).Select(id => id!.Value).Distinct().OrderBy(id => id).ToList();
                if (panelElementIds.Count != 1) throw new InvalidOperationException("circuit_audit_panel_identity_ambiguous:" + requestedPanelName);
                selectedPanelElementId = panelElementIds[0];
                foreach (var system in panelSystems) systems[ElementIdCompat.GetValue(system.Id)] = system;
                foreach (var pair in discoveredFixtures)
                {
                    var selectedSystemIds = discoveredSystemsByElement[pair.Key]
                        .Select(system => ElementIdCompat.GetValue(system.Id)).Where(systems.ContainsKey).OrderBy(id => id).ToList();
                    if (selectedSystemIds.Count == 0) continue;
                    scopedInstances[pair.Key] = pair.Value;
                    systemsByElement[pair.Key] = selectedSystemIds;
                }
                requestedIds = scopedInstances.Keys.OrderBy(id => id).ToList();
                var independentlySelectedIds = discoveredSystemsByElement
                    .Where(pair => pair.Value.Any(system => systems.ContainsKey(ElementIdCompat.GetValue(system.Id))))
                    .Select(pair => pair.Key).OrderBy(id => id).ToList();
                panelInventoryComplete = systems.Count == panelSystems.Count
                    && requestedIds.SequenceEqual(independentlySelectedIds)
                    && systems.Values.All(system => string.Equals(SafeString(() => system.PanelName), requestedPanelName, StringComparison.OrdinalIgnoreCase))
                    && systems.Values.All(system => SafeElementId(() => system.BaseEquipment?.Id) == selectedPanelElementId);
                if (!panelInventoryComplete) throw new InvalidOperationException("circuit_audit_panel_inventory_incomplete:" + requestedPanelName);
            }
            else
            {
                if (requestedIds.Count > maximum) throw new ArgumentException($"elementIds exceeds maxElements ({maximum}).");
                foreach (var id in requestedIds)
                {
                    if (!discoveredFixtures.TryGetValue(id, out var instance))
                    {
                        missingIds.Add(id);
                        continue;
                    }
                    scopedInstances[id] = instance;
                    var powerSystems = discoveredSystemsByElement[id];
                    systemsByElement[id] = powerSystems.Select(system => ElementIdCompat.GetValue(system.Id)).OrderBy(systemId => systemId).ToList();
                    foreach (var system in powerSystems) systems[ElementIdCompat.GetValue(system.Id)] = system;
                }
                if (missingIds.Count > 0) throw new InvalidOperationException("circuit_audit_scope_element_invalid:" + string.Join(",", missingIds));
            }

            var circuitRows = systems.OrderBy(pair => pair.Key).Select(pair => BuildCircuitRow(
                pair.Value,
                scopedInstances,
                request.wireAmpacityProfiles ?? new List<WireAmpacityProfile>())).ToList();
            var scopedDevices = scopedInstances.OrderBy(pair => pair.Key).Select(pair => BuildDeviceRow(
                document,
                pair.Key,
                pair.Value,
                systemsByElement.TryGetValue(pair.Key, out var systemIds) ? systemIds : new List<long>())).ToList();

            var uncircuitedIds = systemsByElement.Where(pair => pair.Value.Count == 0).Select(pair => pair.Key).OrderBy(id => id).ToList();
            var ambiguousIds = systemsByElement.Where(pair => pair.Value.Count > 1).Select(pair => pair.Key).OrderBy(id => id).ToList();
            return Task.FromResult<object>(new
            {
                schema = "revit-operator.electrical-circuit-loading-audit.v1",
                modelSha256 = Sha256(document.PathName),
                documentPath = document.PathName,
                scopeMode = string.IsNullOrWhiteSpace(requestedPanelName) ? "explicit_element_ids" : "panel_inventory",
                selectedPanelName = string.IsNullOrWhiteSpace(requestedPanelName) ? null : requestedPanelName,
                selectedPanelElementId,
                scopeElementIds = requestedIds,
                scopedDevices,
                circuits = circuitRows,
                diagnostics = new
                {
                    complete = true,
                    truncated = false,
                    inventoryComplete = panelInventoryComplete,
                    discoveredElectricalFixtureCount = discoveredFixtures.Count,
                    selectedElectricalFixtureCount = requestedIds.Count,
                    selectedPanelSystemCount = string.IsNullOrWhiteSpace(requestedPanelName) ? 0 : systems.Count,
                    scopedElementCount = requestedIds.Count,
                    circuitCount = circuitRows.Count,
                    uncircuitedElementIds = uncircuitedIds,
                    ambiguousPowerSystemElementIds = ambiguousIds,
                    discoveredUncircuitedElementCount = discoveredUncircuitedIds.Count,
                    discoveredAmbiguousPowerSystemElementCount = discoveredAmbiguousIds.Count,
                    limitation = "Factual native membership, rating, voltage, poles, wire-size, and closed-scope load evidence only. Compliance is evaluated separately from an immutable standards profile."
                }
            });
        }

        private static object BuildDeviceRow(Document document, long elementId, FamilyInstance instance, IReadOnlyList<long> powerSystemIds)
        {
            var symbol = document.GetElement(instance.GetTypeId()) as FamilySymbol;
            return new
            {
                elementId,
                sourceScopedId = "host:" + elementId.ToString(CultureInfo.InvariantCulture),
                category = instance.Category?.Name ?? string.Empty,
                builtInCategory = "OST_ElectricalFixtures",
                familyName = symbol?.FamilyName ?? symbol?.Family?.Name ?? string.Empty,
                typeName = symbol?.Name ?? instance.Name ?? string.Empty,
                elementName = instance.Name ?? string.Empty,
                powerSystemIds = powerSystemIds.OrderBy(id => id).ToList()
            };
        }

        private static object BuildCircuitRow(
            ElectricalSystem system,
            IReadOnlyDictionary<long, FamilyInstance> scopedInstances,
            IReadOnlyList<WireAmpacityProfile> wireProfiles)
        {
            var allMemberIds = GetSystemMemberIds(system);
            var scopedMemberIds = allMemberIds.Where(scopedInstances.ContainsKey).Distinct().OrderBy(id => id).ToList();
            var circuitId = ElementIdCompat.GetValue(system.Id);
            var voltage = ReadNumeric(system, "Voltage", SafeDouble(() => system.Voltage));
            var breaker = ReadNumeric(system, "Rating", null);
            var poles = SafeInt(() => system.PolesNumber);
            var wireSize = ReadText(system, "Wire Size");
            if (string.IsNullOrWhiteSpace(wireSize)) wireSize = SafeString(() => system.WireSizeString);
            var matchingProfiles = wireProfiles.Where(profile =>
                !string.IsNullOrWhiteSpace(profile.wireSizeToken)
                && wireSize.IndexOf(profile.wireSizeToken, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
            var conductorAmpacity = matchingProfiles.Count == 1 ? matchingProfiles[0].ampacityAmps : (double?)null;
            var closedScope = allMemberIds.Count > 0
                && allMemberIds.All(scopedInstances.ContainsKey)
                && scopedMemberIds.Count == allMemberIds.Distinct().Count();
            return new
            {
                circuitId = "electrical-system:" + circuitId.ToString(CultureInfo.InvariantCulture),
                nativeSystemElementId = circuitId,
                memberElementIds = scopedMemberIds,
                allNativeMemberElementIds = allMemberIds.OrderBy(id => id).ToList(),
                voltage,
                phaseCount = poles == 3 ? 3 : 1,
                poles,
                breakerAmps = breaker,
                nativeMembershipVerified = scopedMemberIds.Count > 0,
                nativeOcpdVerified = breaker.HasValue && breaker.Value > 0,
                nativeConductorVerified = !string.IsNullOrWhiteSpace(wireSize) && conductorAmpacity.HasValue,
                wireSize,
                conductorAmpacityAmps = conductorAmpacity,
                conductorOcpdCompatibilityVerified = breaker.HasValue && conductorAmpacity.HasValue && breaker.Value <= conductorAmpacity.Value + 1e-9,
                otherContinuousVa = closedScope ? 0.0 : (double?)null,
                otherNoncontinuousVa = closedScope ? 0.0 : (double?)null,
                otherLoadsNativeVerified = closedScope,
                listedFor100PercentContinuousOperation = false,
                continuousRatingNativeVerified = false,
                continuousRatingEvidenceSha256 = (string?)null,
                panelName = SafeString(() => system.PanelName),
                panelElementId = SafeElementId(() => system.BaseEquipment?.Id),
                circuitNumber = SafeString(() => system.CircuitNumber),
                apparentLoad = ReadNumeric(system, "Apparent Load", SafeDouble(() => system.ApparentLoad)),
                loadClassifications = SafeString(() => system.LoadClassifications),
                evidence = new
                {
                    exactSystemMembership = true,
                    allCircuitMembersInsideScope = closedScope,
                    wireProfileMatchCount = matchingProfiles.Count,
                    wireAmpacityProfileRequiredForConductorProof = true
                }
            };
        }

        private static List<ElectricalSystem> GetPowerSystems(FamilyInstance instance)
        {
            try
            {
                return (instance.MEPModel?.GetElectricalSystems() ?? new HashSet<ElectricalSystem>())
                    .Where(system => system != null && system.SystemType == ElectricalSystemType.PowerCircuit)
                    .OrderBy(system => ElementIdCompat.GetValue(system.Id))
                    .ToList();
            }
            catch { return new List<ElectricalSystem>(); }
        }

        private static List<long> GetSystemMemberIds(ElectricalSystem system)
        {
            var ids = new List<long>();
            try
            {
                foreach (Element element in system.Elements)
                {
                    if (element?.Id != null) ids.Add(ElementIdCompat.GetValue(element.Id));
                }
            }
            catch { }
            return ids.Distinct().ToList();
        }

        private static void ValidateProfiles(IEnumerable<WireAmpacityProfile>? profiles)
        {
            var rows = (profiles ?? Enumerable.Empty<WireAmpacityProfile>()).ToList();
            if (rows.Count == 0) throw new ArgumentException("wireAmpacityProfiles is required; native wire-size text alone does not prove conductor ampacity.");
            if (rows.Any(row => string.IsNullOrWhiteSpace(row.wireSizeToken) || double.IsNaN(row.ampacityAmps)
                || double.IsInfinity(row.ampacityAmps) || row.ampacityAmps <= 0))
                throw new ArgumentException("wireAmpacityProfiles contains an invalid token or ampacity.");
            if (rows.GroupBy(row => row.wireSizeToken.Trim(), StringComparer.OrdinalIgnoreCase).Any(group => group.Count() > 1))
                throw new ArgumentException("wireAmpacityProfiles contains duplicate wire-size tokens.");
        }

        private static string ReadText(Element element, string name)
        {
            try { return (element.LookupParameter(name)?.AsString() ?? element.LookupParameter(name)?.AsValueString() ?? string.Empty).Trim(); }
            catch { return string.Empty; }
        }

        private static double? ReadNumeric(Element element, string name, double? fallback)
        {
            try
            {
                var parameter = element.LookupParameter(name);
                var display = parameter?.AsValueString() ?? parameter?.AsString() ?? string.Empty;
                var match = Regex.Match(display, @"[-+]?\d+(?:[\.,]\d+)?");
                if (match.Success && double.TryParse(match.Value.Replace(',', '.'), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)) return parsed;
                if (parameter != null && parameter.StorageType == StorageType.Double)
                {
                    var raw = parameter.AsDouble();
                    if (!double.IsNaN(raw) && !double.IsInfinity(raw) && raw > 0) return raw;
                }
            }
            catch { }
            return fallback.HasValue && !double.IsNaN(fallback.Value) && !double.IsInfinity(fallback.Value) && fallback.Value > 0 ? fallback : null;
        }

        private static string Sha256(string path)
        {
            // Revit keeps an open write-capable handle to the active model. The
            // audit is read-only, so permit the existing application handle while
            // hashing the last-saved bytes that bind this evidence to the model.
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var hash = SHA256.Create())
                return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", string.Empty).ToLowerInvariant();
        }

        private static double? SafeDouble(Func<double> read) { try { var value = read(); return double.IsNaN(value) || double.IsInfinity(value) ? (double?)null : value; } catch { return null; } }
        private static int? SafeInt(Func<int> read) { try { return read(); } catch { return null; } }
        private static string SafeString(Func<string> read) { try { return (read() ?? string.Empty).Trim(); } catch { return string.Empty; } }
        private static long? SafeElementId(Func<ElementId?> read) { try { var id = read(); return id == null || id == ElementId.InvalidElementId ? (long?)null : ElementIdCompat.GetValue(id); } catch { return null; } }
    }
}
