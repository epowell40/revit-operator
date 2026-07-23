using System;
using System.Collections;
using System.Linq;
using System.Reflection;
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
            public string? action { get; set; } // create|list_types|create_type|inspect|repair
            public long? textNoteId { get; set; } // inspect|repair
            public long? viewId { get; set; }
            public double? x { get; set; }
            public double? y { get; set; }
            // Revit TextNote width is measured in paper-space feet, not model-space feet.
            public double? widthFt { get; set; }
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

            if (action == "inspect" || action == "repair")
            {
                if (!p.textNoteId.HasValue || p.textNoteId.Value <= 0)
                    throw new InvalidOperationException($"create-text({action}) requires textNoteId.");

                var note = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.textNoteId.Value)) as TextNote;
                if (note == null)
                    throw new InvalidOperationException($"TextNote {p.textNoteId.Value} not found.");

                var noteView = doc.GetElement(note.OwnerViewId) as View;
                if (action == "inspect")
                {
                    return Task.FromResult<object>(new
                    {
                        status = "Success",
                        action = "inspect",
                        textNote = CaptureTextNote(note, noteView)
                    });
                }

                var hasPoint = p.x.HasValue || p.y.HasValue;
                if (hasPoint && (!p.x.HasValue || !p.y.HasValue))
                    throw new InvalidOperationException("create-text(repair) requires both x and y when moving a note.");
                if (p.widthFt.HasValue && p.widthFt.Value <= 0)
                    throw new InvalidOperationException("create-text.widthFt must be positive.");

                var hasType = (p.typeId.HasValue && p.typeId.Value > 0) || !string.IsNullOrWhiteSpace(p.typeName);
                var requestedType = hasType ? ResolveTextType(doc, p.typeId, p.typeName) : null;
                if (hasType && requestedType == null)
                    throw new InvalidOperationException("No matching TextNoteType found.");

                var hasRepair = hasPoint || p.widthFt.HasValue || p.text != null || requestedType != null;
                if (!hasRepair)
                    throw new InvalidOperationException("create-text(repair) requires x/y, widthFt, text, or typeId/typeName.");

                var before = CaptureTextNote(note, noteView);
                var plannedText = p.text == null
                    ? note.Text
                    : RevitBridge.Common.RevitTextCasePolicy.NormalizeDraftingText(p.text);
                var targetPoint = hasPoint ? new XYZ(p.x!.Value, p.y!.Value, note.Coord.Z) : note.Coord;
                var dryRunRepair = p.dryRun ?? false;

                if (dryRunRepair)
                {
                    return Task.FromResult<object>(new
                    {
                        status = "Dry Run",
                        action = "repair",
                        dryRun = true,
                        before,
                        plannedAfter = new
                        {
                            textNoteId = RevitBridge.Common.ElementIdCompat.GetValue(note.Id),
                            viewId = RevitBridge.Common.ElementIdCompat.GetValue(note.OwnerViewId),
                            text = plannedText,
                            point = new { x = targetPoint.X, y = targetPoint.Y, z = targetPoint.Z },
                            widthFt = p.widthFt ?? TryGetTextNoteWidth(note),
                            textType = new
                            {
                                id = RevitBridge.Common.ElementIdCompat.GetValue((requestedType ?? doc.GetElement(note.GetTypeId()) as TextNoteType)!.Id),
                                name = (requestedType ?? doc.GetElement(note.GetTypeId()) as TextNoteType)!.Name
                            }
                        }
                    });
                }

                using (var t = new Transaction(doc, "Repair Text Note"))
                {
                    t.Start();

                    if (hasPoint)
                    {
                        var move = targetPoint - note.Coord;
                        if (!move.IsZeroLength()) ElementTransformUtils.MoveElement(doc, note.Id, move);
                    }
                    if (p.text != null) note.Text = plannedText;
                    if (requestedType != null && requestedType.Id != note.GetTypeId()) note.ChangeTypeId(requestedType.Id);
                    if (p.widthFt.HasValue) SetTextNoteWidth(note, p.widthFt.Value);

                    t.Commit();
                }

                note = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.textNoteId.Value)) as TextNote
                       ?? throw new InvalidOperationException($"TextNote {p.textNoteId.Value} disappeared after repair.");
                return Task.FromResult<object>(new
                {
                    status = "Success",
                    action = "repair",
                    dryRun = false,
                    before,
                    after = CaptureTextNote(note, doc.GetElement(note.OwnerViewId) as View)
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
                            widthFt = p.widthFt,
                            widthSpace = "paper",
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
                        var normalizedText = RevitBridge.Common.RevitTextCasePolicy.NormalizeDraftingText(p.text);
                        var created = p.widthFt.HasValue
                            ? TextNote.Create(doc, viewForCreate.Id, origin, p.widthFt.Value, normalizedText, targetType.Id)
                            : TextNote.Create(doc, viewForCreate.Id, origin, normalizedText, targetType.Id);
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
            if (p.widthFt.HasValue && p.widthFt.Value <= 0)
                throw new InvalidOperationException("create-text.widthFt must be positive.");

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
                        widthFt = p.widthFt,
                        widthSpace = "paper",
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

                // Width-bearing creation must use Revit's line-wrapping overload. Creating an
                // unwrapped note and assigning Width later can leave different wrapping/layout
                // state even when the final numeric width matches a reference note.
                var normalizedText = RevitBridge.Common.RevitTextCasePolicy.NormalizeDraftingText(p.text);
                var created = p.widthFt.HasValue
                    ? TextNote.Create(doc, view.Id, origin, p.widthFt.Value, normalizedText, textType.Id)
                    : TextNote.Create(doc, view.Id, origin, normalizedText, textType.Id);
                textNoteId = RevitBridge.Common.ElementIdCompat.GetValue(created.Id);

                t.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                action = "create",
                textNoteId,
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                textType = new { id = RevitBridge.Common.ElementIdCompat.GetValue(textType.Id), name = textType.Name },
                textNote = CaptureTextNote(doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(textNoteId)) as TextNote
                    ?? throw new InvalidOperationException($"TextNote {textNoteId} disappeared after creation."), view)
            });
        }

        private static object CaptureTextNote(TextNote note, View? view)
        {
            var type = note.Document.GetElement(note.GetTypeId()) as TextNoteType;
            var point = note.Coord;
            var paperWidthFt = TryGetTextNoteWidth(note);
            var viewScale = view?.Scale;
            return new
            {
                textNoteId = RevitBridge.Common.ElementIdCompat.GetValue(note.Id),
                viewId = RevitBridge.Common.ElementIdCompat.GetValue(note.OwnerViewId),
                viewName = view?.Name,
                text = note.Text,
                point = new { x = point.X, y = point.Y, z = point.Z },
                widthFt = paperWidthFt,
                widthSpace = "paper",
                modelSpaceWidthFt = paperWidthFt.HasValue && viewScale.HasValue
                    ? (double?)(paperWidthFt.Value * viewScale.Value)
                    : null,
                viewScale,
                isTextWrappingActive = TryGetTextWrappingActive(note),
                leaderCount = TryGetLeaderCount(note),
                textType = new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(note.GetTypeId()),
                    name = type?.Name
                }
            };
        }

        private static double? TryGetTextNoteWidth(TextNote note)
        {
            try
            {
                var prop = typeof(TextNote).GetProperty("Width", BindingFlags.Instance | BindingFlags.Public);
                var value = prop?.GetValue(note);
                return value is double width ? width : (double?)null;
            }
            catch
            {
                return null;
            }
        }

        private static bool? TryGetTextWrappingActive(TextNote note)
        {
            try
            {
                var prop = typeof(TextElement).GetProperty("IsTextWrappingActive", BindingFlags.Instance | BindingFlags.Public);
                var value = prop?.GetValue(note);
                return value is bool active ? active : (bool?)null;
            }
            catch
            {
                return null;
            }
        }

        private static void SetTextNoteWidth(TextNote note, double widthFt)
        {
            var prop = typeof(TextNote).GetProperty("Width", BindingFlags.Instance | BindingFlags.Public);
            if (prop == null || !prop.CanWrite)
                throw new InvalidOperationException("This Revit version does not expose a writable TextNote.Width property.");
            prop.SetValue(note, widthFt);
        }

        private static int? TryGetLeaderCount(TextNote note)
        {
            try
            {
                var method = typeof(TextNote).GetMethod("GetLeaders", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                var leaders = method?.Invoke(note, null) as ICollection;
                return leaders?.Count;
            }
            catch
            {
                return null;
            }
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
