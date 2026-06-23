using System;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers.Drafting;

namespace RevitBridge.Logic.Handlers
{
    public class CreatePipeHandler : IRequestHandler
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
            public string systemType { get; set; } = "Hydronic Supply";
            public string pipeType { get; set; } = "Default"; 
            public string? frameId { get; set; }
            public DraftPoint? startPoint { get; set; }
            public DraftPoint? endPoint { get; set; }
            public string? diameter { get; set; }
            public string? pipeSize { get; set; }
            public bool dryRun { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var doc = app.ActiveUIDocument.Document;

            using (Transaction trans = new Transaction(doc, "Create Pipe"))
            {
                trans.Start();

                Level level = new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .FirstOrDefault(l => !string.IsNullOrWhiteSpace(p.levelName) && l.Name.Equals(p.levelName, StringComparison.OrdinalIgnoreCase));
                
                if (level == null) 
                    level = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().FirstOrDefault();

                MEPSystemType sysType = new FilteredElementCollector(doc)
                    .OfClass(typeof(MEPSystemType))
                    .Cast<MEPSystemType>()
                    .FirstOrDefault(s => s.Name.Contains(p.systemType));

                if (sysType == null)
                    sysType = new FilteredElementCollector(doc).OfClass(typeof(MEPSystemType)).Cast<MEPSystemType>().FirstOrDefault();

                PipeType pType = new FilteredElementCollector(doc)
                    .OfClass(typeof(PipeType))
                    .Cast<PipeType>()
                    .FirstOrDefault(d => d.Name.Contains(p.pipeType));
                
                if (pType == null)
                    pType = new FilteredElementCollector(doc).OfClass(typeof(PipeType)).Cast<PipeType>().FirstOrDefault();

                if (level == null || sysType == null || pType == null)
                    throw new Exception("Could not find required definitions (Level, SystemType, or PipeType).");

                XYZ p1 = ResolvePoint(p.startPoint, p.startX, p.startY, p.startZ, p.frameId);
                XYZ p2 = ResolvePoint(p.endPoint, p.endX, p.endY, p.endZ, p.frameId);

                Pipe pipe = Pipe.Create(doc, sysType.Id, pType.Id, level.Id, p1, p2);
                var requestedDiameter = BuildRequestedDiameterText(p);
                var diameterFt = ParseLengthFeet(requestedDiameter);
                var diameterApplied = diameterFt.HasValue && TrySetDiameterFeet(pipe, diameterFt.Value);

                var result = new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(pipe.Id),
                    type = pipe.PipeType.Name,
                    system = pipe.MEPSystem?.Name,
                    lengthFt = pipe.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH)?.AsDouble(),
                    start = new { x = p1.X, y = p1.Y, z = p1.Z },
                    end = new { x = p2.X, y = p2.Y, z = p2.Z },
                    requestedDiameter,
                    sizeApplied = new { diameter = diameterApplied },
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

        private static string? BuildRequestedDiameterText(Params p)
        {
            var direct = (p.diameter ?? "").Trim();
            if (direct.Length > 0) return direct;
            var size = (p.pipeSize ?? "").Trim();
            return size.Length > 0 ? size : null;
        }

        private static double? ParseLengthFeet(string? raw)
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

        private static bool TrySetDiameterFeet(Pipe pipe, double feet)
        {
            if (TrySetBuiltinDouble(pipe, BuiltInParameter.RBS_PIPE_DIAMETER_PARAM, feet)) return true;
            if (TrySetNamedDouble(pipe, new[] { "Diameter", "Pipe Diameter", "Size" }, feet)) return true;
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

