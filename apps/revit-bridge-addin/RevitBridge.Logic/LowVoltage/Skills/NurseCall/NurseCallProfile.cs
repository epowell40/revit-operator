using System;
using System.Collections.Generic;

namespace RevitBridge.Logic.LowVoltage.Skills.NurseCall
{
    public class NurseCallProfile
    {
        public string Discipline { get; set; } = "nurse_call";
        public string OccupancyProfile { get; set; } = "hospital_default";
        public Dictionary<string, NurseCallRoomRequirement> RoomTypeRequirements { get; set; } = new Dictionary<string, NurseCallRoomRequirement>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, NurseCallAnchorPreference> AnchorPreferences { get; set; } = new Dictionary<string, NurseCallAnchorPreference>(StringComparer.OrdinalIgnoreCase);
        public NurseCallDistanceParameters DistanceParameters { get; set; } = new NurseCallDistanceParameters();
        public NurseCallMountingParameters MountingParameters { get; set; } = new NurseCallMountingParameters();
        public Dictionary<string, List<string>> FamilySymbolPreferences { get; set; } = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        public List<string> ReviewConditions { get; set; } = new List<string> { "missing_anchor", "host_ambiguity", "unknown_fixture", "missing_family_symbol" };
        public Dictionary<string, List<string>> SpaceTypeMappings { get; set; } = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, List<string>> AnchorSemanticMappings { get; set; } = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);

        public static NurseCallProfile CreateDefault()
        {
            var profile = new NurseCallProfile();
            profile.SpaceTypeMappings["patient_room"] = new List<string> { "patient_room" };
            profile.SpaceTypeMappings["patient_toilet"] = new List<string> { "toilet_room", "patient_toilet" };
            profile.SpaceTypeMappings["shower_room"] = new List<string> { "shower" };
            profile.SpaceTypeMappings["nurse_station"] = new List<string> { "nurse_station" };
            profile.SpaceTypeMappings["staff_area"] = new List<string> { "workroom", "staff", "office" };
            profile.SpaceTypeMappings["unknown"] = new List<string>();

            profile.AnchorSemanticMappings["bed"] = new List<string> { "bed" };
            profile.AnchorSemanticMappings["toilet"] = new List<string> { "toilet" };
            profile.AnchorSemanticMappings["shower"] = new List<string> { "shower_fixture", "shower", "bath_fixture" };
            profile.AnchorSemanticMappings["staff_console"] = new List<string> { "nurse_console", "workstation", "workstation_desk" };

            profile.RoomTypeRequirements["patient_room"] = new NurseCallRoomRequirement
            {
                RequiredAnchors = new List<string> { "bed" },
                FallbackAnchors = new List<string> { "room_entry" },
                ReviewIfNoAnchor = true
            };
            profile.RoomTypeRequirements["patient_toilet"] = new NurseCallRoomRequirement
            {
                RequiredAnchors = new List<string> { "toilet" },
                FallbackAnchors = new List<string>(),
                ReviewIfNoAnchor = true
            };
            profile.RoomTypeRequirements["shower_room"] = new NurseCallRoomRequirement
            {
                RequiredAnchors = new List<string> { "shower" },
                FallbackAnchors = new List<string>(),
                ReviewIfNoAnchor = true
            };
            profile.RoomTypeRequirements["nurse_station"] = new NurseCallRoomRequirement
            {
                RequiredAnchors = new List<string> { "staff_console" },
                FallbackAnchors = new List<string> { "room_center" },
                ReviewIfNoAnchor = false
            };

            profile.AnchorPreferences["bed"] = new NurseCallAnchorPreference
            {
                DeviceCategory = "patient_station",
                CandidateStrategies = new List<string> { "anchor_wall_host", "room_entry", "wall_host" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 8.0,
                MinSeparationFt = 4.0,
                PreferredDirections = new List<string> { "left", "right" }
            };
            profile.AnchorPreferences["toilet"] = new NurseCallAnchorPreference
            {
                DeviceCategory = "toilet_pull",
                CandidateStrategies = new List<string> { "anchor_wall_host", "wall_host", "room_entry" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 6.0,
                MinSeparationFt = 3.0,
                PreferredDirections = new List<string> { "left", "right" }
            };
            profile.AnchorPreferences["shower"] = new NurseCallAnchorPreference
            {
                DeviceCategory = "shower_pull",
                CandidateStrategies = new List<string> { "anchor_wall_host", "wall_host", "room_entry" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 6.0,
                MinSeparationFt = 3.0,
                PreferredDirections = new List<string> { "left", "right" }
            };
            profile.AnchorPreferences["staff_console"] = new NurseCallAnchorPreference
            {
                DeviceCategory = "staff_console",
                CandidateStrategies = new List<string> { "anchor_wall_host", "anchor_ceiling_host", "room_center" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 10.0,
                MinSeparationFt = 4.0,
                PreferredDirections = new List<string> { "front", "side" }
            };

            profile.FamilySymbolPreferences["patient_station"] = new List<string> { "nurse call", "patient", "station" };
            profile.FamilySymbolPreferences["toilet_pull"] = new List<string> { "nurse call", "toilet", "pull" };
            profile.FamilySymbolPreferences["shower_pull"] = new List<string> { "nurse call", "shower", "pull" };
            profile.FamilySymbolPreferences["staff_console"] = new List<string> { "nurse call", "console", "staff" };

            profile.MountingParameters.DefaultHostByDeviceCategory["patient_station"] = "wall";
            profile.MountingParameters.DefaultHostByDeviceCategory["toilet_pull"] = "wall";
            profile.MountingParameters.DefaultHostByDeviceCategory["shower_pull"] = "wall";
            profile.MountingParameters.DefaultHostByDeviceCategory["staff_console"] = "wall";

            return profile;
        }
    }

    public class NurseCallRoomRequirement
    {
        public List<string> RequiredAnchors { get; set; } = new List<string>();
        public List<string> FallbackAnchors { get; set; } = new List<string>();
        public bool ReviewIfNoAnchor { get; set; }
    }

    public class NurseCallAnchorPreference
    {
        public string DeviceCategory { get; set; } = string.Empty;
        public List<string> CandidateStrategies { get; set; } = new List<string>();
        public string HostPreference { get; set; } = "wall";
        public double MinDistanceFt { get; set; } = 1.0;
        public double MaxDistanceFt { get; set; } = 8.0;
        public double MinSeparationFt { get; set; } = 4.0;
        public List<string> PreferredDirections { get; set; } = new List<string>();
    }

    public class NurseCallDistanceParameters
    {
        public double RoomEntryFallbackOffsetFt { get; set; } = 2.0;
        public double HostAmbiguityToleranceFt { get; set; } = 0.5;
    }

    public class NurseCallMountingParameters
    {
        public Dictionary<string, string> DefaultHostByDeviceCategory { get; set; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    }
}
