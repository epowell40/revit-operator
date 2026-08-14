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
            public bool discardExistingOpenDocument { get; set; } = false;
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

            var existing = FindOpenDocument(app, p.filePath);
            if (existing != null)
            {
                var active = app.ActiveUIDocument?.Document;
                if (active != null && active.Equals(existing))
                {
                    var activeSettings = BuildProjectSettings(existing);
                    return Task.FromResult<object>(new
                    {
                        status = "Already Active",
                        title = existing.Title,
                        path = existing.PathName,
                        settings = activeSettings
                    });
                }

                if (!p.discardExistingOpenDocument)
                {
                    var existingSettings = BuildProjectSettings(existing);
                    return Task.FromResult<object>(new
                    {
                        status = "Already Open Inactive",
                        title = existing.Title,
                        path = existing.PathName,
                        activeTitle = active?.Title,
                        requiresExplicitDiscardAndReopen = true,
                        settings = existingSettings
                    });
                }

                var discardedUnsavedChanges = existing.IsModified;
                if (!existing.Close(false))
                    throw new InvalidOperationException($"Revit did not close the inactive document before reopening it: {p.filePath}");

                UIDocument reopened = app.OpenAndActivateDocument(modelPath, opts, false);
                var reopenedSettings = BuildProjectSettings(reopened.Document);
                return Task.FromResult<object>(new
                {
                    status = "Reopened and Activated",
                    title = reopened.Document.Title,
                    path = reopened.Document.PathName,
                    discardedUnsavedChanges,
                    settings = reopenedSettings
                });
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
                // Re-check for a document-open race, but never report an inactive
                // document as activated. Reopening is destructive and remains opt-in.
                var racedOpenDocument = FindOpenDocument(app, p.filePath);
                if (racedOpenDocument != null)
                {
                    var active = app.ActiveUIDocument?.Document;
                    if (active != null && active.Equals(racedOpenDocument))
                    {
                        var settings = BuildProjectSettings(racedOpenDocument);
                        return Task.FromResult<object>(new { status = "Already Active", title = racedOpenDocument.Title, path = racedOpenDocument.PathName, settings });
                    }

                    throw new InvalidOperationException(
                        $"The requested model is open but inactive. Retry with discardExistingOpenDocument=true only when discarding unsaved changes is explicitly authorized: {p.filePath}",
                        ex);
                }
                throw;
            }
        }

        private static Document? FindOpenDocument(UIApplication app, string filePath)
        {
            foreach (Document document in app.Application.Documents)
            {
                if (string.Equals(document.PathName, filePath, StringComparison.OrdinalIgnoreCase))
                    return document;
            }

            return null;
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
