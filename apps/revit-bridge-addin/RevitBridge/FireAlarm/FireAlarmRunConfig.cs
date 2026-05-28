using System.Collections.Generic;

namespace RevitBridge.FireAlarm
{
    public class FireAlarmRunConfig
    {
        public string profile { get; set; }
        public List<string> devices { get; set; } = new List<string>();
        public PlacementConfig placement { get; set; } = new PlacementConfig();
        public ClassificationConfig classification { get; set; } = new ClassificationConfig();
        public NotificationRequirementConfig notificationRequirement { get; set; } = new NotificationRequirementConfig();
        public CoverageConfig coverage { get; set; } = new CoverageConfig();
        public VisualizerConfig visualizer { get; set; } = new VisualizerConfig();

        public string deviceMappingsPath { get; set; }
    }

    public class PlacementConfig
    {
        public string strobeMount { get; set; } = "CEILING";
        public double corridorMaxSpacingFt { get; set; } = 100;
        public double corridorEndOffsetFt { get; set; } = 15;
        public double minCeilingHeightFt { get; set; } = 6;
        public string invalidCeilingFallback { get; set; } = "LEVEL_TO_LEVEL";
    }

    public class ClassificationConfig
    {
        public List<string> corridorPatterns { get; set; } = new List<string> { "corridor", "corr", "hall", "passage", "vestibule", "entry" };
        public List<string> supportPatterns { get; set; } = new List<string> { "mech", "mechanical", "electrical", "it", "telecom", "jan", "janitor", "closet", "shaft" };
        public List<string> publicPatterns { get; set; } = new List<string> { "lobby", "waiting", "conference", "restroom", "toilet", "classroom" };
    }

    public class NotificationRequirementConfig
    {
        public string @default { get; set; } = "REVIEW";
        public List<string> requireClasses { get; set; } = new List<string> { "CORRIDOR", "PUBLIC" };
        public List<string> excludeClasses { get; set; } = new List<string> { "SUPPORT" };
        public double minRoomAreaFt2Exclude { get; set; } = 25;
    }

    public class CoverageConfig
    {
        // Placeholder default; user should override per project/profile.
        public double strobeRadiusFt { get; set; } = 20;
        public double sampleSpacingFt { get; set; } = 4;
        public double markerHalfSizeFt { get; set; } = 0.6;
        public int maxUncoveredMarkers { get; set; } = 2500;
    }

    public class VisualizerConfig
    {
        public bool enabled { get; set; } = true;
        public List<string> layers { get; set; } = new List<string> { "UNCOVERED" };
    }
}

