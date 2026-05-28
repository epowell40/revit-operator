using System;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.DB.Mechanical;

namespace RevitBridge.Logic.Handlers.Core
{
    internal static class SpatialElementResolver
    {
        internal sealed class ResolveResult
        {
            public SpatialElement? Element { get; set; }
            public string Query { get; set; } = "";
            public string SpatialKind { get; set; } = "";
            public string Number { get; set; } = "";
            public double Confidence { get; set; }
            public string MatchMode { get; set; } = "";
        }

        public static ResolveResult ResolveByNumber(Document doc, string roomOrSpaceNumber)
        {
            return ResolveByNumber(doc, roomOrSpaceNumber, "auto");
        }

        public static ResolveResult ResolveByNumber(Document doc, string roomOrSpaceNumber, string? spatialKindPreference)
        {
            var q = (roomOrSpaceNumber ?? "").Trim();
            if (doc == null || q.Length == 0)
            {
                return new ResolveResult { Query = q };
            }

            var qNorm = NormalizeNumericRoomNumber(q);
            var pref = (spatialKindPreference ?? "auto").Trim().ToLowerInvariant();
            if (pref.Length == 0) pref = "auto";

            var tryRoomFirst = !pref.Equals("space", StringComparison.OrdinalIgnoreCase);
            if (tryRoomFirst)
            {
                var room = FindRoom(doc, q, qNorm, out var roomMatchMode);
                if (room != null)
                {
                    return new ResolveResult
                    {
                        Element = room,
                        Query = q,
                        SpatialKind = "Room",
                        Number = room.Number ?? "",
                        Confidence = roomMatchMode == "exact" ? 1.0 : 0.92,
                        MatchMode = roomMatchMode
                    };
                }
            }

            var space = FindSpace(doc, q, qNorm, out var spaceMatchMode);
            if (space != null)
            {
                return new ResolveResult
                {
                    Element = space,
                    Query = q,
                    SpatialKind = "Space",
                    Number = space.Number ?? "",
                    Confidence = spaceMatchMode == "exact" ? 0.98 : 0.9,
                    MatchMode = spaceMatchMode
                };
            }

            if (!tryRoomFirst)
            {
                var room = FindRoom(doc, q, qNorm, out var roomMatchMode);
                if (room != null)
                {
                    return new ResolveResult
                    {
                        Element = room,
                        Query = q,
                        SpatialKind = "Room",
                        Number = room.Number ?? "",
                        Confidence = roomMatchMode == "exact" ? 1.0 : 0.92,
                        MatchMode = roomMatchMode
                    };
                }
            }

            return new ResolveResult
            {
                Query = q,
                Confidence = 0.0,
                MatchMode = "none"
            };
        }

        private static Room? FindRoom(Document doc, string q, string qNorm, out string matchMode)
        {
            matchMode = "none";
            foreach (var room in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_Rooms).Cast<Room>())
            {
                var n = (Convert.ToString(room.Number) ?? "").Trim();
                if (string.Equals(n, q, StringComparison.OrdinalIgnoreCase))
                {
                    matchMode = "exact";
                    return room;
                }

                var nNorm = NormalizeNumericRoomNumber(n);
                if (string.Equals(nNorm, qNorm, StringComparison.OrdinalIgnoreCase))
                {
                    matchMode = "normalized";
                    return room;
                }
            }

            return null;
        }

        private static Space? FindSpace(Document doc, string q, string qNorm, out string matchMode)
        {
            matchMode = "none";
            foreach (var space in new FilteredElementCollector(doc).OfCategory(BuiltInCategory.OST_MEPSpaces).Cast<Space>())
            {
                var n = (Convert.ToString(space.Number) ?? "").Trim();
                if (string.Equals(n, q, StringComparison.OrdinalIgnoreCase))
                {
                    matchMode = "exact";
                    return space;
                }

                var nNorm = NormalizeNumericRoomNumber(n);
                if (string.Equals(nNorm, qNorm, StringComparison.OrdinalIgnoreCase))
                {
                    matchMode = "normalized";
                    return space;
                }
            }

            return null;
        }

        private static string NormalizeNumericRoomNumber(string s)
        {
            if (s == null) return "";
            var t = s.Trim();
            if (t.Length == 0) return "";
            foreach (var c in t)
            {
                if (!char.IsDigit(c)) return t;
            }

            var stripped = t.TrimStart('0');
            return stripped.Length == 0 ? "0" : stripped;
        }
    }
}
