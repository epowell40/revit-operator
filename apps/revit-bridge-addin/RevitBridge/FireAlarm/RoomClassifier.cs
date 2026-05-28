using System.Linq;

namespace RevitBridge.FireAlarm
{
    public static class RoomClassifier
    {
        public static ClassificationResult Classify(string roomName, double areaFt2, FireAlarmRunConfig config)
        {
            string n = (roomName ?? "").Trim().ToLowerInvariant();

            if (MatchesAny(n, config?.classification?.corridorPatterns))
            {
                return new ClassificationResult { roomClass = RoomClass.CORRIDOR, reasonCode = "NAME_MATCH_CORRIDOR", confidence = "HIGH" };
            }
            if (MatchesAny(n, config?.classification?.supportPatterns))
            {
                return new ClassificationResult { roomClass = RoomClass.SUPPORT, reasonCode = "NAME_MATCH_SUPPORT", confidence = "HIGH" };
            }
            if (MatchesAny(n, config?.classification?.publicPatterns))
            {
                return new ClassificationResult { roomClass = RoomClass.PUBLIC, reasonCode = "NAME_MATCH_PUBLIC", confidence = "HIGH" };
            }

            if (areaFt2 > 0 && areaFt2 < 30)
            {
                return new ClassificationResult { roomClass = RoomClass.REVIEW, reasonCode = "SMALL_ROOM_REVIEW", confidence = "LOW" };
            }

            return new ClassificationResult { roomClass = RoomClass.PRIVATE, reasonCode = "DEFAULT_PRIVATE", confidence = "MED" };
        }

        private static bool MatchesAny(string haystackLower, System.Collections.Generic.IEnumerable<string>? patterns)
        {
            if (string.IsNullOrWhiteSpace(haystackLower) || patterns == null) return false;
            return patterns.Any(p => !string.IsNullOrWhiteSpace(p) && haystackLower.Contains(p.Trim().ToLowerInvariant()));
        }
    }
}

