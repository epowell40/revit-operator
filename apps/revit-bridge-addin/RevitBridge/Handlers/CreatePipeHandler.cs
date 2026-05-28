using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Plumbing;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public class CreatePipeHandler : IRequestHandler
    {
        public class Params
        {
            public string levelName { get; set; }
            public double startX { get; set; }
            public double startY { get; set; }
            public double startZ { get; set; }
            public double endX { get; set; }
            public double endY { get; set; }
            public double endZ { get; set; }
            public string systemType { get; set; } = "Hydronic Supply";
            public string pipeType { get; set; } = "Default"; 
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            using (Transaction trans = new Transaction(doc, "Create Pipe"))
            {
                trans.Start();

                Level level = new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .FirstOrDefault(l => l.Name.Equals(p.levelName, StringComparison.OrdinalIgnoreCase));
                
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

                XYZ p1 = new XYZ(p.startX, p.startY, p.startZ);
                XYZ p2 = new XYZ(p.endX, p.endY, p.endZ);

                Pipe pipe = Pipe.Create(doc, sysType.Id, pType.Id, level.Id, p1, p2);

                trans.Commit();

                return Task.FromResult<object>(new 
                { 
                    id = RevitBridge.Common.ElementIdCompat.GetValue(pipe.Id), 
                    type = pipe.PipeType.Name,
                    system = pipe.MEPSystem.Name,
                    length = pipe.get_Parameter(BuiltInParameter.CURVE_ELEM_LENGTH)?.AsDouble() 
                });
            }
        }
    }
}
