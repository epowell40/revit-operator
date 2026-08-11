using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    /// <summary>
    /// Read-only Revit projection for observation-core/v1. This adapter is registered only by
    /// the exact development/laboratory runtime boundary, is not a production capability, and
    /// never opens a transaction.
    /// </summary>
    internal static class DynamicObservationRevitAdapterV1
    {
        internal static DynamicObservationEnvelopeV1 Observe(Document document, DynamicObservationSelectorV1 selector)
        {
            if (document == null) throw new ArgumentNullException(nameof(document));
            DynamicObservationPolicyV1.ValidateSelector(selector);
            var requestedElements = new HashSet<string>(selector.ElementUniqueIds, StringComparer.Ordinal);
            var requestedCategories = new HashSet<string>(selector.CategoryStableIds, StringComparer.Ordinal);
            var requestedViews = new HashSet<long>(selector.OwnerViewElementIds);

            IEnumerable<Element> candidates;
            if (requestedElements.Count > 0)
            {
                candidates = requestedElements.OrderBy(value => value, StringComparer.Ordinal)
                    .Select(value => Safe(() => document.GetElement(value))).Where(value => value != null).Cast<Element>();
            }
            else if (selector.VisibleInViewElementId is long visibleViewId)
            {
                candidates = new FilteredElementCollector(document, ElementIdCompat.Create(visibleViewId)).WhereElementIsNotElementType().Cast<Element>();
            }
            else
            {
                candidates = new FilteredElementCollector(document).WhereElementIsNotElementType().Cast<Element>();
            }

            var bounded = candidates.Where(element =>
                    (requestedCategories.Count == 0 || requestedCategories.Contains(CategoryReference(element.Category)?.StableId ?? "")) &&
                    (requestedViews.Count == 0 || requestedViews.Contains(Id(Safe(() => element.OwnerViewId)))))
                .Take(DynamicObservationContractV1.MaximumObservedElements + 1).ToArray();
            if (bounded.Length > DynamicObservationContractV1.MaximumObservedElements)
                throw new InvalidOperationException("Dynamic observation scope exceeds the bounded element count; provide narrower element, category, or owner-view selectors.");

            // Quantize every floating fact before hashing and transport. The SDK canonical then
            // uses a coarser guarded bit identity, so net48/net8 formatter differences and an
            // adjacent parse result cannot change the authenticated observation envelope.
            var observed = bounded.Select(element => NormalizeTransport(Project(document, element, selector)))
                .Select(TransportClone).ToArray();
            return DynamicObservationPolicyV1.BuildPage(selector, DynamicRuntimeSnapshotHandler.Fingerprint(document),
                DynamicRuntimeSnapshotHandler.Session(document), observed);
        }

        private static DynamicObservedElementV1 TransportClone(DynamicObservedElementV1 value) =>
            JsonSerializer.Deserialize<DynamicObservedElementV1>(JsonSerializer.Serialize(value, DynamicRuntimeV1Wire.Camel), DynamicRuntimeV1Wire.Camel)
            ?? throw new InvalidOperationException("Dynamic observation transport normalization failed.");

        private static DynamicObservedElementV1 NormalizeTransport(DynamicObservedElementV1 value)
        {
            Normalize(value.PointLocation);
            value.PointRotationRadians = DynamicObservationPolicyV1.NormalizeTransportDouble(value.PointRotationRadians);
            if (value.CurveLocation != null) { Normalize(value.CurveLocation.Start); Normalize(value.CurveLocation.End); }
            if (value.BoundingBox != null) { Normalize(value.BoundingBox.Min); Normalize(value.BoundingBox.Max); Normalize(value.BoundingBox.Transform); }
            Normalize(value.Transform);
            foreach (var parameter in value.Parameters ?? Array.Empty<DynamicParameterValueV1>())
                parameter.RawDouble = DynamicObservationPolicyV1.NormalizeTransportDouble(parameter.RawDouble);
            return value;
        }

        private static void Normalize(DynamicTransformV1? value)
        {
            if (value == null) return;
            Normalize(value.Origin); Normalize(value.BasisX); Normalize(value.BasisY); Normalize(value.BasisZ);
        }

        private static void Normalize(DynamicPointV1? value)
        {
            if (value == null) return;
            value.X = DynamicObservationPolicyV1.NormalizeTransportDouble(value.X)!.Value;
            value.Y = DynamicObservationPolicyV1.NormalizeTransportDouble(value.Y)!.Value;
            value.Z = DynamicObservationPolicyV1.NormalizeTransportDouble(value.Z)!.Value;
        }

        private static DynamicObservedElementV1 Project(Document document, Element element, DynamicObservationSelectorV1 selector)
        {
            var type = Element(document, Safe(() => element.GetTypeId()));
            var family = Family(document, element, type);
            var instance = element as FamilyInstance;
            var point = element.Location as LocationPoint;
            var curve = element.Location as LocationCurve;
            var result = new DynamicObservedElementV1
            {
                Element = ElementReference(element, "element"),
                Category = CategoryReference(element.Category),
                Family = family == null ? null : ElementReference(family, "family"),
                Type = type == null ? null : ElementReference(type, "type"),
                Host = instance?.Host == null ? null : ElementReference(instance.Host, "host"),
                OwnerView = ElementReference(document, Safe(() => element.OwnerViewId), "owner_view"),
                Level = LevelReference(document, element),
                Workset = WorksetReference(document, element),
                CreatedPhase = PhaseReference(document, element, BuiltInParameter.PHASE_CREATED),
                DemolishedPhase = PhaseReference(document, element, BuiltInParameter.PHASE_DEMOLISHED),
                PointLocation = point == null ? null : Point(Safe(() => point.Point)),
                PointRotationRadians = point == null ? null : SafeNullable(() => point.Rotation),
                CurveLocation = Curve(curve),
                BoundingBox = Box(Safe(() => element.get_BoundingBox(null))),
                Transform = InstanceTransform(element),
                IsPinned = Safe(() => element.Pinned),
                IsGrouped = Id(Safe(() => element.GroupId)) >= 0,
                CoreStateHash = DynamicCoreOperationHostV1.CoreTrustedElementStateHash(element),
                Parameters = Parameters(element, type, selector)
            };
            DynamicObservationPolicyV1.ValidateElement(result);
            return result;
        }

        private static IReadOnlyList<DynamicParameterValueV1> Parameters(Element instance, Element? type, DynamicObservationSelectorV1 selector)
        {
            if (selector.ParameterNames.Length == 0) return Array.Empty<DynamicParameterValueV1>();
            var names = new HashSet<string>(selector.ParameterNames, StringComparer.Ordinal);
            var values = ReadParameters(instance, names, "instance").ToList();
            if (selector.IncludeTypeParameters && type != null) values.AddRange(ReadParameters(type, names, "type"));
            return values.OrderBy(value => value.Scope, StringComparer.Ordinal).ThenBy(value => value.Identity, StringComparer.Ordinal).ToArray();
        }

        private static IEnumerable<DynamicParameterValueV1> ReadParameters(Element element, HashSet<string> names, string scope)
        {
            var values = new List<DynamicParameterValueV1>();
            try
            {
                foreach (Parameter parameter in element.Parameters)
                {
                    var name = Safe(() => parameter.Definition?.Name);
                    if (name == null || !names.Contains(name)) continue;
                    values.Add(Parameter(parameter, name, scope));
                    if (values.Count > DynamicObservationContractV1.MaximumParametersPerElement)
                        throw new InvalidOperationException("Dynamic parameter selection exceeds the per-element bound.");
                }
            }
            catch (InvalidOperationException) { throw; }
            catch { }
            return values;
        }

        private static DynamicParameterValueV1 Parameter(Parameter parameter, string name, string scope)
        {
            var storage = parameter.StorageType;
            var hasValue = Safe(() => parameter.HasValue) && storage != StorageType.None;
            var result = new DynamicParameterValueV1
            {
                Identity = ParameterIdentity(parameter, name),
                Name = name,
                StorageKind = storage == StorageType.String ? "string" : storage == StorageType.Integer ? "integer" :
                    storage == StorageType.Double ? "double" : storage == StorageType.ElementId ? "element_id" : "none",
                HasValue = hasValue,
                FormattedValue = Safe(() => parameter.AsValueString()),
                SpecTypeId = Safe(() => parameter.Definition?.GetDataType()?.TypeId),
                UnitTypeId = Safe(() => parameter.GetUnitTypeId()?.TypeId),
                Scope = scope,
                Writable = storage != StorageType.None && Safe(() => !parameter.IsReadOnly)
            };
            if (hasValue)
            {
                if (storage == StorageType.String) result.RawString = Safe(() => parameter.AsString()) ?? "";
                else if (storage == StorageType.Integer) result.RawInteger = SafeNullable(() => (long)parameter.AsInteger());
                else if (storage == StorageType.Double) result.RawDouble = SafeNullable(() => parameter.AsDouble());
                else if (storage == StorageType.ElementId) result.RawElementId = SafeNullable(() => Id(parameter.AsElementId()));
            }
            return result;
        }

        private static string ParameterIdentity(Parameter parameter, string name)
        {
            try { if (parameter.IsShared) return "parameter:shared:" + parameter.GUID.ToString("D").ToLowerInvariant(); } catch { }
            try
            {
                if (parameter.Definition is InternalDefinition definition)
                {
                    var builtIn = definition.BuiltInParameter;
                    if (builtIn != BuiltInParameter.INVALID) return "parameter:builtin:" + ((int)builtIn).ToString(CultureInfo.InvariantCulture);
                    var definitionId = Id(definition.Id);
                    if (definitionId >= 0) return "parameter:definition:" + definitionId.ToString(CultureInfo.InvariantCulture);
                }
            }
            catch { }
            var spec = Safe(() => parameter.Definition?.GetDataType()?.TypeId) ?? "none";
            return "parameter:name:" + name + ":" + spec;
        }

        private static DynamicStableReferenceV1? CategoryReference(Category? category)
        {
            if (category == null) return null;
            var id = Id(Safe(() => category.Id));
            string? builtInName = null;
            if (id < 0 && id >= int.MinValue) builtInName = Enum.GetName(typeof(BuiltInCategory), (int)id);
            return new DynamicStableReferenceV1
            {
                Kind = "category",
                StableId = builtInName == null ? "category:element:" + id.ToString(CultureInfo.InvariantCulture) : "category:builtin:" + builtInName,
                ElementId = id,
                Name = Optional(Safe(() => category.Name))
            };
        }

        private static DynamicStableReferenceV1 ElementReference(Element element, string kind)
        {
            var uniqueId = Safe(() => element.UniqueId) ?? throw new InvalidOperationException("Observed Revit element has no stable unique id.");
            return new DynamicStableReferenceV1
            {
                Kind = kind,
                StableId = "revit-element:" + uniqueId,
                UniqueId = uniqueId,
                ElementId = Id(element.Id),
                Name = Optional(Safe(() => element.Name))
            };
        }

        private static DynamicStableReferenceV1? ElementReference(Document document, ElementId? id, string kind)
        {
            var element = Element(document, id);
            return element == null ? null : ElementReference(element, kind);
        }

        private static DynamicStableReferenceV1? LevelReference(Document document, Element element)
        {
            var level = Element(document, Safe(() => element.LevelId));
            if (level == null)
            {
                foreach (var builtIn in new[] { BuiltInParameter.FAMILY_LEVEL_PARAM, BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM, BuiltInParameter.INSTANCE_SCHEDULE_ONLY_LEVEL_PARAM })
                {
                    var id = Safe(() => element.get_Parameter(builtIn)?.AsElementId());
                    level = Element(document, id);
                    if (level != null) break;
                }
            }
            return level == null ? null : ElementReference(level, "level");
        }

        private static DynamicStableReferenceV1? WorksetReference(Document document, Element element)
        {
            try
            {
                var workset = document.GetWorksetTable().GetWorkset(element.WorksetId);
                if (workset == null) return null;
                var id = WorksetIdValue(workset.Id);
                return id < 0 ? null : new DynamicStableReferenceV1 { Kind = "workset", StableId = "workset:" + id.ToString(CultureInfo.InvariantCulture), ElementId = id, Name = Optional(workset.Name) };
            }
            catch { return null; }
        }

        private static DynamicStableReferenceV1? PhaseReference(Document document, Element element, BuiltInParameter builtIn)
        {
            var phaseId = Safe(() => element.get_Parameter(builtIn)?.AsElementId());
            var phase = Element(document, phaseId);
            return phase == null ? null : ElementReference(phase, "phase");
        }

        private static Element? Family(Document document, Element element, Element? type)
        {
            if (element is FamilyInstance instance) return Safe(() => instance.Symbol?.Family);
            if (element is FamilySymbol symbol) return Safe(() => symbol.Family);
            if (type is FamilySymbol typeSymbol) return Safe(() => typeSymbol.Family);
            return null;
        }

        private static DynamicCurveLocationV1? Curve(LocationCurve? location)
        {
            var curve = location == null ? null : Safe(() => location.Curve);
            if (curve == null || !Safe(() => curve.IsBound)) return null;
            var start = Point(Safe(() => curve.GetEndPoint(0)));
            var end = Point(Safe(() => curve.GetEndPoint(1)));
            return start == null || end == null ? null : new DynamicCurveLocationV1 { CurveKind = curve.GetType().Name, Start = start, End = end };
        }

        private static DynamicBoxV1? Box(BoundingBoxXYZ? box)
        {
            if (box == null) return null;
            var min = Point(Safe(() => box.Min)); var max = Point(Safe(() => box.Max));
            if (min == null || max == null) return null;
            return new DynamicBoxV1 { Min = min, Max = max, Transform = Transform(Safe(() => box.Transform)) };
        }

        private static DynamicTransformV1? InstanceTransform(Element element)
        {
            if (element is RevitLinkInstance link)
            {
                var total = Safe(() => link.GetTotalTransform()) ?? Safe(() => link.GetTransform());
                return Transform(total);
            }
            return element is Instance instance ? Transform(Safe(() => instance.GetTransform())) : null;
        }

        private static DynamicTransformV1? Transform(Transform? transform)
        {
            if (transform == null) return null;
            var origin = Point(Safe(() => transform.Origin)); var x = Point(Safe(() => transform.BasisX));
            var y = Point(Safe(() => transform.BasisY)); var z = Point(Safe(() => transform.BasisZ));
            return origin == null || x == null || y == null || z == null ? null : new DynamicTransformV1 { Origin = origin, BasisX = x, BasisY = y, BasisZ = z };
        }

        private static DynamicPointV1? Point(XYZ? point) => point == null ? null : new DynamicPointV1 { X = point.X, Y = point.Y, Z = point.Z };
        private static Element? Element(Document document, ElementId? id) => id == null || Id(id) < 0 ? null : Safe(() => document.GetElement(id));
        private static long Id(ElementId? id) => ElementIdCompat.GetValue(id);
        private static long WorksetIdValue(WorksetId id)
        {
            var value = id.GetType().GetProperty("Value")?.GetValue(id) ?? id.GetType().GetProperty("IntegerValue")?.GetValue(id);
            return value == null ? -1 : Convert.ToInt64(value, CultureInfo.InvariantCulture);
        }
        private static string? Optional(string? value) => string.IsNullOrEmpty(value) ? null : value;
        private static T? Safe<T>(Func<T?> getter) { try { return getter(); } catch { return default; } }
        private static bool Safe(Func<bool> getter) { try { return getter(); } catch { return false; } }
        private static double? SafeNullable(Func<double> getter) { try { return getter(); } catch { return null; } }
        private static long? SafeNullable(Func<long> getter) { try { return getter(); } catch { return null; } }
    }
}
