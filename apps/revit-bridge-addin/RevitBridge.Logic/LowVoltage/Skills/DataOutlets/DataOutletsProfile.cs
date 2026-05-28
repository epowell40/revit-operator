using System;
using System.Collections.Generic;

namespace RevitBridge.Logic.LowVoltage.Skills.DataOutlets
{
    public class DataOutletsProfile
    {
        public string Discipline { get; set; } = "data_outlets";
        public string OccupancyProfile { get; set; } = "hospital_default";
        public Dictionary<string, DataEndpointRequirement> EndpointTypeRequirements { get; set; } = new Dictionary<string, DataEndpointRequirement>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, List<string>> FamilySymbolPreferences { get; set; } = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        public DataOutletScoringParameters ScoringParameters { get; set; } = new DataOutletScoringParameters();
        public DataOutletReviewParameters ReviewParameters { get; set; } = new DataOutletReviewParameters();
        public List<string> ReviewConditions { get; set; } = new List<string> { "unknown_endpoint", "missing_family_symbol", "host_ambiguity" };

        public static DataOutletsProfile CreateDefault()
        {
            var profile = new DataOutletsProfile();

            profile.EndpointTypeRequirements["workstation_computer"] = new DataEndpointRequirement
            {
                DeviceCategory = "data_outlet",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "room_entry", "wall_host" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 8.0,
                MinSeparationFt = 3.0,
                ClusterDistanceFt = 4.0,
                PreferredElevationFt = 1.5,
                MinElevationFt = 1.0,
                MaxElevationFt = 2.0,
                PreferredDirections = new List<string> { "left", "right" }
            };

            profile.EndpointTypeRequirements["printer"] = new DataEndpointRequirement
            {
                DeviceCategory = "data_outlet",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "wall_host", "room_entry" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 10.0,
                MinSeparationFt = 4.0,
                ClusterDistanceFt = 5.0,
                PreferredElevationFt = 1.5,
                MinElevationFt = 1.0,
                MaxElevationFt = 2.0,
                PreferredDirections = new List<string> { "left", "right", "back" }
            };

            profile.EndpointTypeRequirements["tv_display"] = new DataEndpointRequirement
            {
                DeviceCategory = "data_outlet",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "wall_host" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 6.0,
                MinSeparationFt = 4.0,
                ClusterDistanceFt = 4.0,
                PreferredElevationFt = 5.0,
                MinElevationFt = 4.0,
                MaxElevationFt = 7.0,
                PreferredDirections = new List<string> { "back" }
            };

            profile.EndpointTypeRequirements["wall_display"] = new DataEndpointRequirement
            {
                DeviceCategory = "data_outlet",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "wall_host" },
                HostPreference = "wall",
                MinDistanceFt = 0.5,
                MaxDistanceFt = 5.0,
                MinSeparationFt = 4.0,
                ClusterDistanceFt = 4.0,
                PreferredElevationFt = 5.0,
                MinElevationFt = 4.0,
                MaxElevationFt = 7.0,
                PreferredDirections = new List<string> { "back" }
            };

            profile.EndpointTypeRequirements["workstation_desk"] = new DataEndpointRequirement
            {
                DeviceCategory = "data_outlet",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "room_entry", "wall_host" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 10.0,
                MinSeparationFt = 4.0,
                ClusterDistanceFt = 5.0,
                PreferredElevationFt = 1.5,
                MinElevationFt = 1.0,
                MaxElevationFt = 2.0,
                PreferredDirections = new List<string> { "left", "right" }
            };

            profile.EndpointTypeRequirements["nurse_station_it"] = new DataEndpointRequirement
            {
                DeviceCategory = "data_outlet",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "wall_host", "room_entry" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 10.0,
                MinSeparationFt = 4.0,
                ClusterDistanceFt = 5.0,
                PreferredElevationFt = 1.5,
                MinElevationFt = 1.0,
                MaxElevationFt = 2.0,
                PreferredDirections = new List<string> { "front", "left", "right" }
            };

            profile.EndpointTypeRequirements["kiosk"] = new DataEndpointRequirement
            {
                DeviceCategory = "data_outlet",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "wall_host" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 8.0,
                MinSeparationFt = 4.0,
                ClusterDistanceFt = 4.0,
                PreferredElevationFt = 1.5,
                MinElevationFt = 1.0,
                MaxElevationFt = 2.0,
                PreferredDirections = new List<string> { "back" }
            };

            profile.EndpointTypeRequirements["medical_it_equipment"] = new DataEndpointRequirement
            {
                DeviceCategory = "data_outlet",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "wall_host", "room_entry" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 8.0,
                MinSeparationFt = 4.0,
                ClusterDistanceFt = 4.0,
                PreferredElevationFt = 1.5,
                MinElevationFt = 1.0,
                MaxElevationFt = 2.0,
                PreferredDirections = new List<string> { "back", "left", "right" }
            };

            profile.EndpointTypeRequirements["unknown_it_endpoint"] = new DataEndpointRequirement
            {
                RequiresOutlet = false,
                DeviceCategory = "data_outlet",
                CandidateStrategies = new List<string>(),
                HostPreference = "wall",
                ReviewIfUnknownHost = true
            };

            profile.FamilySymbolPreferences["data_outlet"] = new List<string> { "data", "communication", "telecom", "outlet", "device" };

            return profile;
        }
    }

    public class DataEndpointRequirement
    {
        public bool RequiresOutlet { get; set; } = true;
        public string DeviceCategory { get; set; } = "data_outlet";
        public List<string> CandidateStrategies { get; set; } = new List<string>();
        public string HostPreference { get; set; } = "wall";
        public double MinDistanceFt { get; set; } = 1.0;
        public double MaxDistanceFt { get; set; } = 8.0;
        public double MinSeparationFt { get; set; } = 4.0;
        public double ClusterDistanceFt { get; set; } = 4.0;
        public double PreferredElevationFt { get; set; } = 1.5;
        public double MinElevationFt { get; set; } = 1.0;
        public double MaxElevationFt { get; set; } = 2.0;
        public List<string> PreferredDirections { get; set; } = new List<string>();
        public bool ReviewIfUnknownHost { get; set; } = true;
    }

    public class DataOutletScoringParameters
    {
        public double PreferredStrategyBonus { get; set; } = 40.0;
        public double HostMatchBonus { get; set; } = 25.0;
        public double PreferredDirectionBonus { get; set; } = 8.0;
        public double DistancePenaltyWeight { get; set; } = 3.0;
        public double RoomEntryBonus { get; set; } = 8.0;
    }

    public class DataOutletReviewParameters
    {
        public bool MissingFamilyRequiresReview { get; set; } = true;
        public bool UnknownEndpointRequiresReview { get; set; } = true;
        public List<string> UnknownEndpointKeywords { get; set; } = new List<string>
        {
            "computer",
            "printer",
            "monitor",
            "display",
            "tv",
            "kiosk",
            "terminal",
            "telemed"
        };
    }
}
