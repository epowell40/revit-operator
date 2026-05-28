using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class FindTextNotesHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? docId { get; set; }
            public string? familyDocumentId { get; set; }
            public string? textContains { get; set; }
            public string? contains { get; set; }
            public string? regex { get; set; }
            public long? viewId { get; set; }
            public int? max { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var sessionId = (p.docId ?? p.familyDocumentId ?? "").Trim();
            Document targetDoc;
            string? familyDocumentId = null;
            string? familyName = null;
            string searchScope;

            if (!string.IsNullOrWhiteSpace(sessionId))
            {
                if (!FamilyEditSessionStore.TryGet(sessionId, out var session, out var err))
                    throw new InvalidOperationException(err ?? "Family edit session not found.");

                targetDoc = session.FamilyDoc;
                familyDocumentId = session.SessionId;
                familyName = session.FamilyName;
                searchScope = "family_session";
            }
            else
            {
                var uidoc = app?.ActiveUIDocument;
                targetDoc = uidoc?.Document ?? throw new InvalidOperationException("No active project document.");
                searchScope = "active_project";
            }

            var contains = (p.textContains ?? p.contains ?? "").Trim();
            var containsNorm = NormalizeForSearch(contains);
            var rx = (p.regex ?? "").Trim();
            var max = p.max.HasValue && p.max.Value > 0 ? p.max.Value : 200;

            Regex? regex = null;
            if (!string.IsNullOrWhiteSpace(rx))
            {
                regex = new Regex(rx, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            }

            var items = new List<object>();
            var elementIds = new List<long>();
            var textSamples = new List<string>();

            FilteredElementCollector collector;
            if (p.viewId.HasValue && p.viewId.Value != 0)
                collector = new FilteredElementCollector(targetDoc, RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value));
            else
                collector = new FilteredElementCollector(targetDoc);

            var textNotes = collector
                .OfClass(typeof(TextNote))
                .WhereElementIsNotElementType()
                .Cast<TextNote>()
                .ToList();

            foreach (var tn in textNotes)
            {
                if (tn == null) continue;
                var t = tn.Text ?? "";
                var tNorm = NormalizeForSearch(t);

                var ok = true;
                if (!string.IsNullOrWhiteSpace(contains) && tNorm.IndexOf(containsNorm, StringComparison.OrdinalIgnoreCase) < 0) ok = false;
                if (ok && regex != null && !regex.IsMatch(tNorm)) ok = false;
                if (!ok) continue;

                elementIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(tn.Id));
                if (textSamples.Count < 20) textSamples.Add(t.Length > 200 ? t.Substring(0, 200) : t);

                try
                {
                    var bb = tn.get_BoundingBox(null);
                    var ownerViewId = SafeGetOwnerViewId(tn);
                    var ownerViewName = ResolveOwnerViewName(targetDoc, ownerViewId);
                    double? cx = null, cy = null, cz = null;
                    if (bb != null)
                    {
                        var c = (bb.Min + bb.Max) * 0.5;
                        cx = c.X; cy = c.Y; cz = c.Z;
                    }

                    items.Add(new
                    {
                        textNoteId = RevitBridge.Common.ElementIdCompat.GetValue(tn.Id),
                        elementId = RevitBridge.Common.ElementIdCompat.GetValue(tn.Id),
                        text = t,
                        textNormalized = tNorm,
                        ownerViewId,
                        ownerViewName,
                        center = cx.HasValue ? new { x = cx.Value, y = cy ?? 0, z = cz ?? 0 } : null
                    });
                }
                catch
                {
                    var ownerViewId = SafeGetOwnerViewId(tn);
                    var ownerViewName = ResolveOwnerViewName(targetDoc, ownerViewId);
                    items.Add(new
                    {
                        textNoteId = RevitBridge.Common.ElementIdCompat.GetValue(tn.Id),
                        elementId = RevitBridge.Common.ElementIdCompat.GetValue(tn.Id),
                        text = t,
                        textNormalized = tNorm,
                        ownerViewId,
                        ownerViewName,
                        center = (object?)null
                    });
                }

                if (items.Count >= max) break;
            }

            return Task.FromResult<object>(new
            {
                ok = true,
                scope = searchScope,
                docId = familyDocumentId,
                familyDocumentId,
                familyName,
                documentTitle = SafeDocTitle(targetDoc),
                elementIds,
                textSamples,
                items
            });
        }

        private static long? SafeGetOwnerViewId(TextNote textNote)
        {
            try
            {
                if (textNote == null) return null;
                var ownerViewId = textNote.OwnerViewId;
                if (ownerViewId == null || ownerViewId == ElementId.InvalidElementId) return null;
                var value = RevitBridge.Common.ElementIdCompat.GetValue(ownerViewId);
                return value > 0 ? value : (long?)null;
            }
            catch
            {
                return null;
            }
        }

        private static string? ResolveOwnerViewName(Document doc, long? ownerViewId)
        {
            try
            {
                if (doc == null || !ownerViewId.HasValue || ownerViewId.Value <= 0) return null;
                var view = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(ownerViewId.Value)) as View;
                return string.IsNullOrWhiteSpace(view?.Name) ? null : view.Name;
            }
            catch
            {
                return null;
            }
        }

        private static string? SafeDocTitle(Document doc)
        {
            try
            {
                return string.IsNullOrWhiteSpace(doc?.Title) ? null : doc.Title;
            }
            catch
            {
                return null;
            }
        }

        private static string NormalizeForSearch(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var chars = s.Replace("\r\n", "\n").Replace('\r', '\n').ToCharArray();
            var outChars = new System.Text.StringBuilder(chars.Length);
            var inWs = false;
            foreach (var c in chars)
            {
                var keep = char.IsLetterOrDigit(c);
                if (!keep)
                {
                    if (!inWs)
                    {
                        outChars.Append(' ');
                        inWs = true;
                    }
                    continue;
                }
                inWs = false;
                outChars.Append(char.ToLowerInvariant(c));
            }
            return outChars.ToString().Trim();
        }
    }
}
