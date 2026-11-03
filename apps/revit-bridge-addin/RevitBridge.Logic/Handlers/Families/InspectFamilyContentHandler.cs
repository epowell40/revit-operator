using System;
using System.Collections.Generic;
using System.Linq;
using System.IO;
using System.Security.Cryptography;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>
    /// Opens one loaded family from a grounded project instance, tag or symbol, inventories the
    /// content needed to classify visible family text/labels, and closes only a
    /// newly opened temporary document without saving. Existing editors are preserved.
    /// editing remains available through the separate family edit primitives.
    /// </summary>
    public sealed class InspectFamilyContentHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long elementId { get; set; }
            public string? filePath { get; set; }
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
            using var request = JsonDocument.Parse(string.IsNullOrEmpty(jsonData) ? "{}" : jsonData);
            if (!FamilyInspectionSource.Validate(request.RootElement, out var sourceError))
                throw new ArgumentException(sourceError);

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var projectDoc = uidoc.Document;
            if (projectDoc.IsFamilyDocument)
                throw new InvalidOperationException("Open a project document before inspecting a family.");

            string? file = null, sourceHash = null;
            object? sourceIdentity = null, fileMetadata = null;
            Func<Document> open;
            if (p.filePath != null)
            {
                file = FamilyInspectionSource.ResolveExisting(WorkspacePaths.GetWorkspaceRootPath(), p.filePath);
                sourceHash = FileHash(file);
                fileMetadata = FileMetadata(file);
                open = () => app.Application.OpenDocumentFile(file);
            }
            else
            {
                var source = projectDoc.GetElement(ElementIdCompat.Create(p.elementId));
                if (source == null) throw new InvalidOperationException($"Element {p.elementId} not found.");
                var symbol = LoadedFamilySource.ResolveSymbolForInspection(projectDoc, source);
                var family = symbol.Family ?? throw new InvalidOperationException("Selected type has no Family.");
                if (!family.IsEditable)
                    throw new InvalidOperationException($"Family '{family.Name}' is not editable (system or in-place families cannot be inspected this way).");
                sourceIdentity = new
                {
                    elementId = ElementIdCompat.GetValue(source.Id), uniqueId = source.UniqueId,
                    category = source.Category?.Name ?? "", runtimeType = source.GetType().Name,
                    familyId = ElementIdCompat.GetValue(family.Id), familyName = family.Name,
                    typeId = ElementIdCompat.GetValue(symbol.Id), typeName = symbol.Name
                };
                open = () => projectDoc.EditFamily(family);
            }

            var max = Math.Max(1, Math.Min(2000, p.maxElements));
            var needle = Normalize(p.contains ?? "");
            var alreadyOpen = app.Application.Documents.Cast<Document>().ToArray();
            var result = TemporaryDocumentInspection.Run<Document, object>(alreadyOpen,
                open, familyDoc =>
            {

                if (!familyDoc.IsFamilyDocument) throw new InvalidOperationException("Inspection source is not a family document.");
                var currentType = familyDoc.FamilyManager.CurrentType;
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
                            formula = string.IsNullOrWhiteSpace(formula) ? null : formula,
                            storageType = parameter.StorageType.ToString(),
                            specTypeId = ReadFact(() => parameter.Definition.GetDataType().TypeId),
                            unitTypeId = ReadFact(() => parameter.GetUnitTypeId().TypeId),
                            currentValue = ReadCurrentValue(currentType, parameter)
                        });
                    }
                }

                var staticText = new List<object>();
                var labels = new List<object>();
                var labelDriverObservations = new List<RevitBridge.Common.Annotation.FamilyLabelBindingObservation.DriverObservation>();
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
                    else if (RevitBridge.Common.Annotation.FamilyLabelInspectionPolicy.IsLabel(runtimeType))
                    {
                        var driverObservation = RevitBridge.Common.Annotation.FamilyLabelBindingObservation.Observe(
                            names => ReadDriverParameterNames(element, familyParameterNamesById, names), p.includeParameters);
                        var driverNames = driverObservation.DriverParameters;
                        if (RevitBridge.Common.Annotation.FamilyLabelInspectionPolicy.MatchesQuery(
                            p.contains, runtimeType, SafeName(element), categoryName, string.Join(" ", driverNames)))
                        {
                            labels.Add(new
                            {
                                elementId = ElementIdCompat.GetValue(element.Id),
                                uniqueId = element.UniqueId,
                                runtimeType,
                                name = SafeName(element),
                                category = categoryName,
                                driverParameters = driverNames,
                                driverParameterObservation = driverObservation.Detail,
                                labelType = ReadLabelType(familyDoc, element),
                                location = Center(element)
                            });
                            labelDriverObservations.Add(driverObservation);
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
                        var summary = new Dictionary<string, object?>
                        {
                            ["elementId"] = ElementIdCompat.GetValue(element.Id),
                            ["uniqueId"] = element.UniqueId,
                            ["runtimeType"] = runtimeType,
                            ["name"] = SafeName(element),
                            ["category"] = categoryName
                        };
                        FamilyConnectorInspectionFacts.AddToSummary(summary, element is ConnectorElement connector
                            ? new ConnectorInspectionSource(connector) : null);
                        otherElements.Add(summary);
                        returned++;
                    }

                    if (returned >= max) break;
                }

                var annotationNestedCount = nestedInstances.Count(item =>
                {
                    var prop = item.GetType().GetProperty("isAnnotation");
                    return prop != null && prop.GetValue(item) is bool value && value;
                });

                return new
                {
                    ok = true,
                    observational = true,
                    mutated = false,
                    source = sourceIdentity ?? new
                    {
                        scope = "external_file", filePath = file, sha256 = sourceHash,
                        sizeBytes = new FileInfo(file!).Length, metadata = fileMetadata,
                        familyName = familyDoc.OwnerFamily?.Name ?? familyDoc.Title,
                        category = familyDoc.OwnerFamily?.FamilyCategory?.Name,
                        hostVersion = app.Application.VersionNumber,
                        openedInHost = true,
                        note = "External file only; not loaded-project verification or design selection."
                    },
                    currentTypeName = currentType?.Name,
                    query = string.IsNullOrWhiteSpace(p.contains) ? null : p.contains,
                    familyParameters,
                    staticText,
                    labels,
                    nestedInstances,
                    otherElements,
                    classification = RevitBridge.Common.Annotation.FamilyLabelBindingObservation.Classify(
                        labelDriverObservations,
                        staticText.Count, nestedInstances.Count, annotationNestedCount),
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
                };
            }, familyDoc => familyDoc.Close(false), familyDoc => familyDoc.IsValidObject);
            if (file != null)
            {
                // Re-resolve after closure; a changed/replaced source cannot receive a successful identity claim.
                var afterFile = FamilyInspectionSource.ResolveExisting(WorkspacePaths.GetWorkspaceRootPath(), p.filePath!);
                if (!string.Equals(file, afterFile, StringComparison.OrdinalIgnoreCase) || FileHash(afterFile) != sourceHash)
                    throw new InvalidOperationException("Family source bytes changed during inspection; findings are not accepted.");
            }
            return Task.FromResult(result);
        }

        private static string FileHash(string path)
        {
            using var stream = File.OpenRead(path);
            using var sha = SHA256.Create();
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        private static object FileMetadata(string path)
        {
            try
            {
                using var info = BasicFileInfo.Extract(path);
                return new { savedFormat = info.Format, error = (string?)null };
            }
            catch (Exception ex)
            {
                return new { savedFormat = (string?)null, error = ex.Message };
            }
        }

        private static object ReadFact(Func<string> read)
        {
            try { return new { value = read(), error = (string?)null }; }
            catch (Exception ex) { return new { value = (string?)null, error = ex.Message }; }
        }

        // These getters run only inside the existing temporary inspection document.
        // Geometry belongs to currentTypeName, not an arbitrary loaded instance or type.
        private sealed class ConnectorInspectionSource : IFamilyConnectorInspectionSource
        {
            private readonly ConnectorElement connector;
            public ConnectorInspectionSource(ConnectorElement value) { connector = value; }
            private static double[] Vector(XYZ point) => new[] { point.X, point.Y, point.Z };
            public string Shape => connector.Shape.ToString();
            public string Domain => connector.Domain.ToString();
            public string SystemClassification => connector.SystemClassification.ToString();
            public bool IsPrimary => connector.IsPrimary;
            public double[] Origin => Vector(connector.Origin);
            public double[] Direction => Vector(connector.Direction);
            public double[][] Axes
            {
                get
                {
                    using var transform = connector.CoordinateSystem;
                    return new[] { Vector(transform.BasisX), Vector(transform.BasisY), Vector(transform.BasisZ) };
                }
            }
            public double Radius => connector.Radius;
            public double Width => connector.Width;
            public double Height => connector.Height;
        }

        private static object ReadCurrentValue(FamilyType? type, FamilyParameter parameter)
        {
            object? value = null;
            try
            {
                var hasValue = type != null && type.HasValue(parameter);
                if (hasValue)
                {
                    switch (parameter.StorageType)
                    {
                        case StorageType.Double: value = type!.AsDouble(parameter); break;
                        case StorageType.Integer: value = type!.AsInteger(parameter); break;
                        case StorageType.String: value = type!.AsString(parameter); break;
                        case StorageType.ElementId: value = ElementIdCompat.GetValue(type!.AsElementId(parameter)); break;
                    }
                }
                return new { hasValue, value, valueBasis = "native_internal_units", error = (string?)null };
            }
            catch (Exception ex)
            {
                return new { hasValue = (bool?)null, value = (object?)null, valueBasis = "native_internal_units", error = ex.Message };
            }
        }

        private static object? ReadLabelType(Document doc, Element label)
        {
            var type = doc.GetElement(label.GetTypeId());
            if (type == null) return null;
            int? Integer(BuiltInParameter parameter) => type.get_Parameter(parameter)?.AsInteger();
            double? Number(BuiltInParameter parameter) => type.get_Parameter(parameter)?.AsDouble();
            return new
            {
                elementId = ElementIdCompat.GetValue(type.Id),
                uniqueId = type.UniqueId,
                name = SafeName(type),
                font = type.get_Parameter(BuiltInParameter.TEXT_FONT)?.AsString(),
                textSizeFeet = Number(BuiltInParameter.TEXT_SIZE),
                bold = Integer(BuiltInParameter.TEXT_STYLE_BOLD) is int bold ? (bool?)(bold != 0) : null,
                italic = Integer(BuiltInParameter.TEXT_STYLE_ITALIC) is int italic ? (bool?)(italic != 0) : null,
                underline = Integer(BuiltInParameter.TEXT_STYLE_UNDERLINE) is int underline ? (bool?)(underline != 0) : null,
                widthFactor = Number(BuiltInParameter.TEXT_WIDTH_SCALE)
            };
        }

        private static void ReadDriverParameterNames(Element element, Dictionary<long, string> namesById, ICollection<string> names)
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
