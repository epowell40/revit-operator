using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>
    /// Opens one loaded family from a grounded project instance, inventories the
    /// content needed to classify visible family text/labels, and always closes
    /// the family document without saving. This is intentionally observational;
    /// editing remains available through the separate family edit primitives.
    /// </summary>
    public sealed class InspectFamilyContentHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long elementId { get; set; }
            public string? contains { get; set; }
            public int maxElements { get; set; } = 500;
            public bool includeParameters { get; set; } = true;
            public bool includeOtherElements { get; set; }
        }

        private sealed class Point3
        {
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
            public string units { get; set; } = "feet";
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.elementId <= 0) throw new InvalidOperationException("inspect-family-content.elementId is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var projectDoc = uidoc.Document;
            if (projectDoc.IsFamilyDocument)
                throw new InvalidOperationException("Open a project document before inspecting a loaded family.");

            var source = projectDoc.GetElement(ElementIdCompat.Create(p.elementId));
            if (!(source is FamilyInstance instance))
                throw new InvalidOperationException($"Element {p.elementId} is not a FamilyInstance.");

            var symbol = instance.Symbol ?? throw new InvalidOperationException("FamilyInstance has no type (Symbol).");
            var family = symbol.Family ?? throw new InvalidOperationException("FamilyInstance type has no Family.");
            if (!family.IsEditable)
                throw new InvalidOperationException($"Family '{family.Name}' is not editable (system or in-place families cannot be inspected this way).");

            var max = Math.Max(1, Math.Min(2000, p.maxElements));
            var needle = Normalize(p.contains ?? "");
            Document? familyDoc = null;
            var closedWithoutSaving = false;

            try
            {
                familyDoc = projectDoc.EditFamily(family)
                    ?? throw new InvalidOperationException("Failed to open the loaded family document for inspection.");

                var familyParameters = new List<object>();
                var familyParameterNamesById = new Dictionary<long, string>();
                if (p.includeParameters)
                {
                    foreach (FamilyParameter parameter in familyDoc.FamilyManager.Parameters)
                    {
                        if (parameter == null) continue;
                        var name = (parameter.Definition?.Name ?? "").Trim();
                        var parameterId = ElementIdCompat.GetValue(parameter.Id);
                        if (parameterId != 0 && !string.IsNullOrWhiteSpace(name))
                            familyParameterNamesById[parameterId] = name;

                        var formula = GetFormula(parameter);
                        familyParameters.Add(new
                        {
                            id = parameterId,
                            name,
                            isInstance = parameter.IsInstance,
                            formula = string.IsNullOrWhiteSpace(formula) ? null : formula
                        });
                    }
                }

                var staticText = new List<object>();
                var labels = new List<object>();
                var nestedInstances = new List<object>();
                var otherElements = new List<object>();
                var classCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                var categoryCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                var scanned = 0;
                var returned = 0;

                foreach (var element in new FilteredElementCollector(familyDoc).WhereElementIsNotElementType().ToElements())
                {
                    scanned++;
                    var runtimeType = element.GetType().Name ?? "Element";
                    Increment(classCounts, runtimeType);
                    var categoryName = element.Category?.Name ?? "";
                    if (!string.IsNullOrWhiteSpace(categoryName)) Increment(categoryCounts, categoryName);

                    if (element is TextNote textNote)
                    {
                        var text = textNote.Text ?? "";
                        if (Matches(needle, text, categoryName, runtimeType))
                        {
                            staticText.Add(new
                            {
                                elementId = ElementIdCompat.GetValue(textNote.Id),
                                uniqueId = textNote.UniqueId,
                                text,
                                category = categoryName,
                                location = Center(textNote)
                            });
                            returned++;
                        }
                    }
                    else if (runtimeType.EndsWith("Label", StringComparison.OrdinalIgnoreCase))
                    {
                        var driverNames = ResolveDriverParameterNames(element, familyParameterNamesById);
                        if (Matches(needle, SafeName(element), categoryName, runtimeType, string.Join(" ", driverNames)))
                        {
                            labels.Add(new
                            {
                                elementId = ElementIdCompat.GetValue(element.Id),
                                uniqueId = element.UniqueId,
                                runtimeType,
                                name = SafeName(element),
                                category = categoryName,
                                driverParameters = driverNames,
                                location = Center(element)
                            });
                            returned++;
                        }
                    }
                    else if (element is FamilyInstance nested)
                    {
                        var nestedFamily = nested.Symbol?.Family?.Name ?? "";
                        var nestedType = nested.Symbol?.Name ?? "";
                        var isAnnotation = nested.Category?.CategoryType == CategoryType.Annotation;
                        if (Matches(needle, SafeName(nested), nestedFamily, nestedType, categoryName, runtimeType))
                        {
                            nestedInstances.Add(new
                            {
                                elementId = ElementIdCompat.GetValue(nested.Id),
                                uniqueId = nested.UniqueId,
                                familyName = nestedFamily,
                                typeName = nestedType,
                                category = categoryName,
                                isAnnotation,
                                location = Center(nested)
                            });
                            returned++;
                        }
                    }
                    else if (p.includeOtherElements && returned < max && Matches(needle, SafeName(element), categoryName, runtimeType))
                    {
                        otherElements.Add(new
                        {
                            elementId = ElementIdCompat.GetValue(element.Id),
                            uniqueId = element.UniqueId,
                            runtimeType,
                            name = SafeName(element),
                            category = categoryName
                        });
                        returned++;
                    }

                    if (returned >= max) break;
                }

                var annotationNestedCount = nestedInstances.Count(item =>
                {
                    var prop = item.GetType().GetProperty("isAnnotation");
                    return prop != null && prop.GetValue(item) is bool value && value;
                });

                return Task.FromResult<object>(new
                {
                    ok = true,
                    observational = true,
                    mutated = false,
                    source = new
                    {
                        elementId = ElementIdCompat.GetValue(instance.Id),
                        uniqueId = instance.UniqueId,
                        category = instance.Category?.Name ?? "",
                        familyId = ElementIdCompat.GetValue(family.Id),
                        familyName = family.Name,
                        typeId = ElementIdCompat.GetValue(symbol.Id),
                        typeName = symbol.Name
                    },
                    query = string.IsNullOrWhiteSpace(p.contains) ? null : p.contains,
                    familyParameters,
                    staticText,
                    labels,
                    nestedInstances,
                    otherElements,
                    classification = new
                    {
                        staticTextCount = staticText.Count,
                        parameterDrivenLabelCount = labels.Count(item =>
                        {
                            var prop = item.GetType().GetProperty("driverParameters");
                            return prop?.GetValue(item) is string[] values && values.Length > 0;
                        }),
                        unboundLabelCount = labels.Count(item =>
                        {
                            var prop = item.GetType().GetProperty("driverParameters");
                            return !(prop?.GetValue(item) is string[] values) || values.Length == 0;
                        }),
                        nestedFamilyCount = nestedInstances.Count,
                        nestedAnnotationCount = annotationNestedCount
                    },
                    inventory = new
                    {
                        scannedElementCount = scanned,
                        returnedElementCount = returned,
                        truncated = returned >= max,
                        maxElements = max,
                        classCounts,
                        categoryCounts
                    },
                    closedWithoutSaving = true
                });
            }
            finally
            {
                if (familyDoc != null)
                {
                    try
                    {
                        familyDoc.Close(false);
                        closedWithoutSaving = true;
                    }
                    catch
                    {
                        if (!closedWithoutSaving)
                            throw new InvalidOperationException("Family inspection completed, but the temporary family document could not be closed without saving.");
                    }
                }
            }
        }

        private static string[] ResolveDriverParameterNames(Element element, Dictionary<long, string> namesById)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                foreach (var parameter in element.GetOrderedParameters())
                {
                    if (parameter == null || parameter.StorageType != StorageType.ElementId) continue;
                    var value = parameter.AsElementId();
                    if (value == null || value == ElementId.InvalidElementId) continue;
                    if (namesById.TryGetValue(ElementIdCompat.GetValue(value), out var name) && !string.IsNullOrWhiteSpace(name))
                        names.Add(name);
                }
            }
            catch { }
            return names.OrderBy(value => value, StringComparer.OrdinalIgnoreCase).ToArray();
        }

        private static Point3? Center(Element element)
        {
            try
            {
                var box = element.get_BoundingBox(null);
                if (box == null) return null;
                return new Point3
                {
                    x = (box.Min.X + box.Max.X) * 0.5,
                    y = (box.Min.Y + box.Max.Y) * 0.5,
                    z = (box.Min.Z + box.Max.Z) * 0.5
                };
            }
            catch { return null; }
        }

        private static string SafeName(Element element)
        {
            try { return element.Name ?? ""; } catch { return ""; }
        }

        private static bool Matches(string normalizedNeedle, params string[] values)
        {
            if (string.IsNullOrWhiteSpace(normalizedNeedle)) return true;
            return values.Any(value => Normalize(value).Contains(normalizedNeedle));
        }

        private static string Normalize(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "";
            var chars = value.Select(character => char.IsLetterOrDigit(character) ? char.ToLowerInvariant(character) : ' ').ToArray();
            return string.Join(" ", new string(chars).Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries));
        }

        private static string GetFormula(FamilyParameter parameter)
        {
            try
            {
                var property = parameter.GetType().GetProperty("Formula", BindingFlags.Public | BindingFlags.Instance);
                return (property?.GetValue(parameter, null) as string ?? "").Trim();
            }
            catch { return ""; }
        }

        private static void Increment(Dictionary<string, int> counts, string key)
        {
            counts[key] = counts.TryGetValue(key, out var current) ? current + 1 : 1;
        }
    }
}
