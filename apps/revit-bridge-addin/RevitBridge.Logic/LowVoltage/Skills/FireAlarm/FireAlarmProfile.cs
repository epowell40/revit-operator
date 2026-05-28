using System;
using System.Collections.Generic;

namespace RevitBridge.Logic.LowVoltage.Skills.FireAlarm
{
    public class FireAlarmProfile
    {
        public string Discipline { get; set; } = "fire_alarm";
        public string OccupancyProfile { get; set; } = "hospital_default";
        public FireAlarmCorridorRules CorridorRules { get; set; } = new FireAlarmCorridorRules();
        public FireAlarmOpenAreaRules OpenAreaRules { get; set; } = new FireAlarmOpenAreaRules();
        public Dictionary<string, FireAlarmRoomTypeRule> RoomTypeRules { get; set; } = new Dictionary<string, FireAlarmRoomTypeRule>(StringComparer.OrdinalIgnoreCase);
        public FireAlarmNotificationDefaults NotificationDefaults { get; set; } = new FireAlarmNotificationDefaults();
        public FireAlarmDetectorDefaults DetectorDefaults { get; set; } = new FireAlarmDetectorDefaults();
        public FireAlarmMountingDefaults MountingDefaults { get; set; } = new FireAlarmMountingDefaults();
        public Dictionary<string, List<string>> FamilySymbolPreferences { get; set; } = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        public List<string> ReviewRequiredConditions { get; set; } = new List<string> { "unknown_room_type", "missing_family_symbol", "no_valid_candidates", "mixed_open_group" };
        public Dictionary<string, List<string>> SpaceTypeMappings { get; set; } = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        public FireAlarmCandidateScoring CandidateScoring { get; set; } = new FireAlarmCandidateScoring();

        public static FireAlarmProfile CreateDefault()
        {
            var profile = new FireAlarmProfile();
            profile.SpaceTypeMappings["corridor"] = new List<string> { "corridor", "hall" };
            profile.SpaceTypeMappings["patient_room"] = new List<string> { "patient_room" };
            profile.SpaceTypeMappings["patient_toilet"] = new List<string> { "toilet_room", "patient_toilet", "shower" };
            profile.SpaceTypeMappings["nurse_station"] = new List<string> { "nurse_station" };
            profile.SpaceTypeMappings["waiting"] = new List<string> { "waiting", "lobby" };
            profile.SpaceTypeMappings["support_room"] = new List<string> { "support_room", "support" };
            profile.SpaceTypeMappings["exam_treatment"] = new List<string> { "exam_treatment", "treatment", "exam" };
            profile.SpaceTypeMappings["utility_room"] = new List<string> { "utility_room", "utility", "clean_utility", "soiled_utility" };
            profile.SpaceTypeMappings["office"] = new List<string> { "office" };

            profile.RoomTypeRules["patient_room"] = new FireAlarmRoomTypeRule
            {
                RequireDevice = true,
                DeviceCategories = new List<string> { "notification_strobe" },
                CandidateStrategies = new List<string> { "room_entry", "wall_host", "room_center" },
                HostPreference = "wall",
                GroupMode = "room",
                MaxCoverageAreaFt2 = 400,
                MinSeparationFt = 6,
                MinClearanceFt = 1.5
            };
            profile.RoomTypeRules["patient_toilet"] = new FireAlarmRoomTypeRule
            {
                RequireDevice = true,
                DeviceCategories = new List<string> { "notification_strobe" },
                CandidateStrategies = new List<string> { "room_entry", "wall_host", "room_center" },
                HostPreference = "wall",
                GroupMode = "room",
                MaxCoverageAreaFt2 = 150,
                MinSeparationFt = 4,
                MinClearanceFt = 1.0
            };
            profile.RoomTypeRules["nurse_station"] = new FireAlarmRoomTypeRule
            {
                RequireDevice = true,
                DeviceCategories = new List<string> { "notification_strobe" },
                CandidateStrategies = new List<string> { "ceiling_host", "room_center", "wall_host" },
                HostPreference = "ceiling",
                GroupMode = "open_area",
                MaxCoverageAreaFt2 = 600,
                MinSeparationFt = 8,
                MinClearanceFt = 2.0
            };
            profile.RoomTypeRules["waiting"] = new FireAlarmRoomTypeRule
            {
                RequireDevice = true,
                DeviceCategories = new List<string> { "notification_strobe" },
                CandidateStrategies = new List<string> { "ceiling_host", "room_center", "wall_host" },
                HostPreference = "ceiling",
                GroupMode = "open_area",
                MaxCoverageAreaFt2 = 600,
                MinSeparationFt = 8,
                MinClearanceFt = 2.0
            };
            profile.RoomTypeRules["exam_treatment"] = new FireAlarmRoomTypeRule
            {
                RequireDevice = true,
                DeviceCategories = new List<string> { "notification_strobe" },
                CandidateStrategies = new List<string> { "ceiling_host", "room_center", "wall_host" },
                HostPreference = "ceiling",
                GroupMode = "room",
                MaxCoverageAreaFt2 = 450,
                MinSeparationFt = 8,
                MinClearanceFt = 1.5
            };
            profile.RoomTypeRules["office"] = new FireAlarmRoomTypeRule
            {
                RequireDevice = true,
                DeviceCategories = new List<string> { "notification_strobe" },
                CandidateStrategies = new List<string> { "ceiling_host", "room_center", "wall_host" },
                HostPreference = "ceiling",
                GroupMode = "room",
                MaxCoverageAreaFt2 = 500,
                MinSeparationFt = 8,
                MinClearanceFt = 1.5
            };
            profile.RoomTypeRules["support_room"] = new FireAlarmRoomTypeRule
            {
                RequireDevice = false,
                ReviewRequired = true,
                CandidateStrategies = new List<string> { "room_center" },
                HostPreference = "ceiling",
                GroupMode = "room",
                MaxCoverageAreaFt2 = 0
            };
            profile.RoomTypeRules["utility_room"] = new FireAlarmRoomTypeRule
            {
                RequireDevice = false,
                ReviewRequired = true,
                CandidateStrategies = new List<string> { "room_center" },
                HostPreference = "ceiling",
                GroupMode = "room",
                MaxCoverageAreaFt2 = 0
            };
            profile.RoomTypeRules["unknown"] = new FireAlarmRoomTypeRule
            {
                RequireDevice = false,
                ReviewRequired = true,
                CandidateStrategies = new List<string> { "room_center" },
                HostPreference = "ceiling",
                GroupMode = "room",
                MaxCoverageAreaFt2 = 0
            };

            profile.FamilySymbolPreferences["notification_strobe"] = new List<string> { "fire alarm", "strobe", "notification" };
            profile.FamilySymbolPreferences["smoke_detector"] = new List<string> { "fire alarm", "smoke", "detector" };
            profile.FamilySymbolPreferences["pull_station"] = new List<string> { "fire alarm", "pull", "station" };
            profile.MountingDefaults.DefaultHostByDeviceCategory["notification_strobe"] = "ceiling";
            profile.MountingDefaults.DefaultHostByDeviceCategory["smoke_detector"] = "ceiling";
            profile.MountingDefaults.DefaultHostByDeviceCategory["pull_station"] = "wall";
            return profile;
        }
    }

    public class FireAlarmCorridorRules
    {
        public bool Enabled { get; set; } = true;
        public List<string> DeviceCategories { get; set; } = new List<string> { "notification_strobe" };
        public List<string> CandidateStrategies { get; set; } = new List<string> { "corridor_centerline", "corridor_end_offset", "ceiling_host", "corridor_offset" };
        public string HostPreference { get; set; } = "ceiling";
        public double MaxSpacingFt { get; set; } = 45;
        public double EndOffsetFt { get; set; } = 10;
        public double MinSeparationFt { get; set; } = 10;
        public double MinClearanceFt { get; set; } = 2;
    }

    public class FireAlarmOpenAreaRules
    {
        public bool Enabled { get; set; } = true;
        public bool UseOpenToCorridor { get; set; } = true;
        public bool AllowMixedBuckets { get; set; }
        public int MinRoomsForGroup { get; set; } = 2;
        public List<string> EligibleBuckets { get; set; } = new List<string> { "nurse_station", "waiting", "exam_treatment", "office" };
    }

    public class FireAlarmRoomTypeRule
    {
        public bool RequireDevice { get; set; }
        public bool ReviewRequired { get; set; }
        public List<string> DeviceCategories { get; set; } = new List<string>();
        public List<string> CandidateStrategies { get; set; } = new List<string>();
        public string HostPreference { get; set; } = "any";
        public string GroupMode { get; set; } = "room";
        public double MaxCoverageAreaFt2 { get; set; } = 400;
        public double MaxSpacingFt { get; set; }
        public double MinSeparationFt { get; set; } = 6;
        public double MinClearanceFt { get; set; } = 1.5;
    }

    public class FireAlarmNotificationDefaults
    {
        public bool UnknownRequiresReview { get; set; } = true;
        public bool MissingFamilyRequiresReview { get; set; } = true;
        public bool NoValidCandidatesRequiresReview { get; set; } = true;
    }

    public class FireAlarmDetectorDefaults
    {
        public bool Enabled { get; set; }
        public List<string> CandidateStrategies { get; set; } = new List<string> { "ceiling_host", "room_center" };
        public double MaxCoverageAreaFt2 { get; set; } = 700;
        public string HostPreference { get; set; } = "ceiling";
    }

    public class FireAlarmMountingDefaults
    {
        public Dictionary<string, string> DefaultHostByDeviceCategory { get; set; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    }

    public class FireAlarmCandidateScoring
    {
        public double PreferredStrategyBonus { get; set; } = 25;
        public double HostMatchBonus { get; set; } = 20;
        public double CenteredBonus { get; set; } = 10;
        public double EntryBonus { get; set; } = 6;
        public double CorridorBonus { get; set; } = 12;
        public double ConflictPenaltyWeight { get; set; } = 4;
    }
}
