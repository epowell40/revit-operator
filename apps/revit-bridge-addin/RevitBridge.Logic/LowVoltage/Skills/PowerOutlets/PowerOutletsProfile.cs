using System;
using System.Collections.Generic;

namespace RevitBridge.Logic.LowVoltage.Skills.PowerOutlets
{
    public class PowerOutletsProfile
    {
        public string Discipline { get; set; } = "power_outlets";
        public string OccupancyProfile { get; set; } = "hospital_default";
        public Dictionary<string, PowerEndpointRequirement> EndpointRequirements { get; set; } = new Dictionary<string, PowerEndpointRequirement>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, List<string>> ReceptacleTypePreferences { get; set; } = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        public PowerDuplicateSuppressionParameters DuplicateSuppressionRules { get; set; } = new PowerDuplicateSuppressionParameters();
        public PowerOutletScoringParameters ScoringParameters { get; set; } = new PowerOutletScoringParameters();
        public PowerOutletReviewParameters ReviewParameters { get; set; } = new PowerOutletReviewParameters();
        public List<string> ReviewConditions { get; set; } = new List<string> { "unknown_power_endpoint", "missing_family_symbol", "host_ambiguity" };

        public static PowerOutletsProfile CreateDefault()
        {
            var profile = new PowerOutletsProfile();

            profile.EndpointRequirements["refrigerator"] = new PowerEndpointRequirement
            {
                DeviceCategory = "dedicated_receptacle",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "wall_host", "room_entry" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 6.0,
                MinSeparationFt = 4.0,
                ClusterDistanceFt = 4.0,
                PreferredElevationFt = 1.5,
                MinElevationFt = 1.0,
                MaxElevationFt = 2.0,
                PreferredDirections = new List<string> { "back", "left", "right" }
            };

            profile.EndpointRequirements["workstation_computer"] = new PowerEndpointRequirement
            {
                DeviceCategory = "duplex_receptacle",
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

            profile.EndpointRequirements["printer"] = new PowerEndpointRequirement
            {
                DeviceCategory = "duplex_receptacle",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "wall_host", "room_entry" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 8.0,
                MinSeparationFt = 4.0,
                ClusterDistanceFt = 5.0,
                PreferredElevationFt = 1.5,
                MinElevationFt = 1.0,
                MaxElevationFt = 2.0,
                PreferredDirections = new List<string> { "back", "left", "right" }
            };

            profile.EndpointRequirements["tv_display"] = new PowerEndpointRequirement
            {
                DeviceCategory = "clock_receptacle",
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

            profile.EndpointRequirements["microwave"] = new PowerEndpointRequirement
            {
                DeviceCategory = "dedicated_receptacle",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "wall_host", "room_entry" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 6.0,
                MinSeparationFt = 4.0,
                ClusterDistanceFt = 4.0,
                PreferredElevationFt = 1.5,
                MinElevationFt = 1.0,
                MaxElevationFt = 2.0,
                PreferredDirections = new List<string> { "back", "left", "right" }
            };

            profile.EndpointRequirements["breakroom_appliance"] = new PowerEndpointRequirement
            {
                DeviceCategory = "dedicated_receptacle",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "wall_host", "room_entry" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 6.0,
                MinSeparationFt = 4.0,
                ClusterDistanceFt = 4.0,
                PreferredElevationFt = 1.5,
                MinElevationFt = 1.0,
                MaxElevationFt = 2.0,
                PreferredDirections = new List<string> { "back", "left", "right" }
            };

            profile.EndpointRequirements["nurse_station_equipment"] = new PowerEndpointRequirement
            {
                DeviceCategory = "duplex_receptacle",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "wall_host", "room_entry" },
                HostPreference = "wall",
                MinDistanceFt = 1.0,
                MaxDistanceFt = 8.0,
                MinSeparationFt = 4.0,
                ClusterDistanceFt = 5.0,
                PreferredElevationFt = 1.5,
                MinElevationFt = 1.0,
                MaxElevationFt = 2.0,
                PreferredDirections = new List<string> { "front", "left", "right" }
            };

            profile.EndpointRequirements["mobile_equipment_dock"] = new PowerEndpointRequirement
            {
                DeviceCategory = "dedicated_receptacle",
                CandidateStrategies = new List<string> { "endpoint_wall_host", "wall_host", "room_entry" },
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

            profile.EndpointRequirements["medical_equipment_powered"] = new PowerEndpointRequirement
            {
                DeviceCategory = "dedicated_receptacle",
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

            profile.EndpointRequirements["unknown_power_endpoint"] = new PowerEndpointRequirement
            {
                RequiresOutlet = false,
                DeviceCategory = "duplex_receptacle",
                CandidateStrategies = new List<string>(),
                HostPreference = "wall",
                ReviewIfUnknownHost = true
            };

            profile.ReceptacleTypePreferences["duplex_receptacle"] = new List<string> { "power", "duplex", "receptacle", "device" };
            profile.ReceptacleTypePreferences["dedicated_receptacle"] = new List<string> { "power", "dedicated", "receptacle", "device" };
            profile.ReceptacleTypePreferences["clock_receptacle"] = new List<string> { "clock", "power", "receptacle", "device" };

            return profile;
        }
    }

    public class PowerEndpointRequirement
    {
        public bool RequiresOutlet { get; set; } = true;
        public string DeviceCategory { get; set; } = "duplex_receptacle";
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

    public class PowerDuplicateSuppressionParameters
    {
        public double DefaultClusterDistanceFt { get; set; } = 4.0;
        public double DefaultMinSeparationFt { get; set; } = 4.0;
    }

    public class PowerOutletScoringParameters
    {
        public double PreferredStrategyBonus { get; set; } = 40.0;
        public double HostMatchBonus { get; set; } = 25.0;
        public double PreferredDirectionBonus { get; set; } = 8.0;
        public double DistancePenaltyWeight { get; set; } = 3.0;
        public double RoomEntryBonus { get; set; } = 8.0;
    }

    public class PowerOutletReviewParameters
    {
        public bool MissingFamilyRequiresReview { get; set; } = true;
        public bool UnknownEndpointRequiresReview { get; set; } = true;
        public List<string> UnknownEndpointKeywords { get; set; } = new List<string>
        {
            "fridge",
            "refrigerator",
            "microwave",
            "appliance",
            "printer",
            "computer",
            "dock",
            "charger",
            "equipment"
        };
    }
}
