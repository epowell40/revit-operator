using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    public sealed class DrawingSpecUpdateRevision
    {
        public int Number { get; set; }
        public string PreviousSourceSha256 { get; set; } = "";
        public string PreviousNativeStateSha256 { get; set; } = "";
        public List<long> ReplacedTextNoteIds { get; set; } = new List<long>();
        public List<long> RetainedViewIds { get; set; } = new List<long>();
        public List<string> RetainedViewUniqueIds { get; set; } = new List<string>();
    }

    public static class DrawingSpecNativeUpdate
    {
        // Existing manifests lack pose/leader state. Accept only the renderer's
        // ordinary ungrouped, unpinned, unrotated, leader-free text, never guess
        // that an unsupported manual modification can be thrown away.
        public static void RequireCurrent(Document document, DrawingSpecStoredImport state, string? expectedSource, string? expectedNative)
        {
            DrawingSpecManagedUpdateGuard.RequireCurrent(expectedSource, expectedNative, state.SourceSha256,
                state.NativeStateSha256, DrawingSpecNativeImportState.CurrentSnapshotHash(document, state));
            if (state.Notes.Count == 0 || state.Notes.Count > 20000 || state.Notes.Select(n => n.Id).Distinct().Count() != state.Notes.Count ||
                state.ViewIds.Count == 0 || state.ViewIds.Count > 1000 || state.ViewIds.Distinct().Count() != state.ViewIds.Count)
                throw new InvalidOperationException("Managed import ownership inventory is invalid or incomplete.");
            foreach (var record in state.Notes)
            {
                var note = document.GetElement(ElementIdCompat.Create(record.Id)) as TextNote;
                var view = document.GetElement(ElementIdCompat.Create(record.ViewId)) as View;
                if (note == null || view == null || view.IsTemplate || view.ViewType != ViewType.DraftingView ||
                    !state.ViewIds.Contains(record.ViewId) || note.UniqueId != record.UniqueId ||
                    ElementIdCompat.GetValue(note.OwnerViewId) != record.ViewId || note.Pinned || ElementIdCompat.GetValue(note.GroupId) > 0 ||
                    !note.BaseDirection.IsAlmostEqualTo(view.RightDirection) || !note.UpDirection.IsAlmostEqualTo(view.UpDirection))
                    throw new InvalidOperationException("An owned note has a manual identity, grouping, pinning or orientation change. Reconcile it before update.");
                var leaders = typeof(TextNote).GetMethod("GetLeaders", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null)?.Invoke(note, null) as IEnumerable;
                if (leaders == null || leaders.Cast<object>().Any() || ReadAlignment(note, "HorizontalAlignment") != "Left" || ReadAlignment(note, "VerticalAlignment") != "Top")
                    throw new InvalidOperationException("Owned text has changed or unreadable leaders/alignment. No manual annotation was discarded.");
            }
        }

        private static string? ReadAlignment(TextNote note, string name) => typeof(TextNote).GetProperty(name)?.GetValue(note)?.ToString();

        public static DrawingSpecUpdateRevision ReplaceOwnedNotes(Document document, DrawingSpecStoredImport state)
        {
            if (!document.IsModifiable) throw new InvalidOperationException("Missing owned native transaction.");
            var revision = new DrawingSpecUpdateRevision { Number = checked((state.LastUpdate?.Number ?? 0) + 1),
                PreviousSourceSha256 = state.SourceSha256, PreviousNativeStateSha256 = state.NativeStateSha256,
                ReplacedTextNoteIds = state.Notes.Select(n => n.Id).ToList(), RetainedViewIds = state.ViewIds.ToList(),
                RetainedViewUniqueIds = state.ViewIds.Select(id => document.GetElement(ElementIdCompat.Create(id)).UniqueId).ToList() };
            var deleted = document.Delete(revision.ReplacedTextNoteIds.Select(ElementIdCompat.Create).ToList());
            DrawingSpecManagedUpdateGuard.RequireExactDeletion(revision.ReplacedTextNoteIds, deleted.Select(ElementIdCompat.GetValue));
            document.Regenerate();
            return revision;
        }

        public static object? InspectRevision(Document document, DrawingSpecStoredImport state)
        {
            var r = state.LastUpdate; if (r == null) return null;
            bool retained = r.RetainedViewIds.Count == r.RetainedViewUniqueIds.Count && r.RetainedViewIds.Select((id, i) =>
                document.GetElement(ElementIdCompat.Create(id)) is View view && !view.IsTemplate && view.ViewType == ViewType.DraftingView &&
                view.UniqueId == r.RetainedViewUniqueIds[i] && state.ViewIds.Contains(id)).All(match => match);
            return new { revision = r.Number, previousSourceSha256 = r.PreviousSourceSha256, previousNativeStateSha256 = r.PreviousNativeStateSha256,
                replacedTextNoteIds = r.ReplacedTextNoteIds, retainedViewIds = r.RetainedViewIds,
                allReplacedNotesAbsent = r.ReplacedTextNoteIds.All(id => document.GetElement(ElementIdCompat.Create(id)) == null),
                retainedViewIdentitiesMatch = retained };
        }
    }
}
