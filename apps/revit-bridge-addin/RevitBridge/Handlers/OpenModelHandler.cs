using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Operator;

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
            public bool continueOnUnresolvedReferences { get; set; } = false;
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
                        completionEligible = false,
                        requestedEffectSatisfied = false,
                        requiresExplicitDiscardAndReopen = true,
                        settings = existingSettings
                    });
                }

                return Task.FromResult(ReopenInactiveDocument(
                    app,
                    existing,
                    modelPath,
                    opts,
                    p.filePath,
                    p.continueOnUnresolvedReferences,
                    armUnresolvedReferencesGuard: true));
            }

            var linkedReferences = FindLinkedDocumentReferences(app, p.filePath);
            if (linkedReferences.Count > 0)
            {
                if (!p.discardExistingOpenDocument)
                {
                    return Task.FromResult<object>(new
                    {
                        status = "Already Loaded As Link",
                        path = p.filePath,
                        completionEligible = false,
                        requestedEffectSatisfied = false,
                        requiresExplicitUnloadAndOpen = true,
                        linkedHosts = DescribeLinkedDocumentReferences(linkedReferences)
                    });
                }

                var unloadedLinks = UnloadLinkedDocumentReferences(linkedReferences);
                ArmUnresolvedReferencesGuardIfRequested(p.continueOnUnresolvedReferences);
                UIDocument openedLinkedDocument = app.OpenAndActivateDocument(modelPath, opts, false);
                var openedLinkedSettings = BuildProjectSettings(openedLinkedDocument.Document);
                return Task.FromResult<object>(new
                {
                    status = "Unloaded Link and Activated",
                    title = openedLinkedDocument.Document.Title,
                    path = openedLinkedDocument.Document.PathName,
                    unloadedLinks,
                    settings = openedLinkedSettings
                });
            }

            try 
            {
                ArmUnresolvedReferencesGuardIfRequested(p.continueOnUnresolvedReferences);
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

                    if (p.discardExistingOpenDocument)
                        return Task.FromResult(ReopenInactiveDocument(
                            app,
                            racedOpenDocument,
                            modelPath,
                            opts,
                            p.filePath,
                            p.continueOnUnresolvedReferences,
                            armUnresolvedReferencesGuard: false));

                    throw new InvalidOperationException(
                        $"The requested model is open but inactive. Retry with discardExistingOpenDocument=true only when discarding unsaved changes is explicitly authorized: {p.filePath}",
                        ex);
                }
                throw;
            }
        }

        private static object ReopenInactiveDocument(
            UIApplication app,
            Document existing,
            ModelPath modelPath,
            OpenOptions opts,
            string filePath,
            bool continueOnUnresolvedReferences,
            bool armUnresolvedReferencesGuard)
        {
            var discardedUnsavedChanges = existing.IsModified;
            if (!existing.Close(false))
                throw new InvalidOperationException($"Revit did not close the inactive document before reopening it: {filePath}");

            if (armUnresolvedReferencesGuard)
                ArmUnresolvedReferencesGuardIfRequested(continueOnUnresolvedReferences);
            UIDocument reopened = app.OpenAndActivateDocument(modelPath, opts, false);
            var reopenedSettings = BuildProjectSettings(reopened.Document);
            return new
            {
                status = "Reopened and Activated",
                title = reopened.Document.Title,
                path = reopened.Document.PathName,
                discardedUnsavedChanges,
                settings = reopenedSettings
            };
        }

        private static void ArmUnresolvedReferencesGuardIfRequested(bool requested)
        {
            if (!requested) return;

            var service = RevitBridge.App.Instance?.DialogComputerUse
                ?? throw new InvalidOperationException(
                    "continueOnUnresolvedReferences requires the Revit dialog guardian, but it is unavailable in this session.");
            service.ArmGuard(new OperatorDialogComputerUse.GuardParams
            {
                buttonText = "Ignore and continue opening the project",
                interactionMode = "message_then_mouse",
                cursorRestoreMode = "keep",
                titleContains = "Unresolved References",
                messageContains = "Revit could not find or read",
                maxTriggers = 1,
                ttlMs = 120000,
                includeScreenshotAfter = false
            });
        }

        private static Document? FindOpenDocument(UIApplication app, string filePath)
        {
            foreach (Document document in app.Application.Documents)
            {
                // A linked model is present in Application.Documents but cannot
                // be activated, saved, or closed as a top-level UI document.
                // Do not mistake a host's loaded link for an inactive project.
                if (document.IsLinked) continue;
                if (string.Equals(document.PathName, filePath, StringComparison.OrdinalIgnoreCase))
                    return document;
            }

            return null;
        }

        private sealed class LinkedDocumentReference
        {
            public Document HostDocument { get; set; } = null!;
            public ElementId LinkTypeId { get; set; } = null!;
            public string LinkTypeName { get; set; } = "";
            public string LinkedDocumentTitle { get; set; } = "";
        }

        private static List<LinkedDocumentReference> FindLinkedDocumentReferences(UIApplication app, string filePath)
        {
            var references = new List<LinkedDocumentReference>();
            foreach (Document hostDocument in app.Application.Documents)
            {
                if (hostDocument.IsLinked) continue;

                foreach (var instance in new FilteredElementCollector(hostDocument)
                    .OfClass(typeof(RevitLinkInstance))
                    .Cast<RevitLinkInstance>())
                {
                    var linkedDocument = instance.GetLinkDocument();
                    if (linkedDocument == null ||
                        !string.Equals(linkedDocument.PathName, filePath, StringComparison.OrdinalIgnoreCase))
                        continue;

                    var linkTypeId = instance.GetTypeId();
                    var rawLinkTypeId = RevitBridge.Common.ElementIdCompat.GetValue(linkTypeId);
                    if (references.Any(reference =>
                        reference.HostDocument.Equals(hostDocument) &&
                        RevitBridge.Common.ElementIdCompat.GetValue(reference.LinkTypeId) == rawLinkTypeId))
                        continue;

                    var linkType = hostDocument.GetElement(linkTypeId) as RevitLinkType;
                    references.Add(new LinkedDocumentReference
                    {
                        HostDocument = hostDocument,
                        LinkTypeId = linkTypeId,
                        LinkTypeName = linkType?.Name ?? instance.Name,
                        LinkedDocumentTitle = linkedDocument.Title
                    });
                }
            }

            return references;
        }

        private static object[] DescribeLinkedDocumentReferences(IEnumerable<LinkedDocumentReference> references)
        {
            return references.Select(reference => (object)new
            {
                hostTitle = reference.HostDocument.Title,
                hostPath = reference.HostDocument.PathName,
                linkTypeId = RevitBridge.Common.ElementIdCompat.GetValue(reference.LinkTypeId),
                linkTypeName = reference.LinkTypeName,
                linkedDocumentTitle = reference.LinkedDocumentTitle
            }).ToArray();
        }

        private static object[] UnloadLinkedDocumentReferences(IEnumerable<LinkedDocumentReference> references)
        {
            var unloaded = new List<object>();
            foreach (var reference in references)
            {
                var linkType = reference.HostDocument.GetElement(reference.LinkTypeId) as RevitLinkType;
                if (linkType == null)
                    throw new InvalidOperationException($"Revit link type {RevitBridge.Common.ElementIdCompat.GetValue(reference.LinkTypeId)} was not found in host {reference.HostDocument.Title}.");

                InvokeUnload(linkType);
                unloaded.Add(new
                {
                    hostTitle = reference.HostDocument.Title,
                    hostPath = reference.HostDocument.PathName,
                    linkTypeId = RevitBridge.Common.ElementIdCompat.GetValue(reference.LinkTypeId),
                    linkTypeName = reference.LinkTypeName,
                    linkedDocumentTitle = reference.LinkedDocumentTitle
                });
            }

            return unloaded.ToArray();
        }

        private static void InvokeUnload(RevitLinkType linkType)
        {
            var methods = typeof(RevitLinkType)
                .GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .Where(method => string.Equals(method.Name, "Unload", StringComparison.Ordinal))
                .OrderBy(method => method.GetParameters().Length)
                .ToList();

            Exception? lastError = null;
            foreach (var method in methods)
            {
                try
                {
                    var args = method.GetParameters()
                        .Select(parameter => parameter.ParameterType.IsValueType ? Activator.CreateInstance(parameter.ParameterType) : null)
                        .ToArray();
                    method.Invoke(linkType, args);
                    return;
                }
                catch (TargetInvocationException ex)
                {
                    lastError = ex.InnerException ?? ex;
                }
                catch (Exception ex)
                {
                    lastError = ex;
                }
            }

            throw new InvalidOperationException(
                lastError == null
                    ? "This Revit API version does not expose RevitLinkType.Unload."
                    : $"Revit link type unload failed: {lastError.Message}");
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
