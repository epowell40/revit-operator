using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class QueryZoneDataHandler : IRequestHandler
    {
        public class Params
        {
            public string levelName { get; set; }
        }

        public class SpaceData
        {
            public long id { get; set; }
            public string number { get; set; }
            public string name { get; set; }
            public double area { get; set; }
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
        }

        public class ZoneData
        {
            public string zoneId { get; set; } // TZ-01
            public string zoneName { get; set; }
            public List<SpaceData> spaces { get; set; } = new List<SpaceData>();
            public List<long> existingVavIds { get; set; } = new List<long>();
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var doc = app.ActiveUIDocument.Document;

            if (string.IsNullOrWhiteSpace(p.levelName))
                throw new ArgumentException("levelName is required.");

            // 1. Get Level
            Level level = null;
            if (!string.IsNullOrEmpty(p.levelName))
            {
                level = new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .FirstOrDefault(l => l.Name.Equals(p.levelName, StringComparison.OrdinalIgnoreCase));
            }

            if (level == null) throw new ArgumentException($"Level '{p.levelName}' not found.");

            // 2. Get Spaces
            var spaces = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_MEPSpaces)
                .WhereElementIsNotElementType()
                .Where(e => e.LevelId == level.Id)
                .Cast<Space>()
                .ToList();

            // 3. Group by TZ_ZoneId
            var zonesMap = new Dictionary<string, ZoneData>();

            foreach (var s in spaces)
            {
                // Read TZ params
                var pZoneId = s.LookupParameter("TZ_ZoneId");
                var pZoneName = s.LookupParameter("TZ_ZoneName");

                string zId = (pZoneId != null && pZoneId.HasValue) ? pZoneId.AsString() : "Unzoned";
                string zName = (pZoneName != null && pZoneName.HasValue) ? pZoneName.AsString() : "";

                if (string.IsNullOrEmpty(zId)) zId = "Unzoned";

                if (!zonesMap.ContainsKey(zId))
                {
                    zonesMap[zId] = new ZoneData { zoneId = zId, zoneName = zName };
                }

                LocationPoint lp = s.Location as LocationPoint;
                zonesMap[zId].spaces.Add(new SpaceData
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(s.Id),
                    number = s.Number,
                    name = s.Name,
                    area = s.Area, // Internal units (sq ft)
                    x = lp?.Point.X ?? 0,
                    y = lp?.Point.Y ?? 0,
                    z = lp?.Point.Z ?? 0
                });
            }

            // 4. Find Existing VAVs (to avoid dupes or allow updates)
            // Look for Mech Equipment on this level with ROS_ZoneId param
            var existingVavs = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_MechanicalEquipment)
                .WhereElementIsNotElementType()
                .Where(e => e.LevelId == level.Id)
                .ToList();

            foreach (var vav in existingVavs)
            {
                var pRosZone = vav.LookupParameter("ROS_ZoneId");
                if (pRosZone != null && pRosZone.HasValue)
                {
                    string zId = pRosZone.AsString();
                    if (zonesMap.ContainsKey(zId))
                    {
                        zonesMap[zId].existingVavIds.Add(RevitBridge.Common.ElementIdCompat.GetValue(vav.Id));
                    }
                }
            }

            return Task.FromResult<object>(zonesMap.Values.Where(z => z.zoneId != "Unzoned").ToList());
        }
    }
}

