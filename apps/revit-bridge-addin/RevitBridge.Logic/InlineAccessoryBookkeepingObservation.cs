using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    // Only used by the existing bounded inline-accessory operation/readback.
    // No IDs, names or caller-supplied exemptions identify internal owners.
    public static class InlineAccessoryBookkeepingObservation
    {
        private static long Id(Element e) => ElementIdCompat.GetValue(e.Id);
        private static object[] Parameters(Element e)
        {
            var ps = e.Parameters.Cast<Parameter>().Take(129).ToArray();
            if (ps.Length > 128) throw new InvalidOperationException("Ancillary parameter bound exceeded.");
            return ParameterValues(ps);
        }
        private static object[] ParameterValues(IEnumerable<Parameter> ps)
        {
            return ps.OrderBy(p => ElementIdCompat.GetValue(p.Id)).Select(p => (object)new {
                id = ElementIdCompat.GetValue(p.Id), storage = p.StorageType.ToString(), readOnly = p.IsReadOnly,
                value = p.StorageType switch {
                    StorageType.Double => p.AsDouble().ToString("R", CultureInfo.InvariantCulture),
                    StorageType.Integer => p.AsInteger().ToString(CultureInfo.InvariantCulture),
                    StorageType.ElementId => ElementIdCompat.GetValue(p.AsElementId()).ToString(CultureInfo.InvariantCulture),
                    StorageType.String => p.AsString(), _ => null }
            }).ToArray();
        }
        private static string[] Schemas(Element e) => e.GetEntitySchemaGuids().Select(x => x.ToString("D")).OrderBy(x => x).ToArray();
        public static object ReadPlacementMetadata(Document doc, long id)
        {
            var e = doc.GetElement(ElementIdCompat.Create(id));
            if (e == null) return new { elementId = id, exists = false };
            var parameters = e.Parameters.Cast<Parameter>().Take(513).ToArray();
            if (parameters.Length > 512) throw new InvalidOperationException("Placement metadata parameter bound exceeded.");
            return new { elementId = Id(e), uniqueId = e.UniqueId, exists = true, className = e.GetType().FullName,
                categoryId = e.Category == null ? (long?)null : ElementIdCompat.GetValue(e.Category.Id),
                typeId = ElementIdCompat.GetValue(e.GetTypeId()), ownerViewId = ElementIdCompat.GetValue(e.OwnerViewId),
                hasLocation = e.Location != null, hasBounds = e.get_BoundingBox(null) != null,
                parameters = ParameterValues(parameters), schemaGuids = Schemas(e), dependentIds = Dependencies(e, 512) };
        }
        public static object[] ReadPlacementParameters(Element owner)
        {
            var parameters = owner.Parameters.Cast<Parameter>().Take(513).ToArray();
            if (parameters.Length > 512) throw new InvalidOperationException("Placement parameter observation bound exceeded.");
            return ParameterValues(parameters);
        }
        private static long[] Dependencies(Element e, int cap, bool retainBoundSentinel = false)
        {
            var ids = e.GetDependentElements(null).Select(ElementIdCompat.GetValue).Take(cap + 1).OrderBy(x => x).ToArray();
            if (ids.Length > cap && !retainBoundSentinel) throw new InvalidOperationException("Ancillary dependency bound exceeded.");
            return ids;
        }
        private static object[] Identities(IEnumerable<Element> elements)
        {
            var rows = elements.Take(5001).ToArray();
            if (rows.Length > 5000) throw new InvalidOperationException("System inventory exceeds bound.");
            return rows.OrderBy(Id).Select(e => (object)new { elementId = Id(e), uniqueId = e.UniqueId }).ToArray();
        }
        public static JsonElement ReadInternalCandidates(Document doc, Action<string>? stage = null, Action<long>? element = null,
            bool retainUnavailableParameterLayout = false, bool classifyUnqualifiedDependencies = false)
        {
            stage?.Invoke("internal_scan");
            var all = new FilteredElementCollector(doc).WhereElementIsNotElementType().Take(InlineAccessoryBookkeeping.CandidateScanLimit + 1).ToArray();
            if (all.Length > InlineAccessoryBookkeeping.CandidateScanLimit) throw new InvalidOperationException("Internal candidate scan exceeds bound.");
            var internals = new List<JsonElement>();
            var unavailableInternals = new List<JsonElement>();
            foreach (var e in all.Where(e => e.GetType() == typeof(Element)))
            {
                element?.Invoke(Id(e));
                stage?.Invoke("internal_category");
                if (e.Category != null) continue;
                stage?.Invoke("internal_type");
                var typeId = ElementIdCompat.GetValue(e.GetTypeId());
                stage?.Invoke("internal_location"); var hasLocation = e.Location != null;
                stage?.Invoke("internal_bounds"); var hasBounds = e.get_BoundingBox(null) != null;
                stage?.Invoke("internal_schema"); var schemas = Schemas(e);
                var profile = JsonSerializer.SerializeToElement(new { elementId = Id(e), uniqueId = e.UniqueId,
                    className = e.GetType().FullName, categoryId = (long?)null, typeId, hasLocation, hasBounds,
                    schemaGuids = schemas });
                Parameter[] parameterLayout = Array.Empty<Parameter>();
                var row = InlineAccessoryBookkeeping.ObserveInternalCandidate(profile, () => {
                    stage?.Invoke("internal_parameter_layout");
                    // Six is an exclusion sentinel: only the existing exact
                    // five-field layout can ever qualify. No value is read here.
                    parameterLayout = e.Parameters.Cast<Parameter>().Take(6).OrderBy(p => ElementIdCompat.GetValue(p.Id)).ToArray();
                    return JsonSerializer.SerializeToElement(parameterLayout.Select(p => new {
                        id = ElementIdCompat.GetValue(p.Id), storage = p.StorageType.ToString(), readOnly = p.IsReadOnly }));
                }, () => {
                    stage?.Invoke("internal_parameter_values");
                    return JsonSerializer.SerializeToElement(ParameterValues(parameterLayout));
                }, () => {
                    stage?.Invoke("internal_dependencies");
                    return Dependencies(e, 64, retainBoundSentinel: true);
                }, retainUnavailableLayout: retainUnavailableParameterLayout);
                if (row.HasValue)
                {
                    if (row.Value.TryGetProperty("dependencyObservation", out _) || row.Value.TryGetProperty("parameterObservation", out _)) unavailableInternals.Add(row.Value);
                    else internals.Add(row.Value);
                }
            }
            element?.Invoke(-1); // A cohort-level failure has no causal element ID.
            stage?.Invoke("bookkeeping_validation");
            // Document inventory uses the existing scan and byte budgets.
            // Legacy transition capacity is enforced by its separate consumer.
            if (internals.Count + unavailableInternals.Count > InlineAccessoryBookkeeping.CandidateScanLimit)
                throw new InvalidOperationException("Internal candidate cohort exceeds bound.");
            var observation = JsonSerializer.SerializeToElement(new { schema = InlineAccessoryBookkeeping.Schema, complete = true,
                scope = "public_semantic_projection_not_hidden_state", candidateScanComplete = true,
                internals = internals.OrderBy(r => r.GetProperty("elementId").GetInt64()).ToArray(),
                unavailableInternals = unavailableInternals.OrderBy(r => r.GetProperty("elementId").GetInt64()).ToArray() });
            stage?.Invoke("bookkeeping_size");
            if (System.Text.Encoding.UTF8.GetByteCount(observation.GetRawText()) > InlineAccessoryBookkeeping.ObservationByteLimit)
                throw new InvalidOperationException("Internal observation exceeds bound.");
            stage?.Invoke("bookkeeping_validation");
            if (classifyUnqualifiedDependencies) observation = InlineAccessoryBookkeeping.ClassifyInternalCandidates(observation);
            InlineAccessoryBookkeeping.ValidateInternalCandidates(observation, (failureStage, failureId) => {
                stage?.Invoke(failureStage); element?.Invoke(failureId ?? -1);
            });
            return observation;
        }
        public static JsonElement Read(Document doc, Element[] physical, Action<string>? stage = null)
        {
            var candidates = ReadInternalCandidates(doc, stage);
            var centers = ReadCenterlines(doc, physical, stage);
            var system = ReadSystem(doc, physical, stage);
            var observation = JsonSerializer.SerializeToElement(new { schema = InlineAccessoryBookkeeping.Schema, complete = true,
                scope = "public_semantic_projection_not_hidden_state", candidateScanComplete = true,
                internals = candidates.GetProperty("internals"), unavailableInternals = candidates.GetProperty("unavailableInternals"),
                centerlines = centers, system });
            stage?.Invoke("bookkeeping_size");
            if (observation.GetRawText().Length > 1048576) throw new InvalidOperationException("Ancillary observation exceeds bound.");
            stage?.Invoke("bookkeeping_validation"); InlineAccessoryBookkeeping.Validate(observation);
            return observation;
        }

        public static JsonElement ReadSystem(Document doc, Element[] physical, Action<string>? stage = null)
        {
            stage?.Invoke("system_identity");
            var systems = physical.OfType<MEPCurve>().Select(e => e.MEPSystem).Where(e => e != null).GroupBy(e => Id(e)).Select(g => g.First()).ToArray();
            if (systems.Length != 1 || systems[0] is not MechanicalSystem system) throw new InvalidOperationException("One current mechanical system is required.");
            var type = doc.GetElement(system.GetTypeId()) ?? throw new InvalidOperationException("Missing system type.");
            stage?.Invoke("system_parameters"); var systemParameters = InlineAccessoryObservation.WritableParameters(system);
            var systemTypeParameters = InlineAccessoryObservation.WritableParameters(type);
            stage?.Invoke("system_members"); var members = Identities(system.Elements.Cast<Element>());
            stage?.Invoke("system_network"); var network = Identities(system.DuctNetwork.Cast<Element>());
            return JsonSerializer.SerializeToElement(new { elementId = Id(system), uniqueId = system.UniqueId, className = system.GetType().FullName,
                typeId = Id(type), typeUniqueId = type.UniqueId, parameters = systemParameters,
                typeParameters = systemTypeParameters, members, network });
        }

        // Reuse the same native dependency reader without starting an unrelated
        // full-document internal/system scan. This is observation, not exemption.
        public static JsonElement ReadCenterlines(Document doc, Element[] physical, Action<string>? stage = null)
        {
            if (physical.Length > 8 || physical.Select(Id).Distinct().Count() != physical.Length)
                throw new InvalidOperationException("Centerline parent scope exceeds bound or repeats an identity.");
            var centers = new List<object>(); var seen = new HashSet<long>();
            foreach (var parent in physical.OrderBy(Id))
            {
                stage?.Invoke("centerline_dependencies");
                foreach (var id in Dependencies(parent, 512))
                {
                    var e = doc.GetElement(ElementIdCompat.Create(id)) ?? throw new InvalidOperationException("Missing logical dependent.");
                    var category = e.Category == null ? 0 : ElementIdCompat.GetValue(e.Category.Id);
                    if (!InlineAccessoryBookkeeping.IsCenterlineCategory(category)) continue;
                    // Flex centerlines are native dependent elements, not the
                    // FlexDuct itself. Never derive ownership from adjacent IDs.
                    if (category == -2008021 && !(parent is FlexDuct))
                        throw new InvalidOperationException("Flex centerline has a non-FlexDuct parent.");
                    if (!seen.Add(id) || centers.Count >= 10) throw new InvalidOperationException("Centerline parent binding ambiguous or exceeds bound.");
                    stage?.Invoke("centerline_parameters");
                    centers.Add(new { elementId = id, uniqueId = e.UniqueId, className = e.GetType().FullName,
                        categoryId = category, parentId = Id(parent), parentUniqueId = parent.UniqueId,
                        schemaGuids = Schemas(e), parameters = Parameters(e), parentParameters = Parameters(parent) });
                }
            }
            var result = JsonSerializer.SerializeToElement(centers.OrderBy(r => JsonSerializer.SerializeToElement(r).GetProperty("elementId").GetInt64()).ToArray());
            InlineAccessoryBookkeeping.ValidateCenterlines(result);
            return result;
        }
    }
}
