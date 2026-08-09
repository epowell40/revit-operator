using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitOperator.DynamicRevitSdk;

namespace RevitBridge.Logic.Handlers.DynamicRuntime
{
    internal static class DynamicAnnotationRevitStateV1
    {
        internal static string StateHash(Element element)
        {
            if (element == null || !element.IsValidObject) throw new InvalidOperationException("Annotation state target is unavailable.");
            var baseHash = DynamicRuntimePreviewHandler.TrustedElementStateHash(element);
            if (!(element is TextNote) && !(element is IndependentTag)) return baseHash;
            var fields = new List<string> { "base:" + baseHash };
            if (element is TextNote note)
            {
                fields.Add("text:" + DynamicAnnotationOperationPolicyV1.NormalizeText(note.Text));
                fields.Add("type:" + UniqueId(note.Document, note.GetTypeId())); fields.Add("view:" + UniqueId(note.Document, note.OwnerViewId));
                fields.Add("coord:" + Point(note.Coord)); fields.Add("width:" + DynamicCoreOperationCanonicalNumberV1.Format(note.Width));
                fields.Add("horizontal:" + note.HorizontalAlignment); fields.Add("vertical:" + note.VerticalAlignment);
            }
            else if (element is IndependentTag tag)
            {
                fields.Add("type:" + UniqueId(tag.Document, tag.GetTypeId())); fields.Add("view:" + UniqueId(tag.Document, tag.OwnerViewId));
                fields.Add("head:" + Point(tag.TagHeadPosition)); fields.Add("orientation:" + tag.TagOrientation); fields.Add("leader:" + (tag.HasLeader ? "1" : "0"));
                fields.Add("targets:" + string.Join(",", tag.GetTaggedLocalElementIds().Select(ElementIdCompat.GetValue).OrderBy(value => value)));
            }
            fields.Sort(StringComparer.Ordinal);
            return DynamicWire.Sha256("dynamic-revit-annotation-exact-state/v1\n" + string.Join("\n", fields));
        }

        internal static string UniqueId(Document document, ElementId id)
        {
            if (id == null || id == ElementId.InvalidElementId) return "none";
            return document.GetElement(id)?.UniqueId ?? throw new InvalidOperationException("Annotation state dependency disappeared.");
        }
        internal static string Point(XYZ value) => DynamicCoreOperationCanonicalNumberV1.Format(value.X) + "," + DynamicCoreOperationCanonicalNumberV1.Format(value.Y) + "," + DynamicCoreOperationCanonicalNumberV1.Format(value.Z);
    }

    internal interface IDynamicAnnotationOperationReadbackSourceV1
    {
        IReadOnlyList<DynamicAnnotationOperationReadbackV1> Readbacks { get; }
    }

    /// <summary>Reusable primitive executor. Transaction ownership and authorization remain with the shared result-graph host.</summary>
    internal sealed class DynamicAnnotationResultGraphExecutorV1 : IDynamicResultReferenceRevitLabExecutorV1, IDynamicAnnotationOperationReadbackSourceV1
    {
        private readonly List<DynamicAnnotationOperationReadbackV1> _readbacks = new List<DynamicAnnotationOperationReadbackV1>();
        public IReadOnlyList<DynamicAnnotationOperationReadbackV1> Readbacks => _readbacks.ToArray();

        public IReadOnlyList<DynamicRevitLabCreatedOutputV1> Execute(Document document, DynamicResultReferenceNodeV1 node,
            IReadOnlyList<DynamicResolvedElementTargetV1> resolvedTargets)
        {
            DynamicAnnotationOperationPolicyV1.ValidateNode(node);
            if (document == null || resolvedTargets == null || resolvedTargets.Count != 1 || _readbacks.Any(value => value.NodeId == node.NodeId))
                throw new InvalidOperationException("Annotation executor target or lifecycle is invalid.");
            return node.Kind == "edit_text_note" ? EditTextNote(document, node, resolvedTargets[0]) : CreateTag(document, node, resolvedTargets[0]);
        }

        private IReadOnlyList<DynamicRevitLabCreatedOutputV1> EditTextNote(Document document, DynamicResultReferenceNodeV1 node, DynamicResolvedElementTargetV1 resolved)
        {
            var note = document.GetElement(resolved.UniqueId) as TextNote ?? throw new InvalidOperationException("edit_text_note target is not an existing TextNote.");
            var before = DynamicAnnotationRevitStateV1.StateHash(note);
            var text = DynamicAnnotationOperationPolicyV1.NormalizeText(note.Text);
            var type = DynamicAnnotationRevitStateV1.UniqueId(document, note.GetTypeId()); var view = DynamicAnnotationRevitStateV1.UniqueId(document, note.OwnerViewId);
            if (before != resolved.StateHash || text != node.Attributes["expected_text"] || type != node.Attributes["expected_text_type_unique_id"] || view != node.Attributes["expected_owner_view_unique_id"])
                throw new InvalidOperationException("Text note text, type, owner view, or exact state is stale.");
            note.Text = node.Attributes["replacement_text"]; document.Regenerate();
            var current = document.GetElement(resolved.UniqueId) as TextNote ?? throw new InvalidOperationException("Edited TextNote identity disappeared.");
            var afterText = DynamicAnnotationOperationPolicyV1.NormalizeText(current.Text);
            if (!TextNoteTextCanonicalizer.IsExactRevitRoundTrip(node.Attributes["replacement_text"], current.Text) || DynamicAnnotationRevitStateV1.UniqueId(document, current.GetTypeId()) != type ||
                DynamicAnnotationRevitStateV1.UniqueId(document, current.OwnerViewId) != view)
                throw new InvalidOperationException("Text note edit produced substituted text, type, view, or identity.");
            AddReadback(node, current.UniqueId, before, DynamicAnnotationRevitStateV1.StateHash(current), new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["text_before"] = text, ["text_after"] = afterText, ["text_type_unique_id"] = type, ["owner_view_unique_id"] = view,
                ["element_id"] = ElementIdCompat.GetValue(current.Id).ToString(CultureInfo.InvariantCulture)
            });
            return Array.Empty<DynamicRevitLabCreatedOutputV1>();
        }

        private IReadOnlyList<DynamicRevitLabCreatedOutputV1> CreateTag(Document document, DynamicResultReferenceNodeV1 node, DynamicResolvedElementTargetV1 resolved)
        {
            var target = document.GetElement(resolved.UniqueId) ?? throw new InvalidOperationException("create_tag target disappeared.");
            if (target.UniqueId != node.Attributes["target_unique_id"] || DynamicAnnotationRevitStateV1.StateHash(target) != resolved.StateHash)
                throw new InvalidOperationException("create_tag target identity or exact state is stale.");
            var view = document.GetElement(node.Attributes["view_unique_id"]) as View ?? throw new InvalidOperationException("create_tag view disappeared or is not a view.");
            var tagType = document.GetElement(node.Attributes["tag_type_unique_id"]) as ElementType ?? throw new InvalidOperationException("create_tag type disappeared or is not an element type.");
            if (view.IsTemplate || view.Id != document.ActiveView.Id || DynamicAnnotationRevitStateV1.StateHash(view) != node.Attributes["expected_view_state_hash"] ||
                DynamicAnnotationRevitStateV1.StateHash(tagType) != node.Attributes["expected_tag_type_state_hash"])
                throw new InvalidOperationException("create_tag view/type is stale, templated, or not the exact active view.");
            if (new FilteredElementCollector(document, view.Id).OfClass(typeof(IndependentTag)).Cast<IndependentTag>().Any(tag =>
                tag.GetTypeId() == tagType.Id && tag.GetTaggedLocalElementIds().Contains(target.Id)))
                throw new InvalidOperationException("create_tag refuses a duplicate target/type tag in the exact view.");
            var head = Point(node.Attributes["head_position_feet"]); var orientation = node.Attributes["tag_orientation"] == "horizontal" ? TagOrientation.Horizontal : TagOrientation.Vertical;
            var leader = node.Attributes["leader_enabled"] == "1"; var reference = new Reference(target);
            var tag = IndependentTag.Create(document, tagType.Id, view.Id, reference, leader, orientation, head) ?? throw new InvalidOperationException("Revit returned no created tag.");
            if (leader)
            {
                tag.LeaderEndCondition = LeaderEndCondition.Free;
                tag.SetLeaderEnd(reference, Point(node.Attributes["leader_end_feet"]));
                tag.SetLeaderElbow(reference, Point(node.Attributes["leader_elbow_feet"]));
            }
            document.Regenerate();
            var targets = tag.GetTaggedLocalElementIds();
            if (tag.OwnerViewId != view.Id || tag.GetTypeId() != tagType.Id || tag.TagOrientation != orientation || tag.HasLeader != leader ||
                targets.Count != 1 || !targets.Contains(target.Id) || !Same(tag.TagHeadPosition, head) || tag.IsHidden(view) ||
                leader && (!Same(tag.GetLeaderEnd(reference), Point(node.Attributes["leader_end_feet"])) || !Same(tag.GetLeaderElbow(reference), Point(node.Attributes["leader_elbow_feet"]))))
                throw new InvalidOperationException("Created tag target, type, view, placement, leader, or visibility readback diverged.");
            var after = DynamicAnnotationRevitStateV1.StateHash(tag);
            AddReadback(node, tag.UniqueId, resolved.StateHash, after, new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["tagged_target_unique_id"] = target.UniqueId, ["owner_view_unique_id"] = view.UniqueId, ["tag_type_unique_id"] = tagType.UniqueId,
                ["head_position_feet"] = DynamicAnnotationRevitStateV1.Point(tag.TagHeadPosition), ["tag_orientation"] = node.Attributes["tag_orientation"],
                ["leader_enabled"] = node.Attributes["leader_enabled"], ["leader_elbow_feet"] = node.Attributes["leader_elbow_feet"],
                ["leader_end_feet"] = node.Attributes["leader_end_feet"], ["visible"] = "1"
            });
            return new[] { new DynamicRevitLabCreatedOutputV1 { OutputSlot = node.Attributes["output_slot"], Element = tag, VisibilityVerified = true } };
        }

        private void AddReadback(DynamicResultReferenceNodeV1 node, string subject, string before, string after, IReadOnlyDictionary<string, string> values)
        {
            var readback = new DynamicAnnotationOperationReadbackV1 { NodeId = node.NodeId, Kind = node.Kind, SubjectUniqueId = subject, BeforeStateHash = before, AfterStateHash = after, Values = values };
            readback.ReadbackHash = DynamicAnnotationOperationPolicyV1.ReadbackHash(readback); _readbacks.Add(readback);
        }
        private static XYZ Point(string value) { var numbers = DynamicAnnotationOperationPolicyV1.ParsePoint(value); return new XYZ(numbers[0], numbers[1], numbers[2]); }
        private static bool Same(XYZ left, XYZ right) => left.DistanceTo(right) <= 1e-9;
    }

    internal static class DynamicAnnotationResultGraphLabPreviewV1
    {
        internal static DynamicAnnotationOperationPreviewV1 Execute(UIApplication application, DynamicResultReferenceGraphV1 graph,
            DynamicEffectBudgetV1 budget, IReadOnlyDictionary<string, DynamicTrustedElementFactV1> admissionTargets)
        {
            DynamicAnnotationOperationPolicyV1.ValidateGraph(graph);
            var executor = new DynamicAnnotationResultGraphExecutorV1();
            var receipt = DynamicResultReferenceRevitLabPreviewV1.Execute(application, graph, budget,
                DynamicAnnotationOperationManifestV1.All.Select(value => value.Kind), admissionTargets, executor);
            var preview = new DynamicAnnotationOperationPreviewV1 { ResultReceipt = receipt, Readbacks = executor.Readbacks };
            preview.ReadbackSetHash = DynamicAnnotationOperationPolicyV1.ReadbackSetHash(preview.Readbacks);
            preview.PreviewHash = DynamicAnnotationOperationPolicyV1.PreviewHash(preview);
            DynamicAnnotationOperationPolicyV1.ValidatePreviewAgainstGraph(preview, graph);
            return preview;
        }
    }
}
