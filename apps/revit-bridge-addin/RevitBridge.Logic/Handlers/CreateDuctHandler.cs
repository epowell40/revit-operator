using System;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.Drafting;

namespace RevitBridge.Logic.Handlers
{
    public class CreateDuctHandler : IRequestHandler
    {
        public class Params
        {
            public string? levelName { get; set; }
            public double startX { get; set; }
            public double startY { get; set; }
            public double startZ { get; set; }
            public double endX { get; set; }
            public double endY { get; set; }
            public double endZ { get; set; }
            public string systemType { get; set; } = "Supply Air";
            public string ductType { get; set; } = "Radius Elbows / Tees"; // Default standard type
            public string? frameId { get; set; }
            public DraftPoint? startPoint { get; set; }
            public DraftPoint? endPoint { get; set; }
            public string? ductSize { get; set; } // e.g. "10x12" or "12"
            public string? width { get; set; } // optional explicit width
            public string? height { get; set; } // optional explicit height
            public string? diameter { get; set; } // optional explicit diameter
            public bool dryRun { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var doc = app.ActiveUIDocument.Document;

            using (Transaction trans = new Transaction(doc, "Create Duct"))
            {
                trans.Start();

                // 1. Find Level
                Level level = new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .FirstOrDefault(l => !string.IsNullOrWhiteSpace(p.levelName) && l.Name.Equals(p.levelName, StringComparison.OrdinalIgnoreCase));
                
                if (level == null) 
                    level = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().FirstOrDefault();

                // 2. Find System Type
                MEPSystemType sysType = new FilteredElementCollector(doc)
                    .OfClass(typeof(MEPSystemType))
                    .Cast<MEPSystemType>()
                    .FirstOrDefault(s => s.Name.Contains(p.systemType));

                if (sysType == null)
                    sysType = new FilteredElementCollector(doc).OfClass(typeof(MEPSystemType)).Cast<MEPSystemType>().FirstOrDefault();

                // 3. Find Duct Type
                DuctType dType = new FilteredElementCollector(doc)
                    .OfClass(typeof(DuctType))
                    .Cast<DuctType>()
                    .FirstOrDefault(d => d.Name.Contains(p.ductType));
                
                if (dType == null)
                    dType = new FilteredElementCollector(doc).OfClass(typeof(DuctType)).Cast<DuctType>().FirstOrDefault();

                if (level == null || sysType == null || dType == null)
                    throw new Exception("Could not find required definitions (Level, SystemType, or DuctType).");

                XYZ p1 = ResolvePoint(p.startPoint, p.startX, p.startY, p.startZ, p.frameId);
                XYZ p2 = ResolvePoint(p.endPoint, p.endX, p.endY, p.endZ, p.frameId);

                Duct duct = Duct.Create(doc, sysType.Id, dType.Id, level.Id, p1, p2);
                var requested = BuildRequestedSizeText(p);
                var size = ParseRequestedSizeFeet(p);
                var widthApplied = false;
                var heightApplied = false;
                var diameterApplied = false;
                if (size.widthFt.HasValue) widthApplied = TrySetWidthFeet(duct, size.widthFt.Value);
                if (size.heightFt.HasValue) heightApplied = TrySetHeightFeet(duct, size.heightFt.Value);
                if (size.diameterFt.HasValue) diameterApplied = TrySetDiameterFeet(duct, size.diameterFt.Value);

                var result = new 
                { 
                    id = RevitBridge.Common.ElementIdCompat.GetValue(duct.Id),
                    type = duct.DuctType.Name,
                    system = duct.MEPSystem?.Name,
                    lengthFt = duct.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH)?.AsDouble(),
                    start = new { x = p1.X, y = p1.Y, z = p1.Z },
                    end = new { x = p2.X, y = p2.Y, z = p2.Z },
                    requestedSize = requested,
                    sizeApplied = new
                    {
                        width = widthApplied,
                        height = heightApplied,
                        diameter = diameterApplied
                    },
                    status = p.dryRun ? "Dry Run" : "Created"
                };

                if (p.dryRun)
                {
                    trans.RollBack();
                }
                else
                {
                    trans.Commit();
                }

                return Task.FromResult<object>(result);
            }
        }

        private static XYZ ResolvePoint(DraftPoint? point, double x, double y, double z, string? frameId)
        {
            if (point != null) return point.Resolve(frameId);
            return new XYZ(x, y, z);
        }

        private static string? BuildRequestedSizeText(Params p)
        {
            var direct = (p.ductSize ?? "").Trim();
            if (direct.Length > 0) return direct;

            var w = (p.width ?? "").Trim();
            var h = (p.height ?? "").Trim();
            var d = (p.diameter ?? "").Trim();
            if (w.Length > 0 && h.Length > 0) return $"{w}x{h}";
            if (d.Length > 0) return d;
            return null;
        }

        private static (double? widthFt, double? heightFt, double? diameterFt) ParseRequestedSizeFeet(Params p)
        {
            var size = (p.ductSize ?? "").Trim().Replace("×", "x").Replace("X", "x");
            if (size.Length > 0 && size.Contains("x"))
            {
                var parts = size.Split(new[] { 'x' }, StringSplitOptions.RemoveEmptyEntries).Select(s => s.Trim()).ToArray();
                if (parts.Length == 2)
                {
                    var w = ParseLengthFeet(parts[0]);
                    var h = ParseLengthFeet(parts[1]);
                    return (w, h, null);
                }
            }
            if (size.Length > 0)
            {
                var d = ParseLengthFeet(size);
                return (null, null, d);
            }

            var width = ParseLengthFeet((p.width ?? "").Trim());
            var height = ParseLengthFeet((p.height ?? "").Trim());
            var diameter = ParseLengthFeet((p.diameter ?? "").Trim());
            return (width, height, diameter);
        }

        private static double? ParseLengthFeet(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return null;
            var t = raw.Trim().ToLowerInvariant();
            var isFeet = t.Contains("ft") || t.Contains("'");
            t = t.Replace("inches", "").Replace("inch", "").Replace("in", "");
            t = t.Replace("feet", "").Replace("foot", "").Replace("ft", "");
            t = t.Replace("\"", "").Replace("'", "").Trim();
            if (!double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out var n)) return null;
            if (double.IsNaN(n) || double.IsInfinity(n) || n <= 0) return null;
            return isFeet ? n : n / 12.0;
        }

        private static bool TrySetWidthFeet(Duct duct, double feet)
        {
            if (TrySetBuiltinDouble(duct, BuiltInParameter.RBS_CURVE_WIDTH_PARAM, feet)) return true;
            if (TrySetNamedDouble(duct, new[] { "Width", "Duct Width", "W" }, feet)) return true;
            return false;
        }

        private static bool TrySetHeightFeet(Duct duct, double feet)
        {
            if (TrySetBuiltinDouble(duct, BuiltInParameter.RBS_CURVE_HEIGHT_PARAM, feet)) return true;
            if (TrySetNamedDouble(duct, new[] { "Height", "Duct Height", "H" }, feet)) return true;
            return false;
        }

        private static bool TrySetDiameterFeet(Duct duct, double feet)
        {
            if (TrySetBuiltinDouble(duct, BuiltInParameter.RBS_CURVE_DIAMETER_PARAM, feet)) return true;
            if (TrySetNamedDouble(duct, new[] { "Diameter", "Duct Diameter", "Size" }, feet)) return true;
            return false;
        }

        private static bool TrySetBuiltinDouble(Element e, BuiltInParameter bip, double value)
        {
            try
            {
                var p = e.get_Parameter(bip);
                if (p == null || p.IsReadOnly || p.StorageType != StorageType.Double) return false;
                return p.Set(value);
            }
            catch
            {
                return false;
            }
        }

        private static bool TrySetNamedDouble(Element e, string[] names, double value)
        {
            foreach (var n in names)
            {
                try
                {
                    var p = e.LookupParameter(n);
                    if (p == null || p.IsReadOnly || p.StorageType != StorageType.Double) continue;
                    if (p.Set(value)) return true;
                }
                catch
                {
                    // ignore and continue
                }
            }
            return false;
        }
    }
}

