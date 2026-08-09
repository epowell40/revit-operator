using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    /// <summary>
    /// Read-only bounded building-systems projection. Internal and reachable only through the
    /// exact development/laboratory boundary; callers must supply a trusted snapshot/revision
    /// identity from the host snapshot authority.
    /// </summary>
    internal static class DynamicBuildingSystemsObservationAdapterV1
    {
        internal static DynamicBuildingSystemsEnvelopeV1 Observe(Document document, DynamicBuildingSystemsSelectorV1 selector,
            long documentRevision, string snapshotHash)
        {
            if (document == null) throw new ArgumentNullException(nameof(document));
            DynamicBuildingSystemsObservationPolicyV1.ValidateSelector(selector);
            var requested = new HashSet<string>(selector.ElementUniqueIds, StringComparer.Ordinal);
            var requestedCategories = new HashSet<string>(selector.CategoryStableIds, StringComparer.Ordinal);
            var requestedKinds = new HashSet<string>(selector.Kinds, StringComparer.Ordinal);
            IEnumerable<Element> candidates = requested.Count == 0
                ? new FilteredElementCollector(document).WhereElementIsNotElementType().Cast<Element>()
                : requested.OrderBy(value => value, StringComparer.Ordinal).Select(value => Safe(() => document.GetElement(value))).Where(value => value != null).Cast<Element>();
            var eligible = candidates.Select(element => new { Element = element, Kind = Kind(element), Category = Category(element.Category)?.StableId ?? "" })
                .Where(value => value.Kind != null && (requestedKinds.Count == 0 || requestedKinds.Contains(value.Kind)) &&
                    (requestedCategories.Count == 0 || requestedCategories.Contains(value.Category)))
                .Take(DynamicBuildingSystemsObservationContractV1.MaximumObservedFacts + 1).ToArray();
            if (eligible.Length > DynamicBuildingSystemsObservationContractV1.MaximumObservedFacts)
                throw new InvalidOperationException("Building-systems scope exceeds the bounded fact count; provide narrower selectors.");
            var facts = eligible.Select(value => Project(document, value.Element, value.Kind!, selector, snapshotHash)).ToArray();
            return DynamicBuildingSystemsObservationPolicyV1.BuildPage(selector, DynamicRuntimeSnapshotHandler.Fingerprint(document),
                DynamicRuntimeSnapshotHandler.Session(document), documentRevision, snapshotHash, facts);
        }

        private static DynamicBuildingSystemsFactV1 Project(Document document, Element element, string kind,
            DynamicBuildingSystemsSelectorV1 selector, string snapshotHash)
        {
            var type = Element(document, Safe(() => element.GetTypeId()));
            var familyInstance = element as FamilyInstance;
            var family = familyInstance?.Symbol?.Family;
            var level = Level(document, element);
            var workset = Workset(document, element);
            var transform = familyInstance == null ? null : TransformValue(Safe(() => familyInstance.GetTransform()));
            var point = element.Location as LocationPoint;
            var location = point == null ? transform?.Origin : Point(Safe(() => point.Point));
            var fact = new DynamicBuildingSystemsFactV1
            {
                Kind = kind,
                Element = Reference(element, kind == "system" ? "system" : "element"),
                Category = Category(element.Category),
                Family = family == null ? null : Reference(family, "family"),
                Type = type == null ? null : Reference(type, "type"),
                Host = familyInstance?.Host == null ? null : Reference(familyInstance.Host, "host"),
                Level = level,
                Workset = workset,
                Location = location,
                Orientation = transform,
                Connectors = kind == "system" ? Array.Empty<DynamicBuildingConnectorV1>() : Connectors(element, snapshotHash),
                Parameters = kind == "system" ? Array.Empty<DynamicParameterValueV1>() : Parameters(element, type, selector)
            };
            if (kind == "mep_curve") fact.Curve = Curve(document, (MEPCurve)element, type, level, fact.Connectors);
            else if (kind == "system") fact.System = SystemFact(document, (MEPSystem)element);
            else
            {
                if (family == null || type == null || transform == null || location == null)
                    throw new InvalidOperationException("Building asset lacks exact location, orientation, family, or type facts.");
                fact.Asset = new DynamicBuildingAssetFactV1 { AssetClass = kind, Location = location, Orientation = transform,
                    Family = Reference(family, "family"), Type = Reference(type, "type"), Host = fact.Host, Level = level, Workset = workset };
            }
            DynamicBuildingSystemsObservationPolicyV1.ValidateFact(fact, snapshotHash);
            return fact;
        }

        private static string? Kind(Element element)
        {
            if (element is MEPSystem) return "system";
            if (element is MEPCurve) return "mep_curve";
            if (!(element is FamilyInstance)) return null;
            var name = BuiltInCategoryName(element.Category);
            if (new[] { "OST_MechanicalEquipment", "OST_ElectricalEquipment" }.Contains(name, StringComparer.Ordinal)) return "equipment";
            if (name != null && (name.EndsWith("Devices", StringComparison.Ordinal) || name == "OST_ElectricalFixtures" ||
                name == "OST_LightingFixtures" || name == "OST_DuctTerminal")) return "device";
            if (name != null && (name.Contains("Accessory") || name.Contains("Fitting"))) return "accessory";
            return null;
        }

        private static IReadOnlyList<DynamicBuildingConnectorV1> Connectors(Element element, string snapshotHash)
        {
            ConnectorSet? set = null;
            if (element is FamilyInstance family) set = family.MEPModel?.ConnectorManager?.Connectors;
            else if (element is MEPCurve curve) set = curve.ConnectorManager?.Connectors;
            if (set == null) return Array.Empty<DynamicBuildingConnectorV1>();
            var owner = element.UniqueId ?? throw new InvalidOperationException("Connector owner lacks a stable identity.");
            var result = new List<DynamicBuildingConnectorV1>();
            foreach (Connector connector in set)
            {
                if (result.Count >= DynamicBuildingSystemsObservationContractV1.MaximumConnectorsPerFact)
                    throw new InvalidOperationException("Building-systems connector count exceeds its bound.");
                var coordinate = connector.CoordinateSystem ?? throw new InvalidOperationException("Connector coordinate frame is unavailable.");
                var identity = DynamicBuildingSystemsObservationPolicyV1.ConnectorStableId(snapshotHash, owner, ConnectorId(connector));
                var connected = new List<string>();
                foreach (Connector counterpart in connector.AllRefs)
                {
                    var counterpartElement = counterpart?.Owner;
                    if (counterpartElement == null || counterpartElement.Id == null || counterpartElement.Id == element.Id || counterpartElement is MEPSystem)
                        continue;
                    bool physicallyConnected;
                    try { physicallyConnected = connector.IsConnectedTo(counterpart); }
                    catch (Exception ex) { throw new InvalidOperationException("Physical connector relationship could not be verified.", ex); }
                    if (!physicallyConnected) continue;
                    if (connected.Count >= DynamicBuildingSystemsObservationContractV1.MaximumConnectionsPerConnector)
                        throw new InvalidOperationException("Connector counterpart count exceeds its bound.");
                    var counterpartOwner = counterpartElement.UniqueId ?? throw new InvalidOperationException("Connected connector owner lacks a stable identity.");
                    connected.Add(DynamicBuildingSystemsObservationPolicyV1.ConnectorStableId(snapshotHash, counterpartOwner, ConnectorId(counterpart)));
                }
                var frame = CanonicalFrame(coordinate);
                result.Add(new DynamicBuildingConnectorV1
                {
                    StableWithinSnapshotId = identity,
                    Origin = Point(connector.Origin)!, BasisX = frame.BasisX, BasisY = frame.BasisY, BasisZ = frame.BasisZ,
                    Domain = connector.Domain.ToString(), ConnectorType = connector.ConnectorType.ToString(), Shape = connector.Shape.ToString(),
                    FlowDirection = RequiredProperty(connector, "Direction"), SystemClassification = Classification(connector),
                    RadiusFeet = NumberProperty(connector, "Radius"), HeightFeet = NumberProperty(connector, "Height"), WidthFeet = NumberProperty(connector, "Width"),
                    System = connector.MEPSystem == null ? null : Reference(connector.MEPSystem, "system"),
                    IsPhysicallyConnected = connected.Count > 0,
                    ConnectedCounterpartIds = connected.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray()
                });
            }
            return result.OrderBy(value => value.StableWithinSnapshotId, StringComparer.Ordinal).ToArray();
        }

        private static DynamicMepCurveFactV1 Curve(Document document, MEPCurve curve, Element? type,
            DynamicStableReferenceV1? level, IReadOnlyList<DynamicBuildingConnectorV1> connectors)
        {
            var location = curve.Location as LocationCurve; var geometry = location?.Curve;
            if (geometry == null || !geometry.IsBound || type == null) throw new InvalidOperationException("MEP curve lacks exact bounded geometry or type.");
            var systems = connectors.Where(value => value.System != null).Select(value => value.System!).GroupBy(value => value.StableId, StringComparer.Ordinal).Select(group => group.First())
                .OrderBy(value => value.StableId, StringComparer.Ordinal).ToArray();
            var shape = connectors.Select(value => value.Shape).Distinct(StringComparer.Ordinal).ToArray();
            if (shape.Length != 1) throw new InvalidOperationException("MEP curve connector shape is missing or inconsistent.");
            return new DynamicMepCurveFactV1
            {
                Start = Point(geometry.GetEndPoint(0))!, End = Point(geometry.GetEndPoint(1))!, CurveKind = geometry.GetType().Name, Shape = shape[0],
                DiameterFeet = ParameterDouble(curve, BuiltInParameter.RBS_CURVE_DIAMETER_PARAM), HeightFeet = ParameterDouble(curve, BuiltInParameter.RBS_CURVE_HEIGHT_PARAM),
                WidthFeet = ParameterDouble(curve, BuiltInParameter.RBS_CURVE_WIDTH_PARAM), OffsetFeet = ParameterDouble(curve, BuiltInParameter.RBS_OFFSET_PARAM),
                Slope = ParameterDouble(curve, BuiltInParameter.RBS_CURVE_SLOPE), Level = level, Type = Reference(type, "type"), Systems = systems
            };
        }

        private static DynamicBuildingSystemFactV1 SystemFact(Document document, MEPSystem system)
        {
            var type = Element(document, Safe(() => system.GetTypeId())) ?? throw new InvalidOperationException("MEP system lacks a type identity.");
            var members = new List<DynamicStableReferenceV1>();
            var elements = Safe(() => system.Elements);
            if (elements != null)
            {
                foreach (Element member in elements)
                {
                    if (members.Count >= DynamicBuildingSystemsObservationContractV1.MaximumSystemMembers) throw new InvalidOperationException("MEP system member count exceeds its bound.");
                    members.Add(Reference(member, "element"));
                }
            }
            return new DynamicBuildingSystemFactV1 { Domain = system.GetType().Name, Classification = SystemClassification(system),
                Type = Reference(type, "type"), Members = members.GroupBy(value => value.StableId, StringComparer.Ordinal).Select(group => group.First()).OrderBy(value => value.StableId, StringComparer.Ordinal).ToArray() };
        }

        private static IReadOnlyList<DynamicParameterValueV1> Parameters(Element element, Element? type, DynamicBuildingSystemsSelectorV1 selector)
        {
            if (selector.ParameterNames.Length == 0) return Array.Empty<DynamicParameterValueV1>();
            var names = new HashSet<string>(selector.ParameterNames, StringComparer.Ordinal); var values = ReadParameters(element, names, "instance").ToList();
            if (selector.IncludeTypeParameters && type != null) values.AddRange(ReadParameters(type, names, "type"));
            if (values.Count > DynamicBuildingSystemsObservationContractV1.MaximumParametersPerFact) throw new InvalidOperationException("Building-systems parameter result exceeds its bound.");
            return values.OrderBy(value => value.Scope, StringComparer.Ordinal).ThenBy(value => value.Identity, StringComparer.Ordinal).ToArray();
        }

        private static IEnumerable<DynamicParameterValueV1> ReadParameters(Element element, HashSet<string> names, string scope)
        {
            foreach (Parameter parameter in element.Parameters)
            {
                var name = Safe(() => parameter.Definition?.Name); if (name == null || !names.Contains(name)) continue;
                var storage = parameter.StorageType; var has = Safe(() => parameter.HasValue) && storage != StorageType.None;
                var value = new DynamicParameterValueV1 { Identity = ParameterIdentity(parameter, name), Name = name,
                    StorageKind = storage == StorageType.String ? "string" : storage == StorageType.Integer ? "integer" : storage == StorageType.Double ? "double" : storage == StorageType.ElementId ? "element_id" : "none",
                    HasValue = has, FormattedValue = Safe(() => parameter.AsValueString()), SpecTypeId = Safe(() => parameter.Definition?.GetDataType()?.TypeId),
                    UnitTypeId = Safe(() => parameter.GetUnitTypeId()?.TypeId), Scope = scope, Writable = storage != StorageType.None && Safe(() => !parameter.IsReadOnly) };
                if (has && storage == StorageType.String) value.RawString = Safe(() => parameter.AsString()) ?? "";
                else if (has && storage == StorageType.Integer) value.RawInteger = SafeLong(() => parameter.AsInteger());
                else if (has && storage == StorageType.Double) value.RawDouble = SafeDouble(() => parameter.AsDouble());
                else if (has && storage == StorageType.ElementId) value.RawElementId = SafeLong(() => Id(parameter.AsElementId()));
                yield return value;
            }
        }

        private static string ParameterIdentity(Parameter parameter, string name)
        {
            try { if (parameter.IsShared) return "parameter:shared:" + parameter.GUID.ToString("D").ToLowerInvariant(); } catch { }
            try { if (parameter.Definition is InternalDefinition definition && definition.BuiltInParameter != BuiltInParameter.INVALID) return "parameter:builtin:" + ((int)definition.BuiltInParameter).ToString(CultureInfo.InvariantCulture); } catch { }
            return "parameter:name:" + name + ":" + (Safe(() => parameter.Definition?.GetDataType()?.TypeId) ?? "none");
        }

        private static string Classification(Connector connector)
        {
            var values = new List<string>();
            foreach (var name in new[] { "DuctSystemType", "PipeSystemType", "ElectricalSystemType" })
            {
                try { var value = connector.GetType().GetProperty(name)?.GetValue(connector, null); if (value != null) values.Add(name + "=" + Convert.ToString(value, CultureInfo.InvariantCulture)); } catch { }
            }
            if (values.Count == 0) values.Add("none:" + connector.Domain);
            return string.Join(";", values.OrderBy(value => value, StringComparer.Ordinal));
        }

        private static string SystemClassification(MEPSystem system)
        {
            foreach (var name in new[] { "SystemType", "DuctSystemType", "PipeSystemType", "ElectricalSystemType" })
            {
                try { var value = system.GetType().GetProperty(name)?.GetValue(system, null); if (value != null) return name + "=" + Convert.ToString(value, CultureInfo.InvariantCulture); } catch { }
            }
            return "none:" + system.GetType().Name;
        }

        private static string RequiredProperty(object value, string name)
        {
            try { var result = value.GetType().GetProperty(name)?.GetValue(value, null); return result == null ? throw new InvalidOperationException("Required Revit property is unavailable: " + name) : Convert.ToString(result, CultureInfo.InvariantCulture) ?? ""; }
            catch (Exception ex) { throw new InvalidOperationException("Required Revit property is unavailable: " + name, ex); }
        }
        private static string ConnectorId(Connector connector) => RequiredProperty(connector, "Id");
        private static double? NumberProperty(object value, string name) { try { var result = value.GetType().GetProperty(name)?.GetValue(value, null); return result == null ? (double?)null : Convert.ToDouble(result, CultureInfo.InvariantCulture); } catch { return null; } }
        private static double? ParameterDouble(Element value, BuiltInParameter parameter) { try { var item = value.get_Parameter(parameter); return item != null && item.StorageType == StorageType.Double && item.HasValue ? item.AsDouble() : (double?)null; } catch { return null; } }

        private static DynamicStableReferenceV1 Reference(Element element, string kind)
        {
            var uniqueId = element.UniqueId ?? throw new InvalidOperationException("Observed Revit element lacks a stable identity.");
            return new DynamicStableReferenceV1 { Kind = kind, StableId = "revit-element:" + uniqueId, UniqueId = uniqueId, ElementId = Id(element.Id), Name = Optional(Safe(() => element.Name)) };
        }
        private static DynamicStableReferenceV1? Category(Category? category)
        {
            if (category == null) return null; var id = Id(category.Id); var builtIn = BuiltInCategoryName(category);
            return new DynamicStableReferenceV1 { Kind = "category", StableId = builtIn == null ? "category:element:" + id.ToString(CultureInfo.InvariantCulture) : "category:builtin:" + builtIn, ElementId = id, Name = Optional(Safe(() => category.Name)) };
        }
        private static string? BuiltInCategoryName(Category? category) { if (category == null) return null; var id = Id(category.Id); return id < 0 && id >= int.MinValue ? Enum.GetName(typeof(BuiltInCategory), (int)id) : null; }
        private static DynamicStableReferenceV1? Level(Document document, Element element)
        {
            var candidate = Element(document, Safe(() => element.LevelId));
            if (candidate == null) foreach (var parameter in new[] { BuiltInParameter.FAMILY_LEVEL_PARAM, BuiltInParameter.INSTANCE_REFERENCE_LEVEL_PARAM, BuiltInParameter.INSTANCE_SCHEDULE_ONLY_LEVEL_PARAM }) { candidate = Element(document, Safe(() => element.get_Parameter(parameter)?.AsElementId())); if (candidate != null) break; }
            return candidate == null ? null : Reference(candidate, "level");
        }
        private static DynamicStableReferenceV1? Workset(Document document, Element element)
        {
            try { var workset = document.GetWorksetTable().GetWorkset(element.WorksetId); if (workset == null) return null; var id = WorksetIdValue(workset.Id); return new DynamicStableReferenceV1 { Kind = "workset", StableId = "workset:" + id.ToString(CultureInfo.InvariantCulture), ElementId = id, Name = Optional(workset.Name) }; } catch { return null; }
        }
        private static DynamicPointV1? Point(XYZ? point) => point == null ? null : new DynamicPointV1 { X = point.X, Y = point.Y, Z = point.Z };
        private static DynamicTransformV1? TransformValue(Transform? transform) => transform == null ? null : CanonicalFrame(transform);
        private static DynamicTransformV1 CanonicalFrame(Transform transform)
        {
            var z = transform.BasisZ.Normalize();
            var projectedX = transform.BasisX - z.Multiply(transform.BasisX.DotProduct(z));
            if (projectedX.GetLength() <= 1e-12)
            {
                var fallback = Math.Abs(z.X) < 0.9 ? XYZ.BasisX : XYZ.BasisY;
                projectedX = fallback - z.Multiply(fallback.DotProduct(z));
            }
            var x = projectedX.Normalize();
            var y = z.CrossProduct(x).Normalize();
            return new DynamicTransformV1 { Origin = Point(transform.Origin)!, BasisX = Point(x)!, BasisY = Point(y)!, BasisZ = Point(z)! };
        }
        private static Element? Element(Document document, ElementId? id) => id == null || Id(id) < 0 ? null : Safe(() => document.GetElement(id));
        private static long Id(ElementId? id) => ElementIdCompat.GetValue(id);
        private static long WorksetIdValue(WorksetId id) { var value = id.GetType().GetProperty("Value")?.GetValue(id) ?? id.GetType().GetProperty("IntegerValue")?.GetValue(id); return value == null ? -1 : Convert.ToInt64(value, CultureInfo.InvariantCulture); }
        private static string? Optional(string? value) => string.IsNullOrEmpty(value) ? null : value;
        private static T? Safe<T>(Func<T?> getter) { try { return getter(); } catch { return default; } }
        private static bool Safe(Func<bool> getter) { try { return getter(); } catch { return false; } }
        private static double? SafeDouble(Func<double> getter) { try { return getter(); } catch { return null; } }
        private static long? SafeLong(Func<long> getter) { try { return getter(); } catch { return null; } }
    }
}
