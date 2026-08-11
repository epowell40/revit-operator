using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
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
        internal const int DefaultResultCount = 200;
        internal const int MaximumResultCount = 500;
        internal const int MaximumTextUtf8Bytes = 4096;

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
            var max = p.max.HasValue && p.max.Value > 0 ? Math.Min(p.max.Value, MaximumResultCount) : DefaultResultCount;

            Regex? regex = null;
            if (!string.IsNullOrWhiteSpace(rx))
            {
                regex = new Regex(rx, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(250));
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
                var textBytes = Encoding.UTF8.GetByteCount(t);
                if (textBytes > MaximumTextUtf8Bytes) throw new InvalidOperationException("TextNote text exceeds the bounded exact-output limit.");
                var tNorm = NormalizeForSearch(t);

                var ok = true;
                if (!string.IsNullOrWhiteSpace(contains) && tNorm.IndexOf(containsNorm, StringComparison.OrdinalIgnoreCase) < 0) ok = false;
                if (ok && regex != null && !regex.IsMatch(tNorm)) ok = false;
                if (!ok) continue;

                elementIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(tn.Id));
                if (textSamples.Count < 20) textSamples.Add(t.Length > 200 ? t.Substring(0, 200) : t);

                var ownerViewId = SafeGetOwnerViewId(tn);
                var ownerView = ownerViewId.HasValue ? targetDoc.GetElement(RevitBridge.Common.ElementIdCompat.Create(ownerViewId.Value)) as View : null;
                var typeId = tn.GetTypeId(); var textType = typeId == null || typeId == ElementId.InvalidElementId ? null : targetDoc.GetElement(typeId);
                var bb = Safe(() => tn.get_BoundingBox(null)); var coord = Safe(() => tn.Coord);
                var center = bb == null ? null : Point((bb.Min + bb.Max) * 0.5);
                items.Add(new
                {
                    textNoteId = RevitBridge.Common.ElementIdCompat.GetValue(tn.Id),
                    elementId = RevitBridge.Common.ElementIdCompat.GetValue(tn.Id),
                    uniqueId = RequiredUniqueId(tn, "TextNote"),
                    text = t,
                    textUtf8Bytes = textBytes,
                    textNormalized = tNorm,
                    textTypeId = textType == null ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(textType.Id),
                    textTypeUniqueId = textType == null ? null : RequiredUniqueId(textType, "TextNote type"),
                    ownerViewId,
                    ownerViewUniqueId = ownerView == null ? null : RequiredUniqueId(ownerView, "TextNote owner view"),
                    ownerViewName = string.IsNullOrWhiteSpace(ownerView?.Name) ? null : ownerView.Name,
                    location = Point(coord),
                    center,
                    boundingBox = bb == null ? null : new { min = Point(bb.Min), max = Point(bb.Max) },
                    widthFeet = SafeDouble(() => tn.Width),
                    horizontalAlignment = Safe(() => tn.HorizontalAlignment.ToString()),
                    verticalAlignment = Safe(() => tn.VerticalAlignment.ToString())
                });

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

        private static string RequiredUniqueId(Element element, string label)
        {
            var value = Safe(() => element.UniqueId);
            if (string.IsNullOrWhiteSpace(value) || value.Length > 256 || value.Any(char.IsControl))
                throw new InvalidOperationException(label + " lacks a bounded stable UniqueId.");
            return value;
        }

        private static object? Point(XYZ? value) => value == null ? null : new { x = value.X, y = value.Y, z = value.Z };
        private static T? Safe<T>(Func<T> read) where T : class { try { return read(); } catch { return null; } }
        private static double? SafeDouble(Func<double> read) { try { var value = read(); return double.IsNaN(value) || double.IsInfinity(value) ? (double?)null : value; } catch { return null; } }

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
