using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    /// <summary>
    /// Additive v1 adapter for signed core-operation graphs. It is registered only by the exact
    /// development/laboratory runtime boundary and is never an advertised production capability.
    /// Preview is always a rolled-back TransactionGroup; apply additionally requires an exact
    /// preview effect-set authorization.
    /// </summary>
    internal static class DynamicCoreOperationHostV1
    {
        private const int BaselineLimit = 50000;
        private const string AdapterSurface = "dynamic-revit-core-operation-host/v4\nset_parameter/v1:exact-owner-readback-effect\nrotate_element/v1:exact-orientation-state-v1\nchange_type/v1:connector-signature-v3\ndelete_element/v1:preview-only\napply-authorization:durable-one-use";
        private static readonly ConcurrentDictionary<string, byte> ConsumedBindings = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);

        internal static string HostAdapterManifestHash(string revitYear) => DynamicWire.Sha256(string.Join("\n", new[]
        {
            AdapterSurface, revitYear, DynamicCoreOperationManifestV1.ManifestHash, DynamicPrimitiveManifestV1.ManifestHash
        }));

        internal static DynamicCoreOperationAdmissionContextV1 BuildAdmissionContext(UIApplication app, DynamicOperationGraphV1 graph,
            DynamicEffectBudgetV1 budget, int plannedExecutionMilliseconds)
        {
            var document = Document(app);
            var targets = graph.Nodes.Select(node => node.TargetUniqueIds[0]).Distinct(StringComparer.Ordinal)
                .Select(uniqueId => document.GetElement(uniqueId) ?? throw new InvalidOperationException("Core-operation target no longer exists: " + uniqueId)).ToArray();
            var owners = graph.Nodes.ToDictionary(node => node.TargetUniqueIds[0], node =>
            {
                var target = document.GetElement(node.TargetUniqueIds[0]) ?? throw new InvalidOperationException("Core-operation target no longer exists: " + node.TargetUniqueIds[0]);
                return MutationOwner(document, node, target);
            }, StringComparer.Ordinal);
            var ownerStates = graph.Nodes.ToDictionary(node => node.TargetUniqueIds[0], node =>
                CoreTrustedElementStateHash(owners[node.TargetUniqueIds[0]], requireExactOrientation: node.Kind == "rotate_element"), StringComparer.Ordinal);
            return new DynamicCoreOperationAdmissionContextV1
            {
                HostAdapterManifestHash = HostAdapterManifestHash(app.Application.VersionNumber),
                TargetCategoryStableIds = targets.ToDictionary(element => element.UniqueId, element => CategoryStableId(element.Category), StringComparer.Ordinal),
                MutationOwnerUniqueIds = owners.ToDictionary(pair => pair.Key, pair => pair.Value.UniqueId, StringComparer.Ordinal),
                TargetStateHashes = ownerStates,
                ViewScopeHash = DynamicRuntimeApplyState.ViewScopeHash(app),
                LevelScopeHash = DynamicRuntimeApplyState.ElementScopeHash("level", targets, element => ElementIdCompat.GetValue(element.LevelId)),
                WorksetScopeHash = DynamicRuntimeApplyState.ElementScopeHash("workset", targets, element => RevitBridge.Common.ElementIdCompat.GetValue(element.WorksetId)),
                PhaseScopeHash = DynamicRuntimeApplyState.PhaseScopeHash(targets), FileCapabilitySetHash = budget.FileCapabilitySetHash,
                PlannedExecutionMilliseconds = plannedExecutionMilliseconds, PlannedRegenerations = graph.Nodes.Count
            };
        }

        internal static DynamicCoreOperationPreviewV1 Preview(UIApplication app, DynamicOperationGraphV1 graph, DynamicEffectBudgetV1 budget,
            DynamicCoreOperationManifestBindingV1 binding, byte[] trustedKey, long nowUnixSeconds, int plannedExecutionMilliseconds)
        {
            var context = BuildAdmissionContext(app, graph, budget, plannedExecutionMilliseconds);
            DynamicCoreOperationAdmissionV1.Validate(graph, budget, context, binding, trustedKey, nowUnixSeconds, "preview",
                hash => ConsumedBindings.TryAdd(hash, 0));
            var result = Execute(app, graph, budget, commit: false, expectedEffectSetHash: null, expectedReadbackSetHash: null);
            var preview = new DynamicCoreOperationPreviewV1
            {
                GraphHash = graph.GraphHash, Effects = result.Effects, EffectSetHash = DynamicCoreOperationEffectPolicyV1.EffectSetHash(result.Effects),
                Readbacks = result.Readbacks, RollbackTruth = result.RollbackTruth
            };
            preview.PreviewHash = DynamicCoreOperationReceiptPolicyV1.PreviewHash(preview);
            DynamicCoreOperationReceiptPolicyV1.ValidateRollback(preview);
            return preview;
        }

        internal static DynamicCoreOperationApplyReceiptV1 Apply(UIApplication app, DynamicOperationGraphV1 graph, DynamicEffectBudgetV1 budget,
            DynamicCoreOperationManifestBindingV1 binding, DynamicCoreOperationPreviewV1 preview,
            DynamicCoreOperationApplyAuthorizationV1 authorization, IDynamicCoreOperationApplyAuthorizationLedgerV1 authorizationLedger,
            byte[] trustedKey, long nowUnixSeconds, int plannedExecutionMilliseconds)
        {
            DynamicCoreOperationReceiptPolicyV1.ValidateRollback(preview);
            if (preview.GraphHash != graph.GraphHash) throw new InvalidOperationException("Core-operation preview was substituted.");
            var context = BuildAdmissionContext(app, graph, budget, plannedExecutionMilliseconds);
            DynamicCoreOperationAdmissionV1.Validate(graph, budget, context, binding, trustedKey, nowUnixSeconds, "apply");
            DynamicCoreOperationApplyAuthorizationPolicyV1.ValidateAndConsume(authorization, graph, binding, preview.EffectSetHash,
                trustedKey, nowUnixSeconds, authorizationLedger);
            var result = Execute(app, graph, budget, commit: true, expectedEffectSetHash: preview.EffectSetHash,
                expectedReadbackSetHash: DynamicCoreOperationReceiptPolicyV1.ReadbackSetHash(preview.Readbacks));
            var observedHash = DynamicCoreOperationEffectPolicyV1.EffectSetHash(result.Effects);
            if (observedHash != preview.EffectSetHash) throw new InvalidOperationException("Core-operation apply effect set diverged from exact preview.");
            var receipt = new DynamicCoreOperationApplyReceiptV1
            {
                Outcome = "committed_verified", GraphHash = graph.GraphHash, EffectSetHash = observedHash, Readbacks = result.Readbacks
            };
            receipt.ReceiptHash = DynamicCoreOperationReceiptPolicyV1.ReceiptHash(receipt);
            return receipt;
        }

        private sealed class Baseline
        {
            internal string UniqueId = "";
            internal string StateHash = "";
        }

        private sealed class ChangeSet
        {
            internal readonly HashSet<long> Added = new HashSet<long>();
            internal readonly HashSet<long> Modified = new HashSet<long>();
            internal readonly HashSet<long> Deleted = new HashSet<long>();
        }

        private sealed class ExecutionResult
        {
            internal IReadOnlyList<DynamicCoreOperationEffectV1> Effects = Array.Empty<DynamicCoreOperationEffectV1>();
            internal IReadOnlyList<DynamicCoreOperationReadbackV1> Readbacks = Array.Empty<DynamicCoreOperationReadbackV1>();
            internal bool RollbackTruth;
        }

        private static ExecutionResult Execute(UIApplication app, DynamicOperationGraphV1 graph, DynamicEffectBudgetV1 budget, bool commit,
            string? expectedEffectSetHash, string? expectedReadbackSetHash)
        {
            var document = Document(app); var baseline = CaptureBaseline(document);
            var effects = new List<DynamicCoreOperationEffectV1>(); var readbacks = new List<DynamicCoreOperationReadbackV1>();
            ChangeSet? current = null; Exception? trackingFailure = null;
            EventHandler<DocumentChangedEventArgs> changed = (sender, args) =>
            {
                try
                {
                    if (current == null || args.GetDocument() != document) return;
                    foreach (var id in args.GetAddedElementIds()) current.Added.Add(ElementIdCompat.GetValue(id));
                    foreach (var id in args.GetModifiedElementIds()) current.Modified.Add(ElementIdCompat.GetValue(id));
                    foreach (var id in args.GetDeletedElementIds()) current.Deleted.Add(ElementIdCompat.GetValue(id));
                }
                catch (Exception ex) { trackingFailure = ex; }
            };
            TransactionGroup? group = null; var completed = false;
            try
            {
                group = new TransactionGroup(document, commit ? "Dynamic Core Operations Apply" : "Dynamic Core Operations Preview");
                if (group.Start() != TransactionStatus.Started) throw new InvalidOperationException("Unable to start core-operation transaction group.");
                app.Application.DocumentChanged += changed;
                foreach (var node in graph.Nodes)
                {
                    var target = document.GetElement(node.TargetUniqueIds[0]) ?? throw new InvalidOperationException("Core-operation target disappeared: " + node.TargetUniqueIds[0]);
                    if (target.Pinned || target.GroupId != ElementId.InvalidElementId) throw new InvalidOperationException("Pinned or grouped core-operation target is not eligible.");
                    var mutationOwner = MutationOwner(document, node, target);
                    var mutationOwnerUniqueId = mutationOwner.UniqueId;
                    var beforeHash = CoreTrustedElementStateHash(mutationOwner, requireExactOrientation: node.Kind == "rotate_element");
                    var primary = ElementIdCompat.GetValue(mutationOwner.Id);
                    current = new ChangeSet();
                    DynamicCoreOperationReadbackV1 readback;
                    ICollection<ElementId>? exactDeleted = null;
                    using (var transaction = new Transaction(document, "Dynamic " + node.Kind))
                    {
                        if (transaction.Start() != TransactionStatus.Started) throw new InvalidOperationException("Unable to start core-operation transaction.");
                        try
                        {
                            readback = ExecuteNode(document, node, target, beforeHash, out exactDeleted);
                            if (transaction.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Core-operation transaction did not commit.");
                        }
                        catch { if (transaction.GetStatus() == TransactionStatus.Started) transaction.RollBack(); throw; }
                    }
                    if (trackingFailure != null) throw new InvalidOperationException("Core-operation DocumentChanged capture failed.", trackingFailure);
                    if (node.Kind != "delete_element")
                    {
                        if (readback.BeforeStateHash == readback.AfterStateHash)
                            throw new InvalidOperationException("Core-operation mutation produced no trusted state change.");
                        // Revit can omit a parameter-only owner from DocumentChanged even though the
                        // exact post-transaction readback proves its state changed. Bind the primary
                        // mutation owner explicitly; all collateral IDs remain event-derived.
                        current.Modified.Add(primary);
                    }
                    if (exactDeleted != null)
                    {
                        var returned = new HashSet<long>(exactDeleted.Select(ElementIdCompat.GetValue));
                        if (!returned.SetEquals(current.Deleted)) throw new InvalidOperationException("Revit deletion cascade diverged from DocumentChanged evidence.");
                    }
                    var effect = new DynamicCoreOperationEffectV1
                    {
                        NodeId = node.NodeId, Kind = node.Kind, PrimaryTargetElementId = primary, PrimaryTargetUniqueId = mutationOwnerUniqueId,
                        AddedElementIds = current.Added.OrderBy(value => value).ToArray(), ModifiedElementIds = current.Modified.OrderBy(value => value).ToArray(),
                        DeletedElementIds = current.Deleted.OrderBy(value => value).ToArray(),
                        DeletedUniqueIds = current.Deleted.OrderBy(value => value).Select(id => baseline.TryGetValue(id, out var prior) ? prior.UniqueId :
                            throw new InvalidOperationException("Deleted cascade contained an element outside the bounded baseline.")).ToArray()
                    };
                    effect.EffectHash = DynamicCoreOperationEffectPolicyV1.CanonicalHash(effect);
                    effects.Add(effect); readbacks.Add(readback); current = null;
                }
                DynamicCoreOperationEffectPolicyV1.ValidateAgainstGraph(effects, graph, budget);
                var observedEffectSetHash = DynamicCoreOperationEffectPolicyV1.EffectSetHash(effects);
                if (expectedEffectSetHash != null && observedEffectSetHash != expectedEffectSetHash)
                    throw new InvalidOperationException("Core-operation apply effect set diverged from exact preview before commit.");
                var observedReadbackSetHash = DynamicCoreOperationReceiptPolicyV1.ReadbackSetHash(readbacks);
                if (expectedReadbackSetHash != null && observedReadbackSetHash != expectedReadbackSetHash)
                    throw new InvalidOperationException("Core-operation apply readback diverged from exact preview before commit.");
                app.Application.DocumentChanged -= changed;
                if (commit)
                {
                    VerifyCommittedReadbacks(document, readbacks);
                    if (group.Assimilate() != TransactionStatus.Committed) throw new InvalidOperationException("Core-operation group did not assimilate.");
                    completed = true;
                    return new ExecutionResult { Effects = effects, Readbacks = readbacks, RollbackTruth = false };
                }
                if (group.RollBack() != TransactionStatus.RolledBack) throw new InvalidOperationException("Core-operation preview did not roll back.");
                completed = true;
                var affected = effects.SelectMany(effect => effect.AddedElementIds.Concat(effect.ModifiedElementIds).Concat(effect.DeletedElementIds)).Distinct().ToArray();
                if (!VerifyRollback(document, baseline, affected)) throw new InvalidOperationException("Core-operation preview rollback truth check failed.");
                return new ExecutionResult { Effects = effects, Readbacks = readbacks, RollbackTruth = true };
            }
            finally
            {
                try { app.Application.DocumentChanged -= changed; } catch { }
                if (!completed && group != null) { try { group.RollBack(); } catch { } }
                group?.Dispose();
            }
        }

        private static DynamicCoreOperationReadbackV1 ExecuteNode(Document document, DynamicOperationNodeV1 node, Element target,
            string beforeHash, out ICollection<ElementId>? exactDeleted)
        {
            exactDeleted = null;
            if (node.Kind == "set_parameter") return SetParameter(document, node, target, beforeHash);
            if (node.Kind == "rotate_element") return Rotate(document, node, target, beforeHash);
            if (node.Kind == "change_type") return ChangeType(document, node, target, beforeHash);
            if (node.Kind == "delete_element")
            {
                var targetUniqueId = target.UniqueId; exactDeleted = document.Delete(target.Id);
                var deletedIds = exactDeleted.Select(ElementIdCompat.GetValue).OrderBy(value => value).ToArray();
                return Readback(node, targetUniqueId, beforeHash, DynamicWire.Sha256("deleted/v1\n" + string.Join("\n", deletedIds.Select(value => value.ToString(CultureInfo.InvariantCulture)))),
                    new Dictionary<string, string>(StringComparer.Ordinal) { ["cascade_element_ids"] = string.Join(",", deletedIds) });
            }
            throw new InvalidOperationException("Unknown core-operation host primitive.");
        }

        private static DynamicCoreOperationReadbackV1 SetParameter(Document document, DynamicOperationNodeV1 node, Element target, string beforeHash)
        {
            var scope = node.Attributes["parameter_scope"];
            var owner = MutationOwner(document, node, target);
            var matches = owner.Parameters.Cast<Parameter>().Where(parameter => ParameterIdentity(parameter) == node.Attributes["parameter_identity"]).ToArray();
            if (matches.Length != 1) throw new InvalidOperationException("Typed parameter identity did not resolve exactly once in its declared scope.");
            var parameter = matches[0]; var before = ParameterValue(parameter, scope);
            if (DynamicCoreOperationStateV1.ParameterStateHash(before) != node.Attributes["expected_parameter_state_hash"] || before.StorageKind != node.Attributes["expected_storage_kind"] || !before.Writable)
                throw new InvalidOperationException("Typed parameter is stale, has a different storage kind, or is not writable.");
            var raw = node.Attributes["raw_value"];
            if (before.StorageKind == "string") parameter.Set(raw);
            else if (before.StorageKind == "integer") parameter.Set(int.Parse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture));
            else if (before.StorageKind == "double")
            {
                if ((before.SpecTypeId ?? "") != node.Attributes["spec_type_id"] || (before.UnitTypeId ?? "") != node.Attributes["unit_type_id"])
                    throw new InvalidOperationException("Typed double spec or unit identity changed before mutation.");
                parameter.Set(double.Parse(raw, NumberStyles.Float, CultureInfo.InvariantCulture));
            }
            else
            {
                var referencedId = long.Parse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture);
                if (referencedId >= 0 && document.GetElement(ElementIdCompat.Create(referencedId)) == null)
                    throw new InvalidOperationException("Typed ElementId parameter value does not resolve in the bound document.");
                parameter.Set(ElementIdCompat.Create(referencedId));
            }
            document.Regenerate();
            var after = ParameterValue(parameter, scope);
            if (after.StorageKind != before.StorageKind) throw new InvalidOperationException("Typed parameter storage changed during mutation.");
            return Readback(node, owner.UniqueId, beforeHash, CoreTrustedElementStateHash(owner), new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["parameter_before_hash"] = DynamicCoreOperationStateV1.ParameterStateHash(before), ["parameter_after_hash"] = DynamicCoreOperationStateV1.ParameterStateHash(after),
                ["raw_before"] = Raw(before), ["raw_after"] = Raw(after), ["scope"] = scope, ["storage_kind"] = after.StorageKind,
                ["requested_target_unique_id"] = target.UniqueId, ["mutation_owner_unique_id"] = owner.UniqueId
            });
        }

        private static DynamicCoreOperationReadbackV1 Rotate(Document document, DynamicOperationNodeV1 node, Element target, string beforeHash)
        {
            var origin = Vector(node.Attributes["axis_origin_feet"]); var direction = Vector(node.Attributes["axis_direction"]);
            var axis = Line.CreateUnbound(origin, direction); var angle = double.Parse(node.Attributes["angle_radians"], CultureInfo.InvariantCulture);
            ElementTransformUtils.RotateElement(document, target.Id, axis, angle); document.Regenerate();
            return Readback(node, target.UniqueId, beforeHash, CoreTrustedElementStateHash(target, requireExactOrientation: true), new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["axis_origin_feet"] = node.Attributes["axis_origin_feet"], ["axis_direction"] = node.Attributes["axis_direction"], ["angle_radians"] = node.Attributes["angle_radians"]
            });
        }

        private static DynamicCoreOperationReadbackV1 ChangeType(Document document, DynamicOperationNodeV1 node, Element target, string beforeHash)
        {
            var replacement = document.GetElement(node.Attributes["replacement_type_unique_id"]) as ElementType ?? throw new InvalidOperationException("Replacement type no longer exists.");
            var category = CategoryStableId(target.Category); var replacementCategory = CategoryStableId(replacement.Category);
            var sourceFamily = FamilyStableId(target, document.GetElement(target.GetTypeId())); var replacementFamily = FamilyStableId(replacement, replacement);
            var connectorBefore = ConnectorSignature(target);
            if (category != node.Attributes["expected_category_stable_id"] || replacementCategory != category ||
                sourceFamily != node.Attributes["expected_source_family_stable_id"] || replacementFamily != node.Attributes["expected_replacement_family_stable_id"] ||
                sourceFamily != replacementFamily || connectorBefore != node.Attributes["expected_connector_signature"] ||
                CoreTrustedElementStateHash(replacement) != node.Attributes["expected_replacement_type_state_hash"])
                throw new InvalidOperationException("Replacement type failed exact category, family, connector, or state compatibility preflight.");
            var changedId = target.ChangeTypeId(replacement.Id);
            if (changedId != ElementId.InvalidElementId && changedId != target.Id) throw new InvalidOperationException("change_type replaced the primary element identity; this v1 primitive only permits in-place changes.");
            document.Regenerate();
            var current = document.GetElement(target.UniqueId) ?? throw new InvalidOperationException("Changed element identity disappeared.");
            if (CategoryStableId(current.Category) != category || FamilyStableId(current, document.GetElement(current.GetTypeId())) != replacementFamily || ConnectorSignature(current) != connectorBefore)
                throw new InvalidOperationException("change_type postflight compatibility diverged.");
            return Readback(node, current.UniqueId, beforeHash, CoreTrustedElementStateHash(current), new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["replacement_type_unique_id"] = replacement.UniqueId, ["category_stable_id"] = category, ["family_stable_id"] = replacementFamily, ["connector_signature"] = connectorBefore
            });
        }

        private static Dictionary<long, Baseline> CaptureBaseline(Document document)
        {
            var result = new Dictionary<long, Baseline>();
            foreach (var element in AllElements(document))
            {
                if (result.Count >= BaselineLimit) throw new InvalidOperationException("Core-operation exact baseline exceeds 50000 elements.");
                var id = ElementIdCompat.GetValue(element.Id);
                result[id] = new Baseline { UniqueId = element.UniqueId ?? "", StateHash = CoreTrustedElementStateHash(element) };
            }
            return result;
        }

        private static IEnumerable<Element> AllElements(Document document)
        {
            foreach (var element in new FilteredElementCollector(document).WhereElementIsNotElementType()) yield return element;
            foreach (var element in new FilteredElementCollector(document).WhereElementIsElementType()) yield return element;
        }

        private static bool VerifyRollback(Document document, IReadOnlyDictionary<long, Baseline> baseline, IEnumerable<long> affected)
        {
            foreach (var id in affected)
            {
                var current = document.GetElement(ElementIdCompat.Create(id));
                if (!baseline.TryGetValue(id, out var before)) { if (current != null) return false; continue; }
                if (current == null || current.UniqueId != before.UniqueId || CoreTrustedElementStateHash(current) != before.StateHash) return false;
            }
            return true;
        }

        private static void VerifyCommittedReadbacks(Document document, IEnumerable<DynamicCoreOperationReadbackV1> readbacks)
        {
            foreach (var readback in readbacks.Where(value => value.Kind != "delete_element"))
            {
                var element = document.GetElement(readback.TargetUniqueId) ?? throw new InvalidOperationException("Core-operation committed target disappeared.");
                if (CoreTrustedElementStateHash(element) != readback.AfterStateHash) throw new InvalidOperationException("Core-operation committed readback is stale.");
            }
        }

        private static DynamicCoreOperationReadbackV1 Readback(DynamicOperationNodeV1 node, string uniqueId, string before, string after, IReadOnlyDictionary<string, string> values)
            => new DynamicCoreOperationReadbackV1 { NodeId = node.NodeId, Kind = node.Kind, TargetUniqueId = uniqueId, BeforeStateHash = before, AfterStateHash = after, Values = values };

        private static DynamicParameterValueV1 ParameterValue(Parameter parameter, string scope)
        {
            var storage = parameter.StorageType; var has = parameter.HasValue && storage != StorageType.None;
            var result = new DynamicParameterValueV1
            {
                Identity = ParameterIdentity(parameter), Name = parameter.Definition?.Name ?? "", Scope = scope,
                StorageKind = storage == StorageType.String ? "string" : storage == StorageType.Integer ? "integer" : storage == StorageType.Double ? "double" : storage == StorageType.ElementId ? "element_id" : "none",
                HasValue = has, FormattedValue = Safe(() => parameter.AsValueString()), SpecTypeId = Safe(() => parameter.Definition?.GetDataType()?.TypeId),
                UnitTypeId = Safe(() => parameter.GetUnitTypeId()?.TypeId), Writable = storage != StorageType.None && !parameter.IsReadOnly
            };
            if (has && storage == StorageType.String) result.RawString = parameter.AsString() ?? "";
            else if (has && storage == StorageType.Integer) result.RawInteger = parameter.AsInteger();
            else if (has && storage == StorageType.Double) result.RawDouble = parameter.AsDouble();
            else if (has && storage == StorageType.ElementId) result.RawElementId = ElementIdCompat.GetValue(parameter.AsElementId());
            return result;
        }

        private static string ParameterIdentity(Parameter parameter)
        {
            try { if (parameter.IsShared) return "parameter:shared:" + parameter.GUID.ToString("D").ToLowerInvariant(); } catch { }
            if (parameter.Definition is InternalDefinition definition)
            {
                if (definition.BuiltInParameter != BuiltInParameter.INVALID) return "parameter:builtin:" + ((int)definition.BuiltInParameter).ToString(CultureInfo.InvariantCulture);
                var definitionId = ElementIdCompat.GetValue(definition.Id); if (definitionId >= 0) return "parameter:definition:" + definitionId.ToString(CultureInfo.InvariantCulture);
            }
            return "parameter:name:" + (parameter.Definition?.Name ?? "") + ":" + (Safe(() => parameter.Definition?.GetDataType()?.TypeId) ?? "none");
        }

        private static string Raw(DynamicParameterValueV1 value) => value.StorageKind == "string" ? value.RawString ?? "" : value.StorageKind == "integer" ?
            (value.RawInteger?.ToString(CultureInfo.InvariantCulture) ?? "null") : value.StorageKind == "double" ?
            (value.RawDouble?.ToString("R", CultureInfo.InvariantCulture) ?? "null") : value.RawElementId?.ToString(CultureInfo.InvariantCulture) ?? "null";

        private static string CategoryStableId(Category? category)
        {
            if (category == null) return "category:none";
            var id = ElementIdCompat.GetValue(category.Id); var builtIn = id < 0 && id >= int.MinValue ? Enum.GetName(typeof(BuiltInCategory), (int)id) : null;
            return builtIn == null ? "category:element:" + id.ToString(CultureInfo.InvariantCulture) : "category:builtin:" + builtIn;
        }

        private static string FamilyStableId(Element element, Element? type)
        {
            Family? family = null;
            if (element is FamilyInstance instance) family = instance.Symbol?.Family;
            else if (element is FamilySymbol symbol) family = symbol.Family;
            else if (type is FamilySymbol typeSymbol) family = typeSymbol.Family;
            return family == null ? "family:none" : "revit-family:" + family.UniqueId;
        }

        private static Element MutationOwner(Document document, DynamicOperationNodeV1 node, Element target)
        {
            if (node.Kind != "set_parameter" || node.Attributes["parameter_scope"] == "instance") return target;
            var typeId = target.GetTypeId();
            if (typeId == ElementId.InvalidElementId) throw new InvalidOperationException("Type-scoped parameter target has no type owner.");
            return document.GetElement(typeId) ?? throw new InvalidOperationException("Type-scoped parameter owner no longer exists.");
        }

        internal static string CoreTrustedElementStateHash(Element element, bool requireExactOrientation = false)
        {
            var fields = new List<string> { "base:" + DynamicRuntimePreviewHandler.TrustedElementStateHash(element) };
            try
            {
                fields.Add("exact-orientation:" + DynamicCoreOperationStateV1.ExactOrientationStateHash(ExactOrientationState(element)));
            }
            catch (Exception ex)
            {
                if (requireExactOrientation) throw new InvalidOperationException("rotate_element target lacks exact supported geometry/orientation state.", ex);
                fields.Add("exact-orientation:unsupported:" + ex.GetType().FullName);
            }
            fields.Sort(StringComparer.Ordinal);
            return DynamicWire.Sha256("dynamic-revit-core-trusted-element-state/v3\n" + string.Join("\n", fields));
        }

        private static DynamicCoreExactOrientationStateV1 ExactOrientationState(Element element)
        {
            var frame = element is Instance instance ? TransformValues(instance.GetTransform()) : Array.Empty<double>();
            var connectorSignature = element is MEPCurve ? ConnectorSignature(element, requireConnectors: true) : null;
            if (element.Location is LocationPoint point)
            {
                return new DynamicCoreExactOrientationStateV1("point", new[] { point.Point.X, point.Point.Y, point.Point.Z, point.Rotation }, frame, connectorSignature);
            }
            if (element.Location is LocationCurve locationCurve)
            {
                var curve = locationCurve.Curve ?? throw new InvalidOperationException("LocationCurve geometry is unavailable.");
                if (!curve.IsBound) throw new InvalidOperationException("Unbound LocationCurve geometry is not supported.");
                if (curve is Line line)
                {
                    return new DynamicCoreExactOrientationStateV1("line", PointPairValues(line.GetEndPoint(0), line.GetEndPoint(1)), frame, connectorSignature);
                }
                if (curve is Arc arc)
                {
                    var values = PointPairValues(arc.GetEndPoint(0), arc.GetEndPoint(1)).Concat(PointValues(arc.Center))
                        .Concat(PointValues(arc.Normal)).Concat(PointValues(arc.XDirection)).Concat(PointValues(arc.YDirection))
                        .Concat(new[] { arc.Radius, arc.GetEndParameter(0), arc.GetEndParameter(1) }).ToArray();
                    return new DynamicCoreExactOrientationStateV1("arc", values, frame, connectorSignature);
                }
                throw new InvalidOperationException("Non-linear LocationCurve type is not in the exact supported set: " + curve.GetType().FullName);
            }
            if (frame.Length == 12) return new DynamicCoreExactOrientationStateV1("transform", Array.Empty<double>(), frame, connectorSignature);
            throw new InvalidOperationException("Element has no exact supported rotation orientation state.");
        }

        private static double[] PointValues(XYZ value) => new[] { value.X, value.Y, value.Z };
        private static double[] PointPairValues(XYZ start, XYZ end) => PointValues(start).Concat(PointValues(end)).ToArray();
        private static double[] TransformValues(Transform value) => PointValues(value.Origin).Concat(PointValues(value.BasisX))
            .Concat(PointValues(value.BasisY)).Concat(PointValues(value.BasisZ)).ToArray();

        private static string ConnectorSignature(Element element, bool requireConnectors = false)
        {
            ConnectorSet? connectors = null;
            if (element is FamilyInstance instance) connectors = instance.MEPModel?.ConnectorManager?.Connectors;
            else if (element is MEPCurve curve) connectors = curve.ConnectorManager?.Connectors;
            if (connectors == null)
            {
                if (requireConnectors) throw new InvalidOperationException("Exact connector orientation state is unavailable.");
                return DynamicCoreOperationStateV1.ConnectorSignature(Array.Empty<DynamicCoreConnectorSignatureEntryV1>());
            }
            var values = new List<DynamicCoreConnectorSignatureEntryV1>();
            foreach (Connector connector in connectors)
            {
                var origin = connector.Origin;
                var coordinateSystem = connector.CoordinateSystem;
                if (coordinateSystem == null) throw new InvalidOperationException("Connector coordinate system is unavailable.");
                var connected = new List<string>();
                foreach (Connector reference in connector.AllRefs)
                    connected.Add(ConnectorEndpointIdentity(reference));
                var system = connector.MEPSystem;
                values.Add(new DynamicCoreConnectorSignatureEntryV1(
                    connector.Owner?.UniqueId ?? throw new InvalidOperationException("Connector owner identity is unavailable."),
                    ConnectorId(connector), connector.Domain.ToString(), connector.ConnectorType.ToString(), connector.Shape.ToString(),
                    origin.X, origin.Y, origin.Z,
                    coordinateSystem.BasisX.X, coordinateSystem.BasisX.Y, coordinateSystem.BasisX.Z,
                    coordinateSystem.BasisY.X, coordinateSystem.BasisY.Y, coordinateSystem.BasisY.Z,
                    coordinateSystem.BasisZ.X, coordinateSystem.BasisZ.Y, coordinateSystem.BasisZ.Z,
                    RequiredConnectorProperty(connector, "Direction"), ConnectorSystemClassification(connector),
                    ConnectorSize(connector, "Radius"), ConnectorSize(connector, "Height"), ConnectorSize(connector, "Width"),
                    system?.UniqueId, system == null ? null : ElementIdCompat.GetValue(system.GetTypeId()).ToString(CultureInfo.InvariantCulture), connected));
            }
            if (requireConnectors && values.Count == 0) throw new InvalidOperationException("MEPCurve has no connectors to bind longitudinal orientation.");
            return DynamicCoreOperationStateV1.ConnectorSignature(values);
        }

        private static string RequiredConnectorProperty(Connector connector, string propertyName)
        {
            try
            {
                var value = connector.GetType().GetProperty(propertyName)?.GetValue(connector, null);
                return value == null ? throw new InvalidOperationException("Connector " + propertyName + " is unavailable.") : Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            }
            catch (Exception ex) { throw new InvalidOperationException("Connector " + propertyName + " is unavailable.", ex); }
        }

        private static string ConnectorSystemClassification(Connector connector)
        {
            var values = new List<string>();
            foreach (var propertyName in new[] { "DuctSystemType", "PipeSystemType", "ElectricalSystemType" })
            {
                try
                {
                    var value = connector.GetType().GetProperty(propertyName)?.GetValue(connector, null);
                    if (value != null) values.Add(propertyName + "=" + Convert.ToString(value, CultureInfo.InvariantCulture));
                }
                catch { }
            }
            if (values.Count == 0) throw new InvalidOperationException("Connector system classification is unavailable.");
            values.Sort(StringComparer.Ordinal);
            return string.Join(";", values);
        }

        private static string ConnectorEndpointIdentity(Connector connector) => (connector.Owner?.UniqueId ?? "owner:none") + ":" + ConnectorId(connector);
        private static string ConnectorId(Connector connector)
        {
            var property = connector.GetType().GetProperty("Id");
            var value = property?.GetValue(connector, null);
            return value == null ? throw new InvalidOperationException("Connector stable id is unavailable.") : Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
        }
        private static double? ConnectorSize(Connector connector, string propertyName)
        {
            try
            {
                var value = connector.GetType().GetProperty(propertyName)?.GetValue(connector, null);
                return value == null ? (double?)null : Convert.ToDouble(value, CultureInfo.InvariantCulture);
            }
            catch { return null; }
        }

        private static XYZ Vector(string value)
        {
            var parts = value.Split(',');
            return new XYZ(double.Parse(parts[0], CultureInfo.InvariantCulture), double.Parse(parts[1], CultureInfo.InvariantCulture), double.Parse(parts[2], CultureInfo.InvariantCulture));
        }
        private static string Coordinate(XYZ point) => DynamicCoreOperationCanonicalNumberV1.Format(point.X) + "," +
            DynamicCoreOperationCanonicalNumberV1.Format(point.Y) + "," + DynamicCoreOperationCanonicalNumberV1.Format(point.Z);
        private static Document Document(UIApplication app) => app?.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
        private static string? Safe(Func<string?> value) { try { return value(); } catch { return null; } }
    }
}
