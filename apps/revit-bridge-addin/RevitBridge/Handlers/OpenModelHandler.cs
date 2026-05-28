using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public class OpenModelHandler : IRequestHandler
    {
        public class Params
        {
            public string filePath { get; set; }
            public bool audit { get; set; } = false;
            public bool detach { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            
            if (!File.Exists(p.filePath))
                throw new FileNotFoundException($"Model file not found: {p.filePath}");

            // Opening a document usually requires no active transaction, 
            // but must be done on UI thread (which we are).
            
            ModelPath modelPath = ModelPathUtils.ConvertUserVisiblePathToModelPath(p.filePath);
            OpenOptions opts = new OpenOptions();
            opts.Audit = p.audit;
            
            if (p.detach)
            {
                opts.DetachFromCentralOption = DetachFromCentralOption.DetachAndPreserveWorksets;
            }

            try 
            {
                UIDocument uidoc = app.OpenAndActivateDocument(modelPath, opts, false);
                var settings = BuildProjectSettings(uidoc.Document);
                return Task.FromResult<object>(new 
                { 
                    status = "Success", 
                    title = uidoc.Document.Title,
                    path = uidoc.Document.PathName,
                    settings
                });
            }
            catch (Exception ex)
            {
                // If it fails (e.g., already open), we might try to just activate it?
                foreach(Document d in app.Application.Documents)
                {
                    if (d.PathName.Equals(p.filePath, StringComparison.OrdinalIgnoreCase))
                    {
                        // Already open, try to activate (limited API for activation without open)
                        // But OpenAndActivate usually handles switching if already open? 
                        // Sometimes it throws if already active.
                        var settings = BuildProjectSettings(d);
                        return Task.FromResult<object>(new { status = "Already Open", title = d.Title, path = d.PathName, settings });
                    }
                }
                throw ex;
            }
        }

        private static object BuildProjectSettings(Document doc)
        {
            var units = ReadLengthUnitLabel(doc);
            var activeView = doc.ActiveView;
            var discipline = ReadActiveViewDiscipline(activeView);

            return new
            {
                lengthUnit = units,
                activeView = activeView == null
                    ? null
                    : new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(activeView.Id),
                        name = activeView.Name,
                        discipline
                    }
            };
        }

        private static string? ReadLengthUnitLabel(Document doc)
        {
            try
            {
                var units = doc.GetUnits();
                if (units == null) return null;

                // Revit 2022+: Units.GetFormatOptions(ForgeTypeId) with SpecTypeId.Length.
                try
                {
                    var specTypeIdType = Type.GetType("Autodesk.Revit.DB.SpecTypeId, RevitAPI");
                    var lengthProp = specTypeIdType?.GetProperty("Length", BindingFlags.Public | BindingFlags.Static);
                    var lengthSpec = lengthProp?.GetValue(null);
                    if (lengthSpec != null)
                    {
                        var getFo = units.GetType().GetMethod("GetFormatOptions", new[] { lengthSpec.GetType() });
                        var fo = getFo?.Invoke(units, new[] { lengthSpec });
                        var label = ReadUnitLabelFromFormatOptions(fo);
                        if (!string.IsNullOrWhiteSpace(label)) return label;
                    }
                }
                catch
                {
                    // fall through to legacy path
                }

                // Legacy fallback (pre-ForgeTypeId contract).
                var unitType = Type.GetType("Autodesk.Revit.DB.UnitType, RevitAPI");
                if (unitType != null && Enum.GetNames(unitType).Contains("UT_Length"))
                {
                    var utLength = Enum.Parse(unitType, "UT_Length");
                    var getFoLegacy = units.GetType().GetMethod("GetFormatOptions", new[] { unitType });
                    var fo = getFoLegacy?.Invoke(units, new[] { utLength });
                    var label = ReadUnitLabelFromFormatOptions(fo);
                    if (!string.IsNullOrWhiteSpace(label)) return label;
                }
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private static string? ReadUnitLabelFromFormatOptions(object? formatOptions)
        {
            if (formatOptions == null) return null;

            try
            {
                var getUnitTypeId = formatOptions.GetType().GetMethod("GetUnitTypeId", Type.EmptyTypes);
                var unitTypeId = getUnitTypeId?.Invoke(formatOptions, null);
                var token = ReadForgeTypeIdToken(unitTypeId);
                if (!string.IsNullOrWhiteSpace(token)) return token;
            }
            catch
            {
                // ignore
            }

            try
            {
                var displayProp = formatOptions.GetType().GetProperty("DisplayUnits", BindingFlags.Public | BindingFlags.Instance);
                var display = displayProp?.GetValue(formatOptions, null)?.ToString();
                if (!string.IsNullOrWhiteSpace(display)) return display;
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private static string? ReadForgeTypeIdToken(object? forgeTypeId)
        {
            if (forgeTypeId == null) return null;
            try
            {
                var typeIdProp = forgeTypeId.GetType().GetProperty("TypeId", BindingFlags.Public | BindingFlags.Instance);
                var raw = typeIdProp?.GetValue(forgeTypeId, null)?.ToString();
                if (!string.IsNullOrWhiteSpace(raw)) return raw;
            }
            catch
            {
                // ignore
            }
            return forgeTypeId.ToString();
        }

        private static string? ReadActiveViewDiscipline(View? view)
        {
            if (view == null) return null;
            try
            {
                var prop = view.GetType().GetProperty("Discipline", BindingFlags.Public | BindingFlags.Instance);
                var value = prop?.GetValue(view, null);
                return value?.ToString();
            }
            catch
            {
                return null;
            }
        }
    }
}
