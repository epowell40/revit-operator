using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class FindFamilyTextNotesHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string familyDocumentId { get; set; } = "";
            public string? contains { get; set; }
            public int max { get; set; } = 200;
        }

        private sealed class Box2
        {
            public double cx;
            public double cy;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");

            if (!FamilyEditSessionStore.TryGet(p.familyDocumentId, out var session, out var err))
                throw new InvalidOperationException(err ?? "Family edit session not found.");

            var famDoc = session.FamilyDoc;
            var needle = (p.contains ?? "").Trim();
            var needleNorm = NormalizeForSearch(needle);
            var max = Math.Max(1, Math.Min(2000, p.max));

            var list = new List<object>();
            foreach (var e in new FilteredElementCollector(famDoc).WhereElementIsNotElementType().ToElements())
            {
                if (!(e is TextNote tn)) continue;
                var text = tn.Text ?? "";
                if (!string.IsNullOrWhiteSpace(needle))
                {
                    var hay = NormalizeForSearch(text);
                    if (hay.IndexOf(needleNorm, StringComparison.OrdinalIgnoreCase) < 0) continue;
                }

                var bb = tn.get_BoundingBox(null);
                Box2? box = null;
                if (bb != null)
                {
                    box = new Box2 { cx = (bb.Min.X + bb.Max.X) * 0.5, cy = (bb.Min.Y + bb.Max.Y) * 0.5 };
                }

                list.Add(new
                {
                    textNoteId = RevitBridge.Common.ElementIdCompat.GetValue(tn.Id),
                    text,
                    location = box == null ? null : new { x = box.cx, y = box.cy, units = "feet" }
                });

                if (list.Count >= max) break;
            }

            return Task.FromResult<object>(new
            {
                ok = true,
                familyDocumentId = session.SessionId,
                familyName = session.FamilyName,
                count = list.Count,
                items = list
            });
        }

        private static string NormalizeForSearch(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            // Make line-break/punctuation-heavy labels searchable with simple "contains" queries.
            // Normalize all whitespace + punctuation down to single spaces and keep only letters/digits.
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
