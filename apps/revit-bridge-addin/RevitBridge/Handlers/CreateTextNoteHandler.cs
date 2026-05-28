using System;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public class CreateTextNoteHandler : IRequestHandler
    {
        public class Params
        {
            public string? action { get; set; } // create|list_types|create_type
            public long? viewId { get; set; }
            public double? x { get; set; }
            public double? y { get; set; }
            public string? text { get; set; }
            public long? typeId { get; set; }
            public string? typeName { get; set; }
            public string? newTypeName { get; set; } // create_type
            public long? baseTypeId { get; set; } // create_type
            public string? baseTypeName { get; set; } // create_type
            public string? fontName { get; set; } // create_type
            public double? textSize { get; set; } // create_type
            public bool? bold { get; set; } // create_type
            public bool? italic { get; set; } // create_type
            public bool? allowExisting { get; set; } // create_type
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var action = (p.action ?? "create").Trim().ToLowerInvariant();
            if (action == "list_types")
            {
                var types = new FilteredElementCollector(doc)
                    .OfClass(typeof(TextNoteType))
                    .Cast<TextNoteType>()
                    .Select(t => new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(t.Id),
                        name = t.Name,
                        fontName = TryReadBuiltInStringParameter(t, "TEXT_FONT"),
                        textSize = TryReadBuiltInDoubleParameter(t, "TEXT_SIZE")
                    })
                    .OrderBy(t => t.name, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(t => t.id)
                    .ToArray();

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    action = "list_types",
                    count = types.Length,
                    textTypes = types
                });
            }

            if (action == "create_type")
            {
                var newTypeName = (p.newTypeName ?? "").Trim();
                if (newTypeName.Length == 0)
                    throw new InvalidOperationException("create-text(create_type) requires newTypeName.");

                var allowExisting = p.allowExisting ?? true;
                var dryRunCreateType = p.dryRun ?? false;
                var existing = ResolveTextType(doc, null, newTypeName);
                var baseType = ResolveTextType(doc, p.baseTypeId, p.baseTypeName) ?? ResolveFallbackTextType(doc);
                if (baseType == null)
                    throw new InvalidOperationException("No TextNoteType found in project.");

                if (existing != null && !allowExisting)
                    throw new InvalidOperationException($"Text note type '{newTypeName}' already exists.");

                var shouldCreate = existing == null;
                var targetType = existing ?? baseType;
                var viewForCreate = ResolveView(doc, p.viewId);
                var hasCreatePayload = p.x.HasValue && p.y.HasValue && !string.IsNullOrWhiteSpace(p.text);

                if (dryRunCreateType)
                {
                    object createTextPlan = hasCreatePayload
                        ? new
                        {
                            requested = true,
                            viewId = p.viewId ?? RevitBridge.Common.ElementIdCompat.GetValue(viewForCreate?.Id),
                            x = p.x,
                            y = p.y,
                            text = RevitBridge.Common.RevitTextCasePolicy.NormalizeDraftingText(p.text)
                        }
                        : new { requested = false };

                    return Task.FromResult<object>(new
                    {
                        status = "Dry Run",
                        action = "create_type",
                        dryRun = true,
                        type = new
                        {
                            name = newTypeName,
                            willCreate = shouldCreate,
                            allowExisting,
                            baseType = new { id = RevitBridge.Common.ElementIdCompat.GetValue(baseType.Id), name = baseType.Name },
                            fontName = p.fontName,
                            textSize = p.textSize,
                            bold = p.bold,
                            italic = p.italic
                        },
                        createText = createTextPlan
                    });
                }

                long? createdTypeTextNoteId = null;
                using (var t = new Transaction(doc, "Create Text Type"))
                {
                    t.Start();

                    if (shouldCreate)
                    {
                        targetType = targetType.Duplicate(newTypeName) as TextNoteType
                                     ?? throw new InvalidOperationException("Failed to create text note type.");
                    }

                    ApplyTypeOverrides(targetType, p.fontName, p.textSize, p.bold, p.italic);

                    if (hasCreatePayload)
                    {
                        if (viewForCreate == null)
                            throw new InvalidOperationException("View not found. Provide viewId or activate a view.");
                        var origin = new XYZ(p.x!.Value, p.y!.Value, 0);
                        var created = TextNote.Create(doc, viewForCreate.Id, origin, RevitBridge.Common.RevitTextCasePolicy.NormalizeDraftingText(p.text), targetType.Id);
                        createdTypeTextNoteId = RevitBridge.Common.ElementIdCompat.GetValue(created.Id);
                    }

                    t.Commit();
                }

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    action = "create_type",
                    type = new
                    {
                        id = RevitBridge.Common.ElementIdCompat.GetValue(targetType.Id),
                        name = targetType.Name,
                        created = shouldCreate,
                        fontName = TryReadBuiltInStringParameter(targetType, "TEXT_FONT"),
                        textSize = TryReadBuiltInDoubleParameter(targetType, "TEXT_SIZE")
                    },
                    textNoteId = createdTypeTextNoteId
                });
            }

            var view = ResolveView(doc, p.viewId);
            if (view == null) throw new InvalidOperationException("View not found. Provide viewId or activate a view.");

            if (!p.x.HasValue || !p.y.HasValue || string.IsNullOrWhiteSpace(p.text))
                throw new InvalidOperationException("create-text(create) requires x, y, and text.");

            var textType = ResolveTextType(doc, p.typeId, p.typeName);
            if (textType == null) throw new InvalidOperationException("No matching TextNoteType found.");

            var dryRun = p.dryRun ?? false;
            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    action = "create",
                    dryRun = true,
                    plan = new
                    {
                        viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                        viewName = view.Name,
                        x = p.x.Value,
                        y = p.y.Value,
                        text = RevitBridge.Common.RevitTextCasePolicy.NormalizeDraftingText(p.text),
                        textType = new { id = RevitBridge.Common.ElementIdCompat.GetValue(textType.Id), name = textType.Name }
                    }
                });
            }

            long textNoteId;

            using (var t = new Transaction(doc, "Create Text Note"))
            {
                t.Start();

                // Create the text note
                // XYZ origin depends on view type. For sheets/plans, Z is usually 0 or matches level elevation.
                // We'll trust the user provided X/Y relative to the view's coordinate system.
                XYZ origin = new XYZ(p.x.Value, p.y.Value, 0);

                // Adjust creation for View vs Sheet if necessary, but TextNote.Create takes a viewId
                var created = TextNote.Create(doc, view.Id, origin, RevitBridge.Common.RevitTextCasePolicy.NormalizeDraftingText(p.text), textType.Id);
                textNoteId = RevitBridge.Common.ElementIdCompat.GetValue(created.Id);

                t.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                action = "create",
                textNoteId,
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                textType = new { id = RevitBridge.Common.ElementIdCompat.GetValue(textType.Id), name = textType.Name }
            });
        }

        private static View? ResolveView(Document doc, long? viewId)
        {
            if (viewId.HasValue && viewId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
            }

            return doc.ActiveView;
        }

        private static TextNoteType? ResolveTextType(Document doc, long? typeId, string? typeName)
        {
            if (typeId.HasValue && typeId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(typeId.Value)) as TextNoteType;
            }

            var name = (typeName ?? "").Trim();
            if (name.Length > 0)
            {
                var named = new FilteredElementCollector(doc)
                    .OfClass(typeof(TextNoteType))
                    .Cast<TextNoteType>()
                    .FirstOrDefault(t => (t.Name ?? "").Trim().Equals(name, StringComparison.OrdinalIgnoreCase));
                if (named != null) return named;
            }

            var fallbackId = new FilteredElementCollector(doc)
                .OfClass(typeof(TextNoteType))
                .FirstElementId();
            if (fallbackId == null || fallbackId == ElementId.InvalidElementId) return null;
            return doc.GetElement(fallbackId) as TextNoteType;
        }

        private static TextNoteType? ResolveFallbackTextType(Document doc)
        {
            var fallbackId = new FilteredElementCollector(doc)
                .OfClass(typeof(TextNoteType))
                .FirstElementId();
            if (fallbackId == null || fallbackId == ElementId.InvalidElementId) return null;
            return doc.GetElement(fallbackId) as TextNoteType;
        }

        private static void ApplyTypeOverrides(TextNoteType type, string? fontName, double? textSize, bool? bold, bool? italic)
        {
            var font = (fontName ?? "").Trim();
            if (font.Length > 0)
            {
                TrySetBuiltInStringParameter(type, "TEXT_FONT", font);
            }

            if (textSize.HasValue && textSize.Value > 0)
            {
                TrySetBuiltInDoubleParameter(type, "TEXT_SIZE", textSize.Value);
            }

            if (bold.HasValue)
            {
                TrySetBuiltInIntegerParameter(type, "TEXT_STYLE_BOLD", bold.Value ? 1 : 0);
            }

            if (italic.HasValue)
            {
                TrySetBuiltInIntegerParameter(type, "TEXT_STYLE_ITALIC", italic.Value ? 1 : 0);
            }
        }

        private static bool TrySetBuiltInStringParameter(Element element, string builtInParameterName, string value)
        {
            try
            {
                var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), builtInParameterName, ignoreCase: true);
                var p = element.get_Parameter(bip);
                if (p == null || p.IsReadOnly || p.StorageType != StorageType.String) return false;
                return p.Set(value);
            }
            catch
            {
                return false;
            }
        }

        private static bool TrySetBuiltInDoubleParameter(Element element, string builtInParameterName, double value)
        {
            try
            {
                var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), builtInParameterName, ignoreCase: true);
                var p = element.get_Parameter(bip);
                if (p == null || p.IsReadOnly || p.StorageType != StorageType.Double) return false;
                return p.Set(value);
            }
            catch
            {
                return false;
            }
        }

        private static bool TrySetBuiltInIntegerParameter(Element element, string builtInParameterName, int value)
        {
            try
            {
                var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), builtInParameterName, ignoreCase: true);
                var p = element.get_Parameter(bip);
                if (p == null || p.IsReadOnly || p.StorageType != StorageType.Integer) return false;
                return p.Set(value);
            }
            catch
            {
                return false;
            }
        }

        private static string? TryReadBuiltInStringParameter(Element element, string builtInParameterName)
        {
            try
            {
                var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), builtInParameterName, ignoreCase: true);
                var p = element.get_Parameter(bip);
                if (p == null || p.StorageType != StorageType.String) return null;
                return p.AsString();
            }
            catch
            {
                return null;
            }
        }

        private static double? TryReadBuiltInDoubleParameter(Element element, string builtInParameterName)
        {
            try
            {
                var bip = (BuiltInParameter)Enum.Parse(typeof(BuiltInParameter), builtInParameterName, ignoreCase: true);
                var p = element.get_Parameter(bip);
                if (p == null || p.StorageType != StorageType.Double) return null;
                return p.AsDouble();
            }
            catch
            {
                return null;
            }
        }
    }
}
