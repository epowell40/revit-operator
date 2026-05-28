using System;
using System.Linq;

namespace RevitBridge.FireAlarm
{
    public static class NotificationRequirement
    {
        public static NotifyResult Decide(RoomClass roomClass, double areaFt2, FireAlarmRunConfig config)
        {
            var req = config?.notificationRequirement;
            if (req == null)
            {
                return new NotifyResult { decision = NotifyDecision.REVIEW, reasonCode = "NO_CONFIG" };
            }

            if (areaFt2 > 0 && areaFt2 < req.minRoomAreaFt2Exclude && roomClass != RoomClass.CORRIDOR)
            {
                return new NotifyResult { decision = NotifyDecision.EXCLUDE, reasonCode = "AREA_LT_MIN_EXCLUDE" };
            }

            string cls = roomClass.ToString();

            if ((req.excludeClasses ?? Enumerable.Empty<string>()).Any(c => string.Equals(c, cls, StringComparison.OrdinalIgnoreCase)))
            {
                return new NotifyResult { decision = NotifyDecision.EXCLUDE, reasonCode = "CLASS_EXCLUDE" };
            }

            if ((req.requireClasses ?? Enumerable.Empty<string>()).Any(c => string.Equals(c, cls, StringComparison.OrdinalIgnoreCase)))
            {
                return new NotifyResult { decision = NotifyDecision.REQUIRE, reasonCode = "CLASS_REQUIRE" };
            }

            if (Enum.TryParse(req.@default, true, out NotifyDecision d))
            {
                return new NotifyResult { decision = d, reasonCode = "DEFAULT" };
            }

            return new NotifyResult { decision = NotifyDecision.REVIEW, reasonCode = "DEFAULT_INVALID" };
        }
    }
}

