using System.Collections.Generic;

namespace RevitBridge.Logic.FireAlarm
{
    public enum RoomClass
    {
        PRIVATE,
        PUBLIC,
        CORRIDOR,
        SUPPORT,
        REVIEW
    }

    public enum NotifyDecision
    {
        REQUIRE,
        EXCLUDE,
        REVIEW
    }

    public class ClassificationResult
    {
        public RoomClass roomClass { get; set; }
        public string reasonCode { get; set; }
        public string confidence { get; set; }
    }

    public class NotifyResult
    {
        public NotifyDecision decision { get; set; }
        public string reasonCode { get; set; }
    }

    public class DeviceTypeMapping
    {
        public string family { get; set; }
        public string type { get; set; }
    }

    public class LayoutPlacedInstance
    {
        public long elementId { get; set; }
        public string deviceKind { get; set; }
        public string family { get; set; }
        public string type { get; set; }
        public double x { get; set; }
        public double y { get; set; }
        public double z { get; set; }
        public long? roomId { get; set; }
    }

    public class FireAlarmAssumption
    {
        public long roomId { get; set; }
        public string roomNumber { get; set; }
        public string roomName { get; set; }
        public double areaFt2 { get; set; }
        public string levelName { get; set; }
        public string inferredClass { get; set; }
        public string classReasonCode { get; set; }
        public string notifyDecision { get; set; }
        public string notifyReasonCode { get; set; }
    }

    public class FireAlarmLayoutReport
    {
        public string runId { get; set; }
        public string levelName { get; set; }
        public long viewId { get; set; }
        public bool dryRun { get; set; }
        public List<FireAlarmAssumption> assumptions { get; set; } = new List<FireAlarmAssumption>();
        public List<LayoutPlacedInstance> placed { get; set; } = new List<LayoutPlacedInstance>();
        public List<string> warnings { get; set; } = new List<string>();
        public List<string> errors { get; set; } = new List<string>();
        public int uncoveredMarkersCreated { get; set; }
    }
}

